import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAll, mockGet } = vi.hoisted(() => ({
  mockAll: vi.fn(),
  mockGet: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { workspace_id: 1 } })),
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: vi.fn(() => null) }))
vi.mock('@/lib/validation', () => ({
  validateBody: vi.fn(),
  createTaskSchema: {},
  bulkUpdateTaskStatusSchema: {},
}))
vi.mock('@/lib/mentions', () => ({ resolveMentionRecipients: vi.fn(() => ({ unresolved: [], recipients: [], tokens: [] })) }))
vi.mock('@/lib/task-status', () => ({ normalizeTaskCreateStatus: vi.fn(() => 'inbox') }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: (sql: string) => ({
      all: (...args: any[]) => mockAll(sql, ...args),
      get: (...args: any[]) => mockGet(sql, ...args),
      run: vi.fn(),
    }),
    transaction: (fn: any) => fn,
  })),
  db_helpers: {},
}))

import { GET } from './route'

describe('GET /api/tasks assignee filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAll.mockReturnValue([])
    mockGet.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*) as total')) return { total: 0 }
      return null
    })
  })

  it('supports ?assignee=agent alias and applies strict assigned_to filter', async () => {
    const req = new Request('http://localhost/api/tasks?assignee=hammerhead') as any
    const res = await GET(req)

    expect(res.status).toBe(200)
    const call = mockAll.mock.calls.find(([sql]: any[]) => String(sql).includes('FROM tasks'))
    expect(call).toBeTruthy()
    expect(call?.[0]).toContain('t.assigned_to = ?')
    expect(call?.slice(1)).toContain('hammerhead')
  })

  it('returns 400 when assigned_to and assignee conflict', async () => {
    const req = new Request('http://localhost/api/tasks?assigned_to=jack&assignee=hammerhead') as any
    const res = await GET(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/must match/i)
  })
})
