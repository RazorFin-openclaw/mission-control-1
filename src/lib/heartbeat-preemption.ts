export type AgentTaskStatus = 'assigned' | 'in_progress'

export interface AgentTaskLike {
  id: number
  status: AgentTaskStatus
}

export type HeartbeatPreemptionAction = 'continue_in_progress' | 'switch_to_assigned' | 'pick_assigned' | 'no_action'

export interface HeartbeatPreemptionPolicy {
  version: 'v1'
  action: HeartbeatPreemptionAction
  reason: string
  in_progress_task_ids: number[]
  assigned_task_ids: number[]
}

export interface HeartbeatDecision {
  action: HeartbeatPreemptionAction
  reason: string
}

export function buildHeartbeatPreemptionPolicy(tasks: AgentTaskLike[]): HeartbeatPreemptionPolicy {
  const inProgressTaskIds = tasks.filter((task) => task.status === 'in_progress').map((task) => task.id)
  const assignedTaskIds = tasks.filter((task) => task.status === 'assigned').map((task) => task.id)

  if (inProgressTaskIds.length > 0 && assignedTaskIds.length > 0) {
    return {
      version: 'v1',
      action: 'continue_in_progress',
      reason: 'in_progress_tasks_take_precedence_over_assigned',
      in_progress_task_ids: inProgressTaskIds,
      assigned_task_ids: assignedTaskIds,
    }
  }

  if (inProgressTaskIds.length > 0) {
    return {
      version: 'v1',
      action: 'continue_in_progress',
      reason: 'active_in_progress_tasks_present',
      in_progress_task_ids: inProgressTaskIds,
      assigned_task_ids: assignedTaskIds,
    }
  }

  if (assignedTaskIds.length > 0) {
    return {
      version: 'v1',
      action: 'pick_assigned',
      reason: 'no_in_progress_tasks_found',
      in_progress_task_ids: inProgressTaskIds,
      assigned_task_ids: assignedTaskIds,
    }
  }

  return {
    version: 'v1',
    action: 'no_action',
    reason: 'no_assigned_or_in_progress_tasks_found',
    in_progress_task_ids: inProgressTaskIds,
    assigned_task_ids: assignedTaskIds,
  }
}

export function resolveHeartbeatDecision(policy?: HeartbeatPreemptionPolicy | null): HeartbeatDecision {
  if (!policy) {
    return {
      action: 'continue_in_progress',
      reason: 'legacy_default_when_policy_missing',
    }
  }

  return {
    action: policy.action,
    reason: policy.reason,
  }
}
