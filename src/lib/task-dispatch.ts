import { getDatabase, db_helpers } from './db'
import { runOpenClaw } from './command'
import { eventBus } from './event-bus'
import { logger } from './logger'

interface DispatchableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  assigned_to: string
  workspace_id: number
  agent_name: string
  agent_id: number
  ticket_prefix: string | null
  project_ticket_no: number | null
  project_id: number | null
}

function buildTaskPrompt(task: DispatchableTask): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You have been assigned a task in Mission Control.',
    '',
    `**[${ticket}] ${task.title}**`,
    `Priority: ${task.priority}`,
  ]

  if (task.description) {
    lines.push('', task.description)
  }

  lines.push('', 'Complete this task and provide your response. Be concise and actionable.')
  return lines.join('\n')
}

function parseAgentResponse(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout)
    // OpenClaw agent --json returns { payloads: [{ text: "..." }] }
    if (parsed?.payloads?.[0]?.text) {
      return parsed.payloads[0].text
    }
    // Fallback: if there's a result or output field
    if (parsed?.result) return String(parsed.result)
    if (parsed?.output) return String(parsed.output)
    // Last resort: stringify the whole response
    return JSON.stringify(parsed, null, 2)
  } catch {
    // Not valid JSON — return raw stdout if non-empty
    return stdout.trim() || null
  }
}

export async function dispatchAssignedTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.*, a.name as agent_name, a.id as agent_id,
           p.ticket_prefix, t.project_ticket_no
    FROM tasks t
    JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.status = 'assigned'
      AND t.assigned_to IS NOT NULL
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      t.created_at ASC
    LIMIT 3
  `).all() as DispatchableTask[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No assigned tasks to dispatch' }
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = []
  const now = Math.floor(Date.now() / 1000)

  for (const task of tasks) {
    // Mark as in_progress immediately to prevent re-dispatch
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run('in_progress', now, task.id)

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'in_progress',
      previous_status: 'assigned',
    })

    db_helpers.logActivity(
      'task_dispatched',
      'task',
      task.id,
      'scheduler',
      `Dispatching task "${task.title}" to agent ${task.agent_name}`,
      { agent: task.agent_name, priority: task.priority },
      task.workspace_id
    )

    try {
      const prompt = buildTaskPrompt(task)
      const result = await runOpenClaw(
        ['agent', '--agent', task.agent_name, '--message', prompt, '--local', '--json', '--timeout', '120'],
        { timeoutMs: 130_000 }
      )

      const responseText = parseAgentResponse(result.stdout)

      if (!responseText) {
        throw new Error('Agent returned empty response')
      }

      const truncated = responseText.length > 10_000
        ? responseText.substring(0, 10_000) + '\n\n[Response truncated at 10,000 characters]'
        : responseText

      // Update task: status → review, set outcome
      db.prepare(`
        UPDATE tasks SET status = ?, outcome = ?, resolution = ?, updated_at = ? WHERE id = ?
      `).run('review', 'success', truncated, Math.floor(Date.now() / 1000), task.id)

      // Add a comment from the agent with the full response
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.agent_name,
        truncated,
        Math.floor(Date.now() / 1000),
        task.workspace_id
      )

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'in_progress',
      })

      eventBus.broadcast('task.updated', {
        id: task.id,
        status: 'review',
        outcome: 'success',
        assigned_to: task.assigned_to,
      })

      db_helpers.logActivity(
        'task_agent_completed',
        'task',
        task.id,
        task.agent_name,
        `Agent completed task "${task.title}" — awaiting review`,
        { response_length: responseText.length },
        task.workspace_id
      )

      results.push({ id: task.id, success: true })
      logger.info({ taskId: task.id, agent: task.agent_name }, 'Task dispatched and completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, agent: task.agent_name, err }, 'Task dispatch failed')

      // Revert to assigned so it can be retried on the next tick
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('assigned', errorMsg.substring(0, 5000), Math.floor(Date.now() / 1000), task.id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'assigned',
        previous_status: 'in_progress',
      })

      db_helpers.logActivity(
        'task_dispatch_failed',
        'task',
        task.id,
        'scheduler',
        `Task dispatch failed for "${task.title}": ${errorMsg.substring(0, 200)}`,
        { error: errorMsg.substring(0, 1000) },
        task.workspace_id
      )

      results.push({ id: task.id, success: false, error: errorMsg.substring(0, 100) })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const failSummary = failed.length > 0
    ? ` (${failed.length} failed: ${failed.map(f => f.error).join('; ')})`
    : ''

  return {
    ok: failed.length === 0,
    message: `Dispatched ${succeeded}/${tasks.length} tasks${failSummary}`,
  }
}
