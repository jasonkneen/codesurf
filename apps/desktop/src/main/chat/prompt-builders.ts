/**
 * Pure system/preamble prompt builders, extracted out of `src/main/ipc/chat.ts`
 * (which pulls in Electron main APIs and cannot be unit-tested). These build
 * the peer-collaboration system prompt and the async-execution preamble injected
 * into agent turns. Types are self-contained and structural so chat.ts's own
 * `PeerContext` / `ChatRequest['asyncExecution']` shapes pass through unchanged.
 *
 * See `test/chat-prompt-builders.test.ts`.
 */

import { buildPeerContextPrompt } from './peer-context-policy.ts'

export interface PromptPeerAction {
  name: string
  description: string
}

export interface PromptPeerContext {
  peerId: string
  peerType: string
  tools: string[]
  actions?: PromptPeerAction[]
  context?: Record<string, unknown>
}

export interface AsyncExecutionContext {
  requestedRunMode: 'foreground' | 'background'
  backend: 'runtime' | 'daemon'
  hostType: 'runtime' | 'local-daemon' | 'remote-daemon'
  hostLabel: string
  providerNativeBackground: boolean
  detachedDaemonAvailable: boolean
  detachedDaemonPreferred: boolean
}

export function buildAsyncExecutionPrompt(asyncExecution: AsyncExecutionContext | undefined): string | undefined {
  if (!asyncExecution) return undefined

  const lines = [
    '## Async Execution',
    `- Active execution backend: ${asyncExecution.backend} (${asyncExecution.hostLabel}).`,
  ]

  if (asyncExecution.providerNativeBackground) {
    lines.push('- Provider-native background agents may be available. Prefer that path for subagents or long-running delegated work when it keeps the main chat responsive.')
  }

  if (asyncExecution.detachedDaemonAvailable) {
    lines.push('- CodeSurf also supports daemon-backed detached jobs that can continue outside the foreground chat.')
  }

  if (asyncExecution.requestedRunMode === 'background') {
    lines.push('- This turn is running as a detached background orchestration job. Continue autonomously and do not expect interactive clarification from the foreground chat unless the task is blocked.')
  } else if (asyncExecution.detachedDaemonAvailable) {
    lines.push('- If the user wants the main conversation to stay free while work continues, prefer detached daemon orchestration for the main task thread.')
  }

  return lines.join('\n')
}

export function buildPeerSystemPrompt(peers?: PromptPeerContext[]): string | undefined {
  return buildPeerContextPrompt(peers).fragment?.text
}

/** Keep stable provider conventions ahead of volatile peer state. */
export function buildPeerAwareTurnPrompt(
  userContent: string,
  peerPrompt: string | undefined,
  stablePreamble?: string,
): string {
  const preamble = [stablePreamble, peerPrompt]
    .map(section => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join('\n\n')
  return preamble ? `${preamble}\n\n---\n\n${userContent}` : userContent
}

/** Append room membership + consumed traffic for this turn. */
export function appendRoomContext(systemPrompt: string | undefined, roomExtra: string | undefined): string | undefined {
  const extra = roomExtra?.trim()
  if (!extra) return systemPrompt
  if (!systemPrompt?.trim()) return extra
  return `${systemPrompt}\n\n${extra}`
}
