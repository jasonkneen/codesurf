import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

const DEFAULT_PROVIDER = 'claude'
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_SESSIONS = 6
const DEFAULT_MAX_MESSAGES_PER_SESSION = 6
const MAX_MESSAGE_CHARS = 500
const MAX_MEMORY_CHARS = 16_000
const MAX_EXISTING_DREAM_CHARS = 8_000
const MAX_SESSION_BLOCK_CHARS = 4_000
const DEFAULT_AUTO_MIN_SESSIONS = 3
const DEFAULT_AUTO_MIN_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_AUTO_DEBOUNCE_MS = 5_000
const DEFAULT_AUTO_SWEEP_MS = 5 * 60 * 1000

function assertSafeId(id) {
  if (/[\\/]|\.\./.test(String(id ?? ''))) {
    throw new Error(`Unsafe ID: ${id}`)
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(filePath, value) {
  await ensureDir(dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tempPath, filePath)
}

async function writeTextAtomic(filePath, content) {
  await ensureDir(dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, String(content ?? ''), 'utf8')
  await fs.rename(tempPath, filePath)
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

function truncateText(value, maxChars) {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function sanitizeDreamMarkdown(value) {
  let text = normalizeText(value)
  if (!text) return '# DREAMING\n\nNo durable memory could be consolidated from the available context.\n'
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced) text = normalizeText(fenced[1])
  return `${text}\n`
}

function workspaceDreamFilePath(workspaceDir) {
  return join(workspaceDir, '.codesurf', 'DREAMING.md')
}

function dreamingDir(homeDir, workspaceId) {
  assertSafeId(workspaceId)
  return join(homeDir, 'workspaces', workspaceId, '.codesurf', 'dreaming')
}

function dreamingRunsDir(homeDir, workspaceId) {
  return join(dreamingDir(homeDir, workspaceId), 'runs')
}

function dreamingStatePath(homeDir, workspaceId) {
  return join(dreamingDir(homeDir, workspaceId), 'state.json')
}

function dreamingRunJsonPath(homeDir, workspaceId, runId) {
  assertSafeId(runId)
  return join(dreamingRunsDir(homeDir, workspaceId), `${runId}.json`)
}

function dreamingRunMarkdownPath(homeDir, workspaceId, runId) {
  assertSafeId(runId)
  return join(dreamingRunsDir(homeDir, workspaceId), `${runId}.md`)
}

function parseIso(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function visibleMemorySections(memoryContext) {
  const included = new Set(Array.isArray(memoryContext?.includedBuckets) ? memoryContext.includedBuckets : ['local-only', 'remote-safe'])
  return Array.isArray(memoryContext?.sections)
    ? memoryContext.sections.filter(section => included.has(section.bucket) && !String(section.displayPath ?? '').endsWith('.codesurf/DREAMING.md'))
    : []
}

function renderMemorySections(memoryContext) {
  const sections = visibleMemorySections(memoryContext)
  if (sections.length === 0) return ''
  const lines = [
    '## Existing Workspace Instructions',
    'These are the current non-generated instructions and memory layers for this workspace.',
    '',
  ]
  for (const section of sections) {
    lines.push(`### ${String(section.displayPath ?? 'unknown')}`)
    lines.push(String(section.content ?? '').trim())
    lines.push('')
  }
  return truncateText(lines.join('\n').trim(), MAX_MEMORY_CHARS)
}

function summarizeSessionMessages(messages) {
  const relevant = Array.isArray(messages)
    ? messages.filter(message => ['user', 'assistant', 'system'].includes(String(message?.role ?? '')))
    : []
  const slice = relevant.slice(-DEFAULT_MAX_MESSAGES_PER_SESSION)
  if (slice.length === 0) return '(no readable messages)'
  const lines = []
  for (const message of slice) {
    const role = String(message?.role ?? 'assistant').toUpperCase()
    const content = truncateText(message?.content, MAX_MESSAGE_CHARS)
    if (!content) continue
    lines.push(`${role}: ${content}`)
  }
  const joined = lines.join('\n\n').trim()
  return joined ? truncateText(joined, MAX_SESSION_BLOCK_CHARS) : '(no readable messages)'
}

function eligibleEntries(entries) {
  return Array.isArray(entries)
    ? entries.filter(entry => typeof entry?.id === 'string' && entry.canOpenInChat !== false && entry.isArchived !== true)
    : []
}

function reviewCutoff(state) {
  return Math.max(parseIso(state?.lastReviewedAt), parseIso(state?.lastSuccessfulCompletedAt))
}

function selectFreshEntries(entries, state) {
  const normalized = eligibleEntries(entries)
  const cutoff = reviewCutoff(state)
  if (cutoff <= 0) return normalized
  return normalized.filter(entry => Number(entry?.updatedAt ?? 0) > cutoff)
}

function selectEntries(entries, state, maxSessions) {
  const safeMax = Math.max(1, Math.min(12, Number(maxSessions) || DEFAULT_MAX_SESSIONS))
  const fresh = selectFreshEntries(entries, state)
  if (fresh.length > 0) return fresh.slice(0, safeMax)
  return eligibleEntries(entries).slice(0, safeMax)
}

function buildSummary(text) {
  const lines = normalizeText(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('#'))
  if (lines.length === 0) return null
  return truncateText(lines[0], 200)
}

function makeRunRecord(base) {
  return {
    id: base.id,
    workspaceId: base.workspaceId,
    workspaceName: base.workspaceName,
    workspaceDir: base.workspaceDir,
    provider: base.provider,
    model: base.model,
    status: base.status,
    requestedAt: base.requestedAt,
    startedAt: base.startedAt,
    completedAt: base.completedAt ?? null,
    sessionsReviewed: Number(base.sessionsReviewed ?? 0),
    reviewedSessionIds: Array.isArray(base.reviewedSessionIds) ? base.reviewedSessionIds : [],
    latestSessionUpdatedAt: base.latestSessionUpdatedAt ?? null,
    outputPath: base.outputPath ?? null,
    artifactPath: base.artifactPath ?? null,
    summary: base.summary ?? null,
    promptPreview: base.promptPreview ?? null,
    error: base.error ?? null,
  }
}

async function readDreamState(homeDir, workspaceId) {
  return await readJson(dreamingStatePath(homeDir, workspaceId), {
    workspaceId,
    lastRunId: null,
    lastCompletedAt: null,
    lastSuccessfulRunId: null,
    lastSuccessfulCompletedAt: null,
    lastReviewedAt: null,
    latestMemoryPath: null,
  })
}

async function writeDreamState(homeDir, workspaceId, state) {
  await writeJsonAtomic(dreamingStatePath(homeDir, workspaceId), {
    workspaceId,
    lastRunId: state.lastRunId ?? null,
    lastCompletedAt: state.lastCompletedAt ?? null,
    lastSuccessfulRunId: state.lastSuccessfulRunId ?? null,
    lastSuccessfulCompletedAt: state.lastSuccessfulCompletedAt ?? null,
    lastReviewedAt: state.lastReviewedAt ?? null,
    latestMemoryPath: state.latestMemoryPath ?? null,
  })
}

async function listDreamRunsFromDisk(homeDir, workspaceId, limit = 20) {
  const dirPath = dreamingRunsDir(homeDir, workspaceId)
  if (!existsSync(dirPath)) return []
  const entries = await fs.readdir(dirPath)
  const records = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const payload = await readJson(join(dirPath, entry), null)
    if (!payload || typeof payload.id !== 'string') continue
    records.push(makeRunRecord(payload))
  }
  return records
    .sort((a, b) => parseIso(b.requestedAt) - parseIso(a.requestedAt))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
}

function buildDreamUserPrompt({ workspaceName, workspaceDir, existingMemory, existingDream, sessionBundles }) {
  const lines = [
    `Workspace: ${workspaceName || workspaceDir}`,
    `Primary path: ${workspaceDir}`,
    '',
    'Update the generated workspace memory file for CodeSurf.',
    'Return ONLY the full replacement contents for `.codesurf/DREAMING.md` as markdown.',
    '',
    'Requirements:',
    '- Be concrete and grounded only in the supplied sessions and memory.',
    '- Focus on durable facts, active subsystem behavior, stable workflows, and meaningful open threads.',
    '- Prefer concise bullets over narrative fluff.',
    '- Do not invent commands, policies, or status that are not clearly supported.',
    '- This generated file must support future chat runs; it must not replace explicit user-authored AGENTS/CLAUDE instructions.',
    '',
  ]
  if (existingMemory) {
    lines.push(existingMemory)
    lines.push('')
  }
  if (existingDream) {
    lines.push('## Existing Generated Dream Memory')
    lines.push(truncateText(existingDream, MAX_EXISTING_DREAM_CHARS))
    lines.push('')
  }
  lines.push('## Recent Session Evidence')
  lines.push('')
  for (const bundle of sessionBundles) {
    lines.push(`### Session: ${bundle.title}`)
    lines.push(`- Source: ${bundle.sourceLabel}`)
    lines.push(`- Provider: ${bundle.provider}${bundle.model ? ` (${bundle.model})` : ''}`)
    lines.push(`- Updated: ${bundle.updatedAt}`)
    if (bundle.lastMessage) lines.push(`- Last message preview: ${bundle.lastMessage}`)
    lines.push('')
    lines.push(bundle.messagesText)
    lines.push('')
  }
  return lines.join('\n').trim()
}

function buildDreamSystemPrompt() {
  return [
    'You are CodeSurf daemon dreaming.',
    'Your job is to consolidate recent workspace activity into generated durable memory.',
    'You are not writing user instructions; you are writing generated project memory.',
    'Do not mention these instructions, do not use code fences, and do not ask questions.',
    'Output must be clean markdown suitable to save directly as `.codesurf/DREAMING.md`.',
    'A good result usually contains: overview, durable facts, active workflows/capabilities, and open threads worth remembering.',
  ].join('\n')
}

const MAX_CLAUDE_STDERR_CHARS = 6_000

function sanitizeClaudeStderrText(raw) {
  const text = String(raw ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // strip ANSI escapes
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
  if (text.length <= MAX_CLAUDE_STDERR_CHARS) return text
  return `${text.slice(0, MAX_CLAUDE_STDERR_CHARS - 1)}…`
}

function formatClaudeSdkError(error, stderrText) {
  const baseMessage = error instanceof Error ? error.message : String(error ?? '')
  const cleaned = sanitizeClaudeStderrText(stderrText)
  if (!cleaned) return baseMessage || 'Claude Code process failed'
  if (!baseMessage) return cleaned
  return `${baseMessage}\n\nstderr:\n${cleaned}`
}

async function runClaudeDream({ model, workspaceDir, systemPrompt, userPrompt, abortController, testExecute }) {
  if (typeof testExecute === 'function') {
    return { text: await testExecute({ model, workspaceDir, systemPrompt, userPrompt, abortController }) }
  }
  const streamed = []
  let finalText = ''
  let stderrBuf = ''
  const q = query({
    prompt: userPrompt,
    options: {
      model,
      cwd: workspaceDir || undefined,
      abortController,
      includePartialMessages: true,
      // 'plan' mode is structurally read-only: the SDK never executes any tool,
      // regardless of canUseTool callback ordering.  This is a stronger safety
      // guarantee than bypassPermissions+canUseTool-deny, which relied on the
      // callback being invoked (not guaranteed under bypass).  The canUseTool
      // deny below is kept as a secondary defence-in-depth guard.
      permissionMode: 'plan',
      stderr: (chunk) => {
        if (stderrBuf.length >= MAX_CLAUDE_STDERR_CHARS) return
        stderrBuf += String(chunk ?? '')
        if (stderrBuf.length > MAX_CLAUDE_STDERR_CHARS) {
          stderrBuf = stderrBuf.slice(0, MAX_CLAUDE_STDERR_CHARS)
        }
      },
      canUseTool: async (_toolName, _input, toolOptions) => ({
        behavior: 'deny',
        message: 'CodeSurf daemon dreaming is read-only and may not use tools.',
        toolUseID: toolOptions?.toolUseID,
      }),
      thinking: { type: 'enabled', budget_tokens: 4096 },
      agent: 'codesurf-dreaming',
      agents: {
        'codesurf-dreaming': {
          description: 'CodeSurf daemon dreaming memory consolidator',
          prompt: systemPrompt,
        },
      },
    },
  })
  try {
    for await (const msg of q) {
      if (msg?.type === 'stream_event') {
        const evt = msg.event
        if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
          streamed.push(evt.delta.text)
        }
      } else if (msg?.type === 'result' && typeof msg.result === 'string') {
        finalText = msg.result
      }
    }
  } catch (error) {
    throw new Error(formatClaudeSdkError(error, stderrBuf))
  }
  return { text: normalizeText(finalText) || normalizeText(streamed.join('')) }
}

async function buildDreamInputs({ homeDir, workspaceId, workspaceDir, projectPaths, state, maxSessions, listSessions, getSessionState, loadMemoryContext }) {
  const entries = await listSessions({
    workspaceId,
    workspaceDir,
    projectPaths,
    force: true,
  })
  const selectedEntries = selectEntries(entries, state, maxSessions)
  const sessionBundles = []
  let latestSessionUpdatedAt = null
  for (const entry of selectedEntries) {
    const chatState = await getSessionState({
      workspaceId,
      workspaceDir,
      projectPaths,
      sessionEntryId: entry.id,
    })
    if (!chatState || !Array.isArray(chatState.messages) || chatState.messages.length === 0) continue
    const updatedAt = Number(entry?.updatedAt ?? 0)
    if (!latestSessionUpdatedAt || updatedAt > latestSessionUpdatedAt) latestSessionUpdatedAt = updatedAt
    sessionBundles.push({
      id: entry.id,
      title: String(entry?.title ?? entry?.sessionId ?? entry?.id ?? 'Session').trim() || 'Session',
      sourceLabel: String(entry?.sourceLabel ?? entry?.source ?? 'Session').trim() || 'Session',
      provider: String(chatState?.provider ?? entry?.provider ?? 'claude').trim() || 'claude',
      model: String(chatState?.model ?? entry?.model ?? '').trim(),
      updatedAt: updatedAt > 0 ? new Date(updatedAt).toISOString() : '',
      lastMessage: truncateText(entry?.lastMessage, 200),
      messagesText: summarizeSessionMessages(chatState.messages),
    })
  }
  const memoryContext = await loadMemoryContext({
    homeDir,
    workspaceDir,
    projectPaths,
    executionTarget: 'local',
  })
  const existingMemory = renderMemorySections(memoryContext)
  const existingDream = truncateText(await readTextIfExists(workspaceDreamFilePath(workspaceDir)), MAX_EXISTING_DREAM_CHARS)
  return {
    existingMemory,
    existingDream,
    sessionBundles,
    latestSessionUpdatedAt: latestSessionUpdatedAt ? new Date(latestSessionUpdatedAt).toISOString() : null,
    freshSessionCount: selectFreshEntries(entries, state).length,
  }
}

function parseBooleanEnv(value, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function parseNumberEnv(value, fallback, { allowZero = false, min = 0 } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  if (allowZero && parsed === 0) return 0
  if (parsed < min) return fallback
  return Math.floor(parsed)
}

function buildAutoConfig(overrides = null) {
  const envEnabled = parseBooleanEnv(process.env.CODESURF_AUTO_DREAM_ENABLED, true)
  const envMinSessions = parseNumberEnv(process.env.CODESURF_AUTO_DREAM_MIN_SESSIONS, DEFAULT_AUTO_MIN_SESSIONS, { min: 1 })
  const envMinIntervalMs = parseNumberEnv(process.env.CODESURF_AUTO_DREAM_MIN_INTERVAL_MS, DEFAULT_AUTO_MIN_INTERVAL_MS, { allowZero: true, min: 0 })
  const envDebounceMs = parseNumberEnv(process.env.CODESURF_AUTO_DREAM_DEBOUNCE_MS, DEFAULT_AUTO_DEBOUNCE_MS, { allowZero: true, min: 0 })
  const envSweepMs = parseNumberEnv(process.env.CODESURF_AUTO_DREAM_SWEEP_MS, DEFAULT_AUTO_SWEEP_MS, { allowZero: true, min: 0 })
  return {
    enabled: typeof overrides?.enabled === 'boolean' ? overrides.enabled : envEnabled,
    minSessions: Math.max(1, Number(overrides?.minSessions ?? envMinSessions) || envMinSessions),
    minIntervalMs: Math.max(0, Number(overrides?.minIntervalMs ?? envMinIntervalMs) || 0),
    debounceMs: Math.max(0, Number(overrides?.debounceMs ?? envDebounceMs) || 0),
    sweepMs: Math.max(0, Number(overrides?.sweepMs ?? envSweepMs) || 0),
  }
}

export function createDreamingManager(options) {
  const homeDir = String(options?.homeDir ?? '').trim()
  if (!homeDir) throw new Error('createDreamingManager requires homeDir')
  if (typeof options?.listSessions !== 'function') throw new Error('createDreamingManager requires listSessions')
  if (typeof options?.getSessionState !== 'function') throw new Error('createDreamingManager requires getSessionState')
  if (typeof options?.loadMemoryContext !== 'function') throw new Error('createDreamingManager requires loadMemoryContext')

  const activeRuns = new Map()
  const autoTimers = new Map()
  const testExecute = typeof options?.testExecute === 'function' ? options.testExecute : null
  const getAutoDreamConfig = typeof options?.getAutoDreamConfig === 'function'
    ? options.getAutoDreamConfig
    : () => options?.autoDream
  let sweepTimer = null
  let sweepIntervalMs = null

  async function resolveAutoConfig() {
    try {
      return buildAutoConfig(await getAutoDreamConfig())
    } catch {
      return buildAutoConfig(options?.autoDream)
    }
  }

  async function persistRun(workspaceId, run) {
    await ensureDir(dreamingRunsDir(homeDir, workspaceId))
    await writeJsonAtomic(dreamingRunJsonPath(homeDir, workspaceId, run.id), makeRunRecord(run))
  }

  // Threshold beyond which a disk run still marked `running` is treated as orphaned
  // from a daemon restart / crash and flipped to `failed`.
  const ORPHAN_RUN_THRESHOLD_MS = 10 * 60 * 1000

  async function reconcileOrphanRuns(workspaceId) {
    // Only reconcile if we have no live in-memory run for this workspace.
    if (activeRuns.has(workspaceId)) return
    const runs = await listDreamRunsFromDisk(homeDir, workspaceId, 5)
    const now = Date.now()
    for (const record of runs) {
      if (record.status !== 'running') continue
      const startedMs = parseIso(record.startedAt ?? record.requestedAt)
      if (!Number.isFinite(startedMs)) continue
      if (now - startedMs < ORPHAN_RUN_THRESHOLD_MS) continue
      const reconciledAt = new Date().toISOString()
      const patched = {
        ...record,
        status: 'failed',
        completedAt: reconciledAt,
        error: record.error || 'Daemon restart orphaned this run',
      }
      await writeJsonAtomic(dreamingRunJsonPath(homeDir, workspaceId, record.id), makeRunRecord(patched))
      const state = await readDreamState(homeDir, workspaceId)
      // Only advance lastRunId pointers if this orphan was actually the newest.
      if (!state.lastRunId || state.lastRunId === record.id || parseIso(state.lastCompletedAt) < startedMs) {
        await writeDreamState(homeDir, workspaceId, {
          ...state,
          lastRunId: patched.id,
          lastCompletedAt: patched.completedAt,
        })
      }
    }
  }

  async function latestRun(workspaceId) {
    const active = activeRuns.get(workspaceId)
    if (active) return makeRunRecord(active.metadata)
    await reconcileOrphanRuns(workspaceId).catch((err) => {
      console.error(`[dreaming] reconcileOrphanRuns failed for ${workspaceId}:`, err)
    })
    const runs = await listDreamRunsFromDisk(homeDir, workspaceId, 1)
    return runs[0] ?? null
  }

  async function runDream(args) {
    const workspaceId = String(args?.workspaceId ?? '').trim()
    const workspaceDir = String(args?.workspaceDir ?? '').trim()
    if (!workspaceId) throw new Error('workspaceId is required')
    if (!workspaceDir) throw new Error('workspaceDir is required')
    assertSafeId(workspaceId)

    const existing = activeRuns.get(workspaceId)
    if (existing) {
      return {
        started: false,
        run: makeRunRecord(existing.metadata),
      }
    }

    const provider = String(args?.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER
    const model = String(args?.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL
    if (provider !== 'claude') {
      throw new Error(`Dreaming currently supports only Claude. Requested: ${provider}`)
    }

    const requestedAt = new Date().toISOString()
    const run = {
      id: randomUUID(),
      workspaceId,
      workspaceName: String(args?.workspaceName ?? '').trim() || null,
      workspaceDir,
      provider,
      model,
      status: 'running',
      requestedAt,
      startedAt: requestedAt,
      completedAt: null,
      sessionsReviewed: 0,
      reviewedSessionIds: [],
      latestSessionUpdatedAt: null,
      outputPath: workspaceDreamFilePath(workspaceDir),
      artifactPath: dreamingRunMarkdownPath(homeDir, workspaceId, randomUUID()),
      summary: null,
      promptPreview: null,
      error: null,
    }
    run.artifactPath = dreamingRunMarkdownPath(homeDir, workspaceId, run.id)
    const abortController = new AbortController()
    const active = { metadata: run, abortController }
    activeRuns.set(workspaceId, active)
    await persistRun(workspaceId, run)

    void (async () => {
      try {
        const state = await readDreamState(homeDir, workspaceId)
        const projectPaths = Array.isArray(args?.projectPaths) && args.projectPaths.length > 0 ? args.projectPaths : [workspaceDir]
        const inputs = await buildDreamInputs({
          homeDir,
          workspaceId,
          workspaceDir,
          projectPaths,
          state,
          maxSessions: args?.maxSessions,
          listSessions: options.listSessions,
          getSessionState: options.getSessionState,
          loadMemoryContext: options.loadMemoryContext,
        })
        if (inputs.sessionBundles.length === 0) {
          throw new Error('No readable sessions were available for dreaming')
        }
        run.sessionsReviewed = inputs.sessionBundles.length
        run.reviewedSessionIds = inputs.sessionBundles.map(bundle => bundle.id)
        run.latestSessionUpdatedAt = inputs.latestSessionUpdatedAt
        const systemPrompt = buildDreamSystemPrompt()
        const userPrompt = buildDreamUserPrompt({
          workspaceName: run.workspaceName,
          workspaceDir,
          existingMemory: inputs.existingMemory,
          existingDream: inputs.existingDream,
          sessionBundles: inputs.sessionBundles,
        })
        run.promptPreview = truncateText(userPrompt, 600)
        await persistRun(workspaceId, run)

        const result = await runClaudeDream({
          model,
          workspaceDir,
          systemPrompt,
          userPrompt,
          abortController,
          testExecute,
        })
        if (abortController.signal.aborted) {
          throw new Error('Dreaming cancelled')
        }
        const markdown = sanitizeDreamMarkdown(result.text)
        await writeTextAtomic(run.outputPath, markdown)
        await writeTextAtomic(run.artifactPath, markdown)

        run.status = 'completed'
        run.completedAt = new Date().toISOString()
        run.summary = buildSummary(markdown)
        run.error = null
        await persistRun(workspaceId, run)

        await writeDreamState(homeDir, workspaceId, {
          ...state,
          lastRunId: run.id,
          lastCompletedAt: run.completedAt,
          lastSuccessfulRunId: run.id,
          lastSuccessfulCompletedAt: run.completedAt,
          lastReviewedAt: run.latestSessionUpdatedAt ?? run.completedAt,
          latestMemoryPath: run.outputPath,
        })
      } catch (error) {
        run.status = abortController.signal.aborted ? 'cancelled' : 'failed'
        run.completedAt = new Date().toISOString()
        run.error = error instanceof Error ? error.message : String(error)
        await persistRun(workspaceId, run)
        const state = await readDreamState(homeDir, workspaceId)
        await writeDreamState(homeDir, workspaceId, {
          ...state,
          lastRunId: run.id,
          lastCompletedAt: run.completedAt,
        })
      } finally {
        activeRuns.delete(workspaceId)
      }
    })()

    return {
      started: true,
      run: makeRunRecord(run),
    }
  }

  async function evaluateAutoDream(args) {
    const workspaceId = String(args?.workspaceId ?? '').trim()
    const workspaceDir = String(args?.workspaceDir ?? '').trim()
    if (!workspaceId || !workspaceDir) {
      return { started: false, reason: 'workspace-required' }
    }
    assertSafeId(workspaceId)
    const autoConfig = await resolveAutoConfig()
    if (!autoConfig.enabled) {
      return { started: false, reason: 'disabled' }
    }
    if (activeRuns.has(workspaceId)) {
      return { started: false, reason: 'active-run' }
    }

    const state = await readDreamState(homeDir, workspaceId)
    const now = Date.now()
    const lastSuccessfulCompletedAt = parseIso(state.lastSuccessfulCompletedAt)
    if (lastSuccessfulCompletedAt > 0 && (now - lastSuccessfulCompletedAt) < autoConfig.minIntervalMs) {
      return {
        started: false,
        reason: 'cooldown',
        remainingMs: autoConfig.minIntervalMs - (now - lastSuccessfulCompletedAt),
      }
    }

    const projectPaths = Array.isArray(args?.projectPaths) && args.projectPaths.length > 0 ? args.projectPaths : [workspaceDir]
    const entries = await options.listSessions({
      workspaceId,
      workspaceDir,
      projectPaths,
      force: true,
    })
    const freshEntries = selectFreshEntries(entries, state)
    if (freshEntries.length < autoConfig.minSessions) {
      return {
        started: false,
        reason: 'threshold',
        freshSessions: freshEntries.length,
      }
    }

    return await runDream({
      ...args,
      projectPaths,
      maxSessions: Math.max(Number(args?.maxSessions ?? DEFAULT_MAX_SESSIONS) || DEFAULT_MAX_SESSIONS, freshEntries.length),
    })
  }

  async function scheduleAutoDreamEvaluation(args) {
    const workspaceId = String(args?.workspaceId ?? '').trim()
    if (!workspaceId) return { scheduled: false, reason: 'workspace-required' }
    assertSafeId(workspaceId)
    const autoConfig = await resolveAutoConfig()
    if (!autoConfig.enabled) return { scheduled: false, reason: 'disabled' }
    const existing = autoTimers.get(workspaceId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      autoTimers.delete(workspaceId)
      void evaluateAutoDream(args).catch((err) => {
        console.error('[dreaming] auto-dream evaluation failed:', err)
      })
    }, autoConfig.debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
    autoTimers.set(workspaceId, timer)
    return {
      scheduled: true,
      workspaceId,
      delayMs: autoConfig.debounceMs,
    }
  }

  async function getDreamStatus(workspaceId) {
    assertSafeId(workspaceId)
    const state = await readDreamState(homeDir, workspaceId)
    const active = activeRuns.get(workspaceId)
    const lastRun = active ? makeRunRecord(active.metadata) : await latestRun(workspaceId)
    const autoConfig = await resolveAutoConfig()
    return {
      workspaceId,
      running: Boolean(active),
      activeRun: active ? makeRunRecord(active.metadata) : null,
      lastRun,
      state,
      auto: {
        ...autoConfig,
        pending: autoTimers.has(workspaceId),
      },
    }
  }

  async function listDreamRuns(workspaceId, limit = 20) {
    assertSafeId(workspaceId)
    return await listDreamRunsFromDisk(homeDir, workspaceId, limit)
  }

  async function cancelDream(workspaceId, runId = null) {
    assertSafeId(workspaceId)
    const active = activeRuns.get(workspaceId)
    if (!active) return { ok: false, error: 'No active dream run' }
    if (runId && active.metadata.id !== runId) return { ok: false, error: 'Requested run is not active' }
    active.abortController.abort()
    return { ok: true }
  }

  async function runAutoSweepOnce() {
    if (typeof options?.listWorkspaces !== 'function') return
    const workspaces = await options.listWorkspaces().catch(() => [])
    for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
      const workspaceId = String(workspace?.workspaceId ?? workspace?.id ?? '').trim()
      const workspaceDir = String(workspace?.workspaceDir ?? workspace?.path ?? '').trim()
      if (!workspaceId || !workspaceDir) continue
      await scheduleAutoDreamEvaluation({
        workspaceId,
        workspaceName: String(workspace?.workspaceName ?? workspace?.name ?? '').trim() || null,
        workspaceDir,
        projectPaths: Array.isArray(workspace?.projectPaths) ? workspace.projectPaths : [workspaceDir],
      }).catch((err) => {
        console.error(`[dreaming] auto-dream scheduling failed for ${workspaceId}:`, err)
      })
    }
  }

  async function refreshAutoDreamSweep() {
    const autoConfig = await resolveAutoConfig()
    if (!autoConfig.enabled || typeof options?.listWorkspaces !== 'function' || autoConfig.sweepMs <= 0) {
      if (sweepTimer) clearInterval(sweepTimer)
      sweepTimer = null
      sweepIntervalMs = null
      return { enabled: autoConfig.enabled, sweepMs: autoConfig.sweepMs, running: false }
    }
    if (sweepTimer && sweepIntervalMs === autoConfig.sweepMs) {
      return { enabled: true, sweepMs: autoConfig.sweepMs, running: true }
    }
    if (sweepTimer) clearInterval(sweepTimer)
    sweepIntervalMs = autoConfig.sweepMs
    sweepTimer = setInterval(() => {
      void runAutoSweepOnce().catch((err) => {
        console.error('[dreaming] auto-sweep failed:', err)
      })
    }, autoConfig.sweepMs)
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
    return { enabled: true, sweepMs: autoConfig.sweepMs, running: true }
  }

  void refreshAutoDreamSweep().catch(() => {})

  return {
    runDream,
    evaluateAutoDream,
    scheduleAutoDreamEvaluation,
    refreshAutoDreamSweep,
    getDreamStatus,
    listDreamRuns,
    cancelDream,
  }
}

export const DREAMING_DEFAULTS = {
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
}
