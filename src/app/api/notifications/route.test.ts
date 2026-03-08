import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRun, mockAction } = vi.hoisted(() => ({
  mockRun: vi.fn((..._args: any[]) => ({ changes: 1 })),
  mockAction: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole: vi.fn(() => ({ user: { workspace_id: 1 } })) }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: vi.fn(() => null) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock('@/lib/validation', () => ({
  validateBody: vi.fn(async (req: Request) => ({ data: await req.json() })),
  notificationActionSchema: {},
}))
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: (sql: string) => ({
      run: (...args: any[]) => {
        mockAction(sql, ...args)
        return mockRun(args)
      },
      all: vi.fn(() => []),
      get: vi.fn(() => ({ count: 0, total: 0 })),
    }),
  })),
}))

import { PUT } from './route'

describe('PUT /api/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('supports ack action and returns normalized payload', async () => {
    const req = new Request('http://localhost/api/notifications', {
      method: 'PUT',
      body: JSON.stringify({ ids: [1, 2], action: 'ack' }),
      headers: { 'content-type': 'application/json' },
    }) as any

    const res = await PUT(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.action).toBe('ack')
    expect(body.marked).toBe(1)
    expect(mockAction).toHaveBeenCalledWith(expect.stringContaining('UPDATE notifications'), expect.any(Number), 1, 2, 1)
  })
})
