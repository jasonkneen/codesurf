#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = new URL('..', import.meta.url).pathname
const tempDir = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-smoke-'))
const smokeHome = join(tempDir, 'home')
await mkdir(smokeHome, { recursive: true })
const smokeFile = join(tempDir, 'status.json')
const timeoutMs = Number(process.env.CODESURF_ELECTROBUN_SMOKE_TIMEOUT_MS ?? 15000)

let stdout = ''
let stderr = ''
let child

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readStatus() {
  if (!existsSync(smokeFile)) return null
  try {
    return JSON.parse(await readFile(smokeFile, 'utf8'))
  } catch {
    return null
  }
}

function sanitizeForOutput(value) {
  if (Array.isArray(value)) return value.map(sanitizeForOutput)
  if (!value || typeof value !== 'object') return value
  const next = {}
  for (const [key, entry] of Object.entries(value)) {
    next[key] = key.toLowerCase().includes('token') ? '[REDACTED]' : sanitizeForOutput(entry)
  }
  return next
}

function stopDaemonFromStatus(status) {
  const pid = Number(status?.daemonStatus?.info?.pid ?? 0)
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  try { process.kill(pid, 'SIGTERM') } catch {}
}

try {
  child = spawn('bun', ['run', 'run:electrobun'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: smokeHome,
      CODESURF_ELECTROBUN_FORCE_BUNDLED: '1',
      CODESURF_ELECTROBUN_SMOKE: '1',
      CODESURF_ELECTROBUN_SELF_CHECK: '1',
      CODESURF_ELECTROBUN_SMOKE_EXIT_AFTER_MS: process.env.CODESURF_ELECTROBUN_SMOKE_EXIT_AFTER_MS ?? '2000',
      CODESURF_ELECTROBUN_SMOKE_FILE: smokeFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })

  const startedAt = Date.now()
  let status = null
  let sawStarted = false
  let sawBridge = false

  const exitPromise = new Promise(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })

  while (Date.now() - startedAt < timeoutMs) {
    status = await readStatus()
    if (status?.phase === 'started' || status?.phase === 'renderer-bridge-ready' || status?.phase === 'exiting') sawStarted = true
    if (status?.bridge?.hasElectronFacade === true) sawBridge = true
    if (child.exitCode !== null) break
    await sleep(200)
  }

  let exit = child.exitCode !== null
    ? { code: child.exitCode, signal: child.signalCode }
    : await Promise.race([exitPromise, sleep(Math.max(1000, timeoutMs - (Date.now() - startedAt))).then(() => null)])

  if (!exit) {
    child.kill('SIGTERM')
    await sleep(500)
    if (child.exitCode === null) child.kill('SIGKILL')
    throw new Error(`Electrobun smoke timed out after ${timeoutMs}ms. Last status: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }

  status = await readStatus()
  if (!sawStarted || !status?.rendererUrl || status?.dbStatus?.schemaVersion !== 4) {
    throw new Error(`Electrobun smoke did not reach started runtime with migrated DB. Status: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  if (process.env.CODESURF_ELECTROBUN_REQUIRE_BRIDGE !== '0' && !sawBridge) {
    throw new Error(`Electrobun renderer bridge did not report ready. Status: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  if (process.env.CODESURF_ELECTROBUN_REQUIRE_BRIDGE !== '0' && status?.bridge?.homedir !== smokeHome) {
    throw new Error(`Electrobun renderer facade did not receive the host home directory. Status: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  if (process.env.CODESURF_ELECTROBUN_REQUIRE_WEBVIEW_TAG !== '0' && status?.bridge?.hasElectrobunWebviewTag !== true) {
    throw new Error(`Electrobun renderer did not expose the native electrobun-webview tag. Status: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  if (process.env.CODESURF_ELECTROBUN_REQUIRE_DAEMON !== '0' && status?.daemonStatus?.running !== true) {
    throw new Error(`Electrobun smoke did not start/report a live daemon. Status: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  if (process.env.CODESURF_ELECTROBUN_REQUIRE_CORE_IPC !== '0' && status?.coreIpcStatus?.ok !== true) {
    throw new Error(`Electrobun smoke did not pass the replacement core IPC self-check. Status: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  const homedirCheck = status?.coreIpcStatus?.checks?.find(check => check?.name === 'homedir:get')
  if (process.env.CODESURF_ELECTROBUN_REQUIRE_CORE_IPC !== '0' && homedirCheck?.detail !== smokeHome) {
    throw new Error(`Electrobun homedir:get self-check did not exercise the host trust path. Status: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  if (exit.code !== 0 && exit.signal !== 'SIGTERM') {
    throw new Error(`Electrobun smoke exited unexpectedly: ${JSON.stringify(exit)}\nStatus: ${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }

  console.log(JSON.stringify({ ok: true, exit, home: smokeHome, status: sanitizeForOutput(status), stdout: stdout.trim().split(/\r?\n/).slice(-8), stderr: stderr.trim().split(/\r?\n/).filter(Boolean).slice(-8) }, null, 2))
} finally {
  const status = await readStatus()
  if (child && child.exitCode === null) child.kill('SIGTERM')
  stopDaemonFromStatus(status)
  await rm(tempDir, { recursive: true, force: true })
}
