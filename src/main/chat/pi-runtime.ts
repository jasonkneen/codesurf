/**
 * Pi runtime — in-process embed of the user's INSTALLED pi coding-agent runtime
 * (@mariozechner/pi-coding-agent). We never bundle or ship a copy: the package is
 * resolved at runtime from wherever it already lives on the machine (see
 * resolveCsagentEntry) and loaded lazily via dynamic import so non-users pay zero
 * boot cost (mirroring chat.ts:getOpencodeClient). Auth + models are reused from
 * the user's own ~/.pi/agent (auth.json, models.json) via AuthStorage/ModelRegistry.
 *
 * NOTE on the in-process choice: pi ships no stdout CLI and has no `pi` binary on
 * this machine (only transitive npm copies), so an ACP/subprocess integration has
 * nothing to spawn — embedding the SDK in-process is the only viable path. It is
 * surfaced to the rest of the app under the internal provider id `csagent`
 * (UI label "Pi"). Pi is a third-party name and intentionally shown as-is.
 *
 * Responsibilities (PR1 core path):
 *  - lazy-load the runtime + AuthStorage/ModelRegistry singletons
 *  - open/resume a SessionManager session under ~/.codesurf/agent-sessions
 *  - createAgentSession, subscribe, translate AgentSessionEvent -> agent:stream
 *  - MANDATORY streaming mitigation: suffix-delta extraction (emit only the new
 *    tail per content block, never the full snapshot) + microtask-coalesced
 *    batched flush.
 *  - lifecycle helpers: stop / steer / dispose / resume, keyed by cardId in
 *    DEDICATED maps (never the shared claude/codex sessionIds map).
 *
 * Self-contained typing: the heavy runtime types come from the dynamic import at
 * runtime, so this file uses local minimal interface shims for the session/event
 * shapes it drives. That keeps the module typecheck-clean WITHOUT a static import
 * of the dep (which would pull its transitive types eagerly).
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import { CODESURF_HOME } from '../paths'
import { buildCsagentImages } from './provider-image-attachments.ts'
export { buildCsagentImages } from './provider-image-attachments.ts'
import {
  awaitGuardedPreparation,
  csagentPrelaunchBoundary,
  providerLaunchIsCurrent,
  type ProviderLaunchGuard,
} from './provider-launch-guard.ts'
import {
  chatStreamScopeKey,
  createChatStreamScope,
  type ChatStreamScope,
} from './room-stream-scope.ts'
import {
  bindStableContextSession,
  clearStableSessionContext,
  invalidateStableContextSelection,
  selectStableContextForTurn,
} from './stable-session-context.ts'
import {
  createPiTranslateState,
  translatePiAgentEvent,
} from './pi-stream-translate.ts'
import {
  catalogUsablePiModels,
  collectPiProviderProbe,
  formatPiCatalogError,
  parsePiModelRef,
  planPiLaunchModel,
  type PiModelOption,
  type PiProviderProbeResult,
  type PiProviderProbeSample,
} from './pi-model-availability.ts'

/** Internal provider id (neutral). Never surface 'pi'/'earendil' to users. */
export const CSAGENT_PROVIDER_ID = 'csagent' as const

/** PI session JSONL store — under ~/.codesurf, NOT ~/.pi. */
const CSAGENT_SESSION_DIR = join(CODESURF_HOME, 'agent-sessions')

// ── Emit + request shapes (host-owned; kept minimal to avoid coupling) ──────

/** Normalized agent:stream event payload (the host injects cardId). */
type StreamEvent = Record<string, unknown>

/** Emit a single normalized event for a card (host fans out to windows). */
export type EmitFn = (event: StreamEvent) => void

interface CsagentImageAttachment {
  path: string
  mediaType: string
  displayPath: string
  byteCount: number
  device: string
  inode: string
  mtimeMs: number
  ctimeMs: number
  ownedTemporary?: boolean
}

/** The subset of the chat request this runtime consumes. */
export interface CsagentRunRequest {
  cardId: string
  workspaceId?: string
  model: string
  workspaceDir?: string
  sessionId?: string | null
  thinking?: string
  /** Last user text to send. If omitted, derived by the caller. */
  prompt: string
  contextPrompt?: string
  imageAttachments?: CsagentImageAttachment[]
}

// ── Local minimal runtime shims (resolved at runtime via dynamic import) ─────
// These describe ONLY the surface this file drives. The real shapes come from
// the user's installed @mariozechner/pi-coding-agent at runtime; we intentionally
// avoid a static import so the heavy dep is never loaded at boot, its transitive
// types are never pulled eagerly, and the bundler never tries to resolve a package
// that lives outside this app's node_modules.

/** PI image content: { type:'image'; data: <base64>; mimeType } */
interface PiImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/** Discriminated assistant-message delta union (per-token streaming, if enabled). */
interface PiAssistantMessageEvent {
  type: string
  delta?: string
  contentIndex?: number
}

/** A content block on a pi message: text / thinking / tool_call. */
interface PiContentBlock {
  type: string
  text?: string
  thinking?: string
  // tool_call blocks
  id?: string
  name?: string
  arguments?: unknown
  input?: unknown
}

/** A pi message (user or assistant) as carried by message_start / message_end. */
interface PiMessage {
  role: string
  content?: PiContentBlock[]
  stopReason?: string
  errorMessage?: string
}

/** A tool result as carried by turn_end.toolResults. */
interface PiToolResult {
  toolCallId?: string
  toolName?: string
  result?: unknown
  output?: unknown
  isError?: boolean
}

/** AgentSessionEvent (the subscribe channel) — only members we translate. */
interface PiAgentSessionEvent {
  type: string
  // message_update (only fires when the build streams per-token)
  assistantMessageEvent?: PiAssistantMessageEvent
  // message_start / message_end carry the (possibly partial/full) message
  message?: PiMessage
  // turn_end
  toolResults?: PiToolResult[]
  // tool_execution_*
  toolCallId?: string
  toolName?: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
}

interface PiSessionStats {
  sessionId: string
  cost: number
  assistantMessages: number
}

interface PiAgentSession {
  readonly sessionId: string
  subscribe(listener: (e: PiAgentSessionEvent) => void): () => void
  prompt(text: string, options?: { images?: PiImageContent[]; source?: string }): Promise<void>
  steer(text: string, images?: PiImageContent[]): Promise<void>
  abort(): Promise<void>
  clearQueue(): { steering: string[]; followUp: string[] }
  dispose(): void
  setThinkingLevel(level: string): void
  getSessionStats(): PiSessionStats
}

interface PiSessionManager {
  getSessionFile(): string | undefined
}

interface PiResourceLoader {
  reload(): Promise<void>
}

/** A model entry from ModelRegistry.getAvailable() (auth-configured models). */
interface PiModelInfo {
  id: string
  provider: string
  name?: string
  reasoning?: boolean
}

interface PiModelRegistry {
  find(provider: string, id: string): unknown
  getAvailable(): PiModelInfo[]
  getApiKeyForProvider?(provider: string): Promise<string | undefined>
  getError?(): string | undefined
  refresh?(): void
}

interface PiRuntime {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiAgentSession }>
  AuthStorage: { create(authPath?: string): unknown }
  ModelRegistry: { create(authStorage: unknown, modelsJsonPath?: string): PiModelRegistry }
  SessionManager: {
    open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManager
    create(cwd: string, sessionDir?: string): PiSessionManager
  }
  DefaultResourceLoader: new (options: { cwd: string; agentDir: string }) => PiResourceLoader
  getAgentDir(): string
}

// ── Module-level singletons + DEDICATED per-card maps ───────────────────────
let _csagentRuntime: any = null
let _csagentAuth: any = null // AuthStorage singleton (shares ~/.pi/agent/auth.json with the pi CLI — documented coupling)
let _csagentModels: any = null // ModelRegistry singleton

const csagentSessions = new Map<string, PiAgentSession>()
const csagentUnsubs = new Map<string, () => void>()
const csagentSessionIds = new Map<string, string>()

function csagentScope(req: Pick<CsagentRunRequest, 'workspaceId' | 'cardId'>): ChatStreamScope {
  return createChatStreamScope(req.workspaceId, req.cardId)
}

/** Package name of the user's installed pi runtime (never bundled by this app). */
const PI_PKG = '@mariozechner/pi-coding-agent'
/** Cached absolute path to the resolved runtime entry (dist/index.js). */
let _csagentEntry: string | null = null

/** Global module roots to scan for an installed copy of the pi runtime. */
function piModuleRoots(): string[] {
  const home = homedir()
  const roots: string[] = [
    join(home, '.pi', 'npm', 'lib', 'node_modules'),
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    join(home, 'Library', 'pnpm', 'global', '5', 'node_modules'),
  ]
  // Every installed nvm node version's global modules (the active one may vary).
  const nvm = join(home, '.nvm', 'versions', 'node')
  for (const v of safeReaddir(nvm)) roots.push(join(nvm, v, 'lib', 'node_modules'))
  return roots
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Compare two semver-ish strings: a >= b (numeric major.minor.patch only). */
function verGte(a: string, b: string): boolean {
  const t = (v: string): number[] => String(v).split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const x = t(a)
  const y = t(b)
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  }
  return true
}

/**
 * Resolve the user's INSTALLED pi runtime entry (dist/index.js). We never bundle
 * a copy — the package is loaded from wherever it already lives on the machine.
 * Order: explicit override (CODESURF_PI_PATH) → highest version found across known
 * global module roots, scanning BOTH direct installs and transitive (nested) ones
 * (the package commonly ships only as a dependency of other pi-* tools).
 */
function resolveCsagentEntry(): string {
  if (_csagentEntry) return _csagentEntry

  // 1. Explicit override — a package directory OR a direct dist/index.js path.
  const override = process.env.CODESURF_PI_PATH?.trim()
  if (override) {
    const entry = override.endsWith('.js') ? override : join(override, 'dist', 'index.js')
    if (existsSync(entry)) return (_csagentEntry = entry)
  }

  // 2. Scan known roots; collect every install, then keep the highest version.
  const candidates: { entry: string; version: string }[] = []
  const consider = (pkgDir: string): void => {
    const entry = join(pkgDir, 'dist', 'index.js')
    if (!existsSync(entry)) return
    let version = '0.0.0'
    try {
      version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version || '0.0.0'
    } catch {
      /* keep default */
    }
    candidates.push({ entry, version })
  }
  for (const root of piModuleRoots()) {
    consider(join(root, PI_PKG)) // direct: <root>/@mariozechner/pi-coding-agent
    for (const pkg of safeReaddir(root)) {
      if (pkg.startsWith('.')) continue
      if (pkg.startsWith('@')) {
        for (const scoped of safeReaddir(join(root, pkg))) {
          consider(join(root, pkg, scoped, 'node_modules', PI_PKG))
        }
      } else {
        consider(join(root, pkg, 'node_modules', PI_PKG))
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Pi runtime not found. Install it (e.g. \`npm i -g ${PI_PKG}\`) or set ` +
        `CODESURF_PI_PATH to its package directory.`,
    )
  }
  const best = candidates.reduce((a, b) => (verGte(b.version, a.version) ? b : a))
  return (_csagentEntry = best.entry)
}

/**
 * Lazy-load the runtime exactly once from the user's installed copy. ESM-only,
 * Node>=22 (Electron 41 main is 22.x — compatible). Mirrors getOpencodeClient's
 * try/catch-and-degrade pattern.
 */
async function getCsagentRuntime(): Promise<PiRuntime> {
  if (!_csagentRuntime) {
    const entry = resolveCsagentEntry() // throws an actionable error if not installed
    try {
      // Variable specifier (file URL) → the bundler leaves this external, so we
      // load the user's own installed copy at runtime, never a bundled one.
      _csagentRuntime = await import(/* @vite-ignore */ pathToFileURL(entry).href)
    } catch (e) {
      throw new Error(
        `Pi runtime could not be loaded from ${entry} (ESM-only, Node>=22 required). ` +
          (e instanceof Error ? e.message : String(e)),
      )
    }
  }
  return _csagentRuntime as PiRuntime
}

/** codesurf thinking id -> runtime ThinkingLevel (off|minimal|low|medium|high|xhigh). */
function mapThinking(thinking: string | undefined): string {
  switch (thinking) {
    case 'none':
      return 'off'
    case 'adaptive':
      return 'medium'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'max':
      return 'xhigh'
    default:
      return 'medium'
  }
}

function buildCsagentContextPreamble(req: CsagentRunRequest): string | undefined {
  return req.contextPrompt?.trim() || undefined
}

/**
 * Translate the subscribe-channel AgentSessionEvent stream into codesurf's
 * agent:stream event schema, then microtask-coalesce the flush so a token
 * storm cannot storm agent:stream.
 */
function makeTranslator(req: CsagentRunRequest, emit: EmitFn): (e: PiAgentSessionEvent) => void {
  const scopeKey = chatStreamScopeKey(csagentScope(req))
  const pending: StreamEvent[] = []
  let scheduled = false
  let doneEmitted = false
  const state = createPiTranslateState()
  const flush = (): void => {
    scheduled = false
    const batch = pending.splice(0)
    for (const ev of batch) emit(ev)
  }
  const enqueue = (ev: StreamEvent): void => {
    pending.push(ev)
    if (!scheduled) {
      scheduled = true
      queueMicrotask(flush)
    }
  }

  const emitDone = (): void => {
    if (doneEmitted) return
    doneEmitted = true
    const stats = safeStats(scopeKey)
    enqueue({
      type: 'done',
      sessionId: csagentSessionIds.get(scopeKey) ?? stats?.sessionId,
      cost: stats?.cost,
      turns: stats?.assistantMessages,
    })
  }

  return (e: PiAgentSessionEvent): void => {
    for (const ev of translatePiAgentEvent(e, state)) {
      if (ev.type === 'done') emitDone()
      else enqueue(ev)
    }
  }
}

function safeStats(scopeKey: string): PiSessionStats | undefined {
  try {
    return csagentSessions.get(scopeKey)?.getSessionStats()
  } catch {
    return undefined
  }
}

function drainAuthErrorText(auth: { drainErrors?: () => unknown[] } | null | undefined): string {
  try {
    const drained = typeof auth?.drainErrors === 'function' ? auth.drainErrors() : []
    if (!Array.isArray(drained) || drained.length === 0) return ''
    return drained
      .map(error => error instanceof Error ? error.message : String(error))
      .map(message => message.trim())
      .filter(Boolean)
      .join('; ')
  } catch {
    return ''
  }
}

async function probeUsablePiProviders(
  registry: PiModelRegistry,
  auth: { getApiKey?: (provider: string) => Promise<string | undefined>; drainErrors?: () => unknown[] } | null,
  candidates: PiModelInfo[],
): Promise<PiProviderProbeResult> {
  const providers = [...new Set(candidates.map(candidate => candidate.provider).filter(Boolean))]
  const canProbe = typeof registry.getApiKeyForProvider === 'function'
    || typeof auth?.getApiKey === 'function'
  if (!canProbe) {
    return collectPiProviderProbe(providers.map(provider => ({ provider, apiKey: 'unprobed' })))
  }

  const samples: PiProviderProbeSample[] = []
  for (const provider of providers) {
    try {
      const apiKey = typeof registry.getApiKeyForProvider === 'function'
        ? await registry.getApiKeyForProvider(provider)
        : await auth?.getApiKey?.(provider)
      samples.push({
        provider,
        apiKey: apiKey || null,
        error: apiKey ? undefined : (drainAuthErrorText(auth) || `No API key for provider: ${provider}`),
      })
    } catch (error) {
      samples.push({
        provider,
        apiKey: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return collectPiProviderProbe(samples)
}

/**
 * Start (or resume) a CodeSurf Agent turn in-process and stream the reply.
 *
 * The caller passes `emit` with an immutable workspace/card scope captured by
 * the provider invocation,
 * keeping this module decoupled from the host's window-fanout. On any failure to
 * load the runtime or create the session, emits an `{type:'error'}` followed by
 * `{type:'done'}` and returns (mirrors the OpenCode degrade path).
 */
export async function runCodesurfAgent(
  req: CsagentRunRequest,
  emit: EmitFn,
  launchGuard?: ProviderLaunchGuard,
): Promise<void> {
  const scope = csagentScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  // Restore a stored runtime sessionId for resume (the caller persists it via
  // the `session` event; on a fresh turn after restart req.sessionId carries it).
  if (req.sessionId && !csagentSessionIds.has(scopeKey)) {
    csagentSessionIds.set(scopeKey, req.sessionId)
  }

  let rt: PiRuntime
  let stableContext: ReturnType<typeof selectStableContextForTurn> | null = null
  let launchedSession: PiAgentSession | null = null
  const launchIsCurrent = (): boolean => providerLaunchIsCurrent(launchGuard)
  const disposeLaunchedSession = (): void => {
    if (stableContext) invalidateStableContextSelection(stableContext)
    const session = launchedSession
    if (!session) return
    try { session.dispose() } catch { /* already disposed */ }
    if (csagentSessions.get(scopeKey) === session) {
      try { csagentUnsubs.get(scopeKey)?.() } catch { /* already unsubscribed */ }
      csagentUnsubs.delete(scopeKey)
      csagentSessions.delete(scopeKey)
      csagentSessionIds.delete(scopeKey)
    }
    launchedSession = null
  }
  try {
    const preparedRuntime = await awaitGuardedPreparation(launchGuard, getCsagentRuntime())
    if (!preparedRuntime.ok) return
    rt = preparedRuntime.value
  } catch (e) {
    if (!launchIsCurrent()) return
    emit({ type: 'error', error: e instanceof Error ? e.message : String(e) })
    emit({ type: 'done' })
    return
  }

  try {
    // Lazy-init singletons once.
    if (!_csagentAuth) _csagentAuth = rt.AuthStorage.create()
    if (!_csagentModels) _csagentModels = rt.ModelRegistry.create(_csagentAuth)

    const candidates: PiModelInfo[] = _csagentModels.getAvailable?.() ?? []
    const probe = await awaitGuardedPreparation(
      launchGuard,
      probeUsablePiProviders(_csagentModels, _csagentAuth, candidates),
    )
    if (!probe.ok) return
    const usableModels: PiModelOption[] = catalogUsablePiModels(candidates, probe.value.usable)
    const requestedRef = parsePiModelRef(req.model)
    const plan = planPiLaunchModel({
      requested: req.model,
      usableModels,
      requestedProviderError: requestedRef
        ? probe.value.errorByProvider.get(requestedRef.provider)
        : undefined,
    })
    if (!plan.ok) {
      if (!launchIsCurrent()) return
      emit({ type: 'error', error: plan.error })
      emit({ type: 'done' })
      return
    }
    const model = _csagentModels.find(plan.ref.provider, plan.ref.id)
    if (!model) {
      if (!launchIsCurrent()) return
      emit({
        type: 'error',
        error: `Pi cannot use ${plan.ref.provider}/${plan.ref.id}: model is not in the local registry.`,
      })
      emit({ type: 'done' })
      return
    }

    // Open/resume the session JSONL under ~/.codesurf/agent-sessions. The runtime
    // names fresh files `<timestamp>_<sessionId>.jsonl` (create), so resume must
    // locate the existing file by the stored sessionId rather than guessing a path
    // — otherwise SessionManager.open would silently start an empty session and we
    // would lose conversation history on every turn after the first.
    const storedId = csagentSessionIds.get(scopeKey)
    const resumePath = storedId ? findSessionFile(storedId) : undefined
    const sessionManager = resumePath
      ? rt.SessionManager.open(resumePath, CSAGENT_SESSION_DIR, req.workspaceDir)
      : rt.SessionManager.create(req.workspaceDir ?? process.cwd(), CSAGENT_SESSION_DIR)

    // Build + prime the resource loader (extensions/tool-bridge are later PRs).
    const loader = new rt.DefaultResourceLoader({
      cwd: req.workspaceDir ?? process.cwd(),
      agentDir: rt.getAgentDir(),
    })
    const reloaded = await awaitGuardedPreparation(launchGuard, loader.reload())
    if (!reloaded.ok) return

    const created = await awaitGuardedPreparation(
      launchGuard,
      rt.createAgentSession({
        cwd: req.workspaceDir,
        authStorage: _csagentAuth,
        modelRegistry: _csagentModels,
        resourceLoader: loader,
        sessionManager,
        thinkingLevel: mapThinking(req.thinking),
        model,
      }),
      ({ session }) => { try { session.dispose() } catch { /* incomplete session */ } },
    )
    if (!created.ok) return
    const { session } = created.value
    launchedSession = session
    csagentSessions.set(scopeKey, session)

    // Emit the runtime sessionId once so the tile persists it for resume.
    const sid = session.sessionId
    if (sid) {
      csagentSessionIds.set(scopeKey, sid)
      emit({ type: 'session', sessionId: sid })
    }

    // Tap the typed event stream.
    const unsub = session.subscribe(makeTranslator(req, emit))
    csagentUnsubs.set(scopeKey, unsub)

    // First/idle prompt: NO streamingBehavior (only required while streaming).
    const preparedImages = await awaitGuardedPreparation(
      launchGuard,
      buildCsagentImages(req.imageAttachments),
    )
    if (!preparedImages.ok) {
      disposeLaunchedSession()
      return
    }
    const images = preparedImages.value
    stableContext = selectStableContextForTurn({
      scope,
      provider: CSAGENT_PROVIDER_ID,
      sessionId: sid,
      contextPrompt: buildCsagentContextPreamble(req),
    })
    const contextPreamble = stableContext.contextPrompt
    const promptText = contextPreamble
      ? `${contextPreamble}\n\n---\n\n${req.prompt}`
      : req.prompt
    const prompted = await csagentPrelaunchBoundary.run({
      guard: launchGuard,
      prepare: () => ({ session, promptText, images }),
      disposePrepared: () => disposeLaunchedSession(),
      launch: prepared => prepared.session.prompt(prepared.promptText, {
        ...(prepared.images.length > 0 ? { images: prepared.images } : {}),
        source: 'interactive',
      }),
    })
    if (!prompted.ok) {
      disposeLaunchedSession()
      return
    }
    await prompted.value
    if (!launchIsCurrent()) {
      disposeLaunchedSession()
      return
    }
    bindStableContextSession(stableContext, sid)
  } catch (e) {
    if (!launchIsCurrent()) {
      disposeLaunchedSession()
      return
    }
    if (stableContext) invalidateStableContextSelection(stableContext)
    emit({ type: 'error', error: e instanceof Error ? e.message : String(e) })
    emit({ type: 'done' })
  }
}

/**
 * Locate an existing session JSONL by its runtime sessionId (resume). The runtime
 * writes `<timestamp>_<sessionId>.jsonl`, so we match on the embedded id rather
 * than reconstructing the (unknown) timestamp prefix. Returns undefined when no
 * matching file exists, so the caller falls back to creating a fresh session.
 */
function findSessionFile(sessionId: string | undefined): string | undefined {
  if (!sessionId || !sessionId.trim()) return undefined
  try {
    const match = readdirSync(CSAGENT_SESSION_DIR).find(
      f => f.endsWith('.jsonl') && f.includes(sessionId),
    )
    return match ? join(CSAGENT_SESSION_DIR, match) : undefined
  } catch {
    return undefined
  }
}

/**
 * Stop the current turn for a card. The runtime's abort() does NOT clear the
 * queue, so we clearQueue() explicitly, then prune the per-card maps.
 */
export async function stopCsagent(scope: ChatStreamScope): Promise<void> {
  const session = csagentSessions.get(chatStreamScopeKey(scope))
  if (!session) return
  try {
    await session.abort()
  } catch {
    /* already idle */
  }
  try {
    session.clearQueue()
  } catch {
    /* no queue */
  }
}

/** Native mid-turn steering (2nd steerable provider after Claude). */
export async function steerCsagent(scope: ChatStreamScope, text: string): Promise<boolean> {
  const session = csagentSessions.get(chatStreamScopeKey(scope))
  if (!session) return false
  await session.steer(text)
  return true
}

/**
 * Dispose a card's runtime state: drop the subscribe listener, dispose the live
 * session, and delete the cardId key from ALL THREE dedicated maps.
 */
export function disposeCsagent(scope: ChatStreamScope): void {
  const scopeKey = chatStreamScopeKey(scope)
  try {
    csagentUnsubs.get(scopeKey)?.()
  } catch {
    /* listener already gone */
  }
  try {
    csagentSessions.get(scopeKey)?.dispose()
  } catch {
    /* already disposed */
  }
  csagentUnsubs.delete(scopeKey)
  csagentSessions.delete(scopeKey)
  csagentSessionIds.delete(scopeKey)
  clearStableSessionContext(scope, CSAGENT_PROVIDER_ID)
}

/**
 * Clear a card's session bookkeeping WITHOUT disposing a live session (mirrors
 * chat:clearSession — same tile, fresh conversation).
 */
export function clearCsagentSession(scope: ChatStreamScope): void {
  const scopeKey = chatStreamScopeKey(scope)
  csagentUnsubs.delete(scopeKey)
  csagentSessions.delete(scopeKey)
  csagentSessionIds.delete(scopeKey)
  clearStableSessionContext(scope, CSAGENT_PROVIDER_ID)
}

/** True if a live CodeSurf Agent session exists for the card (for dispatch). */
export function hasCsagentSession(scope: ChatStreamScope): boolean {
  return csagentSessions.has(chatStreamScopeKey(scope))
}

export interface CsagentModelsResult {
  models: Array<{ id: string; label: string; description?: string }>
  error?: string
}

/**
 * List models the installed Pi runtime can actually call. `getAvailable()` only
 * checks that credentials exist; this also probes `getApiKey` so expired OAuth
 * does not show up as a selectable model. Failures are returned as `error`
 * instead of being swallowed into the static default list.
 */
export async function listCsagentModels(): Promise<CsagentModelsResult> {
  try {
    const rt = await getCsagentRuntime()
    if (!_csagentAuth) _csagentAuth = rt.AuthStorage.create()
    if (!_csagentModels) _csagentModels = rt.ModelRegistry.create(_csagentAuth)
    try { _csagentModels.refresh?.() } catch { /* keep previously loaded models */ }
    const candidates: PiModelInfo[] = _csagentModels.getAvailable?.() ?? []
    const probe = await probeUsablePiProviders(_csagentModels, _csagentAuth, candidates)
    const models = catalogUsablePiModels(candidates, probe.usable)
    const error = formatPiCatalogError({
      models,
      probeErrors: probe.errors,
      runtimeError: models.length === 0 ? _csagentModels.getError?.() : undefined,
    })
    return error ? { models, error } : { models }
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
