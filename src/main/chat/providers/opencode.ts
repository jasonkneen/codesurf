/**
 * OpenCode provider — uses @opencode-ai/sdk against a local `opencode serve` process.
 */

import { spawn, execFileSync } from 'child_process'
import * as net from 'net'
import { buildOpenCodeSessionPermissions } from '../../agents/opencode-permissions'
import { getAgentPath, getShellEnvPath } from '../../agent-paths'
import { buildSafeSpawnEnv } from '../../ipc/terminal-helpers'
import { broadcastToRenderer } from '../../utils/broadcast'
import { errorMessage } from '../../../shared/errors.ts'
import { type ToolPermissionRequest } from '../../permissions'
import { resolveInlineToolPermission } from '../permission-flow'
import { buildPeerAwareTurnPrompt } from '../prompt-builders'
import {
  bindStableContextSession,
  clearStableSessionContext,
  invalidateStableContextSelection,
  selectStableContextForTurn,
} from '../stable-session-context'
import type { ChatRequest } from '../types'
import {
  chatRequestScope,
  chatStreamScopeKey,
  log,
  sendStream,
  getPreparedMessages,
  markRoomPromptAccepted,
  processTreeSpawnOptions,
  terminateProcessTree,
  type ChatStreamScope,
} from '../runtime'
import { createAuthenticatedOpenCodeClient, OpenCodeClientCache } from './opencode-client'
import { OpenCodeServerManager as HardenedOpenCodeServerManager } from './opencode-server-manager.ts'
import {
  awaitGuardedPreparation,
  providerLaunchIsCurrent,
  type ProviderLaunchGuard,
} from '../provider-launch-guard.ts'

// Lazy-loaded: @opencode-ai/sdk only exports ESM, Electron main is CJS.
// externalizeDepsPlugin converts dynamic import() to require() which can't
// resolve ESM-only exports — wrap in try/catch so the app still starts.
let _createOpencodeClient: any = null
async function getOpencodeClient(): Promise<any> {
  if (!_createOpencodeClient) {
    try {
      const mod = await import('@opencode-ai/sdk/v2/client')
      _createOpencodeClient = mod.createOpencodeClient
    } catch {
      throw new Error(
        'OpenCode SDK could not be loaded (ESM/CJS mismatch). ' +
        'Use the opencode CLI directly or check @opencode-ai/sdk compatibility.'
      )
    }
  }
  return _createOpencodeClient
}

// --- OpenCode Server Manager (spawns `opencode serve`, manages lifecycle) --------

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      server.close(() => resolve(addr.port))
    })
    server.on('error', reject)
  })
}

function resolveOpenCodeBinary(): string | null {
  // Use startup-detected path first
  const detected = getAgentPath('opencode')
  if (detected) return detected
  // Fallback to which
  try {
    const shellPath = getShellEnvPath()
    return execFileSync('which', ['opencode'], {
      encoding: 'utf-8',
      env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    }).trim() || null
  } catch {
    return null
  }
}

const openCodeServerManager = new HardenedOpenCodeServerManager({
  resolveBinary: resolveOpenCodeBinary,
  findAvailablePort,
  spawnServer: (binary, port, password) => {
    const shellPath = getShellEnvPath()
    return spawn(binary, ['serve', '--port', String(port)], processTreeSpawnOptions({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSafeSpawnEnv({
        ...(shellPath && { PATH: shellPath }),
        OPENCODE_SERVER_PASSWORD: password,
      }),
    }))
  },
  terminateProcessTree,
  log,
})

function getOpenCodeServerManager(): HardenedOpenCodeServerManager {
  return openCodeServerManager
}

export async function shutdownOpenCodeServer(): Promise<void> {
  await openCodeServerManager.shutdown()
}

// Cached model list
const OPEN_CODE_FALLBACK_MODELS: Array<{ id: string; label: string; description?: string }> = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
  { id: 'openai/o4-mini', label: 'o4-mini' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
]

let cachedOpenCodeModels: Array<{ id: string; label: string; description?: string }> = []
let openCodeModelsInflight: Promise<Array<{ id: string; label: string; description?: string }>> | null = null
let openCodeModelsRefreshPromise: Promise<void> | null = null
let cachedOpenCodeModelsAt = 0
const OPEN_CODE_MODELS_CACHE_MS = 15_000

function getOpenCodeFallbackModels(): Array<{ id: string; label: string; description?: string }> {
  return OPEN_CODE_FALLBACK_MODELS.map(model => ({ ...model }))
}

function broadcastOpenCodeModelsUpdated(payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }): void {
  broadcastToRenderer('chat:opencodeModelsUpdated', payload)
}

function refreshOpenCodeModelsInBackground(force = false): Promise<void> {
  if (openCodeModelsRefreshPromise && !force) return openCodeModelsRefreshPromise

  const isFresh = cachedOpenCodeModels.length > 0 && (Date.now() - cachedOpenCodeModelsAt) < OPEN_CODE_MODELS_CACHE_MS
  if (isFresh && !force) return Promise.resolve()

  openCodeModelsRefreshPromise = (async () => {
    try {
      const models = await fetchOpenCodeModels()
      const nextModels = models.length > 0 ? models : getOpenCodeFallbackModels()
      broadcastOpenCodeModelsUpdated({
        models: nextModels,
        source: models.length > 0 ? 'opencode' : 'fallback',
      })
    } catch (err) {
      log('refreshOpenCodeModelsInBackground error:', errorMessage(err))
      const nextModels = cachedOpenCodeModels.length > 0 ? cachedOpenCodeModels : getOpenCodeFallbackModels()
      broadcastOpenCodeModelsUpdated({
        models: nextModels,
        source: cachedOpenCodeModels.length > 0 ? 'cache' : 'fallback',
        error: errorMessage(err),
      })
    } finally {
      openCodeModelsRefreshPromise = null
    }
  })()

  return openCodeModelsRefreshPromise
}

export function warmOpenCodeModelsOnStartup(): void {
  // Startup warmup intentionally disabled.
}

async function fetchOpenCodeModels(): Promise<Array<{ id: string; label: string; description?: string }>> {
  const now = Date.now()
  if (cachedOpenCodeModels.length > 0 && (now - cachedOpenCodeModelsAt) < OPEN_CODE_MODELS_CACHE_MS) {
    return cachedOpenCodeModels
  }
  if (openCodeModelsInflight) return openCodeModelsInflight
  openCodeModelsInflight = (async () => {
    const { client } = await getOrCreateOpencodeClient()

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('OpenCode provider.list timed out after 10s')), 10_000)
    })

    const response = await Promise.race([
      client.provider.list(),
      timeoutPromise,
    ])

    if ((response as any).error) {
      throw new Error(`Failed to fetch OpenCode providers: ${JSON.stringify((response as any).error)}`)
    }

    const providers = (response as any).data
    if (!providers) return []

    const connectedIds = new Set<string>(providers.connected ?? [])
    if (connectedIds.size === 0) {
      log('OpenCode: no connected providers found')
      return []
    }

    const models: Array<{ id: string; label: string; description?: string }> = []
    for (const provider of (providers.all ?? [])) {
      if (!connectedIds.has(provider.id)) continue

      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        const m = model as any
        models.push({
          id: `${provider.id}/${modelId}`,
          label: m.name ?? modelId,
          description: `${provider.name ?? provider.id} - ${m.family ?? ''}`.trim(),
        })
      }
    }

    log(`OpenCode: fetched ${models.length} models from ${connectedIds.size} connected providers`)
    cachedOpenCodeModels = models
    cachedOpenCodeModelsAt = Date.now()
    return models
  })()

  try {
    return await openCodeModelsInflight
  } finally {
    openCodeModelsInflight = null
  }
}

export function getOpenCodeModelsSnapshot(): {
  models: Array<{ id: string; label: string; description?: string }>
  source: string
  loading: boolean
} {
  const isFresh = cachedOpenCodeModels.length > 0 && (Date.now() - cachedOpenCodeModelsAt) < OPEN_CODE_MODELS_CACHE_MS
  if (!isFresh) void refreshOpenCodeModelsInBackground()
  const models = isFresh
    ? cachedOpenCodeModels
    : (cachedOpenCodeModels.length > 0 ? cachedOpenCodeModels : getOpenCodeFallbackModels())

  return {
    models,
    source: isFresh ? 'cache' : (cachedOpenCodeModels.length > 0 ? 'stale-cache' : 'fallback'),
    loading: openCodeModelsRefreshPromise !== null,
  }
}

// --- OpenCode via @opencode-ai/sdk SSE streaming ---------------------------------

// Store opencode session IDs separately (keyed by cardId)
const opencodeSessionIds = new Map<string, string>()
const opencodeSessionPermissionModes = new Map<string, string>()

function normalizeOpenCodePermissionMode(mode?: string | null): string {
  return mode === 'plan' || mode === 'bypassPermissions' ? mode : 'default'
}

export function clearOpenCodeSession(scope: ChatStreamScope): void {
  const key = chatStreamScopeKey(scope)
  opencodeSessionIds.delete(key)
  opencodeSessionPermissionModes.delete(key)
  clearStableSessionContext(scope, 'opencode')
}

export async function abortOpenCodeSession(scope: ChatStreamScope): Promise<void> {
  const ocSessionId = opencodeSessionIds.get(chatStreamScopeKey(scope))
  if (!ocSessionId) return
  try {
    const mgr = getOpenCodeServerManager()
    if (mgr.isRunning()) {
      const createClient = await getOpencodeClient()
      const { url } = await mgr.ensureRunning()
      const client = createAuthenticatedOpenCodeClient<any>(createClient, url, mgr.getAuthHeaders())
      await client.session.abort({ sessionID: ocSessionId })
      log('opencode session aborted:', ocSessionId)
    }
  } catch (err) {
    log('opencode abort error (non-fatal):', errorMessage(err))
  }
}

// Cached SDK client — avoid re-creating on every message
const opencodeClientCache = new OpenCodeClientCache<any>()

async function getOrCreateOpencodeClient(): Promise<{ client: any; url: string }> {
  const mgr = getOpenCodeServerManager()
  const { url } = await mgr.ensureRunning()
  const createClient = await getOpencodeClient()
  const client = opencodeClientCache.getOrCreate(url, createClient, mgr.getAuthHeaders())
  return { client, url }
}

export function chatOpencode(
  req: ChatRequest,
  launchGuard?: ProviderLaunchGuard,
): void {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  const lastUserMsg = [...getPreparedMessages(req)].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(scope, { type: 'error', error: 'No user message' })
    return
  }
  const launchIsCurrent = (): boolean => providerLaunchIsCurrent(launchGuard)
  if (!launchIsCurrent()) return

  // Parse model string like "anthropic/claude-sonnet-4-6" into providerID + modelID
  const slashIdx = req.model.indexOf('/')
  const providerID = slashIdx > 0 ? req.model.slice(0, slashIdx) : 'anthropic'
  const modelID = slashIdx > 0 ? req.model.slice(slashIdx + 1) : req.model

  const requestedPermissionMode = normalizeOpenCodePermissionMode(req.mode)
  if (req.sessionId && !opencodeSessionIds.has(scopeKey)) {
    opencodeSessionIds.set(scopeKey, req.sessionId)
  }
  const recordedPermissionMode = opencodeSessionPermissionModes.get(scopeKey)
  const sessionPermissionModeMatches = recordedPermissionMode === requestedPermissionMode
  const existingSessionId = sessionPermissionModeMatches ? opencodeSessionIds.get(scopeKey) : undefined
  if (!sessionPermissionModeMatches && opencodeSessionIds.has(scopeKey)) {
    // OpenCode permissions are fixed at session creation. If the mode is unknown
    // after process restart, fail closed by creating a fresh session.
    log('opencode session permission mode changed; creating new session', {
      cardId: req.cardId,
      from: recordedPermissionMode ?? 'unknown',
      to: requestedPermissionMode,
    })
    opencodeSessionIds.delete(scopeKey)
    opencodeSessionPermissionModes.delete(scopeKey)
  }
  log('chatOpencode starting', {
    model: req.model,
    providerID,
    modelID,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
  })
  let stableContext: ReturnType<typeof selectStableContextForTurn> | null = null

  ;(async () => {
    try {
      // 1. Get cached client (server already warm from model list fetch)
      const preparedClient = await awaitGuardedPreparation(
        launchGuard,
        getOrCreateOpencodeClient(),
      )
      if (!preparedClient.ok) return
      const { client } = preparedClient.value

      // 2. Create or reuse session
      let sessionID = existingSessionId
      if (!sessionID) {
        const permission = buildOpenCodeSessionPermissions(req.mode)
        const sessionRes = await client.session.create({
          title: `Chat ${req.cardId.slice(0, 8)}`,
          permission,
          ...(req.workspaceDir && { directory: req.workspaceDir }),
        })
        const sessionData = (sessionRes as any).data ?? sessionRes
        sessionID = sessionData?.info?.id ?? sessionData?.id
        if (!sessionID) {
          throw new Error('Failed to create OpenCode session — no session ID returned')
        }
        if (!launchIsCurrent()) {
          try { await client.session.abort({ sessionID }) } catch { /* incomplete session */ }
          return
        }
        opencodeSessionIds.set(scopeKey, sessionID)
        opencodeSessionPermissionModes.set(scopeKey, requestedPermissionMode)
        log('opencode session created:', sessionID, req.mode === 'plan'
          ? '(plan mode)'
          : req.mode === 'bypassPermissions'
            ? '(bypass mode)'
            : '(default ask mode)')
      }

      // 3. Subscribe to SSE + send prompt concurrently
      const sseResult = await client.event.subscribe()
      const stream = (sseResult as any).stream
      if (!launchIsCurrent()) {
        try { await stream?.return?.() } catch { /* stream not yet active */ }
        return
      }

      // Track state for this response
      let assistantMessageId: string | null = null
      let isDone = false
      const seenParts = new Map<string, string>() // partID -> accumulated text
      const assistantPartIds = new Set<string>() // part IDs belonging to assistant messages
      const userMessageIds = new Set<string>() // message IDs that are user messages

      // Fire prompt without waiting — response arrives via SSE.
      // OpenCode has no separate system channel in this call. Install stable
      // host context once per session/version; volatile context remains in the
      // latest prepared user message on every turn.
      stableContext = selectStableContextForTurn({
        scope,
        provider: req.provider,
        sessionId: sessionID,
        contextPrompt: req.contextPrompt,
      })
      const promptText = buildPeerAwareTurnPrompt(
        lastUserMsg.content,
        stableContext.contextPrompt,
      )
      if (!launchIsCurrent()) {
        invalidateStableContextSelection(stableContext)
        try { await stream?.return?.() } catch { /* stream not yet active */ }
        return
      }
      const promptPromise = client.session.prompt({
        sessionID,
        model: { providerID, modelID },
        parts: [{ type: 'text', text: promptText }],
      }).then(() => {
        if (!launchIsCurrent()) return
        if (stableContext) bindStableContextSession(stableContext, sessionID)
        markRoomPromptAccepted(scope)
      }).catch((err: any) => {
        if (stableContext) invalidateStableContextSelection(stableContext)
        if (!isDone && launchIsCurrent()) {
          log('opencode prompt error:', err.message)
          sendStream(scope, { type: 'error', error: err.message ?? String(err) })
        }
      })

      // Medium: inactivity timeout — restart the 5-min clock each time we
      // receive any SSE event so a long-running but active session is not
      // aborted. If the stream goes silent for 5 min we abort and close.
      const INACTIVITY_MS = 5 * 60_000
      let streamTimeoutHandle: ReturnType<typeof setTimeout> | null = null

      const resetStreamTimeout = (): void => {
        if (streamTimeoutHandle !== null) clearTimeout(streamTimeoutHandle)
        streamTimeoutHandle = setTimeout(() => {
          if (!isDone) {
            log('opencode SSE inactivity timeout (5min)')
            isDone = true
            // Best-effort server-side abort before closing the iterator.
            void abortOpenCodeSession(scope).catch(() => {})
            sendStream(scope, { type: 'done' })
          }
        }, INACTIVITY_MS)
      }
      resetStreamTimeout()

      // Keep a reference so the finally block can cancel it.
      const streamTimeout = { clear: () => { if (streamTimeoutHandle !== null) clearTimeout(streamTimeoutHandle) } }

      try {
        for await (const event of stream) {
          if (!launchIsCurrent()) break
          resetStreamTimeout()
          if (isDone) break
          const evt = event as any
          const evtType: string = evt?.type ?? ''

          // Skip noisy file-watcher events (git index.lock churn, etc.)
          if (evtType.startsWith('file.watcher')) continue

          // Log all event types for debugging (except high-frequency deltas)
          if (evtType !== 'message.part.delta') {
            log('opencode SSE event:', evtType, JSON.stringify(evt?.properties ?? {}).slice(0, 300))
          }

          // Filter events to our session
          const props = evt?.properties ?? {}
          const evtSessionID = props.sessionID ?? props.info?.sessionID ?? ''
          if (evtSessionID && evtSessionID !== sessionID) continue

          switch (evtType) {
            case 'message.updated': {
              const info = props.info
              if (info?.role === 'user') {
                // Track user message IDs so we can skip their parts
                userMessageIds.add(info.id)
              } else if (info?.role === 'assistant') {
                assistantMessageId = info.id
                // Report cost/token info when message completes
                if (info.finish) {
                  sendStream(scope, {
                    type: 'done',
                    cost: info.cost,
                    tokens: info.tokens,
                    sessionId: sessionID,
                  })
                  isDone = true
                }
              }
              break
            }

            case 'message.part.updated': {
              const part = props.part
              if (!part) break
              // Skip parts from user messages (don't echo user input back)
              if (userMessageIds.has(part.messageID)) break
              // If we know the assistant message ID, only accept parts from it
              if (assistantMessageId && part.messageID !== assistantMessageId) break
              // Track this as an assistant part
              assistantPartIds.add(part.id)

              if (part.type === 'text') {
                const prev = seenParts.get(part.id) ?? ''
                if (part.text && part.text.length > prev.length) {
                  const newText = part.text.slice(prev.length)
                  seenParts.set(part.id, part.text)
                  sendStream(scope, { type: 'text', text: newText })
                }
              } else if (part.type === 'tool') {
                const toolId = part.callID ?? part.id
                const toolName = part.tool ?? 'tool'
                const state = part.state
                const seenKey = `tool:${part.id}`
                const prevStatus = seenParts.get(seenKey)

                if (!prevStatus) {
                  // First time seeing this tool — send tool_start
                  sendStream(scope, { type: 'tool_start', toolId, toolName })
                  if (state?.input) {
                    const inputStr = typeof state.input === 'string' ? state.input : JSON.stringify(state.input, null, 2)
                    sendStream(scope, { type: 'tool_input', text: inputStr })
                  }
                }

                if (state?.status === 'running' && prevStatus !== 'running') {
                  // Tool started running — update with title if available
                  if (state.title) {
                    sendStream(scope, { type: 'tool_use', toolName, toolInput: state.title })
                  }
                } else if (state?.status === 'completed') {
                  // Tool finished — send summary with output
                  const summary = state.title
                    ? `${state.title}${state.output ? '\n' + state.output.slice(0, 500) : ''}`
                    : state.output?.slice(0, 500) ?? 'Done'
                  sendStream(scope, { type: 'tool_summary', text: summary, toolName })
                } else if (state?.status === 'error') {
                  sendStream(scope, { type: 'tool_summary', text: `Error: ${state.error}`, toolName })
                }

                seenParts.set(seenKey, state?.status ?? 'unknown')
              } else if (part.type === 'reasoning') {
                const prev = seenParts.get(part.id) ?? ''
                if (part.text && part.text.length > prev.length) {
                  const newText = part.text.slice(prev.length)
                  seenParts.set(part.id, part.text)
                  sendStream(scope, { type: 'reasoning', text: newText })
                }
              } else if (part.type === 'step-finish') {
                sendStream(scope, {
                  type: 'step_finish',
                  cost: part.cost,
                  tokens: part.tokens,
                  reason: part.reason,
                })
              }
              break
            }

            case 'message.part.delta': {
              // Incremental text delta — most efficient streaming path
              const { partID, field, delta, messageID } = props
              // Skip deltas for user messages
              if (messageID && userMessageIds.has(messageID)) break
              // Only accept deltas for parts we've seen from assistant
              if (partID && !assistantPartIds.has(partID)) {
                // Could be a part we haven't seen via part.updated yet — but
                // if the messageID matches a user message, skip it
                if (messageID && assistantMessageId && messageID !== assistantMessageId) break
              }
              if (field === 'text' && delta) {
                const prev = seenParts.get(partID) ?? ''
                seenParts.set(partID, prev + delta)
                sendStream(scope, { type: 'text', text: delta })
              }
              break
            }

            case 'session.status': {
              if (props.status?.type === 'idle' && assistantMessageId) {
                if (!isDone) {
                  isDone = true
                  sendStream(scope, { type: 'done', sessionId: sessionID })
                }
              }
              break
            }

            case 'session.error': {
              isDone = true
              sendStream(scope, {
                type: 'error',
                error: props.error ?? 'OpenCode session error',
              })
              break
            }

            case 'permission.asked': {
              const permReq = props as any
              log('opencode permission asked:', permReq.permission, 'id:', permReq.id)
              try {
                const permissionRequest: ToolPermissionRequest = {
                  provider: 'opencode',
                  toolName: typeof permReq.permission === 'string' ? permReq.permission : 'tool',
                  title: typeof permReq.title === 'string' ? permReq.title : null,
                  description: typeof permReq.description === 'string'
                    ? permReq.description
                    : (typeof permReq.command === 'string' ? permReq.command : null),
                  blockedPath: typeof permReq.path === 'string' ? permReq.path : null,
                  workspaceDir: req.workspaceDir,
                }

                const toolUseIDHint = typeof permReq.id === 'string' ? permReq.id : null
                const result = await resolveInlineToolPermission(scope, permissionRequest, toolUseIDHint)

                if ('error' in result) {
                  log('opencode permission error:', result.error)
                  break
                }

                const { decision, toolUseID } = result

                // Map our richer scope model to OpenCode's three-value enum.
                //   forever        → 'always'   (persistent approval)
                //   today/session/once → 'once' (auto-approved but per-call)
                //   deny / never   → 'reject'
                const allowed = decision !== 'deny' && decision !== 'never'
                const reply: 'once' | 'always' | 'reject' = allowed
                  ? (decision === 'forever' ? 'always' : 'once')
                  : 'reject'
                await client.permission.reply({
                  requestID: toolUseID,
                  reply,
                  ...(allowed ? {} : { message: decision === 'never'
                    ? 'Tool permission permanently denied. Future calls will be auto-rejected.'
                    : 'Tool permission denied by the user.' }),
                })
                log('opencode permission decision:', permReq.id, reply, `(scope=${decision})`)
              } catch (permErr) {
                log('opencode permission reply error:', errorMessage(permErr))
              }
              break
            }

            case 'question.asked': {
              // Auto-answer questions from the model
              const qReq = props as any
              log('opencode question asked:', qReq.id, JSON.stringify(qReq.questions ?? []).slice(0, 200))
              try {
                // Each question needs an answer array; default to first option or "yes"
                const answers = (qReq.questions ?? []).map((q: any) => {
                  if (q.options?.length > 0) return [q.options[0].value ?? q.options[0].label ?? 'yes']
                  return ['yes']
                })
                await client.question.reply({
                  requestID: qReq.id,
                  answers,
                })
                log('opencode question auto-answered:', qReq.id)
              } catch (qErr) {
                log('opencode question reply error:', errorMessage(qErr))
              }
              break
            }
          }
        }
      } finally {
        streamTimeout.clear()
      }

      await promptPromise

      if (!isDone && launchIsCurrent()) {
        sendStream(scope, { type: 'done', sessionId: sessionID })
      }
    } catch (err) {
      if (stableContext) invalidateStableContextSelection(stableContext)
      if (!launchIsCurrent()) return
      const msg = errorMessage(err)
      log('chatOpencode error:', msg)
      const errorMsg = msg.includes('opencode CLI not found')
        ? 'OpenCode CLI not found. Install: go install github.com/opencodeco/opencode@latest'
        : msg.includes('ESM/CJS')
          ? 'OpenCode SDK could not be loaded. Check @opencode-ai/sdk compatibility.'
          : msg
      sendStream(scope, { type: 'error', error: errorMsg })
      sendStream(scope, { type: 'done' })
    }
  })()
}
