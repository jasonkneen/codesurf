/**
 * Chat IPC — uses @anthropic-ai/claude-agent-sdk for Claude sessions.
 * No API keys needed — the SDK uses the Claude CLI's own auth.
 * Codex uses codex CLI, OpenCode uses @opencode-ai/sdk via local server.
 *
 * Multi-turn: stores sessionId per card, uses `resume` on subsequent turns.
 */

import { ipcMain, BrowserWindow, dialog } from 'electron'

import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { promisify } from 'util'
import {
  stopCsagent,
  steerCsagent,
  disposeCsagent,
  clearCsagentSession,
  listCsagentModels,
} from '../chat/pi-runtime'
import { getShellEnvPath } from '../agent-paths'
import { updateLinks, prepareTurnContext, post as roomPost } from '../agent-room'
import { CODESURF_HOME } from '../paths'

import {
  applyProjectContextPolicy,
  buildProviderContextPolicy,
  describeProjectContextEnvelope,
} from '../privacy/provider-context-policy'
import { loadExternalSessionMessagesPage } from '../session-sources'
import type { SessionEntryHint } from '../../shared/session-types'
import type { ExecutionHostRecord } from '../../shared/types'
import { daemonClient } from '../daemon/client'
import { ensureDaemonRunning } from '../daemon/manager'
import { DaemonCardStream } from '../chat/daemon-card-stream.ts'
import {
  MAX_SKILLS_SUMMARY_BYTES,
  previewContextToolInput,
  truncateUtf8,
} from '@codesurf/daemon/context-budget'
import { getBuiltinExecutionHosts, resolveExecutionTarget } from '../execution/targets'
import { getWorkspacePathById, readSettingsSync } from './workspace'

import type { ToolPermissionRequest } from '../permissions'
import { chatHermes, clearHermesSession } from '../chat/providers/hermes'
import { chatOpenclaw, clearOpenclawSession, listOpenclawAgents } from '../chat/providers/openclaw'
import {
  abortOpenCodeSession,
  chatOpencode,
  clearOpenCodeSession,
  getOpenCodeModelsSnapshot,
  shutdownOpenCodeServer,
} from '../chat/providers/opencode'
import { revokeTileToken } from '../mcp-server'
import {
  buildClaudeTextInput,
  cancelPendingAskUserQuestionsForCard,
  cardAbortControllers,
  cardPermissionModes,
  chatClaude,
  markClaudeQueryIntentionallyClosed,
  resolvePendingAskUserQuestion,
} from '../chat/providers/claude'
import { chatCodex } from '../chat/providers/codex'
import { agentModeUnresolved, AGENT_MODE_UNRESOLVED_ERROR } from '../chat/agent-mode-tools'
import { resolveAuthoritativeAgentMode } from '../chat/agent-mode-resolver'
import {
  applyAuthoritativePersonaPolicy,
  canonicalizeElectronChatRequest,
} from '../chat/request-policy'
import { chatCsagent } from '../chat/providers/csagent'
import { chatLocalProxy, stopLocalProxyTurn } from '../chat/providers/local-proxy'
import { chatGateway, getGatewayModelsSnapshot, stopGatewayTurn } from '../chat/providers/gateway'
import type {
  ChatRequest,
  ChatImageAttachment,
  ChatContextBucketBundle,
} from '../chat/types'
import {
  log,
  sendStream,
  cloneChatMessages,
  getPreparedMessages,
  activeQueries,
  chatRequestScope,
  chatStreamScopeKey,
  createChatStreamScope,
  persistSessionIds,
  deleteCardSessionIds,
  registerRoomContextAcknowledgement,
  markRoomPromptAccepted,
  discardRoomContextAcknowledgement,
  beginRuntimeSessionPersistence,
  bindRuntimeSessionPersistence,
  clearRuntimeSessionState,
  stopActiveChatProcess,
  stopAllActiveChatProcesses,
  type ChatStreamScope,
} from '../chat/runtime'
import { hostShouldPrefetchStableContext } from '../chat/hostStableContextLoad.ts'
import {
  consumeStableContextAnnouncement,
  readRuntimeStableLoad,
  writeRuntimeStableLoad,
} from '../chat/stable-session-context.ts'
import { isValidAgentRoomId } from '../agent-room/validation.ts'
import { appendComposedUserContextToLatestUser } from '../chat/room-context-message.ts'
import { composeHostChatContext } from '../chat/request-context.ts'
import { loadAuthoritativeChatPeers } from '../chat/peer-authority.ts'
import {
  isProviderAcceptanceEvent,
  pollProviderCompletion,
  isSuccessfulProviderCompletion,
} from '../chat/provider-acceptance.ts'
import {
  BUILTIN_CHAT_PROVIDER_IDS,
  resolveHostChatProvider,
} from '../chat/provider-registry.ts'
import {
  ChatPreparationFence,
  type ChatPreparationLease,
} from '../chat/chat-preparation-fence.ts'
import { ChatLifecycleCoordinator } from '../chat/chat-lifecycle-coordinator.ts'
import { runConfirmedSessionClear } from '../chat/chat-session-lifecycle.ts'
import { DaemonJobRegistry } from '../chat/daemon-job-registry.ts'
import { getAuthoritativeNegotiatedPeerTools } from '../chat/peer-authority-policy.ts'
import type { ProviderLaunchGuard } from '../chat/provider-launch-guard.ts'
import { cleanupOwnedImageAttachments } from '../chat/provider-image-attachments.ts'
import { routeHostForAttachments } from '../chat/attachment-route-policy.ts'

const BUILTIN_CHAT_PROVIDERS = new Set<string>(BUILTIN_CHAT_PROVIDER_IDS)
const chatPreparationFence = new ChatPreparationFence()
const chatLifecycleCoordinator = new ChatLifecycleCoordinator(chatPreparationFence)
const ownedImageAttachmentsByScope = new Map<string, ChatImageAttachment[]>()
const ownedImageAttachmentTimers = new Map<string, ReturnType<typeof setTimeout>>()

type TempAttachmentIdentity = {
  device: string
  inode: string
  byteCount: number
  mtimeMs: number
  ctimeMs: number
}

async function unlinkTempAttachmentIfIdentityMatches(
  path: string,
  expected: TempAttachmentIdentity,
): Promise<void> {
  try {
    const stat = await fs.lstat(path)
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || String(stat.dev) !== expected.device
      || String(stat.ino) !== expected.inode
      || stat.size !== expected.byteCount
      || stat.mtimeMs !== expected.mtimeMs
      || stat.ctimeMs !== expected.ctimeMs
    ) return
    await fs.unlink(path)
  } catch {
    // The daemon also sweeps strict stale owned names on startup. Never broaden
    // a failed rollback into deleting an unattested path replacement.
  }
}

function trackOwnedImageAttachments(
  scope: ChatStreamScope,
  attachments: ChatImageAttachment[] | undefined,
): void {
  const owned = (attachments ?? []).filter(attachment => attachment.ownedTemporary)
  if (owned.length === 0) return
  const scopeKey = chatStreamScopeKey(scope)
  const previous = ownedImageAttachmentsByScope.get(scopeKey)
  if (previous) void cleanupOwnedImageAttachments(previous)
  const previousTimer = ownedImageAttachmentTimers.get(scopeKey)
  if (previousTimer) clearTimeout(previousTimer)
  ownedImageAttachmentsByScope.set(scopeKey, owned)
  const timer = setTimeout(() => {
    ownedImageAttachmentTimers.delete(scopeKey)
    const pending = ownedImageAttachmentsByScope.get(scopeKey)
    ownedImageAttachmentsByScope.delete(scopeKey)
    if (pending) void cleanupOwnedImageAttachments(pending)
  }, 5 * 60 * 1000)
  timer.unref?.()
  ownedImageAttachmentTimers.set(scopeKey, timer)
}

async function cleanupOwnedImageAttachmentsForScope(scope: ChatStreamScope): Promise<void> {
  const scopeKey = chatStreamScopeKey(scope)
  const timer = ownedImageAttachmentTimers.get(scopeKey)
  if (timer) clearTimeout(timer)
  ownedImageAttachmentTimers.delete(scopeKey)
  const pending = ownedImageAttachmentsByScope.get(scopeKey)
  ownedImageAttachmentsByScope.delete(scopeKey)
  if (pending) await cleanupOwnedImageAttachments(pending)
}

function validatedChatScope(
  workspaceId: unknown,
  cardId: unknown,
): ChatStreamScope | null {
  const normalizedWorkspaceId = String(workspaceId ?? '').trim()
  const normalizedCardId = String(cardId ?? '').trim()
  if (
    !isValidAgentRoomId(normalizedWorkspaceId)
    || !isValidAgentRoomId(normalizedCardId)
  ) return null
  return createChatStreamScope(normalizedWorkspaceId, normalizedCardId)
}

export { warmOpenCodeModelsOnStartup } from '../chat/providers/opencode'

export type {
  ChatMessage,
  ChatRequest,
  ChatImageAttachment,
  ChatContextBucketBundle,
  RuntimeChatSessionState,
} from '../chat/types'
export {
  log,
  sendStream,
  cloneChatMessages,
  getPreparedMessages,
  upsertRuntimeSessionState,
  activeQueries,
  activeProcesses,
  activeHttpRequests,
  sessionIds,
  persistSessionIds,
  SESSION_IDS_PATH,
} from '../chat/runtime'

type LoadedMemoryContext = Awaited<ReturnType<typeof daemonClient.loadMemoryContext>>

function mayContainFileReferences(text: string): boolean {
  return text.includes('@')
    || text.includes('Attached file paths:')
    || text.includes('Attached file capabilities:')
}

function extractHostAttachmentCapabilities(req: ChatRequest): string[] {
  const messages = getPreparedMessages(req)
  const lastUser = [...messages].reverse().find(message => message.role === 'user')
  const content = String(lastUser?.content ?? '')
  const marker = 'Attached file capabilities:'
  const markerIndex = content.indexOf(marker)
  if (markerIndex < 0) return []
  return content
    .slice(markerIndex + marker.length)
    .split(/\r?\n/)
    .map(line => line.trim().split('\t', 1)[0] ?? '')
    .filter(capability => /^[A-Za-z0-9_-]{43}$/.test(capability))
}

async function hasHostValidatedAttachments(
  req: ChatRequest,
  selectedHost: ExecutionHostRecord | null,
): Promise<boolean> {
  if (selectedHost?.type !== 'local-daemon' || !req.workspaceId) return false
  const capabilities = extractHostAttachmentCapabilities(req)
  if (capabilities.length === 0) return false
  const inspected = await daemonClient.inspectAttachmentCapabilities({
    workspaceId: req.workspaceId,
    cardId: req.cardId,
    capabilities,
  })
  return inspected.hasAttachments
}

function supportedImageMediaTypesForRequest(req: ChatRequest, remoteExecution = false): string[] {
  if (remoteExecution) return []
  return ['claude', 'codex', 'csagent'].includes(req.provider)
    ? [...ANTHROPIC_SUPPORTED_IMAGE_TYPES]
    : []
}

async function expandLatestUserFileReferences(req: ChatRequest, remoteExecution = false): Promise<{
  request: ChatRequest
  expansion: Awaited<ReturnType<typeof daemonClient.expandFileReferences>> | null
}> {
  if (!req.workspaceId && !req.workspaceDir) {
    return { request: req, expansion: null }
  }

  const preparedMessages = getPreparedMessages(req)
  let lastUserIndex = -1
  for (let index = preparedMessages.length - 1; index >= 0; index -= 1) {
    if (preparedMessages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }

  if (lastUserIndex < 0) {
    return { request: req, expansion: null }
  }

  const lastUserMessage = preparedMessages[lastUserIndex]
  if (!mayContainFileReferences(String(lastUserMessage?.content ?? ''))) {
    return { request: req, expansion: null }
  }

  const expansion = await daemonClient.expandFileReferences({
    message: lastUserMessage.content,
    workspaceId: req.workspaceId ?? null,
    cardId: req.cardId,
    workspaceDir: req.workspaceDir ?? null,
    executionTarget: req.executionTarget === 'cloud' ? 'cloud' : 'local',
    supportedImageMediaTypes: supportedImageMediaTypesForRequest(req, remoteExecution),
  })

  // Register daemon-committed owned paths before cloning/mapping any response
  // fields. A mapper failure or superseded turn can then clean every owned
  // binary even though the one-shot capability transaction already committed.
  trackOwnedImageAttachments(
    chatRequestScope(req),
    (expansion.ownedTemporaryAttachments ?? []).map(attachment => ({
      path: String(attachment.path ?? ''),
      mediaType: String(attachment.mediaType ?? ''),
      displayPath: String(attachment.displayPath ?? ''),
      byteCount: Number(attachment.byteCount),
      device: String(attachment.device ?? ''),
      inode: String(attachment.inode ?? ''),
      mtimeMs: Number(attachment.mtimeMs),
      ctimeMs: Number(attachment.ctimeMs),
      ownedTemporary: true,
    })),
  )

  if (!expansion.changed) {
    return { request: req, expansion: null }
  }

  const expandedMessages = cloneChatMessages(preparedMessages)
  expandedMessages[lastUserIndex] = {
    ...expandedMessages[lastUserIndex],
    content: expansion.bodyText,
  }

  // Pull out binary image attachments so we can send them to Claude as real
  // multimodal image blocks (the text expansion only has a `(binary attachment
  // — content not inlined)` placeholder — the model can't see the pixels from
  // that alone).
  const imageAttachments: ChatImageAttachment[] = []
  for (const reference of expansion.references ?? []) {
    if (!reference.binary) continue
    const mediaType = String(reference.mediaType ?? '')
    const resolvedPath = String(reference.resolvedPath ?? '').trim()
    if (!resolvedPath) continue
    if (isSupportedVisionMediaType(mediaType)) {
      imageAttachments.push({
        path: resolvedPath,
        mediaType,
        displayPath: reference.displayPath,
        byteCount: reference.byteCount,
        device: String(reference.device ?? ''),
        inode: String(reference.inode ?? ''),
        mtimeMs: Number(reference.mtimeMs),
        ctimeMs: Number(reference.ctimeMs),
        ownedTemporary: reference.ownedTemporary === true,
      })
    }
  }

  return {
    request: {
      ...req,
      expandedMessages,
      fileReferencePrompt: expansion.contextText,
      ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    },
    expansion,
  }
}

const ANTHROPIC_SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

function isSupportedVisionMediaType(mediaType: string): boolean {
  return ANTHROPIC_SUPPORTED_IMAGE_TYPES.has(mediaType.toLowerCase())
}

/**
 * Kill every live chat subprocess (Codex/OpenClaw/Hermes/OpenCode CLI children)
 * and stop the OpenCode server. Called from app `before-quit` so a hard quit
 * does not leave orphaned agent processes running and billing. Terminals are
 * intentionally left alone — tmux-backed sessions are designed to survive
 * restarts (see terminal.ts), and the direct-PTY fallback receives SIGHUP when
 * the PTY master closes on parent death.
 */
export async function killAllChatProcesses(): Promise<void> {
  for (const entry of daemonCardStreams.values()) entry.stream.close()
  daemonCardStreams.clear()
  const [processResult, openCodeResult] = await Promise.allSettled([
    stopAllActiveChatProcesses(),
    shutdownOpenCodeServer(),
  ])
  for (const timer of ownedImageAttachmentTimers.values()) clearTimeout(timer)
  ownedImageAttachmentTimers.clear()
  for (const attachments of ownedImageAttachmentsByScope.values()) {
    void cleanupOwnedImageAttachments(attachments)
  }
  ownedImageAttachmentsByScope.clear()

  const failures: string[] = []
  if (processResult.status === 'rejected') {
    failures.push(processResult.reason instanceof Error
      ? processResult.reason.message
      : String(processResult.reason))
  } else {
    failures.push(...processResult.value
      .filter(result => !result.confirmed)
      .map(result => `${result.scopeKey}: ${result.detail}`))
  }
  if (openCodeResult.status === 'rejected') {
    failures.push(openCodeResult.reason instanceof Error
      ? openCodeResult.reason.message
      : String(openCodeResult.reason))
  }
  if (failures.length > 0) {
    throw new Error(`Chat shutdown could not confirm every process tree exited: ${failures.join('; ')}`)
  }
}
const activeDaemonJobs = new DaemonJobRegistry<ExecutionHostRecord>()

const execFileAsync = promisify(execFile)

// --- Tool permission prompts (inline UI, mirrors AskUserQuestion pattern) -----

export type ToolPermissionDecision = 'deny' | 'never' | 'once' | 'session' | 'today' | 'forever'

interface PendingToolPermission {
  resolve: (decision: ToolPermissionDecision) => void
  reject: (err: Error) => void
}

// Keyed by workspace/card identity plus toolUseID.
const pendingToolPermissions = new Map<string, PendingToolPermission>()

function toolPermissionKey(scope: ChatStreamScope, toolUseID: string | null | undefined): string {
  return JSON.stringify([chatStreamScopeKey(scope), toolUseID ?? ''])
}

export function awaitToolPermissionAnswer(
  scope: ChatStreamScope,
  toolUseID: string | null,
  request: ToolPermissionRequest,
): Promise<ToolPermissionDecision> {
  const key = toolPermissionKey(scope, toolUseID)
  const prior = pendingToolPermissions.get(key)
  if (prior) {
    try { prior.reject(new Error('Tool permission superseded')) } catch { /* noop */ }
    pendingToolPermissions.delete(key)
  }
  return new Promise<ToolPermissionDecision>((resolve, reject) => {
    pendingToolPermissions.set(key, { resolve, reject })
    sendStream(scope, {
      type: 'tool_permission_request',
      toolId: toolUseID,
      provider: request.provider,
      toolName: request.toolName,
      title: request.title ?? null,
      description: request.description ?? null,
      blockedPath: request.blockedPath ?? null,
      workspaceDir: request.workspaceDir ?? null,
    })
  })
}

function resolvePendingToolPermission(
  scope: ChatStreamScope,
  toolUseID: string | null | undefined,
  decision: ToolPermissionDecision,
): boolean {
  const key = toolPermissionKey(scope, toolUseID)
  const pending = pendingToolPermissions.get(key)
  if (!pending) return false
  pendingToolPermissions.delete(key)
  pending.resolve(decision)
  return true
}

function cancelPendingToolPermissionsForCard(
  scope: ChatStreamScope,
  reason: string = 'Cancelled',
): void {
  const scopeKey = chatStreamScopeKey(scope)
  for (const [key, pending] of pendingToolPermissions.entries()) {
    try {
      const parsed = JSON.parse(key)
      if (!Array.isArray(parsed) || parsed[0] !== scopeKey) continue
      pendingToolPermissions.delete(key)
      try { pending.reject(new Error(reason)) } catch { /* noop */ }
    } catch { /* ignore malformed internal keys */ }
  }
}

async function resolveHostEndpoint(host: ExecutionHostRecord): Promise<{ baseUrl: string; token: string | null }> {
  if (host.type === 'local-daemon') {
    const info = await ensureDaemonRunning()
    return {
      baseUrl: `http://127.0.0.1:${info.port}`,
      token: info.token,
    }
  }

  if (host.type === 'remote-daemon') {
    const baseUrl = String(host.url ?? '').trim().replace(/\/+$/, '')
    if (!baseUrl) throw new Error(`Remote host ${host.label} is missing a URL`)
    return {
      baseUrl,
      token: host.authToken ?? null,
    }
  }

  throw new Error(`Host ${host.label} does not expose a daemon endpoint`)
}

async function hostRequest<T>(host: ExecutionHostRecord, path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const endpoint = await resolveHostEndpoint(host)
  const response = await fetch(`${endpoint.baseUrl}${path}`, {
    method: options?.method ?? (options?.body == null ? 'GET' : 'POST'),
    headers: {
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
      ...(options?.body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options?.body == null ? undefined : JSON.stringify(options.body),
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  })

  const text = await response.text()
  const payload = text.trim() ? JSON.parse(text) as T : null
  if (!response.ok) {
    const errorMessage = typeof payload === 'object' && payload && 'error' in payload
      ? String((payload as { error?: unknown }).error ?? `Daemon request failed (${response.status})`)
      : (text.trim() || `Daemon request failed (${response.status})`)
    throw new Error(errorMessage)
  }
  return payload as T
}

async function getExecutionRoutingState(): Promise<{
  hosts: ExecutionHostRecord[]
  localDaemonAvailable: boolean
}> {
  try {
    await ensureDaemonRunning()
    const hosts = await daemonClient.listHosts()
    return {
      hosts,
      localDaemonAvailable: true,
    }
  } catch {
    return {
      hosts: getBuiltinExecutionHosts(),
      localDaemonAvailable: false,
    }
  }
}

function supportsDaemonChatProvider(provider: string | null | undefined): boolean {
  return provider === 'claude' || provider === 'codex' || provider === 'opencode' || provider === 'hermes' || provider === 'omnigent'
}

function requiresDaemonChatProvider(provider: string | null | undefined): boolean {
  return provider === 'omnigent'
}

function supportsProviderNativeBackground(provider: string | null | undefined): boolean {
  return provider === 'claude' || provider === 'codex'
}

function buildAsyncExecutionContext(params: {
  request: ChatRequest
  daemonHost: ExecutionHostRecord | null
  localDaemonAvailable: boolean
}): NonNullable<ChatRequest['asyncExecution']> {
  const requestedRunMode = params.request.runMode === 'background' ? 'background' : 'foreground'
  const backend = params.daemonHost ? 'daemon' : 'runtime'
  const hostType = params.daemonHost?.type ?? 'runtime'
  const hostLabel = params.daemonHost?.label ?? 'Electron runtime'
  const providerNativeBackground = supportsProviderNativeBackground(params.request.provider)
  const detachedDaemonAvailable = Boolean(params.daemonHost) || params.localDaemonAvailable

  return {
    requestedRunMode,
    backend,
    hostType,
    hostLabel,
    providerNativeBackground,
    detachedDaemonAvailable,
    detachedDaemonPreferred: detachedDaemonAvailable && !providerNativeBackground,
  }
}

// Prompt conventions live in ./prompt-conventions (pure, unit-testable). They
// are imported at the top of this file.

function syncPeerLinks(req: ChatRequest): void {
  if (!req.workspaceId) return
  const tileTypes: Record<string, string> = { [req.cardId]: 'chat' }
  for (const peer of req.peers ?? []) {
    tileTypes[peer.peerId] = peer.peerType || 'unknown'
  }
  updateLinks(
    req.workspaceId,
    req.cardId,
    (req.peers ?? []).map(peer => peer.peerId),
    tileTypes,
  )
}

/** Join room from canvas wires, inject pending room traffic, announce identity. */
function attachRoomContext(req: ChatRequest): ChatRequest {
  if (!req.workspaceId) return { ...req, roomAckSequence: undefined }
  syncPeerLinks(req)
  const {
    roomId,
    systemExtra,
    acknowledgeThrough: roomAckSequence,
  } = prepareTurnContext(req.workspaceId, req.cardId, 'chat', {
    supplementalUntrustedContext: req.untrustedPeerContext,
  })
  if (roomId) {
    // Share the latest user message into the room so peers get it on their next turn
    const lastUser = [...(req.messages ?? [])].reverse().find(m => m.role === 'user')
    const userText = String(lastUser?.content ?? '').trim()
    if (userText) {
      roomPost(req.workspaceId, {
        fromTileId: req.cardId,
        fromTileType: 'chat',
        kind: 'message',
        text: userText.slice(0, 4000),
        meta: { source: 'chat_user_turn' },
      })
    }
  }
  if (!systemExtra.trim()) {
    return {
      ...req,
      roomContext: undefined,
      roomAckSequence: roomAckSequence ?? undefined,
    }
  }
  return {
    ...req,
    roomContext: systemExtra,
    roomAckSequence: roomAckSequence ?? undefined,
  }
}

function normalizeContextBucketBundle(context: LoadedMemoryContext | null | undefined): ChatContextBucketBundle | undefined {
  if (context?.contextBuckets && Array.isArray(context.contextBuckets.buckets)) {
    return context.contextBuckets
  }
  if (!context) return undefined

  const includedBuckets = Array.isArray(context.includedBuckets)
    ? context.includedBuckets.filter((bucket): bucket is string => typeof bucket === 'string' && bucket.trim().length > 0)
    : []
  const sections = Array.isArray(context.sections)
    ? context.sections.filter(section => includedBuckets.includes(section.bucket))
    : []
  const bucketOrder = Array.from(new Set(['local-only', 'remote-safe', ...includedBuckets, ...sections.map(section => section.bucket)]))

  return {
    version: 1,
    includedBuckets,
    buckets: bucketOrder.map(bucket => {
      const bucketSections = sections
        .filter(section => section.bucket === bucket)
        .map(section => ({
          scope: section.scope,
          displayPath: section.displayPath,
          importedFrom: section.importedFrom ?? null,
        }))
      return {
        bucket,
        included: includedBuckets.includes(bucket),
        sectionCount: bucketSections.length,
        sections: bucketSections,
      }
    }),
  }
}

function summarizeContextBucketBundle(bundle: ChatContextBucketBundle | undefined): string | undefined {
  const inspectSummary = String(bundle?.inspect?.summary ?? '').trim()
  if (inspectSummary) return inspectSummary
  if (!bundle) return undefined

  const sections = bundle.buckets
    .filter(bucket => bucket.included)
    .flatMap(bucket => bucket.sections)
  if (sections.length === 0) return undefined

  const paths = sections.slice(0, 3).map(section => section.displayPath)
  const suffix = sections.length > 3 ? ` +${sections.length - 3} more` : ''
  const bucketSummary = bundle.buckets
    .filter(bucket => bucket.included)
    .map(bucket => `${bucket.bucket}: ${bucket.sectionCount}`)
    .join(', ')
  return `Loaded ${sections.length} instruction section${sections.length === 1 ? '' : 's'} [${bucketSummary}]: ${paths.join(', ')}${suffix}`
}

function buildContextBucketInput(bundle: ChatContextBucketBundle | undefined, prompt: string | undefined): string | undefined {
  const inspectInput = String(bundle?.inspect?.input ?? '').trim()
  if (inspectInput) return inspectInput

  const promptText = String(prompt ?? '').trim() || undefined
  if (!bundle) return promptText

  const lines = [
    '## Outbound Context Buckets',
    `Included buckets: ${bundle.includedBuckets.length > 0 ? bundle.includedBuckets.join(', ') : 'none'}`,
    '',
  ]

  for (const bucket of bundle.buckets) {
    if (bucket.included) {
      lines.push(`### ${bucket.bucket}`)
      if (bucket.sections.length === 0) {
        lines.push('- no sections')
      } else {
        for (const section of bucket.sections) {
          lines.push(`- ${section.displayPath}${section.importedFrom ? ` (imported from ${section.importedFrom})` : ''}`)
        }
      }
    } else {
      lines.push(`### ${bucket.bucket} (omitted from outbound bundle)`)
      lines.push('- omitted from outbound bundle')
    }
    lines.push('')
  }

  if (promptText) {
    lines.push('## Injected Prompt')
    lines.push(promptText)
  }

  return lines.join('\n').trim() || undefined
}

function summarizeMemoryContext(context: LoadedMemoryContext | null | undefined): string | undefined {
  return summarizeContextBucketBundle(normalizeContextBucketBundle(context))
}

function buildMemoryContextInput(context: LoadedMemoryContext | null | undefined): string | undefined {
  return buildContextBucketInput(
    normalizeContextBucketBundle(context),
    String(context?.prompt ?? '').trim() || undefined,
  )
}

function boundOptionalRuntimeContext(value: unknown, maxBytes: number, reason: string): string | undefined {
  const normalized = String(value ?? '').trim()
  if (!normalized) return undefined
  return truncateUtf8(normalized, maxBytes, { reason }).text
}

function revalidateRuntimeContextRequest(req: ChatRequest): ChatRequest {
  const composed = composeHostChatContext(req)
  const skillsSummary = boundOptionalRuntimeContext(
    req.skillsSummary,
    MAX_SKILLS_SUMMARY_BYTES,
    `maximum skills summary bytes (${MAX_SKILLS_SUMMARY_BYTES})`,
  )
  const messages = appendComposedUserContextToLatestUser(req.messages, composed.context.userSuffix)
  const expandedMessages = req.expandedMessages
    ? appendComposedUserContextToLatestUser(req.expandedMessages, composed.context.userSuffix)
    : undefined
  return {
    ...req,
    peers: composed.peers,
    messages,
    ...(expandedMessages ? { expandedMessages } : {}),
    contextPrompt: composed.context.systemPrompt,
    memoryPrompt: undefined,
    roomContext: undefined,
    fileReferencePrompt: undefined,
    recentEditContext: undefined,
    blockNotesContext: undefined,
    skillsPrompt: undefined,
    skillsSummary,
  }
}

function emitMemoryContextLoaded(
  scope: ChatStreamScope,
  context: LoadedMemoryContext | null | undefined,
  sessionId?: string | null,
): void {
  const summary = summarizeMemoryContext(context)
  if (!summary) return
  const input = buildMemoryContextInput(context)
  if (!consumeStableContextAnnouncement({
    scope,
    kind: 'memory',
    sessionId,
    content: `${summary}\n${input ?? ''}`,
  })) return
  const toolId = `codesurf-memory-${Date.now()}`
  sendStream(scope, { type: 'tool_start', toolId, toolName: 'Workspace Instructions' })
  if (input) {
    sendStream(scope, { type: 'tool_input', toolId, text: previewContextToolInput(input).text })
  }
  sendStream(scope, { type: 'tool_summary', toolId, toolName: 'Workspace Instructions', text: summary })
}

function summarizeSelectedSkills(index: Awaited<ReturnType<typeof daemonClient.listSkills>> | null | undefined): string | undefined {
  return boundOptionalRuntimeContext(
    index?.selection?.summary,
    MAX_SKILLS_SUMMARY_BYTES,
    `maximum skills summary bytes (${MAX_SKILLS_SUMMARY_BYTES})`,
  )
}

function buildSelectedSkillsPrompt(index: Awaited<ReturnType<typeof daemonClient.listSkills>> | null | undefined): string | undefined {
  return String(index?.selection?.prompt ?? '').trim() || undefined
}

function emitSelectedSkillsLoaded(
  scope: ChatStreamScope,
  index: Awaited<ReturnType<typeof daemonClient.listSkills>> | null | undefined,
  sessionId?: string | null,
): void {
  const summary = summarizeSelectedSkills(index)
  if (!summary) return
  const input = buildSelectedSkillsPrompt(index)
  if (!consumeStableContextAnnouncement({
    scope,
    kind: 'skills',
    sessionId,
    content: `${summary}\n${input ?? ''}`,
  })) return
  const toolId = `codesurf-skills-${Date.now()}`
  sendStream(scope, { type: 'tool_start', toolId, toolName: 'Included Skills' })
  if (input) {
    sendStream(scope, { type: 'tool_input', toolId, text: previewContextToolInput(input).text })
  }
  sendStream(scope, { type: 'tool_summary', toolId, toolName: 'Included Skills', text: summary })
}

function emitSkippedSkillLocations(
  scope: ChatStreamScope,
  index: Awaited<ReturnType<typeof daemonClient.listSkills>> | null | undefined,
  sessionId?: string | null,
): void {
  const skipped = index?.skippedLocations ?? []
  if (skipped.length === 0) return
  const lines = skipped.map(entry => `${entry.path} (${entry.code})`).join('\n')
  const summary = `${skipped.length} skill location${skipped.length === 1 ? '' : 's'} could not be read. Skills from those paths were skipped.`
  if (!consumeStableContextAnnouncement({
    scope,
    kind: 'skills-skipped',
    sessionId,
    content: `${summary}\n${lines}`,
  })) return
  const toolId = `codesurf-skills-skipped-${Date.now()}`
  sendStream(scope, { type: 'tool_start', toolId, toolName: 'Skill Scan Warning' })
  if (lines) {
    sendStream(scope, { type: 'tool_input', toolId, text: lines })
  }
  sendStream(scope, { type: 'tool_summary', toolId, toolName: 'Skill Scan Warning', text: summary })
}

function emitFileReferenceExpansion(
  scope: ChatStreamScope,
  expansion: Awaited<ReturnType<typeof daemonClient.expandFileReferences>> | null | undefined,
): void {
  const summary = String(expansion?.summaryText ?? '').trim()
  if (!summary) return
  const toolId = `codesurf-file-refs-${Date.now()}`
  sendStream(scope, { type: 'tool_start', toolId, toolName: 'Workspace File References' })
  const input = String(expansion?.inputText ?? '').trim()
  if (input) {
    sendStream(scope, { type: 'tool_input', toolId, text: input })
  }
  sendStream(scope, { type: 'tool_summary', toolId, toolName: 'Workspace File References', text: summary })
}

async function loadRuntimeMemoryContext(req: ChatRequest): Promise<LoadedMemoryContext | null> {
  if (!req.workspaceId) return null
  const executionTarget = req.executionTarget === 'cloud' ? 'cloud' : 'local'
  const cached = readRuntimeStableLoad<LoadedMemoryContext | null>(
    'memory',
    req.workspaceId,
    req.cardId,
    executionTarget,
  )
  if (cached.hit) return cached.value
  const loaded = await daemonClient.loadMemoryContext(req.workspaceId, executionTarget)
  writeRuntimeStableLoad('memory', req.workspaceId, req.cardId, executionTarget, loaded)
  return loaded
}

async function loadRuntimeSkillsContext(req: ChatRequest): Promise<Awaited<ReturnType<typeof daemonClient.listSkills>> | null> {
  const workspaceId = String(req.workspaceId ?? '').trim()
  const workspaceDir = String(req.workspaceDir ?? '').trim()
  if (!workspaceId && !workspaceDir) return null
  const cached = readRuntimeStableLoad<Awaited<ReturnType<typeof daemonClient.listSkills>> | null>(
    'skills',
    workspaceId || workspaceDir,
    req.cardId,
    null,
  )
  if (cached.hit) return cached.value
  const loaded = await daemonClient.listSkills({
    workspaceId: workspaceId || null,
    workspaceDir: workspaceDir || null,
    cardId: req.cardId,
  })
  writeRuntimeStableLoad('skills', workspaceId || workspaceDir, req.cardId, null, loaded)
  return loaded
}

async function selectChatExecutionHost(req: ChatRequest): Promise<ExecutionHostRecord | null> {
  const { hosts, localDaemonAvailable } = await getExecutionRoutingState()
  const settings = readSettingsSync()
  const executionPreference = req.executionPreference ?? settings.execution
  const provider = String(req.provider ?? '').trim()

  if (!supportsDaemonChatProvider(provider)) {
    const providerLabel = provider || 'This provider'
    if (req.executionTarget === 'cloud') {
      throw new Error(`${providerLabel} does not support remote daemon execution yet. Daemon-backed chat currently supports Claude, Codex, OpenCode, Hermes, and Omnigent only.`)
    }
    if (executionPreference.mode === 'daemon-only' || executionPreference.mode === 'specific-host') {
      throw new Error(`${providerLabel} does not support daemon-backed chat yet. Supported daemon providers: Claude, Codex, OpenCode, Hermes, and Omnigent.`)
    }
    return null
  }

  if (req.executionTarget === 'cloud') {
    const remoteHosts = hosts.filter(host => host.type === 'remote-daemon' && host.enabled !== false)
    const chosen = remoteHosts.find(host => host.id === req.cloudHostId)
      ?? remoteHosts.find(host => host.id === executionPreference.hostId)
      ?? remoteHosts[0]
    if (!chosen) {
      throw new Error('No remote daemon is registered for cloud execution')
    }
    return chosen
  }

  const resolution = resolveExecutionTarget({
    hosts,
    preference: executionPreference,
    localDaemonAvailable,
  })
  if (executionPreference.mode === 'daemon-only' && resolution.host.type === 'runtime') {
    throw new Error('Execution requires the local daemon, but it is unavailable.')
  }
  if (resolution.host.type !== 'runtime') return resolution.host

  if (requiresDaemonChatProvider(provider)) {
    if (!localDaemonAvailable) {
      throw new Error(`${provider || 'This provider'} requires daemon-backed chat, but the local daemon is unavailable.`)
    }
    const localDaemonHost = hosts.find(host => host.type === 'local-daemon' && host.enabled !== false)
      ?? getBuiltinExecutionHosts().find(host => host.type === 'local-daemon')
    if (!localDaemonHost) {
      throw new Error(`${provider || 'This provider'} requires daemon-backed chat, but no local daemon host is registered.`)
    }
    return localDaemonHost
  }

  return null
}

type ProjectContextResult = {
  workspaceDir: string | null
  gitRemoteUrl: string | null
  gitBranch: string | null
  repoName: string | null
}

const PROJECT_CONTEXT_TTL_MS = 5000
const projectContextCache = new Map<string, { value: ProjectContextResult; expires: number }>()

async function buildProjectContext(workspaceDir: string | undefined): Promise<ProjectContextResult> {
  const normalizedWorkspace = String(workspaceDir ?? '').trim()
  if (!normalizedWorkspace) {
    return { workspaceDir: null, gitRemoteUrl: null, gitBranch: null, repoName: null }
  }

  const now = Date.now()
  const cached = projectContextCache.get(normalizedWorkspace)
  if (cached && cached.expires > now) return cached.value

  const shellPath = getShellEnvPath()
  const env = { ...process.env, ...(shellPath && { PATH: shellPath }) }

  const runGit = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: normalizedWorkspace, encoding: 'utf8', env })
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  const [toplevel, gitRemoteUrl, gitBranch] = await Promise.all([
    runGit(['rev-parse', '--show-toplevel']),
    runGit(['remote', 'get-url', 'origin']),
    runGit(['branch', '--show-current']),
  ])

  const repoRoot = toplevel || normalizedWorkspace
  const value: ProjectContextResult = {
    workspaceDir: repoRoot,
    gitRemoteUrl,
    gitBranch,
    repoName: basename(repoRoot) || null,
  }
  projectContextCache.set(normalizedWorkspace, { value, expires: now + PROJECT_CONTEXT_TTL_MS })
  return value
}

const daemonCardStreams = new Map<string, { identity: string; stream: DaemonCardStream }>()

function closeDaemonCardStream(scope: ChatStreamScope): void {
  const key = chatStreamScopeKey(scope)
  daemonCardStreams.get(key)?.stream.close()
  daemonCardStreams.delete(key)
}

async function getDaemonCardStream(scope: ChatStreamScope, host: ExecutionHostRecord): Promise<DaemonCardStream> {
  const endpoint = await resolveHostEndpoint(host)
  const identity = JSON.stringify([host.id, endpoint.baseUrl, endpoint.token])
  const key = chatStreamScopeKey(scope)
  const existing = daemonCardStreams.get(key)
  if (existing?.identity === identity) return existing.stream
  existing?.stream.close()
  const stream = new DaemonCardStream(endpoint, scope.cardId)
  daemonCardStreams.set(key, { identity, stream })
  return stream
}

async function attachDaemonJobStream(
  scope: ChatStreamScope,
  host: ExecutionHostRecord,
  jobId: string,
  sinceSequence = 0,
): Promise<void> {
  const scopeKey = chatStreamScopeKey(scope)
  const activity = activeDaemonJobs.register(scopeKey, jobId, host, 'foreground')
  const abortController = activity.abortController

  try {
    const stream = await getDaemonCardStream(scope, host)
    await stream.consumeJob(jobId, sinceSequence, abortController.signal, payload => {
      if (!activeDaemonJobs.isActive(activity) || abortController.signal.aborted) return
      if (isProviderAcceptanceEvent(payload)) markRoomPromptAccepted(scope)
      // Daemon SSE is never host attestation for a later local file read.
      sendStream(scope, { ...payload, fileChangesTrusted: false })
    })
    if (abortController.signal.aborted) return
    const state = await hostRequest<{ status: string; error?: string | null }>(
      host,
      `/chat/job/state?jobId=${encodeURIComponent(jobId)}`,
    ).catch(() => null)
    if (isSuccessfulProviderCompletion(state)) markRoomPromptAccepted(scope)
  } catch (error) {
    if (abortController.signal.aborted) return
    if (error instanceof Error && error.name === 'AbortError') return
    throw error
  } finally {
    activeDaemonJobs.complete(activity)
  }
}

function waitForDaemonMonitor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(finish, milliseconds)
    const onAbort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function monitorDetachedDaemonRoomAcceptance(
  scope: ChatStreamScope,
  host: ExecutionHostRecord,
  jobId: string,
): Promise<void> {
  const scopeKey = chatStreamScopeKey(scope)
  const activity = activeDaemonJobs.register(scopeKey, jobId, host, 'background')
  try {
    const outcome = await pollProviderCompletion({
      readState: () => hostRequest<{ status: string; error?: string | null }>(
        host,
        `/chat/job/state?jobId=${encodeURIComponent(jobId)}`,
        { signal: activity.abortController.signal },
      ),
      isActive: () => activeDaemonJobs.isActive(activity),
      wait: milliseconds => waitForDaemonMonitor(
        milliseconds,
        activity.abortController.signal,
      ),
    })
    if (outcome === 'accepted') markRoomPromptAccepted(scope)
    else if (outcome !== 'superseded') discardRoomContextAcknowledgement(scope)
  } finally {
    activeDaemonJobs.complete(activity)
  }
}

async function sendChatToDaemon(
  req: ChatRequest,
  host: ExecutionHostRecord,
  preparationLease: ChatPreparationLease,
): Promise<{ ok: boolean; jobId: string; detached?: boolean; error?: string }> {
  const scope = chatRequestScope(req)
  const rawProjectContext = await buildProjectContext(req.workspaceDir)
  const contextPolicy = buildProviderContextPolicy({
    executionTarget: req.executionTarget,
    hostType: host.type,
  })
  const projectContext = applyProjectContextPolicy(rawProjectContext, contextPolicy)

  log('daemon projectContext policy', {
    hostType: host.type,
    executionTarget: req.executionTarget ?? 'local',
    reason: contextPolicy.reason,
    raw: describeProjectContextEnvelope(rawProjectContext),
    effective: describeProjectContextEnvelope(projectContext),
  })

  const requestWithProviderSettings: ChatRequest = req.provider === 'omnigent'
    ? {
      ...req,
      omnigent: req.omnigent ?? readSettingsSync().omnigent,
    }
    : req

  let cardStream: DaemonCardStream | undefined
  let job: { id: string; status: string }
  try {
    if (!chatPreparationFence.isCurrent(preparationLease)) {
      return { ok: false, jobId: '', error: 'Chat preparation superseded' }
    }
    if (req.runMode !== 'background') {
      cardStream = await getDaemonCardStream(scope, host)
      await cardStream.prepare()
    }
    if (!chatPreparationFence.isCurrent(preparationLease)) {
      cardStream?.finishPreparation()
      return { ok: false, jobId: '', error: 'Chat preparation superseded' }
    }
    job = await hostRequest<{
      id: string
      status: string
    }>(host, '/chat/job/start', {
      body: {
        request: {
          ...requestWithProviderSettings,
          messages: getPreparedMessages(requestWithProviderSettings),
          projectContext,
        },
      },
    })
    if (!chatPreparationFence.isCurrent(preparationLease)) {
      cardStream?.finishPreparation()
      try {
        await hostRequest(host, '/chat/job/cancel', { body: { jobId: job.id } })
      } catch {
        // Best effort: invalidation still prevents stream attachment and ACKs.
      }
      return { ok: false, jobId: '', error: 'Chat preparation superseded' }
    }
    registerRoomContextAcknowledgement(req)
  } catch (error) {
    cardStream?.finishPreparation()
    const message = error instanceof Error ? error.message : String(error)
    sendStream(scope, { type: 'error', error: message })
    sendStream(scope, { type: 'done' })
    return { ok: false, jobId: '' }
  }

  if (req.runMode !== 'background') {
    void attachDaemonJobStream(scope, host, job.id, 0).catch((error: Error) => {
      sendStream(scope, { type: 'error', error: error.message, jobId: job.id })
      sendStream(scope, { type: 'done', jobId: job.id })
    })
  } else {
    sendStream(scope, {
      type: 'tool_summary',
      toolName: 'Background job',
      text: `Started detached ${requestWithProviderSettings.provider} job ${job.id}.`,
      jobId: job.id,
    })
    sendStream(scope, { type: 'done', jobId: job.id })
    void monitorDetachedDaemonRoomAcceptance(scope, host, job.id)
  }

  return { ok: true, jobId: job.id, detached: req.runMode === 'background' }
}

async function resumeChatDaemonJob(req: ChatRequest): Promise<{ ok: boolean; resumed: boolean; jobId: string | null }> {
  const scope = chatRequestScope(req)
  if (!req.jobId) return { ok: false, resumed: false, jobId: null }
  const host = await selectChatExecutionHost(req)
  if (!host) return { ok: false, resumed: false, jobId: req.jobId }

  const state = await hostRequest<{
    id: string
    status: string
    lastSequence: number
    error?: string | null
    sessionId?: string | null
  }>(host, `/chat/job/state?jobId=${encodeURIComponent(req.jobId)}`)

  const sinceSequence = Number(req.jobSequence ?? 0)
  if (state.status !== 'running' && sinceSequence >= Number(state.lastSequence ?? 0)) {
    if (state.error) {
      sendStream(scope, { type: 'error', error: state.error, jobId: req.jobId, sequence: state.lastSequence })
    }
    sendStream(scope, { type: 'done', jobId: req.jobId, sequence: state.lastSequence, sessionId: state.sessionId ?? undefined })
    return { ok: true, resumed: false, jobId: req.jobId }
  }

  void attachDaemonJobStream(scope, host, req.jobId, sinceSequence).catch((error: Error) => {
    sendStream(scope, { type: 'error', error: error.message, jobId: req.jobId })
    sendStream(scope, { type: 'done', jobId: req.jobId })
  })

  return { ok: true, resumed: true, jobId: req.jobId }
}

async function cancelChatDaemonJobs(scope: ChatStreamScope): Promise<{ ok: boolean, errors: string[] }> {
  const scopeKey = chatStreamScopeKey(scope)
  const jobs = activeDaemonJobs.list(scopeKey)
  const errors: string[] = []
  await Promise.all(jobs.map(async job => {
    try {
      const result = await hostRequest<{ ok?: boolean, error?: string }>(job.host, '/chat/job/cancel', {
        body: { jobId: job.jobId },
      })
      if (result?.ok !== true) {
        const state = await hostRequest<{ status?: string }>(
          job.host,
          `/chat/job/state?jobId=${encodeURIComponent(job.jobId)}`,
        ).catch(() => null)
        if (state?.status !== 'completed' && state?.status !== 'failed') {
          errors.push(`${job.jobId}: ${result?.error || 'daemon did not confirm cancellation'}`)
          return
        }
      }
      job.abortController.abort()
      activeDaemonJobs.complete(job)
    } catch (error) {
      log('daemon cancel error', job.jobId, error)
      errors.push(
        `${job.jobId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }))
  return { ok: errors.length === 0, errors }
}

/**
 * Tear down every in-flight provider for a card (Claude SDK query, CLI procs,
 * HTTP streams, daemon jobs, OpenCode, csagent). Shared by chat:stop,
 * chat:disposeCard, and foreground chat:send replace so no path leaves
 * orphaned work streaming into a dead cardId.
 */
async function stopCardExecution(
  scope: ChatStreamScope,
  options?: { emitDone?: boolean, reason?: string, preservePreparation?: boolean },
): Promise<{ ok: boolean, error?: string }> {
  const reason = options?.reason ?? 'Chat stopped'
  const scopeKey = chatStreamScopeKey(scope)
  if (!options?.preservePreparation) chatPreparationFence.invalidate(scopeKey)
  // Lifecycle completion generated by an explicit stop is not evidence that
  // the provider accepted this turn. Preserve unread peer context for retry.
  discardRoomContextAcknowledgement(scope)
  const ac = cardAbortControllers.get(scopeKey)
  if (ac) {
    ac.abort()
    cardAbortControllers.delete(scopeKey)
  }
  const q = activeQueries.get(scopeKey)
  if (q) {
    markClaudeQueryIntentionallyClosed(q)
    q.close()
    activeQueries.delete(scopeKey)
  }
  const processTermination = await stopActiveChatProcess(scopeKey)
  stopLocalProxyTurn(scope)
  stopGatewayTurn(scope)
  const daemonCancellation = await cancelChatDaemonJobs(scope)
  cancelPendingAskUserQuestionsForCard(scope, reason)
  cancelPendingToolPermissionsForCard(scope, reason)
  cardPermissionModes.delete(scopeKey)
  await abortOpenCodeSession(scope)
  try { await stopCsagent(scope) } catch { /* best-effort */ }
  disposeCsagent(scope)
  await cleanupOwnedImageAttachmentsForScope(scope)

  const failures: string[] = []
  if (processTermination && !processTermination.confirmed) {
    failures.push(`CLI process tree: ${processTermination.detail}`)
  }
  if (!daemonCancellation.ok) {
    failures.push(...daemonCancellation.errors.map(error => `daemon job ${error}`))
  }
  if (failures.length > 0) {
    const error = `${reason}, but termination could not be confirmed: ${failures.join('; ')}`
    sendStream(scope, { type: 'error', error })
    return { ok: false, error }
  }
  if (options?.emitDone !== false) {
    sendStream(scope, { type: 'done' })
  }
  return { ok: true }
}

export function registerChatIPC(): void {
  log('registerChatIPC: handlers registered')
  ipcMain.handle('chat:send', async (_, incomingReq: ChatRequest) => {
    const scope = validatedChatScope(incomingReq?.workspaceId, incomingReq?.cardId)
    if (!scope) {
      return { ok: false, error: 'Invalid or missing workspace/card identity' }
    }
    const req: ChatRequest = {
      ...incomingReq,
      workspaceId: scope.workspaceId,
      cardId: scope.cardId,
    }
    const requestedRunMode = req.runMode === 'background' ? 'background' : 'foreground'
    const scopeKey = chatStreamScopeKey(scope)
    return chatLifecycleCoordinator.runSend(
      scopeKey,
      requestedRunMode,
      async preparationLease => {
    // Lease persistence before any asynchronous request preparation. A clear
    // that occurs while memory/skills/files are loading tombstones this turn.
    // Detached daemon work does not replace a live local foreground writer.
    const runtimePersistenceLease = beginRuntimeSessionPersistence(
      req,
      requestedRunMode === 'foreground',
    )
    const submittedPeers = incomingReq?.peers
    log('chat:send received', { provider: req.provider, model: req.model, msgCount: req.messages.length })
    const preparationIsCurrent = (): boolean => chatPreparationFence.isCurrent(preparationLease)
    const providerLaunchGuard: ProviderLaunchGuard = { isCurrent: preparationIsCurrent }
    const preparationSuperseded = (): { ok: false; error: string } => ({
      ok: false,
      error: 'Chat preparation superseded',
    })
    if (requestedRunMode === 'foreground') {
      // Foreground turns replace the current foreground execution for this card.
      // Full stop (incl. csagent) so the previous turn cannot interleave events.
      // emitDone:false — the new turn owns the stream; a premature done would
      // flip the UI to idle before the replacement send starts.
      const replacementStop = await stopCardExecution(scope, {
        emitDone: false,
        reason: 'Replaced by new turn',
        preservePreparation: true,
      })
      if (!replacementStop.ok) return replacementStop
      if (!preparationIsCurrent()) return preparationSuperseded()
    }

    let canonicalRequest: ChatRequest
    try {
      canonicalRequest = await canonicalizeElectronChatRequest(req, getWorkspacePathById)
      const peerAuthority = await loadAuthoritativeChatPeers(
        scope.workspaceId,
        scope.cardId,
        submittedPeers,
      )
      canonicalRequest = {
        ...canonicalRequest,
        peers: peerAuthority.peers,
        untrustedPeerContext: peerAuthority.untrustedPeerContext,
        providerTransport: await resolveHostChatProvider({
          workspaceId: scope.workspaceId,
          workspaceDir: canonicalRequest.workspaceDir ?? '',
          provider: canonicalRequest.provider,
          model: canonicalRequest.model,
          peers: peerAuthority.peers,
        }),
        negotiatedTools: getAuthoritativeNegotiatedPeerTools(
          peerAuthority.peers,
          canonicalRequest.mcpEnabled,
        ),
      }
    } catch (error) {
      if (!preparationIsCurrent()) return preparationSuperseded()
      sendStream(scope, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      sendStream(scope, { type: 'done' })
      return { ok: false }
    }
    if (!preparationIsCurrent()) return preparationSuperseded()

    const authoritativeResolution = await resolveAuthoritativeAgentMode({
      agentId: canonicalRequest.agentId ?? null,
      resolveWorkspaceRoot: () => canonicalRequest.workspaceDir ?? null,
    })
    if (!preparationIsCurrent()) return preparationSuperseded()
    if (!authoritativeResolution.ok) {
      sendStream(scope, { type: 'error', error: authoritativeResolution.error })
      sendStream(scope, { type: 'done' })
      return { ok: false }
    }
    const authoritativeAgentMode = authoritativeResolution.agentMode

    let policyRequest: ChatRequest
    try {
      policyRequest = applyAuthoritativePersonaPolicy(
        canonicalRequest,
        authoritativeAgentMode,
      )
    } catch (error) {
      if (!preparationIsCurrent()) return preparationSuperseded()
      sendStream(scope, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      sendStream(scope, { type: 'done' })
      return { ok: false }
    }
    if (!preparationIsCurrent()) return preparationSuperseded()

    let daemonHost: ExecutionHostRecord | null = null
    let localDaemonAvailable = false
    try {
      localDaemonAvailable = (await getExecutionRoutingState()).localDaemonAvailable
      daemonHost = await selectChatExecutionHost(policyRequest)
      const hasHostAttachments = await hasHostValidatedAttachments(policyRequest, daemonHost)
      daemonHost = routeHostForAttachments({
        selectedHost: daemonHost,
        executionMode: (policyRequest.executionPreference ?? readSettingsSync().execution).mode,
        hasHostAttachments,
      })
    } catch (error) {
      if (!preparationIsCurrent()) return preparationSuperseded()
      sendStream(scope, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      sendStream(scope, { type: 'done' })
      return { ok: false }
    }
    if (!preparationIsCurrent()) return preparationSuperseded()

    const effectiveRequest: ChatRequest = {
      ...policyRequest,
      agentMode: authoritativeAgentMode,
      runMode: requestedRunMode,
      asyncExecution: buildAsyncExecutionContext({
        request: { ...policyRequest, runMode: requestedRunMode },
        daemonHost,
        localDaemonAvailable,
      }),
    }

    let memoryPrompt: string | undefined
    let memoryContext: Awaited<ReturnType<typeof daemonClient.loadMemoryContext>> | null = null
    let skillsPrompt: string | undefined
    let skillsSummary: string | null = null
    let skillsContext: Awaited<ReturnType<typeof daemonClient.listSkills>> | null = null
    // Daemon jobs strip caller memory/skills and rebuild them. Prefetching here
    // only wastes /memory/load and /skills/list on every turn.
    if (hostShouldPrefetchStableContext(daemonHost)) {
      try {
        memoryContext = await loadRuntimeMemoryContext(effectiveRequest)
        memoryPrompt = String(memoryContext?.prompt ?? '').trim() || undefined
      } catch (error) {
        if (!preparationIsCurrent()) return preparationSuperseded()
        sendStream(scope, {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        sendStream(scope, { type: 'done' })
        return { ok: false }
      }
      if (!preparationIsCurrent()) return preparationSuperseded()

      try {
        skillsContext = await loadRuntimeSkillsContext(effectiveRequest)
        skillsPrompt = buildSelectedSkillsPrompt(skillsContext)
        skillsSummary = summarizeSelectedSkills(skillsContext) ?? null
      } catch (error) {
        console.warn(
          '[chat] Skills index unavailable; continuing without skill context:',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    if (!preparationIsCurrent()) return preparationSuperseded()

    const requestWithContext: ChatRequest = {
      ...effectiveRequest,
      ...(memoryPrompt ? { memoryPrompt } : {}),
      ...(memoryContext?.contextBuckets ? { contextBuckets: memoryContext.contextBuckets } : {}),
      ...(skillsPrompt ? { skillsPrompt, skillsSummary } : {}),
    }

    let requestWithFileReferences: ChatRequest = requestWithContext
    let fileReferenceExpansion: Awaited<ReturnType<typeof daemonClient.expandFileReferences>> | null = null
    try {
      // Capability expansion can consume one-shot handles; never enter it for
      // a turn invalidated by replacement, stop, clear, or disposal.
      if (!preparationIsCurrent()) return preparationSuperseded()
      if (!daemonHost || daemonHost.type === 'remote-daemon') {
        const expanded = await expandLatestUserFileReferences(
          requestWithContext,
          daemonHost?.type === 'remote-daemon',
        )
        requestWithFileReferences = expanded.request
        fileReferenceExpansion = expanded.expansion
      }
    } catch (error) {
      await cleanupOwnedImageAttachmentsForScope(scope)
      if (!preparationIsCurrent()) return preparationSuperseded()
      sendStream(scope, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      sendStream(scope, { type: 'done' })
      return { ok: false }
    }
    if (!preparationIsCurrent()) {
      await cleanupOwnedImageAttachmentsForScope(scope)
      return preparationSuperseded()
    }

    emitFileReferenceExpansion(scope, fileReferenceExpansion)

    // Room membership + consume pending traffic (all execution backends)
    if (!preparationIsCurrent()) {
      await cleanupOwnedImageAttachmentsForScope(scope)
      return preparationSuperseded()
    }
    requestWithFileReferences = revalidateRuntimeContextRequest(
      attachRoomContext(requestWithFileReferences),
    )
    bindRuntimeSessionPersistence(requestWithFileReferences, runtimePersistenceLease)

    if (daemonHost) {
      log('chat execution route', {
        cardId: req.cardId,
        provider: req.provider,
        model: req.model,
        runMode: requestedRunMode,
        executionTarget: req.executionTarget ?? 'local',
        executionPreference: req.executionPreference ?? null,
        backend: 'daemon',
        hostId: daemonHost.id,
        hostType: daemonHost.type,
      })
      if (!preparationIsCurrent()) return preparationSuperseded()
      return await sendChatToDaemon(requestWithFileReferences, daemonHost, preparationLease)
    }

    emitMemoryContextLoaded(scope, memoryContext, effectiveRequest.sessionId)
    emitSelectedSkillsLoaded(scope, skillsContext, effectiveRequest.sessionId)
    emitSkippedSkillLocations(scope, skillsContext, effectiveRequest.sessionId)

    if (requestedRunMode === 'background') {
      await cleanupOwnedImageAttachmentsForScope(scope)
      sendStream(scope, {
        type: 'error',
        error: 'Detached background chat execution currently requires a daemon-backed Claude or Codex host.',
      })
      sendStream(scope, { type: 'done' })
      return { ok: false }
    }

    log('chat execution route', {
      cardId: req.cardId,
      provider: req.provider,
      model: req.model,
      runMode: requestedRunMode,
      executionTarget: req.executionTarget ?? 'local',
      executionPreference: req.executionPreference ?? null,
      backend: 'runtime',
    })

    // A-PR1 BLOCKING-1 (security chokepoint): a selected agent whose definition
    // has not resolved must not launch unrestricted on ANY runtime provider.
    // chatClaude/chatCodex/chatHermes each also fail closed via their builders
    // (defense-in-depth), but opencode/openclaw/csagent/local-proxy ignore
    // agentMode entirely — so this switch-level guard is the non-bypassable net
    // that covers every provider in one place.
    if (agentModeUnresolved(requestWithFileReferences)) {
      await cleanupOwnedImageAttachmentsForScope(scope)
      sendStream(scope, { type: 'error', error: AGENT_MODE_UNRESOLVED_ERROR })
      sendStream(scope, { type: 'done' })
      return { ok: false }
    }

    if (
      requestWithFileReferences.providerTransport?.type === 'local-proxy'
      && BUILTIN_CHAT_PROVIDERS.has(requestWithFileReferences.provider)
    ) {
      await cleanupOwnedImageAttachmentsForScope(scope)
      sendStream(scope, {
        type: 'error',
        error: `Extension provider id cannot use reserved built-in provider: ${requestWithFileReferences.provider}`,
      })
      sendStream(scope, { type: 'done' })
      return { ok: false }
    }

    if (!preparationIsCurrent()) {
      await cleanupOwnedImageAttachmentsForScope(scope)
      return preparationSuperseded()
    }
    registerRoomContextAcknowledgement(requestWithFileReferences)
    const reportProviderRejection = (error: unknown): void => {
      void cleanupOwnedImageAttachmentsForScope(scope)
      sendStream(scope, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      sendStream(scope, { type: 'done' })
    }
    try {
      switch (requestWithFileReferences.provider) {
        case 'claude': chatClaude(requestWithFileReferences); break
        case 'codex':
          void chatCodex(requestWithFileReferences, providerLaunchGuard).catch(reportProviderRejection)
          break
        case 'opencode': chatOpencode(requestWithFileReferences, providerLaunchGuard); break
        case 'openclaw': chatOpenclaw(requestWithFileReferences); break
        case 'hermes': chatHermes(requestWithFileReferences); break
        case 'gateway':
          // No writeTileMcpConfig here on purpose. This branch is the
          // IN-PROCESS gateway, which calls executeChatAgentTool directly and
          // never reads that file; and the daemon route cannot reach this
          // switch at all (supportsDaemonChatProvider excludes 'gateway', and
          // the daemon branch returns earlier). Writing it anyway put a live
          // tile bearer token on disk every turn for zero consumers.
          //
          // If daemon-executed gateway jobs are enabled later, add 'gateway'
          // to supportsDaemonChatProvider and write the config in the daemon
          // branch above — not here, where it would still be dead.
          chatGateway(requestWithFileReferences)
          break
        case 'csagent':
          void chatCsagent(requestWithFileReferences, providerLaunchGuard).catch(reportProviderRejection)
          break
        default:
          if (requestWithFileReferences.providerTransport?.type === 'local-proxy') {
            chatLocalProxy(requestWithFileReferences)
          } else {
            void cleanupOwnedImageAttachmentsForScope(scope)
            sendStream(scope, { type: 'error', error: `Unsupported provider: ${requestWithFileReferences.provider}` })
            sendStream(scope, { type: 'done' })
          }
      }
    } catch (error) {
      reportProviderRejection(error)
      return { ok: false }
    }

    return { ok: true }
      },
    )
  })

  ipcMain.handle('chat:resumeJob', (_, req: ChatRequest) => {
    const scope = validatedChatScope(req?.workspaceId, req?.cardId)
    if (!scope) {
      return { ok: false, resumed: false, jobId: req?.jobId ?? null }
    }
    return resumeChatDaemonJob({
      ...req,
      workspaceId: scope.workspaceId,
      cardId: scope.cardId,
    })
  })

  ipcMain.handle('chat:steer', async (_, payload: {
    workspaceId?: string
    cardId?: string
    message?: string
  }) => {
    const scope = validatedChatScope(payload?.workspaceId, payload?.cardId)
    const message = String(payload?.message ?? '').trim()
    if (!scope || !message) {
      return { ok: false, error: 'invalid workspace/card identity or message' }
    }
    try {
      if (await steerCsagent(scope, message)) {
        sendStream(scope, { type: 'steer_sent', text: message })
        return { ok: true }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const q = activeQueries.get(chatStreamScopeKey(scope))
    if (!q) return { ok: false, error: 'no active steerable Claude stream' }
    try {
      await q.streamInput(buildClaudeTextInput(message, 'now'))
      sendStream(scope, { type: 'steer_sent', text: message })
      return { ok: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log('chat:steer failed:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('chat:stop', async (_, payload: {
    workspaceId?: string
    cardId?: string
  }) => {
    const scope = validatedChatScope(payload?.workspaceId, payload?.cardId)
    if (!scope) return { ok: false, error: 'invalid workspace/card identity' }
    return chatLifecycleCoordinator.runLifecycle(chatStreamScopeKey(scope), async () => {
      return await stopCardExecution(scope, {
        emitDone: true,
        reason: 'Chat stopped',
        preservePreparation: true,
      })
    })
  })

  // Permanently dispose a card's chat state when its tile is deleted. Unlike
  // clearSession (same tile, fresh conversation) this also stops live work and
  // prunes the persisted session-ids.json so neither the in-memory maps nor the
  // on-disk file grow unbounded across the install lifetime.
  ipcMain.handle('chat:disposeCard', async (_, payload: {
    workspaceId?: string
    cardId?: string
  }) => {
    const scope = validatedChatScope(payload?.workspaceId, payload?.cardId)
    if (!scope) return { ok: false, error: 'invalid workspace/card identity' }
    return chatLifecycleCoordinator.runLifecycle(chatStreamScopeKey(scope), async () => {
      // Stop every provider first — tile delete used to only clear session maps,
      // leaving Codex/Claude/daemon/csagent running against a dead cardId.
      const stopResult = await stopCardExecution(scope, {
        emitDone: true,
        reason: 'Card disposed',
        preservePreparation: true,
      })
      if (!stopResult.ok) return stopResult
      closeDaemonCardStream(scope)
      let runtimeClearError: string | null = null
      try {
        await clearRuntimeSessionState(scope)
      } catch (error) {
        runtimeClearError = error instanceof Error ? error.message : String(error)
      }
      deleteCardSessionIds(scope)
      clearOpenCodeSession(scope)
      clearOpenclawSession(scope)
      clearHermesSession(scope)
      clearCsagentSession(scope)
      // Drop the tile-scoped MCP token so a deleted tile's agent can no longer auth.
      revokeTileToken(scope.workspaceId, scope.cardId)
      // Schedule a rewrite of session-ids.json from the (now-pruned) map.
      persistSessionIds()
      return runtimeClearError
        ? { ok: false, error: `Card disposed locally, but daemon session cleanup failed: ${runtimeClearError}` }
        : { ok: true }
    })
  })

  // Clear session for a card (start fresh conversation)
  ipcMain.handle('chat:clearSession', async (_, payload: {
    workspaceId?: string
    cardId?: string
  }) => {
    const scope = validatedChatScope(payload?.workspaceId, payload?.cardId)
    if (!scope) return { ok: false, error: 'invalid workspace/card identity' }
    return chatLifecycleCoordinator.runLifecycle(chatStreamScopeKey(scope), async () => {
      return await runConfirmedSessionClear({
        // Clearing is a lifecycle boundary: stop every provider before
        // evicting state so late close/events cannot recreate the record.
        stopExecution: () => stopCardExecution(scope, {
          emitDone: true,
          reason: 'Session cleared',
          preservePreparation: true,
        }),
        clearPersistedState: () => {
          closeDaemonCardStream(scope)
          return clearRuntimeSessionState(scope)
        },
        evictSessionState: () => {
          deleteCardSessionIds(scope)
          clearOpenCodeSession(scope)
          clearOpenclawSession(scope)
          clearHermesSession(scope)
          clearCsagentSession(scope)
          cancelPendingAskUserQuestionsForCard(scope, 'Session cleared')
          cancelPendingToolPermissionsForCard(scope, 'Session cleared')
          cardPermissionModes.delete(chatStreamScopeKey(scope))
          // Persist eviction so the cleared session does not return on restart.
          persistSessionIds()
          log('session cleared for card', scope.workspaceId, scope.cardId)
        },
      })
    })
  })

  // Change the Claude SDK permission mode mid-thread. This lets the user flip
  // from Default -> Bypass (or vice versa) without ending the current turn.
  // If switching TO bypass, any pending permission prompts auto-resolve as
  // "once" (allow) so the agent stops waiting on the UI.
  ipcMain.handle('chat:setPermissionMode', async (_, payload: {
    workspaceId: string
    cardId: string
    mode: string
  }) => {
    const scope = validatedChatScope(payload?.workspaceId, payload?.cardId)
    if (!scope) {
      return { ok: false, error: 'invalid payload' }
    }
    const sdkModeMap: Record<string, string> = {
      default: 'default',
      acceptEdits: 'acceptEdits',
      plan: 'plan',
      bypassPermissions: 'bypassPermissions',
    }
    const sdkMode = sdkModeMap[payload.mode ?? '']
    if (!sdkMode) {
      return { ok: false, error: `unknown mode: ${payload.mode}` }
    }

    const scopeKey = chatStreamScopeKey(scope)
    const previous = cardPermissionModes.get(scopeKey) ?? 'default'
    cardPermissionModes.set(scopeKey, sdkMode)

    // Tell the SDK too, so any internal gating (hooks, agents) uses the new
    // mode. Swallow errors — the query may have already closed.
    const activeQuery = activeQueries.get(scopeKey)
    if (activeQuery) {
      try {
        await activeQuery.setPermissionMode(sdkMode as any)
      } catch (err) {
        log('setPermissionMode SDK call failed:', (err as Error).message)
      }
    }

    // Auto-resolve pending prompts when flipping to bypass so the agent
    // unblocks immediately.
    if (sdkMode === 'bypassPermissions') {
      for (const [key, pending] of pendingToolPermissions.entries()) {
        let parsed: unknown
        try { parsed = JSON.parse(key) } catch { continue }
        if (!Array.isArray(parsed) || parsed[0] !== scopeKey) continue
        pendingToolPermissions.delete(key)
        try { pending.resolve('once') } catch { /* noop */ }
        // Tell the UI the pending chip is gone.
        const toolUseID = typeof parsed[1] === 'string' && parsed[1] ? parsed[1] : null
        sendStream(scope, {
          type: 'tool_permission_resolved',
          toolId: toolUseID,
          decision: 'once',
          reason: 'mode_change',
        })
      }
    }

    sendStream(scope, {
      type: 'permission_mode_changed',
      mode: sdkMode,
      previous,
    })

    return { ok: true }
  })

  // Tool permission — receive the user's decision from the renderer and resolve
  // the pending canUseTool promise so the agent can continue (or halt).
  ipcMain.handle('chat:answerToolPermission', async (_, payload: {
    workspaceId: string
    cardId: string
    toolId: string | null
    decision: ToolPermissionDecision
  }) => {
    const scope = validatedChatScope(payload?.workspaceId, payload?.cardId)
    if (!scope) {
      return { ok: false, error: 'invalid payload' }
    }
    const validDecisions: ToolPermissionDecision[] = ['deny', 'never', 'once', 'session', 'today', 'forever']
    if (!validDecisions.includes(payload.decision)) {
      return { ok: false, error: 'invalid decision' }
    }
    const delivered = resolvePendingToolPermission(scope, payload.toolId ?? null, payload.decision)
    if (!delivered) {
      const activeDaemon = activeDaemonJobs.latest(chatStreamScopeKey(scope), 'foreground')
        ?? activeDaemonJobs.latest(chatStreamScopeKey(scope))
      if (activeDaemon) {
        try {
          return await hostRequest(activeDaemon.host, '/chat/job/permission/answer', {
            body: {
              jobId: activeDaemon.jobId,
              toolId: payload.toolId ?? '',
              decision: payload.decision,
            },
          })
        } catch (error) {
          log('chat:answerToolPermission daemon reply failed:', error instanceof Error ? error.message : String(error))
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      log('chat:answerToolPermission: no pending request for', scope.workspaceId, scope.cardId, payload.toolId)
      return { ok: false, error: 'no pending request' }
    }
    return { ok: true }
  })

  // AskUserQuestion — receive the user's form submission from the renderer and
  // resolve the pending canUseTool promise so the agent can continue.
  ipcMain.handle('chat:answerUserQuestion', async (_, payload: {
    workspaceId: string
    cardId: string
    toolId: string | null
    answers: Record<string, string>
    annotations?: Record<string, { notes?: string; preview?: string }>
  }) => {
    const scope = validatedChatScope(payload?.workspaceId, payload?.cardId)
    if (!scope) {
      return { ok: false, error: 'invalid payload' }
    }
    const answers = (payload.answers && typeof payload.answers === 'object') ? payload.answers : {}
    const annotations = (payload.annotations && typeof payload.annotations === 'object') ? payload.annotations : undefined
    const delivered = resolvePendingAskUserQuestion(scope, payload.toolId ?? null, { answers, annotations })
    if (!delivered) {
      log('chat:answerUserQuestion: no pending question for', scope.workspaceId, scope.cardId, payload.toolId)
      return { ok: false, error: 'no pending question' }
    }
    // Emit a tool_summary so the form is replaced by a permanent summary of the
    // user's selections (persists across re-renders and session rehydration).
    const summaryLines = Object.entries(answers).map(([q, a]) => `• ${q} — ${a}`)
    if (summaryLines.length > 0) {
      sendStream(scope, {
        type: 'tool_summary',
        toolId: payload.toolId,
        toolName: 'AskUserQuestion',
        text: summaryLines.join('\n'),
      })
    }
    return { ok: true }
  })

  // Open a file picker dialog for attachments
  ipcMain.handle('chat:selectFiles', async (_, workspaceId: string, cardId: string) => {
    const scope = validatedChatScope(workspaceId, cardId)
    if (!scope || !(await getWorkspacePathById(scope.workspaceId))) {
      throw new Error('A registered workspace and card are required')
    }
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach Files',
    })
    if (result.canceled || result.filePaths.length === 0) return []
    await ensureDaemonRunning()
    const issued = await daemonClient.issueAttachmentCapabilities({
      workspaceId: scope.workspaceId,
      cardId: scope.cardId,
      paths: result.filePaths,
    })
    return issued.attachments
  })

  // Paths on this channel are produced only inside preload via
  // webUtils.getPathForFile(File). Synthetic File objects and renderer-authored
  // URI/text paths never reach this IPC.
  ipcMain.handle('chat:authorizeDroppedFiles', async (
    _,
    workspaceId: string,
    cardId: string,
    paths: string[],
  ) => {
    const scope = validatedChatScope(workspaceId, cardId)
    if (!scope || !(await getWorkspacePathById(scope.workspaceId))) {
      throw new Error('A registered workspace and card are required')
    }
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 12) return []
    await ensureDaemonRunning()
    const issued = await daemonClient.issueAttachmentCapabilities({
      workspaceId: scope.workspaceId,
      cardId: scope.cardId,
      paths,
    })
    return issued.attachments
  })

  ipcMain.handle('chat:openclawAgents', async () => listOpenclawAgents())

  // Write a bounded renderer payload and return only a host-issued capability.
  ipcMain.handle('chat:writeTempAttachment', async (_, payload: {
    workspaceId: string
    cardId: string
    data: string            // base64 (no data-URL prefix)
    mime?: string           // e.g. 'image/png'
    ext?: string            // e.g. 'png'
    filenameHint?: string   // optional, no path components
  }) => {
    let dest: string | null = null
    let destHandle: Awaited<ReturnType<typeof fs.open>> | null = null
    let destIdentity: TempAttachmentIdentity | null = null
    try {
      const scope = validatedChatScope(payload?.workspaceId, payload?.cardId)
      if (!scope || !(await getWorkspacePathById(scope.workspaceId))) {
        return { ok: false, error: 'A registered workspace and card are required' }
      }
      if (!payload || typeof payload.data !== 'string' || !payload.data) {
        return { ok: false, error: 'missing data' }
      }
      const maxDecodedBytes = 5 * 1024 * 1024
      const maxEncodedBytes = Math.ceil(maxDecodedBytes / 3) * 4
      if (payload.data.length > maxEncodedBytes) {
        return { ok: false, error: `attachment exceeds ${maxDecodedBytes} bytes` }
      }
      if (
        payload.data.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.data)
      ) {
        return { ok: false, error: 'attachment data must be canonical base64' }
      }
      const buf = Buffer.from(payload.data, 'base64')
      if (buf.byteLength > maxDecodedBytes || buf.toString('base64') !== payload.data) {
        return { ok: false, error: 'attachment data is invalid or too large' }
      }
      const ext = (
        (payload.ext || (payload.mime?.split('/')[1]) || 'png')
          .replace(/[^a-z0-9]/gi, '')
          .toLowerCase()
          .slice(0, 12)
        || 'png'
      )
      const safeHint = (payload.filenameHint || 'sketch')
        .normalize('NFKD')
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 40) || 'sketch'
      // ~/.codesurf/chat-attachments — see chat-vision comment above for
      // the rationale: stable, user-owned path inside the daemon's
      // permission scope so agent jobs can Read attachments back.
      const dir = join(CODESURF_HOME, 'chat-attachments')
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const dirStat = await fs.lstat(dir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
        throw new Error('Attachment directory must be a canonical directory')
      }
      await fs.chmod(dir, 0o700)
      const filename = `codesurf-owned-v1-${Date.now()}-${randomUUID()}-${safeHint}.${ext}`
      dest = join(dir, filename)
      destHandle = await fs.open(dest, 'wx', 0o600)
      try {
        await destHandle.writeFile(buf)
        await destHandle.sync()
      } finally {
        const stat = await destHandle.stat().catch(() => null)
        if (stat?.isFile()) {
          destIdentity = {
            device: String(stat.dev),
            inode: String(stat.ino),
            byteCount: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
          }
        }
        await destHandle.close().catch(() => {})
        destHandle = null
      }
      await ensureDaemonRunning()
      const issued = await daemonClient.issueAttachmentCapabilities({
        workspaceId: scope.workspaceId,
        cardId: scope.cardId,
        paths: [dest],
        ownedTemporary: true,
      })
      const attachment = issued.attachments[0]
      if (!attachment) throw new Error('Attachment capability issuance returned no result')
      dest = null
      destIdentity = null
      return { ok: true, attachment }
    } catch (err) {
      await destHandle?.close().catch(() => {})
      if (dest && destIdentity) {
        await unlinkTempAttachmentIfIdentityMatches(dest, destIdentity)
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Loads one older transcript page for a linked external session. The
   * renderer prepends these pages into the same chat list so upward scrolling
   * feels like a normal continuous transcript rather than a separate archive.
   */
  ipcMain.handle('chat:loadSessionHistory', async (
    _,
    payload: {
      workspaceId?: string
      sessionEntryId?: string
      entryHint?: SessionEntryHint | null
      beforeFingerprint?: string | null
      limit?: number
    },
  ) => {
    const workspaceId = String(payload?.workspaceId || '').trim()
    const sessionEntryId = String(payload?.sessionEntryId || '').trim()
    if (!sessionEntryId) return { ok: false, error: 'sessionEntryId required', messages: [], total: 0, hasMore: false }

    const rawHint = payload?.entryHint
    const entryHint: SessionEntryHint | null = rawHint && typeof rawHint === 'object' && typeof rawHint.id === 'string' && typeof rawHint.source === 'string'
      ? {
          id: rawHint.id,
          source: rawHint.source as SessionEntryHint['source'],
          filePath: typeof rawHint.filePath === 'string' ? rawHint.filePath : undefined,
          sessionId: typeof rawHint.sessionId === 'string' || rawHint.sessionId === null ? rawHint.sessionId : null,
          provider: typeof rawHint.provider === 'string' ? rawHint.provider : '',
          model: typeof rawHint.model === 'string' ? rawHint.model : '',
          messageCount: typeof rawHint.messageCount === 'number' ? rawHint.messageCount : 0,
          title: typeof rawHint.title === 'string' ? rawHint.title : '',
          projectPath: typeof rawHint.projectPath === 'string' || rawHint.projectPath === null ? rawHint.projectPath : null,
        }
      : null

    const workspacePath = workspaceId
      ? await getWorkspacePathById(workspaceId).catch(() => null)
      : null

    const page = await loadExternalSessionMessagesPage(workspacePath, sessionEntryId, {
      entryHint,
      beforeFingerprint: typeof payload?.beforeFingerprint === 'string' ? payload.beforeFingerprint : null,
      limit: typeof payload?.limit === 'number' ? payload.limit : undefined,
    }).catch(error => {
      return {
        error: error instanceof Error ? error.message : String(error),
      }
    })

    if (!page || 'error' in page) {
      return {
        ok: false,
        error: (page && 'error' in page) ? page.error : 'Could not load earlier messages',
        messages: [],
        total: 0,
        hasMore: false,
      }
    }

    return {
      ok: true,
      messages: page.messages,
      total: page.total,
      hasMore: page.hasMore,
      provider: page.provider,
      model: page.model,
      sessionId: page.sessionId,
    }
  })

  ipcMain.handle('chat:opencodeModels', async () => getOpenCodeModelsSnapshot())

  // AI Gateway model catalog (live from the gateway /models endpoint, cached).
  // Best-effort: returns [] with an error when no key is configured — the tile
  // keeps its built-in default list.
  ipcMain.handle('chat:gatewayModels', async () => getGatewayModelsSnapshot())

  // Pi (csagent) models from the user's installed pi ModelRegistry (auth-configured).
  // Best-effort: returns [] if pi isn't installed/authed — the tile keeps its defaults.
  ipcMain.handle('chat:csagentModels', async () => listCsagentModels())
}
