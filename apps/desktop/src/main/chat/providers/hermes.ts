import { spawn, execFileSync } from 'child_process'
import { getAgentPath, getShellEnvPath } from '../../agent-paths'
import { buildSafeSpawnEnv } from '../../ipc/terminal-helpers'
import {
  hermesChatHelpSupportsStreamJson,
  sanitizeAgentCliDiagnostic,
} from '../../agents/agent-cli-contracts'
import { buildHermesSpawnArgs } from './agent-mode-payloads'
import {
  chatRequestScope,
  chatStreamScopeKey,
  getPreparedMessages,
  isCurrentChatProcess,
  log,
  markRoomPromptAccepted,
  processTreeSpawnOptions,
  registerActiveChatProcess,
  sendStream,
  stopActiveChatProcess,
  terminateProcessTree,
  type ChatStreamScope,
} from '../runtime'
import {
  clearStableSessionContext,
  completeStableContextCliTurn,
  invalidateStableContextSelection,
  selectStableContextForTurn,
} from '../stable-session-context'
import type { ChatRequest } from '../types'
import { isProviderAcceptanceEvent } from '../provider-acceptance.ts'

// Store hermes session IDs for multi-turn resume
const hermesSessionIds = new Map<string, string>()

/** Hermes often re-emits the full thinking/text snapshot; keep only the new tail. */
/**
 * Keys a Hermes stream event may contribute. Anything else the CLI prints —
 * notably workspaceId/cardId — is dropped rather than forwarded.
 */
const HERMES_EVENT_PASSTHROUGH_KEYS = ['type', 'text', 'toolId', 'toolName', 'error', 'sessionId'] as const

function pickKnownHermesEventFields(evt: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of HERMES_EVENT_PASSTHROUGH_KEYS) {
    const value = evt[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

function hermesSnapshotTail(incoming: string, accumulated: string): string {
  if (!incoming) return ''
  if (accumulated === incoming || (accumulated && accumulated.endsWith(incoming))) return ''
  if (accumulated && incoming.startsWith(accumulated)) return incoming.slice(accumulated.length)
  if (accumulated && accumulated.startsWith(incoming)) return ''
  return incoming
}

const hermesStreamJsonSupport = new Map<string, boolean>()

function hermesBinarySupportsStreamJson(bin: string): boolean {
  const cached = hermesStreamJsonSupport.get(bin)
  if (cached != null) return cached
  const shellPath = getShellEnvPath()
  let help = ''
  try {
    help = execFileSync(bin, ['chat', '--help'], {
      encoding: 'utf-8',
      timeout: 8000,
      env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    })
  } catch (err) {
    const failed = err as { stdout?: string, stderr?: string }
    help = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`
  }
  const supported = hermesChatHelpSupportsStreamJson(help)
  hermesStreamJsonSupport.set(bin, supported)
  return supported
}

function resolveHermesBinary(): string | null {
  const detected = getAgentPath('hermes')
  if (detected) return detected
  try {
    const shellPath = getShellEnvPath()
    return execFileSync('which', ['hermes'], {
      encoding: 'utf-8',
      env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    }).trim() || null
  } catch {
    return null
  }
}

export function clearHermesSession(scope: ChatStreamScope): void {
  hermesSessionIds.delete(chatStreamScopeKey(scope))
  clearStableSessionContext(scope, 'hermes')
}

export function chatHermes(req: ChatRequest): void {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  const lastUserMsg = [...getPreparedMessages(req)].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(scope, { type: 'error', error: 'No user message' })
    return
  }

  const hermesBin = resolveHermesBinary()
  if (!hermesBin) {
    sendStream(scope, { type: 'error', error: 'Hermes CLI not found. Install: pip install hermes-agent' })
    return
  }

  const shellPath = getShellEnvPath()
  if (req.sessionId && !hermesSessionIds.has(scopeKey)) {
    hermesSessionIds.set(scopeKey, req.sessionId)
  }
  const existingSessionId = hermesSessionIds.get(scopeKey)
  const stableContext = selectStableContextForTurn({
    scope,
    provider: req.provider,
    sessionId: existingSessionId,
    contextPrompt: req.contextPrompt,
  })

  log('chatHermes starting', {
    model: req.model,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
  })

  // Build the `hermes chat` argv from the shared, pure builder. It maps
  // AgentMode.tools onto Hermes' coarse toolset categories, installs stable
  // host context only when its session/version changes, and FAILS CLOSED if a
  // selected agent's definition has not resolved (A-PR1 BLOCKING-1) — caught
  // below so we surface the reason instead of launching unrestricted.
  let args: string[]
  try {
    args = buildHermesSpawnArgs({
      agentId: req.agentId,
      agentMode: req.agentMode,
      mode: req.mode,
      model: req.model,
      userContent: lastUserMsg.content,
      existingSessionId,
      contextPrompt: stableContext.contextPrompt,
      streamJson: hermesBinarySupportsStreamJson(hermesBin),
    })
  } catch (err) {
    invalidateStableContextSelection(stableContext)
    sendStream(scope, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    sendStream(scope, { type: 'done' })
    return
  }

  const proc = spawn(hermesBin, args, processTreeSpawnOptions({
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    ...(req.workspaceDir && { cwd: req.workspaceDir }),
  }))

  if (!registerActiveChatProcess(scopeKey, proc)) {
    void terminateProcessTree(proc).then(termination => {
      sendStream(scope, {
        type: 'error',
        error: termination.confirmed
          ? 'Hermes launch refused because the previous chat process is still active'
          : `Duplicate Hermes process could not be terminated: ${termination.detail}`,
      })
      if (termination.confirmed) sendStream(scope, { type: 'done' })
    })
    return
  }

  // H-9: identity-guard — only clean up / emit done|error if this proc is
  // still the active one for this card. A rapid re-send replaces the map
  // entry before the old proc's close handler fires, so we must check first.
  const isCurrent = (): boolean => isCurrentChatProcess(scopeKey, proc)

  // NDJSON line dispatcher. Hermes' --stream-json mode emits one JSON event
  // per line on stdout, mapping directly to CodeSurf's existing stream event
  // schema (type: text | thinking | tool_start | tool_input | tool_summary
  // | session | error | done). Unparseable lines are treated as raw text so
  // an older Hermes binary that doesn't recognise --stream-json (and falls
  // through to plain output) still produces *something* in the UI rather
  // than silence.
  let stdoutBuf = ''
  let hadProviderError = false
  let sawProviderAcceptance = false
  let accumulatedThinking = ''
  let accumulatedText = ''
  const noteProviderAcceptance = (): void => {
    sawProviderAcceptance = true
    markRoomPromptAccepted(scope)
  }
  const dispatchHermesEvents = (chunk: string, flushPartial = false): void => {
    if (!isCurrent()) return
    stdoutBuf += chunk
    const lines = stdoutBuf.split(/\r?\n/)
    stdoutBuf = flushPartial ? '' : (lines.pop() ?? '')

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // Legacy fallback: plain "session_id: …" sentinel from a binary
      // without --stream-json. Surface it the way the old streamer did.
      const sessionLineMatch = trimmed.match(/^(?:session_id|session)\s*:\s*(\S+)$/i)
      if (sessionLineMatch?.[1]) {
        const sid = sessionLineMatch[1]
        hermesSessionIds.set(scopeKey, sid)
        sendStream(scope, { type: 'session', sessionId: sid })
        continue
      }

      let evt: any
      try {
        evt = JSON.parse(trimmed)
      } catch {
        noteProviderAcceptance()
        sendStream(scope, { type: 'text', text: line + '\n' })
        continue
      }
      if (!evt || typeof evt !== 'object' || typeof evt.type !== 'string') {
        continue
      }

      switch (evt.type) {
        case 'session':
          if (typeof evt.sessionId === 'string' && evt.sessionId.trim()) {
            const sid = evt.sessionId.trim()
            hermesSessionIds.set(scopeKey, sid)
            sendStream(scope, { type: 'session', sessionId: sid })
          }
          break
        case 'text':
          if (typeof evt.text === 'string' && evt.text) {
            const tail = hermesSnapshotTail(evt.text, accumulatedText)
            if (tail) {
              accumulatedText += tail
              noteProviderAcceptance()
              sendStream(scope, { type: 'text', text: tail })
            }
          }
          break
        case 'thinking':
          if (typeof evt.text === 'string' && evt.text) {
            const tail = hermesSnapshotTail(evt.text, accumulatedThinking)
            if (tail) {
              accumulatedThinking += tail
              noteProviderAcceptance()
              sendStream(scope, { type: 'thinking', text: tail })
            }
          }
          break
        case 'tool_start':
          noteProviderAcceptance()
          sendStream(scope, {
            type: 'tool_start',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            toolName: typeof evt.toolName === 'string' ? evt.toolName : 'tool',
          })
          break
        case 'tool_input':
          noteProviderAcceptance()
          sendStream(scope, {
            type: 'tool_input',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            text: typeof evt.text === 'string' ? evt.text : '',
          })
          break
        case 'tool_summary':
          noteProviderAcceptance()
          sendStream(scope, {
            type: 'tool_summary',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            toolName: typeof evt.toolName === 'string' ? evt.toolName : undefined,
            text: typeof evt.text === 'string' ? evt.text : '',
          })
          break
        case 'error':
          hadProviderError = true
          sendStream(scope, {
            type: 'error',
            error: typeof evt.error === 'string' ? evt.error : 'Unknown Hermes error',
          })
          break
        case 'done':
          // Suppressed here — emitted from proc.on('close') below so we
          // always get a final 'done' even if Hermes exits mid-stream.
          break
        default:
          // Forward only known keys. Every other case in this switch builds a
          // fixed-shape literal with typeof guards; this branch used to spread
          // whatever the CLI printed, and an unrecognized `type` from an older or
          // quiet-mode binary could carry workspaceId/cardId that overrode the
          // authenticated scope. runtime.ts now also puts scope last, so this is
          // belt and braces.
          if (isProviderAcceptanceEvent(evt)) noteProviderAcceptance()
          sendStream(scope, pickKnownHermesEventFields(evt))
      }
    }
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    dispatchHermesEvents(chunk.toString(), false)
  })

  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })

  proc.on('close', (code) => {
    if (!isCurrent()) return // superseded by a new turn — suppress stale done/error
    dispatchHermesEvents('', true)
    void (async () => {
      const termination = await stopActiveChatProcess(scopeKey)
      if (!termination?.confirmed) {
        invalidateStableContextSelection(stableContext)
        sendStream(scope, {
          type: 'error',
          error: `Hermes process-tree exit could not be confirmed: ${termination?.detail ?? 'process ownership was lost'}`,
        })
        return
      }
      completeStableContextCliTurn(stableContext, {
        exitCode: code,
        sawProviderAcceptance,
        providerError: hadProviderError,
        sessionId: hermesSessionIds.get(scopeKey) ?? existingSessionId,
      })
      if (code !== 0 && stderrBuf.trim()) {
        sendStream(scope, { type: 'error', error: sanitizeAgentCliDiagnostic(stderrBuf.trim()) })
      }
      if (code === 0 && !hadProviderError && sawProviderAcceptance) markRoomPromptAccepted(scope)
      sendStream(scope, { type: 'done' })
    })().catch(error => {
      invalidateStableContextSelection(stableContext)
      sendStream(scope, {
        type: 'error',
        error: `Hermes process finalization failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  })

  proc.on('error', (err) => {
    if (!isCurrent()) return // superseded — new turn owns the slot
    void (async () => {
      const termination = await stopActiveChatProcess(scopeKey)
      invalidateStableContextSelection(stableContext)
      sendStream(scope, {
        type: 'error',
        error: err.message.includes('ENOENT')
          ? 'Hermes CLI not found. Install: pip install hermes-agent'
          : err.message,
      })
      if (!termination?.confirmed) {
        sendStream(scope, {
          type: 'error',
          error: `Hermes process-tree exit could not be confirmed: ${termination?.detail ?? 'process ownership was lost'}`,
        })
        return
      }
      sendStream(scope, { type: 'done' })
    })().catch(error => {
      sendStream(scope, {
        type: 'error',
        error: `Hermes process finalization failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  })
}
