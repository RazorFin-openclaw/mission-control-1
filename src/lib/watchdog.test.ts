import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import * as watchdog from './watchdog'

function createMockConfig(overrides: Partial<watchdog.WatchdogConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-watchdog-'))
  mkdirSync(cwd, { recursive: true })
  const base: watchdog.WatchdogConfig = {
    healthUrl: 'http://127.0.0.1:3000/api/agents/hammerhead/heartbeat',
    apiKey: 'test-key',
    restartCommand: 'echo restart_ok',
    failureThreshold: 2,
    probeTimeoutMs: 500,
    recoveryWindowMs: 2500,
    statePath: join(cwd, 'watchdog-state.json'),
    logPath: join(cwd, 'watchdog.log'),
  }

  return { config: { ...base, ...overrides } }
}

describe('watchdog lib', () => {
  it('buildLogLine emits ISO date and plain text format', () => {
    const line = watchdog.buildLogLine('event', 'reason=1')
    expect(line).toContain('event reason=1')
    expect(line).toContain('T')
  })

  it('tracks unhealthy->recovery flow with restart command and success', async () => {
    const { config } = createMockConfig({
      failureThreshold: 1,
      recoveryWindowMs: 1500,
    })

    let probeCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      probeCount += 1
      if (probeCount === 1) {
        return new Response(null, { status: 500 })
      }

      return new Response(JSON.stringify({ status: 'WORK_ITEMS_FOUND' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const restart = vi.fn(async () => undefined)
    const result = await watchdog.runWatchdog({
      ...config,
      restart,
    })
    expect(result.status).toBe('recovered')
    expect(result.restarted).toBe(true)
    expect(restart).toHaveBeenCalledOnce()

    const state = watchdog.readState(config.statePath)
    expect(state.failureStreak).toBe(0)

    const logText = readFileSync(config.logPath, 'utf8')
    expect(logText).toContain('watchdog_unhealthy')
    expect(logText).toContain('watchdog_recovery_success')

    vi.restoreAllMocks()
  })

  it('does not restart until threshold is crossed', async () => {
    const { config } = createMockConfig({
      failureThreshold: 3,
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 500 }))
    const execSpy = vi.spyOn(watchdog, 'executeRestart').mockResolvedValue(undefined)

    const first = await watchdog.runWatchdog(config)
    const second = await watchdog.runWatchdog(config)
    expect(first.status).toBe('degraded')
    expect(second.status).toBe('degraded')
    expect(execSpy).not.toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  it('saves and reads state', () => {
    const { config } = createMockConfig()
    const state = { failureStreak: 5, lastFailureAt: 'ts', lastRecoveryAt: 'rts' }
    watchdog.saveState(config.statePath, state)
    expect(watchdog.readState(config.statePath)).toEqual(state)
  })

  it('resolveWatchdogDefaults has sensible defaults', () => {
    const cfg = watchdog.resolveWatchdogDefaults('/tmp')
    expect(cfg.healthUrl).toBe('http://127.0.0.1:3000/api/agents/hammerhead/heartbeat')
    expect(cfg.failureThreshold).toBe(3)
    expect(cfg.probeTimeoutMs).toBe(1500)
  })
})
