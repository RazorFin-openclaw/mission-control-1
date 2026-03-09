#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const config = {
  healthUrl: process.env.MC_WATCHDOG_HEALTH_URL || 'http://127.0.0.1:3000/api/agents/hammerhead/heartbeat',
  apiKey: process.env.MC_WATCHDOG_API_KEY,
  restartCommand: process.env.MC_WATCHDOG_RESTART_COMMAND || 'openclaw gateway restart',
  failureThreshold: Number.parseInt(process.env.MC_WATCHDOG_FAILURE_THRESHOLD || '3', 10),
  probeTimeoutMs: Number.parseInt(process.env.MC_WATCHDOG_PROBE_TIMEOUT_MS || '1500', 10),
  recoveryWindowMs: Number.parseInt(process.env.MC_WATCHDOG_RECOVERY_WINDOW_MS || '30000', 10),
  statePath: process.env.MC_WATCHDOG_STATE_PATH || './.data/watchdog-state.json',
  logPath: process.env.MC_WATCHDOG_LOG_PATH || './.data/watchdog-recovery.log',
}

function loadState(path) {
  if (!existsSync(path)) {
    return { failureStreak: 0, lastFailureAt: null, lastRecoveryAt: null }
  }

  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { failureStreak: 0, lastFailureAt: null, lastRecoveryAt: null }
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2))
}

function appendLog(path, event, reason) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${new Date().toISOString()} ${event} ${reason}\n`)
}

async function probeHealth() {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.probeTimeoutMs)
    const response = await fetch(config.healthUrl, {
      headers: config.apiKey ? { 'x-api-key': config.apiKey } : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (response.status !== 200) {
      return { healthy: false, details: `HTTP_${response.status}` }
    }

    const body = await response.json().catch(() => null)
    if (!body || !['HEARTBEAT_OK', 'WORK_ITEMS_FOUND'].includes(body.status)) {
      return { healthy: false, details: `UNEXPECTED_STATUS_${body?.status}` }
    }

    return { healthy: true, details: body.status }
  } catch (error) {
    return { healthy: false, details: error?.name || 'PROBE_ERROR' }
  }
}

async function run() {
  const state = loadState(config.statePath)
  const probe = await probeHealth()

  if (probe.healthy) {
    saveState(config.statePath, { ...state, failureStreak: 0 })
    appendLog(config.logPath, 'watchdog_healthy', `status=${probe.details}`)
    return
  }

  const updated = { ...state, failureStreak: (state.failureStreak || 0) + 1, lastFailureAt: new Date().toISOString() }
  appendLog(config.logPath, 'watchdog_unhealthy', probe.details)

  if (updated.failureStreak < config.failureThreshold) {
    saveState(config.statePath, updated)
    return
  }

  appendLog(config.logPath, 'watchdog_recovery_triggered', `failures=${updated.failureStreak}`)

  try {
    execSync(config.restartCommand)
  } catch (error) {
    appendLog(config.logPath, 'watchdog_recovery_failed', `restart_error=${error?.message || 'unknown'}`)
    saveState(config.statePath, updated)
    return
  }

  const deadline = Date.now() + config.recoveryWindowMs
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    const retry = await probeHealth()
    if (retry.healthy) {
      appendLog(config.logPath, 'watchdog_recovery_success', `attempts=${attempts}`)
      saveState(config.statePath, { failureStreak: 0, lastFailureAt: updated.lastFailureAt, lastRecoveryAt: new Date().toISOString() })
      return
    }
    await sleep(1000)
  }

  appendLog(config.logPath, 'watchdog_recovery_timeout', `windowMs=${config.recoveryWindowMs}`)
  saveState(config.statePath, updated)
}

run().catch((error) => {
  appendLog(config.logPath, 'watchdog_unhandled_error', String(error?.message || error))
  process.exitCode = 2
})
