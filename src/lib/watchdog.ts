import { exec as execRaw } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

export interface WatchdogConfig {
  healthUrl: string
  apiKey?: string
  restartCommand: string
  failureThreshold: number
  probeTimeoutMs: number
  recoveryWindowMs: number
  statePath: string
  logPath: string
  restart?: (command: string) => Promise<void>
}

export interface WatchdogState {
  failureStreak: number
  lastFailureAt: string | null
  lastRecoveryAt: string | null
}

export interface WatchdogRunResult {
  status: 'healthy' | 'degraded' | 'recovered'
  failureStreak: number
  attempts: number
  restarted: boolean
  reason: string
}

const exec = promisify(execRaw)

export async function executeRestart(command: string): Promise<void> {
  await exec(command)
}

export function resolveWatchdogDefaults(baseDir = process.cwd()): WatchdogConfig {
  return {
    healthUrl: process.env.MC_WATCHDOG_HEALTH_URL || 'http://127.0.0.1:3000/api/agents/hammerhead/heartbeat',
    apiKey: process.env.MC_WATCHDOG_API_KEY,
    restartCommand: process.env.MC_WATCHDOG_RESTART_COMMAND || 'openclaw gateway restart',
    failureThreshold: Number.parseInt(process.env.MC_WATCHDOG_FAILURE_THRESHOLD || '3', 10),
    probeTimeoutMs: Number.parseInt(process.env.MC_WATCHDOG_PROBE_TIMEOUT_MS || '1500', 10),
    recoveryWindowMs: Number.parseInt(process.env.MC_WATCHDOG_RECOVERY_WINDOW_MS || '30000', 10),
    statePath: process.env.MC_WATCHDOG_STATE_PATH || path.join(baseDir, '.data', 'watchdog-state.json'),
    logPath: process.env.MC_WATCHDOG_LOG_PATH || path.join(baseDir, '.data', 'watchdog-recovery.log'),
  }
}

export function buildLogLine(event: string, reason: string): string {
  return `${new Date().toISOString()} ${event} ${reason}`
}

function ensureDataDir(logPath: string, statePath: string) {
  const dirs = new Set<string>([path.dirname(logPath), path.dirname(statePath)])
  for (const d of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

export function readState(pathToState: string): WatchdogState {
  if (!existsSync(pathToState)) {
    return { failureStreak: 0, lastFailureAt: null, lastRecoveryAt: null }
  }

  try {
    const raw = readFileSync(pathToState, 'utf8')
    const parsed = JSON.parse(raw) as Partial<WatchdogState>
    return {
      failureStreak: Number.isFinite(parsed.failureStreak as number) ? Number(parsed.failureStreak) : 0,
      lastFailureAt: typeof parsed.lastFailureAt === 'string' ? parsed.lastFailureAt : null,
      lastRecoveryAt: typeof parsed.lastRecoveryAt === 'string' ? parsed.lastRecoveryAt : null,
    }
  } catch {
    return { failureStreak: 0, lastFailureAt: null, lastRecoveryAt: null }
  }
}

export function saveState(pathToState: string, state: WatchdogState): void {
  ensureDataDir('', pathToState)
  writeFileSync(pathToState, JSON.stringify(state, null, 2))
}

function appendLog(pathToLog: string, event: string, reason: string) {
  ensureDataDir(pathToLog, pathToLog)
  writeFileSync(pathToLog, `${buildLogLine(event, reason)}\n`, { flag: 'a' })
}

async function probeHealth(config: WatchdogConfig): Promise<{ healthy: boolean; details: string }> {
  try {
    const response = await fetch(config.healthUrl, {
      headers: config.apiKey ? { 'x-api-key': config.apiKey } : undefined,
      signal: AbortSignal.timeout(config.probeTimeoutMs),
    })

    if (response.status !== 200) {
      return { healthy: false, details: `HTTP_${response.status}` }
    }

    const body = await response.json().catch(() => null)
    if (!body || typeof body.status !== 'string') {
      return { healthy: false, details: 'MISSING_STATUS' }
    }

    if (body.status !== 'HEARTBEAT_OK' && body.status !== 'WORK_ITEMS_FOUND') {
      return { healthy: false, details: `UNEXPECTED_STATUS_${body.status}` }
    }

    return { healthy: true, details: body.status }
  } catch (error: any) {
    return { healthy: false, details: error?.name || 'PROBE_ERROR' }
  }
}

export async function runWatchdog(config: WatchdogConfig): Promise<WatchdogRunResult> {
  const state = readState(config.statePath)
  const probe = await probeHealth(config)

  if (probe.healthy) {
    const normalized: WatchdogState = {
      failureStreak: 0,
      lastFailureAt: state.lastFailureAt,
      lastRecoveryAt: state.lastRecoveryAt,
    }

    saveState(config.statePath, normalized)
    appendLog(config.logPath, 'watchdog_healthy', `status=${probe.details}`)
    return { status: 'healthy', failureStreak: 0, attempts: 1, restarted: false, reason: probe.details }
  }

  const updated: WatchdogState = {
    ...state,
    failureStreak: state.failureStreak + 1,
    lastFailureAt: new Date().toISOString(),
  }

  appendLog(config.logPath, 'watchdog_unhealthy', probe.details)

  if (updated.failureStreak < config.failureThreshold) {
    saveState(config.statePath, updated)
    return {
      status: 'degraded',
      failureStreak: updated.failureStreak,
      attempts: 1,
      restarted: false,
      reason: `Failure streak ${updated.failureStreak} < ${config.failureThreshold}`,
    }
  }

  appendLog(config.logPath, 'watchdog_recovery_triggered', `failures=${updated.failureStreak}`)
  try {
    await (config.restart ?? executeRestart)(config.restartCommand)
  } catch (error: any) {
    saveState(config.statePath, updated)
    appendLog(config.logPath, 'watchdog_recovery_failed', `restart_error=${error?.message ?? 'unknown'}`)
    return {
      status: 'degraded',
      failureStreak: updated.failureStreak,
      attempts: 1,
      restarted: false,
      reason: 'Restart command failed',
    }
  }

  const deadline = Date.now() + config.recoveryWindowMs
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    const postRecoveryProbe = await probeHealth(config)
    if (postRecoveryProbe.healthy) {
      const recovered: WatchdogState = {
        failureStreak: 0,
        lastFailureAt: updated.lastFailureAt,
        lastRecoveryAt: new Date().toISOString(),
      }
      saveState(config.statePath, recovered)
      appendLog(config.logPath, 'watchdog_recovery_success', `attempts=${attempts}`)
      return {
        status: 'recovered',
        failureStreak: 0,
        attempts,
        restarted: true,
        reason: `Recovered after ${attempts} attempts`,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  saveState(config.statePath, updated)
  appendLog(config.logPath, 'watchdog_recovery_timeout', `windowMs=${config.recoveryWindowMs}`)
  return {
    status: 'degraded',
    failureStreak: updated.failureStreak,
    attempts,
    restarted: true,
    reason: `Recovery window ${config.recoveryWindowMs}ms exhausted`,
  }
}
