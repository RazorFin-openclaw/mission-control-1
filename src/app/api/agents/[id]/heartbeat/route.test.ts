import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAll, mockGet, mockUpdateAgentStatus, mockLogActivity } = vi.hoisted(() => ({
  mockAll: vi.fn(),
  mockGet: vi.fn(),
  mockUpdateAgentStatus: vi.fn(),
  mockLogActivity: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { workspace_id: 1 } })),
}))

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: (sql: string) => ({
      get: (...args: any[]) => mockGet(sql, ...args),
      all: (...args: any[]) => mockAll(sql, ...args),
    }),
  })),
  db_helpers: {
    getPendingNotifications: vi.fn(() => [
      { id: 3, type: 'comment', title: 'Comment', message: 'x', created_at: 123, source_type: 'comment', source_id: 77 },
    ]),
    updateAgentStatus: mockUpdateAgentStatus,
    logActivity: mockLogActivity,
  },
}))

import { GET } from './route'

describe('GET /api/agents/[id]/heartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockImplementation((sql: string) => {
      if (sql.includes('FROM agents')) return { id: 1, name: 'jack' }
      return null
    })
    mockAll.mockImplementation((sql: string) => {
      if (sql.includes('FROM comments')) return []
      if (sql.includes('FROM tasks')) {
        return [
          { id: 10, title: 'A', status: 'assigned', priority: 'high', due_date: null },
          { id: 11, title: 'B', status: 'in_progress', priority: 'medium', due_date: null },
        ]
      }
      if (sql.includes('FROM activities')) return []
      return []
    })
  })

  it('returns actionable heartbeat fields and filtered task buckets', async () => {
    const req = new Request('http://localhost/api/agents/jack/heartbeat') as any
    const res = await GET(req, { params: Promise.resolve({ id: 'jack' }) })
    const body = await res.json()

    expect(body.status).toBe('WORK_ITEMS_FOUND')
    expect(body.assigned_tasks).toHaveLength(1)
    expect(body.in_progress_tasks).toHaveLength(1)
    expect(body.has_actionable_work).toBe(true)
    const notifications = body.work_items.find((w: any) => w.type === 'notifications')
    expect(notifications.items[0].comment_id).toBe(77)
  })
})
