import { describe, expect, it } from 'vitest'
import { buildHeartbeatPreemptionPolicy, resolveHeartbeatDecision } from '@/lib/heartbeat-preemption'

describe('buildHeartbeatPreemptionPolicy', () => {
  it('returns continue_in_progress for mixed in_progress + assigned states', () => {
    const policy = buildHeartbeatPreemptionPolicy([
      { id: 82, status: 'in_progress' },
      { id: 83, status: 'assigned' },
    ])

    expect(policy.action).toBe('continue_in_progress')
    expect(policy.reason).toBe('in_progress_tasks_take_precedence_over_assigned')
    expect(policy.in_progress_task_ids).toEqual([82])
    expect(policy.assigned_task_ids).toEqual([83])
  })

  it('returns pick_assigned when only assigned tasks exist', () => {
    const policy = buildHeartbeatPreemptionPolicy([
      { id: 83, status: 'assigned' },
    ])

    expect(policy.action).toBe('pick_assigned')
    expect(policy.reason).toBe('no_in_progress_tasks_found')
  })
})

describe('resolveHeartbeatDecision', () => {
  it('uses legacy default when policy is absent', () => {
    const decision = resolveHeartbeatDecision(undefined)

    expect(decision.action).toBe('continue_in_progress')
    expect(decision.reason).toBe('legacy_default_when_policy_missing')
  })

  it('uses explicit policy when provided', () => {
    const decision = resolveHeartbeatDecision({
      version: 'v1',
      action: 'pick_assigned',
      reason: 'no_in_progress_tasks_found',
      in_progress_task_ids: [],
      assigned_task_ids: [83],
    })

    expect(decision.action).toBe('pick_assigned')
    expect(decision.reason).toBe('no_in_progress_tasks_found')
  })
})
