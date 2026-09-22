const fs = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')

const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const MAX_OUTPUT_CHARS = 80000

const runsById = new Map()
const lastRunByWorkspace = new Map()
const activeRunByWorkspace = new Map()
let runSeq = 0
let bus = null

function isSafeWorkspacePath(workspacePath) {
  return typeof workspacePath === 'string'
    && workspacePath.trim().length > 1
    && path.isAbsolute(workspacePath)
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function assertWorkspace(workspacePath) {
  if (!isSafeWorkspacePath(workspacePath)) throw new Error('Expected an absolute workspacePath')
  const stat = await fs.stat(workspacePath).catch(() => null)
  if (!stat || !stat.isDirectory()) throw new Error('Workspace path does not exist')
}

async function detectPackageManager(workspacePath) {
  if (await exists(path.join(workspacePath, 'bun.lockb')) || await exists(path.join(workspacePath, 'bun.lock'))) return 'bun'
  if (await exists(path.join(workspacePath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(path.join(workspacePath, 'yarn.lock'))) return 'yarn'
  if (await exists(path.join(workspacePath, 'package-lock.json'))) return 'npm'
  return 'npm'
}

function classifyScript(name) {
  const lower = name.toLowerCase()
  if (lower.includes('watch')) return null
  if (lower === 'test' || lower.startsWith('test:')) return 'test'
  if (lower === 'typecheck' || lower.startsWith('typecheck:') || lower === 'tsc') return 'typecheck'
  if (lower === 'lint' || lower.startsWith('lint:')) return 'lint'
  if (lower === 'build' || lower.startsWith('build:')) return 'build'
  return null
}

function buildPackageScriptProfile(packageManager, scriptName, commandText) {
  return {
    id: `package:${scriptName}`,
    kind: classifyScript(scriptName) || 'script',
    label: `${packageManager} run ${scriptName}`,
    description: commandText || `Run package script ${scriptName}`,
    command: packageManager,
    args: ['run', scriptName],
    scriptName,
    packageManager,
    source: 'package.json',
  }
}

function sortProfiles(profiles) {
  const priority = { test: 0, typecheck: 1, lint: 2, build: 3, script: 4 }
  return profiles.sort((a, b) => {
    const pa = priority[a.kind] ?? 9
    const pb = priority[b.kind] ?? 9
    if (pa !== pb) return pa - pb
    return a.id.localeCompare(b.id)
  })
}

async function detectProfiles(workspacePath) {
  await assertWorkspace(workspacePath)
  const profiles = []
  const packageJson = await readJson(path.join(workspacePath, 'package.json'))
  const packageManager = await detectPackageManager(workspacePath)

  if (packageJson && packageJson.scripts && typeof packageJson.scripts === 'object') {
    for (const [scriptName, commandText] of Object.entries(packageJson.scripts)) {
      const kind = classifyScript(scriptName)
      if (!kind) continue
      profiles.push(buildPackageScriptProfile(packageManager, scriptName, String(commandText || '')))
    }
  }

  if (await exists(path.join(workspacePath, 'pyproject.toml')) || await exists(path.join(workspacePath, 'pytest.ini'))) {
    profiles.push({
      id: 'python:pytest',
      kind: 'test',
      label: 'python -m pytest',
      description: 'Run pytest for this Python workspace.',
      command: 'python',
      args: ['-m', 'pytest'],
      source: 'python',
    })
  }

  if (await exists(path.join(workspacePath, 'Cargo.toml'))) {
    profiles.push({
      id: 'cargo:test',
      kind: 'test',
      label: 'cargo test',
      description: 'Run Rust tests for this workspace.',
      command: 'cargo',
      args: ['test'],
      source: 'cargo',
    })
  }

  if (profiles.length === 0 && await exists(path.join(workspacePath, 'Makefile'))) {
    profiles.push({
      id: 'make:test',
      kind: 'test',
      label: 'make test',
      description: 'Run the test target from Makefile.',
      command: 'make',
      args: ['test'],
      source: 'make',
    })
  }

  return {
    workspacePath,
    packageManager,
    profiles: sortProfiles(profiles),
  }
}

function normalizeTimeout(timeoutMs) {
  const parsed = Number(timeoutMs)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.floor(parsed)))
}

function redactText(text) {
  return String(text || '')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/ig, '$1[REDACTED]')
    .replace(/((?:api|access|secret|auth|token|password|key)[a-z0-9_\-]*\s*[=:]\s*)[^\s'"`]+/ig, '$1[REDACTED]')
}

function appendOutput(run, chunk) {
  if (!chunk) return
  run.output += redactText(chunk)
  if (run.output.length > MAX_OUTPUT_CHARS) {
    run.output = '[output truncated; keeping last ' + MAX_OUTPUT_CHARS + ' chars]\n' + run.output.slice(-MAX_OUTPUT_CHARS)
  }
  run.updatedAt = Date.now()
}

function serializeRun(run) {
  if (!run) return null
  return {
    id: run.id,
    workspacePath: run.workspacePath,
    profileId: run.profileId,
    profile: run.profile,
    status: run.status,
    exitCode: run.exitCode,
    signal: run.signal,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    timeoutMs: run.timeoutMs,
    output: run.output,
    outputChars: run.output.length,
    summary: formatRunSummary(run),
  }
}

function publishRun(run, eventType) {
  const payload = { run: serializeRun(run) }
  if (bus) bus.publish('ctx:test-loop:last_run', eventType, payload)
}

async function resolveProfile(workspacePath, profileId) {
  const detected = await detectProfiles(workspacePath)
  const profile = detected.profiles.find(candidate => candidate.id === profileId)
  if (!profile) throw new Error(`Unknown test profile: ${profileId}`)
  return profile
}

async function startRun(workspacePath, profileId, options) {
  await assertWorkspace(workspacePath)
  const active = activeRunByWorkspace.get(workspacePath)
  if (active && active.status === 'running') {
    throw new Error(`A Test Loop run is already active: ${active.id}`)
  }

  const profile = await resolveProfile(workspacePath, profileId)
  const timeoutMs = normalizeTimeout(options && options.timeoutMs)
  const run = {
    id: `test-loop-${Date.now()}-${++runSeq}`,
    workspacePath,
    profileId,
    profile,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    durationMs: null,
    timeoutMs,
    output: `$ ${profile.command} ${profile.args.join(' ')}\n`,
    child: null,
    timer: null,
  }

  runsById.set(run.id, run)
  lastRunByWorkspace.set(workspacePath, run)
  activeRunByWorkspace.set(workspacePath, run)

  const child = spawn(profile.command, profile.args, {
    cwd: workspacePath,
    env: {
      ...process.env,
      CI: process.env.CI || '1',
      CODESURF_TEST_LOOP: '1',
    },
    shell: false,
  })
  run.child = child

  child.stdout.on('data', chunk => appendOutput(run, chunk.toString()))
  child.stderr.on('data', chunk => appendOutput(run, chunk.toString()))
  child.once('error', err => {
    appendOutput(run, `\n[spawn error] ${err.message}\n`)
  })
  child.once('close', (code, signal) => {
    if (run.timer) clearTimeout(run.timer)
    const wasCanceling = run.status === 'canceling'
    const wasTimedOut = run.status === 'timed_out'
    run.exitCode = typeof code === 'number' ? code : null
    run.signal = signal || null
    run.completedAt = Date.now()
    run.durationMs = run.completedAt - run.startedAt
    run.status = wasTimedOut ? 'timed_out' : wasCanceling ? 'canceled' : code === 0 ? 'passed' : 'failed'
    activeRunByWorkspace.delete(workspacePath)
    appendOutput(run, `\n[${run.status}] exit=${run.exitCode === null ? 'null' : run.exitCode}${signal ? ` signal=${signal}` : ''} duration=${run.durationMs}ms\n`)
    publishRun(run, 'test_loop.run.completed')
  })

  run.timer = setTimeout(() => {
    if (run.status !== 'running') return
    run.status = 'timed_out'
    appendOutput(run, `\n[timeout] exceeded ${timeoutMs}ms; terminating process\n`)
    child.kill('SIGTERM')
  }, timeoutMs)

  publishRun(run, 'test_loop.run.started')
  return serializeRun(run)
}

function getLastRun(workspacePath) {
  return serializeRun(lastRunByWorkspace.get(workspacePath))
}

function cancelRun(params) {
  const runId = typeof params === 'string' ? params : params && params.runId
  const workspacePath = params && params.workspacePath
  const run = runId ? runsById.get(runId) : activeRunByWorkspace.get(workspacePath)
  if (!run) return { ok: false, error: 'No active run found' }
  if (run.status !== 'running') return { ok: false, error: `Run is already ${run.status}`, run: serializeRun(run) }
  run.status = 'canceling'
  appendOutput(run, '\n[cancel] terminating process\n')
  if (run.child) run.child.kill('SIGTERM')
  publishRun(run, 'test_loop.run.canceling')
  return { ok: true, run: serializeRun(run) }
}

function formatRunSummary(run) {
  if (!run) return 'No Test Loop run yet.'
  const profile = run.profile || {}
  const lines = []
  lines.push('# Test Loop Run')
  lines.push('')
  lines.push(`Profile: ${profile.label || run.profileId}`)
  lines.push(`Status: ${run.status}`)
  if (run.exitCode !== null && run.exitCode !== undefined) lines.push(`Exit code: ${run.exitCode}`)
  if (run.durationMs !== null && run.durationMs !== undefined) lines.push(`Duration: ${run.durationMs}ms`)
  lines.push(`Workspace: ${run.workspacePath}`)
  lines.push('')
  lines.push('## Output')
  lines.push('```text')
  lines.push((run.output || '').trim().slice(-12000))
  lines.push('```')
  return lines.join('\n').trim()
}

function formatProfilesMarkdown(detected) {
  const lines = []
  lines.push('# Test Loop Profiles')
  lines.push('')
  lines.push(`Workspace: ${detected.workspacePath}`)
  lines.push(`Package manager: ${detected.packageManager}`)
  lines.push('')
  if (!detected.profiles.length) {
    lines.push('No runnable profiles detected.')
  } else {
    detected.profiles.forEach(profile => {
      lines.push(`- ${profile.id}: ${profile.label}`)
      lines.push(`  - kind: ${profile.kind}`)
      lines.push(`  - source: ${profile.source}`)
    })
  }
  return lines.join('\n')
}

module.exports = {
  activate(ctx) {
    bus = ctx.bus
    ctx.log('Test Loop activated')

    ctx.ipc.handle('detectProfiles', async (workspacePath) => detectProfiles(String(workspacePath || '')))
    ctx.ipc.handle('startRun', async (workspacePath, profileId, options) => startRun(String(workspacePath || ''), String(profileId || ''), options || {}))
    ctx.ipc.handle('getLastRun', async (workspacePath) => getLastRun(String(workspacePath || '')))
    ctx.ipc.handle('cancelRun', async (params) => cancelRun(params || {}))

    ctx.mcp.registerTool({
      name: 'detect_profiles',
      description: 'Detect runnable Test Loop profiles for a workspace.',
      inputSchema: {
        type: 'object',
        properties: { workspacePath: { type: 'string' } },
        required: ['workspacePath'],
      },
      handler: async (args) => formatProfilesMarkdown(await detectProfiles(String(args.workspacePath || ''))),
    })

    ctx.mcp.registerTool({
      name: 'start_run',
      description: 'Start a Test Loop run for a detected profile.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          profileId: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['workspacePath', 'profileId'],
      },
      handler: async (args) => {
        const run = await startRun(String(args.workspacePath || ''), String(args.profileId || ''), { timeoutMs: args.timeoutMs })
        return `Started Test Loop run ${run.id}\n\n${run.summary}`
      },
    })

    ctx.mcp.registerTool({
      name: 'get_last_run',
      description: 'Return the latest Test Loop run for a workspace.',
      inputSchema: {
        type: 'object',
        properties: { workspacePath: { type: 'string' } },
        required: ['workspacePath'],
      },
      handler: async (args) => {
        const run = getLastRun(String(args.workspacePath || ''))
        return run ? run.summary : 'No Test Loop run yet.'
      },
    })

    ctx.mcp.registerTool({
      name: 'cancel_run',
      description: 'Cancel the active Test Loop run for a workspace or run id.',
      inputSchema: {
        type: 'object',
        properties: {
          workspacePath: { type: 'string' },
          runId: { type: 'string' },
        },
      },
      handler: async (args) => JSON.stringify(cancelRun(args), null, 2),
    })

    return () => {
      for (const run of runsById.values()) {
        if (run.status === 'running' && run.child) {
          run.status = 'canceling'
          run.child.kill('SIGTERM')
        }
        if (run.timer) clearTimeout(run.timer)
      }
      bus = null
    }
  },
  __testing: {
    classifyScript,
    detectPackageManager,
    detectProfiles,
    redactText,
    formatRunSummary,
    formatProfilesMarkdown,
    normalizeTimeout,
    sortProfiles,
  },
}
