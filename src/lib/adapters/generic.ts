import { eventBus } from '@/lib/event-bus'
import { getDatabase } from '@/lib/db'
import type { FrameworkAdapter, AgentRegistration, HeartbeatPayload, TaskReport, Assignment } from './adapter'

export class GenericAdapter implements FrameworkAdapter {
  readonly framework = 'generic'

  async register(agent: AgentRegistration): Promise<void> {
    eventBus.broadcast('agent.created', {
      id: agent.agentId,
      name: agent.name,
      framework: agent.framework || this.framework,
      status: 'online',
      ...(agent.metadata ?? {}),
    })
  }

  async heartbeat(payload: HeartbeatPayload): Promise<void> {
    eventBus.broadcast('agent.status_changed', {
      id: payload.agentId,
      status: payload.status,
      metrics: payload.metrics ?? {},
      framework: this.framework,
    })
  }

  async reportTask(report: TaskReport): Promise<void> {
    eventBus.broadcast('task.updated', {
      id: report.taskId,
      agentId: report.agentId,
      progress: report.progress,
      status: report.status,
      output: report.output,
      framework: this.framework,
    })
  }

  async getAssignments(agentId: string): Promise<Assignment[]> {
    try {
      const db = getDatabase()
      const rows = db.prepare(`
        SELECT id, title, description, priority
        FROM tasks
        WHERE (assigned_to = ? OR assigned_to IS NULL)
          AND status IN ('assigned', 'inbox')
        ORDER BY
          CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC,
          due_date ASC,
          created_at ASC
        LIMIT 5
      `).all(agentId) as Array<{ id: number; title: string; description: string | null; priority: string }>

      return rows.map(row => ({
        taskId: String(row.id),
        description: row.title + (row.description ? `\n${row.description}` : ''),
        priority: row.priority === 'critical' ? 0 : row.priority === 'high' ? 1 : row.priority === 'medium' ? 2 : 3,
      }))
    } catch {
      return []
    }
  }

  async disconnect(agentId: string): Promise<void> {
    eventBus.broadcast('agent.status_changed', {
      id: agentId,
      status: 'offline',
      framework: this.framework,
    })
  }
}
