#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = new URL('..', import.meta.url).pathname
const tempDir = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-accept-'))
const homeDir = join(tempDir, 'home')
await mkdir(homeDir, { recursive: true })
const codesurfHome = join(homeDir, '.codesurf')
const statusFile = join(tempDir, 'status.json')
const timeoutMs = Number(process.env.CODESURF_ELECTROBUN_ACCEPT_TIMEOUT_MS ?? 20000)
const settleAfterBridgeMs = Number(process.env.CODESURF_ELECTROBUN_ACCEPT_SETTLE_MS ?? 1200)

let stdout = ''
let stderr = ''
let child = null

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readStatus() {
  if (!existsSync(statusFile)) return null
  try {
    return JSON.parse(await readFile(statusFile, 'utf8'))
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

function assert(condition, message, detail) {
  if (!condition) {
    const suffix = detail === undefined ? '' : `\n${JSON.stringify(sanitizeForOutput(detail), null, 2)}`
    throw new Error(`${message}${suffix}`)
  }
}

async function processTable() {
  const { stdout: output } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { maxBuffer: 1024 * 1024 })
  return output
    .trim()
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      if (!match) return null
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        comm: match[3],
        args: match[4],
      }
    })
    .filter(Boolean)
}

function descendants(rows, rootPid) {
  const byParent = new Map()
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row)
  }
  const found = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    for (const row of byParent.get(pid) ?? []) {
      found.push(row)
      queue.push(row.pid)
    }
  }
  return found
}

function isElectronRuntimeProcess(row) {
  const haystack = `${row.comm} ${row.args}`
  return /Electron\.app|Electron Helper|electron-vite|dist-electron\/main|\belectron\b/i.test(haystack)
}

function stopPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  try { process.kill(pid, 'SIGTERM') } catch {}
}

function stopProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch {}
  }
}

async function waitForChildExit(ms) {
  const deadline = Date.now() + ms
  while (child && child.exitCode === null && Date.now() < deadline) {
    await sleep(100)
  }
  return !child || child.exitCode !== null
}

try {
  child = spawn('bun', ['run', 'run:electrobun'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      CODESURF_HOME: codesurfHome,
      CODESURF_ELECTROBUN_FORCE_BUNDLED: '1',
      CODESURF_ELECTROBUN_SELF_CHECK: '1',
      CODESURF_ELECTROBUN_RENDERER_SELF_CHECK: '1',
      CODESURF_ELECTROBUN_SMOKE_FILE: statusFile,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })

  const startedAt = Date.now()
  let status = null
  let bridgeReadyAt = 0

  while (Date.now() - startedAt < timeoutMs) {
    status = await readStatus()
    if (status?.bridge?.hasElectronFacade === true && status?.coreIpcStatus?.ok === true && status?.daemonStatus?.running === true) {
      if (!bridgeReadyAt) bridgeReadyAt = Date.now()
      if (Date.now() - bridgeReadyAt >= settleAfterBridgeMs) break
    }
    if (child.exitCode !== null) break
    await sleep(200)
  }

  status = await readStatus()
  assert(child.exitCode === null, 'Electrobun real-run exited before acceptance completed', { exitCode: child.exitCode, signal: child.signalCode, status, stdout, stderr })
  assert(status?.rendererUrl === 'views://mainview/index.html', 'Electrobun did not boot the bundled renderer', status)
  assert(status?.bridge?.hasElectronFacade === true, 'Electrobun renderer bridge/facade did not become ready', status)
  assert(status?.bridge?.homedir === homeDir, 'Electrobun renderer facade did not receive the host home directory', status)
  assert(status?.bridge?.hasElectrobunWebviewTag === true, 'Electrobun renderer did not expose the native electrobun-webview tag', status)
  assert(status?.bridge?.selfCheck?.ok === true, 'Electrobun renderer-to-host chat self-check failed', status?.bridge?.selfCheck)
  const bridgeCheckNames = new Set((status?.bridge?.selfCheck?.checks ?? [])
    .filter(check => check?.ok === true)
    .map(check => check.name))
  for (const checkName of [
    'renderer:chat:send-stream-stop',
    'renderer:chat:clearSession',
    'renderer:chat:attachment-issue',
    'renderer:chat:attachment-revoke',
  ]) {
    assert(bridgeCheckNames.has(checkName), `Electrobun renderer self-check did not prove ${checkName}`, status?.bridge?.selfCheck)
  }
  assert(status?.dbStatus?.schemaVersion === 4, 'Electrobun did not open/migrate the runtime DB', status)
  assert(status?.daemonStatus?.running === true, 'Electrobun did not start/report the real daemon', status)
  assert(status?.coreIpcStatus?.ok === true, 'Electrobun core IPC self-check failed', status?.coreIpcStatus)
  const homedirCheck = status?.coreIpcStatus?.checks?.find(check => check?.name === 'homedir:get')
  assert(homedirCheck?.detail === homeDir, 'Electrobun homedir:get self-check did not exercise the host trust path', status?.coreIpcStatus)
  const workspaceCheck = status?.coreIpcStatus?.checks?.find(check => check?.name === 'workspace:list')
  const [workspaceDoc, projectsDoc] = await Promise.all([
    readFile(join(codesurfHome, 'workspaces', 'workspaces.json'), 'utf8').then(JSON.parse),
    readFile(join(codesurfHome, 'projects', 'projects.json'), 'utf8').then(JSON.parse),
  ])
  const persistedWorkspace = workspaceDoc?.workspaces?.find(entry => entry?.id === 'electrobun-local')
  const persistedProject = projectsDoc?.projects?.find(entry => entry?.id === persistedWorkspace?.primaryProjectId)
  const expectedProjectPath = await realpath(join(codesurfHome, 'projects', 'electrobun-local'))
  assert(
    persistedWorkspace?.projectIds?.length === 1
      && persistedWorkspace.projectIds[0] === persistedWorkspace.primaryProjectId,
    'Electrobun first-run workspace registry is not singular and referentially complete',
    { workspaceDoc, projectsDoc },
  )
  assert(
    persistedProject?.path === expectedProjectPath && existsSync(expectedProjectPath),
    'Electrobun first-run project authority is not the app-owned project directory',
    { expectedProjectPath, persistedProject },
  )
  assert(
    workspaceCheck?.detail?.workspaceId === persistedWorkspace.id
      && workspaceCheck?.detail?.projectId === persistedProject.id
      && workspaceCheck?.detail?.reloadVerified === true,
    'Electrobun core IPC self-check did not prove concurrent/reloaded registry integrity',
    { workspaceCheck, persistedWorkspace, persistedProject },
  )

  const rows = await processTable()
  const tree = [
    ...rows.filter(row => row.pid === child.pid),
    ...descendants(rows, child.pid),
  ]
  const electronProcesses = tree.filter(isElectronRuntimeProcess)
  assert(electronProcesses.length === 0, 'Electrobun acceptance found Electron runtime processes in the app process tree', electronProcesses)
  assert(tree.some(row => /Resources\/main\.js/.test(row.args) || /CodeSurf-dev\.app/.test(row.args)), 'Electrobun runtime process was not present in the app process tree', tree)
  assert(tree.some(row => /electrobun run/.test(row.args) || /node_modules\/electrobun\/bin\/electrobun/.test(row.args)), 'Electrobun launcher process was not present in the app process tree', tree)

  console.log(JSON.stringify({
    ok: true,
    home: homeDir,
    status: sanitizeForOutput(status),
    processTree: sanitizeForOutput(tree.map(row => ({ pid: row.pid, ppid: row.ppid, comm: row.comm, args: row.args }))),
    stdout: stdout.trim().split(/\r?\n/).slice(-10),
    stderr: stderr.trim().split(/\r?\n/).filter(Boolean).slice(-10),
  }, null, 2))
} finally {
  const status = await readStatus()
  stopPid(Number(status?.daemonStatus?.info?.pid ?? 0))
  if (child && child.exitCode === null) {
    stopProcessGroup(child.pid, 'SIGTERM')
    if (!(await waitForChildExit(1500))) {
      stopProcessGroup(child.pid, 'SIGKILL')
      await waitForChildExit(800)
    }
  }
  await rm(tempDir, { recursive: true, force: true })
}
