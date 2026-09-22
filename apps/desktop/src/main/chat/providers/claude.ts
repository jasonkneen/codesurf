/**
 * Claude provider — uses @anthropic-ai/claude-agent-sdk for agent sessions.
 * No API keys needed — the SDK uses the Claude CLI's own auth.
 */

import { query, type Query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { getAgentPath } from '../../agent-paths'
import { getMCPPort, getTileToken, getContexMcpToolNames } from '../../mcp-server'
import {
  BoundedTextAccumulator,
  MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES,
  MAX_PROVIDER_DEDUP_TAIL_BYTES,
  MAX_PROVIDER_DIAGNOSTIC_BYTES,
  appendBoundedSuffix,
  boundProviderHistoryText,
} from '../bounded-output'
import { formatClaudeSdkError } from '../output-sanitizers'
import { buildClaudeAgentModeOptions } from './agent-mode-payloads'
import { getDisconnectedPeerBridgeMcpToolNames } from '../../../shared/nodeTools'
import { type ToolPermissionRequest } from '../../permissions'
import { resolveInlineToolPermission } from '../permission-flow'
import { createRuntimeCheckpoint } from '../runtime-checkpoints'
import type { ChatRequest, RuntimeChatSessionState } from '../types'
import {
  buildClaudePromptWithImages,
  cleanupOwnedImageAttachments,
} from '../provider-image-attachments.ts'
export { buildClaudePromptWithImages } from '../provider-image-attachments.ts'
import {
  activeQueries,
  chatRequestScope,
  chatStreamScopeKey,
  clearActiveQuery,
  cloneChatMessages,
  getPreparedMessages,
  isActiveQuery,
  log,
  markRoomPromptAccepted,
  getCardSessionId,
  sendStream,
  setCardSessionId,
  upsertRuntimeSessionState,
  type ChatStreamScope,
} from '../runtime'

// Live permission mode per workspace/card, so mid-thread mode switches
// propagate into the running canUseTool closure.
export const cardPermissionModes = new Map<string, string>()

// Per-workspace/card AbortController so chat:stop can cancel the SDK request.
export const cardAbortControllers = new Map<string, AbortController>()

function clearActiveClaudeQuery(scope: ChatStreamScope, q: Query): void {
  clearActiveQuery(scope, q)
  cardAbortControllers.delete(chatStreamScopeKey(scope))
}

const intentionallyClosedQueries = new WeakSet<Query>()

export function markClaudeQueryIntentionallyClosed(query: Query): void {
  intentionallyClosedQueries.add(query)
}

function wasClaudeQueryIntentionallyClosed(query: Query): boolean {
  return intentionallyClosedQueries.has(query)
}

// ---- AskUserQuestion interactive-form handling ----------------------------
interface AskUserQuestionOption {
  label: string
  description?: string
  preview?: string
}
interface AskUserQuestionItem {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskUserQuestionOption[]
}
interface AskUserQuestionAnswer {
  answers: Record<string, string>
  annotations?: Record<string, { notes?: string; preview?: string }>
}
interface PendingAskUserQuestion {
  resolve: (value: AskUserQuestionAnswer) => void
  reject: (err: Error) => void
}
// Keyed by workspace/card identity plus toolUseID.
const pendingAskUserQuestions = new Map<string, PendingAskUserQuestion>()

function askUserQuestionKey(scope: ChatStreamScope, toolUseID: string | null | undefined): string {
  return JSON.stringify([chatStreamScopeKey(scope), toolUseID ?? ''])
}

function awaitAskUserQuestionAnswer(
  scope: ChatStreamScope,
  toolUseID: string | null,
  questions: AskUserQuestionItem[],
): Promise<AskUserQuestionAnswer> {
  const key = askUserQuestionKey(scope, toolUseID)
  // Reject any prior pending prompt at the same key (shouldn't happen, but be safe).
  const prior = pendingAskUserQuestions.get(key)
  if (prior) {
    try { prior.reject(new Error('AskUserQuestion superseded')) } catch { /* noop */ }
    pendingAskUserQuestions.delete(key)
  }
  return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
    pendingAskUserQuestions.set(key, { resolve, reject })
    // Notify the renderer that a form is awaiting user input.
    sendStream(scope, {
      type: 'ask_user_question',
      toolId: toolUseID,
      questions,
    })
  })
}

export function resolvePendingAskUserQuestion(
  scope: ChatStreamScope,
  toolUseID: string | null | undefined,
  payload: AskUserQuestionAnswer,
): boolean {
  const key = askUserQuestionKey(scope, toolUseID)
  const pending = pendingAskUserQuestions.get(key)
  if (!pending) return false
  pendingAskUserQuestions.delete(key)
  pending.resolve(payload)
  return true
}

export function cancelPendingAskUserQuestionsForCard(
  scope: ChatStreamScope,
  reason: string = 'Cancelled',
): void {
  const scopeKey = chatStreamScopeKey(scope)
  for (const [key, pending] of pendingAskUserQuestions.entries()) {
    try {
      const parsed = JSON.parse(key)
      if (!Array.isArray(parsed) || parsed[0] !== scopeKey) continue
      pendingAskUserQuestions.delete(key)
      try { pending.reject(new Error(reason)) } catch { /* noop */ }
    } catch { /* ignore malformed internal keys */ }
  }
}

// --- Runtime checkpoints (Anthropic Edit/Write tools) ---------------------------
// createRuntimeCheckpoint is shared (../runtime-checkpoints). Path extractors stay Claude-specific.

function displayPathForWorkspace(absPath: string, workspaceDir: string | null | undefined): string {
  if (!absPath) return ''
  if (!workspaceDir) return absPath
  const ws = workspaceDir.replace(/\/$/, '')
  if (absPath === ws) return ''
  if (absPath.startsWith(ws + '/')) return absPath.slice(ws.length + 1)
  return absPath
}

function resolveAnthropicFilePath(filePath: string, workspaceDir?: string): string {
  if (workspaceDir && !filePath.startsWith('/')) return resolve(workspaceDir, filePath)
  return resolve(filePath)
}

function extractAnthropicCheckpointPaths(toolName: string, input: Record<string, unknown>, workspaceDir?: string): string[] {
  const resolveFile = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null
    return resolveAnthropicFilePath(value, workspaceDir)
  }

  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    const filePath = resolveFile(input.file_path)
    return filePath ? [filePath] : []
  }

  if (toolName === 'NotebookEdit') {
    const filePath = resolveFile(input.notebook_path) ?? resolveFile(input.file_path)
    return filePath ? [filePath] : []
  }

  return []
}

type ToolCheckpointPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string }

async function allowToolWithCheckpoint(
  req: ChatRequest,
  toolName: string,
  input: Record<string, unknown>,
  toolOptions: any,
): Promise<ToolCheckpointPermissionResult> {
  const checkpoint = await createRuntimeCheckpoint(req, toolName, extractAnthropicCheckpointPaths(toolName, input, req.workspaceDir), {
    toolUseID: typeof toolOptions?.toolUseID === 'string' ? toolOptions.toolUseID : null,
  })
  if (!checkpoint.ok) {
    return {
      behavior: 'deny',
      message: `Checkpoint creation failed before ${toolName}: ${checkpoint.error ?? 'unknown error'}`,
      toolUseID: toolOptions?.toolUseID,
    }
  }
  // The Claude Code control protocol requires an `allow` result to echo back
  // `updatedInput` (the possibly-modified tool input). Omitting it makes the
  // CLI's Zod validation reject the response — the tool then fails even though
  // the user approved it. Echo the input unchanged.
  return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions?.toolUseID }
}

export function buildClaudeTextInput(text: string, priority: SDKUserMessage['priority'] = 'now'): AsyncIterable<SDKUserMessage> {
  async function* generator(): AsyncGenerator<SDKUserMessage, void, unknown> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
      priority,
      timestamp: new Date().toISOString(),
    }
  }
  return generator()
}

// --- Anthropic file-change summaries -----------------------------------------

interface AnthropicFileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

function countLines(s: string): number {
  if (!s) return 0
  // Trailing-newline-insensitive count so "a\nb" and "a\nb\n" both report 2.
  const trimmed = s.replace(/\n$/, '')
  if (trimmed === '') return 0
  return trimmed.split('\n').length
}

function makeEditDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const chunks: string[] = []
  for (const line of oldLines) chunks.push('-' + line)
  for (const line of newLines) chunks.push('+' + line)
  return chunks.join('\n')
}

function makeWholeFileDiff(content: string, kind: 'add' | 'del'): string {
  const marker = kind === 'add' ? '+' : '-'
  return content.split('\n').map(line => marker + line).join('\n')
}

function buildAnthropicFileChanges(
  toolName: string,
  rawInput: string,
  workspaceDir: string | null | undefined,
): AnthropicFileChange[] {
  let parsed: unknown
  try { parsed = JSON.parse(rawInput) } catch { return [] }
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>

  const getStr = (k: string): string | null => typeof obj[k] === 'string' ? (obj[k] as string) : null

  if (toolName === 'Edit') {
    const filePath = getStr('file_path') ?? ''
    if (!filePath) return []
    const oldStr = getStr('old_string') ?? ''
    const newStr = getStr('new_string') ?? ''
    const diff = makeEditDiff(oldStr, newStr)
    return [{
      path: displayPathForWorkspace(filePath, workspaceDir),
      changeType: 'update',
      additions: countLines(newStr),
      deletions: countLines(oldStr),
      diff,
    }]
  }

  if (toolName === 'MultiEdit') {
    const filePath = getStr('file_path') ?? ''
    if (!filePath) return []
    const edits = Array.isArray(obj.edits) ? obj.edits as unknown[] : []
    let additions = 0
    let deletions = 0
    const diffChunks: string[] = []
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue
      const e = edit as Record<string, unknown>
      const oldStr = typeof e.old_string === 'string' ? e.old_string : ''
      const newStr = typeof e.new_string === 'string' ? e.new_string : ''
      additions += countLines(newStr)
      deletions += countLines(oldStr)
      diffChunks.push(makeEditDiff(oldStr, newStr))
    }
    if (additions === 0 && deletions === 0) return []
    return [{
      path: displayPathForWorkspace(filePath, workspaceDir),
      changeType: 'update',
      additions,
      deletions,
      diff: diffChunks.join('\n'),
    }]
  }

  if (toolName === 'Write') {
    const filePath = getStr('file_path') ?? ''
    if (!filePath) return []
    const content = getStr('content') ?? ''
    const priorExisted = (() => {
      try { return existsSync(filePath) } catch { return true }
    })()
    return [{
      path: displayPathForWorkspace(filePath, workspaceDir),
      changeType: priorExisted ? 'update' : 'add',
      additions: countLines(content),
      deletions: 0,
      diff: makeWholeFileDiff(content, 'add'),
    }]
  }

  if (toolName === 'NotebookEdit') {
    const filePath = getStr('notebook_path') ?? getStr('file_path') ?? ''
    if (!filePath) return []
    const newSource = getStr('new_source') ?? ''
    if (!newSource) return []
    return [{
      path: displayPathForWorkspace(filePath, workspaceDir),
      changeType: 'update',
      additions: countLines(newSource),
      deletions: 0,
      diff: makeWholeFileDiff(newSource, 'add'),
    }]
  }

  return []
}

// --- Claude via Agent SDK ----------------------------------------------------

export function chatClaude(req: ChatRequest): void {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  const lastUserMsg = [...getPreparedMessages(req)].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(scope, { type: 'error', error: 'No user message' })
    void cleanupOwnedImageAttachments(req.imageAttachments)
    return
  }

  // Restore sessionId from frontend (survives app restart via tile state)
  if (req.sessionId && !getCardSessionId(scope, req.provider)) {
    setCardSessionId(scope, req.provider, req.sessionId)
  }

  const existingSessionId = getCardSessionId(scope, req.provider) ?? req.sessionId ?? null
  const runtimeMessages = cloneChatMessages(req.messages)
  const runtimeSession: RuntimeChatSessionState = {
    provider: req.provider,
    model: req.model,
    sessionId: existingSessionId ?? req.sessionId ?? null,
    jobId: req.jobId ?? null,
    jobSequence: typeof req.jobSequence === 'number' ? req.jobSequence : 0,
    executionTarget: req.executionTarget === 'cloud' ? 'cloud' : 'local',
    cloudHostId: req.cloudHostId ?? null,
    isStreaming: true,
    messages: runtimeMessages,
  }
  void upsertRuntimeSessionState(req, runtimeSession)
  log('chatClaude starting', {
    model: req.model,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
    sessionId: existingSessionId?.slice(0, 8),
  })

  const abortController = new AbortController()
  cardAbortControllers.set(scopeKey, abortController)
  const claudeStderr = new BoundedTextAccumulator(MAX_PROVIDER_DIAGNOSTIC_BYTES)

  // Map mode from UI to SDK permission mode
  const modeMap: Record<string, string> = {
    default: 'default',
    acceptEdits: 'acceptEdits',
    plan: 'plan',
    bypassPermissions: 'bypassPermissions',
  }
  const permMode = modeMap[req.mode ?? ''] ?? 'default'
  // Seed live mode map so mid-thread switches can override it without waiting
  // for the next turn.
  cardPermissionModes.set(scopeKey, permMode)

  // Map thinking option from UI to SDK thinking config
  const thinkingMap: Record<string, { type: string; budget_tokens?: number }> = {
    adaptive: { type: 'adaptive' },
    none: { type: 'disabled' },
    low: { type: 'enabled', budget_tokens: 2048 },
    medium: { type: 'enabled', budget_tokens: 8192 },
    high: { type: 'enabled', budget_tokens: 32768 },
    max: { type: 'enabled', budget_tokens: 131072 },
  }
  const thinkingConfig = thinkingMap[req.thinking ?? ''] ?? { type: 'adaptive' }

  // Wire up the codesurf MCP server (Bearer auth matches mcp-server HTTP checks)
  const mcpPort = getMCPPort()
  const mcpServers: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> = {}
  if (req.mcpEnabled !== false && mcpPort && req.workspaceId) {
    mcpServers.codesurf = {
      type: 'http',
      url: `http://127.0.0.1:${mcpPort}/mcp`,
      headers: {
        Authorization: `Bearer ${getTileToken(req.workspaceId, req.cardId)}`,
      },
    }
    log('MCP server attached at port', mcpPort)
  }

  const contexToolNames = getContexMcpToolNames()
  const disallowedPeerBridgeTools = req.mcpEnabled === false
    ? []
    : getDisconnectedPeerBridgeMcpToolNames(req.negotiatedTools ?? req.peers?.flatMap(peer => peer.tools) ?? [])

  // The canonical host composes every model-visible context fragment once.
  if (req.peers && req.peers.length > 0) {
    log('Peer data:', JSON.stringify(req.peers.map(p => ({ id: p.peerId, type: p.peerType, tools: p.tools.length, actions: p.actions?.length ?? 0 }))))
  }
  const systemPrompt = req.contextPrompt?.trim() || undefined
  if (systemPrompt) {
    log('host context attached for', req.peers?.length ?? 0, 'peers, codesurf tools:', contexToolNames.length)
  }
  // Resolved AgentMode (selected agent definition): persona → system prompt,
  // tools allow-list → SDK tool restriction. The shared builder FAILS CLOSED
  // (throws) if a selected agent's definition has not resolved (A-PR1
  // BLOCKING-1) — surface it instead of launching unrestricted. Mirrors the
  // daemon Claude path.
  let agentTools: string[] | undefined
  try {
    ({ tools: agentTools } = buildClaudeAgentModeOptions(req))
  } catch (err) {
    sendStream(scope, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    sendStream(scope, { type: 'done' })
    cardAbortControllers.delete(scopeKey)
    void cleanupOwnedImageAttachments(req.imageAttachments)
    return
  }
  // Resolve claude binary from startup detection
  const claudePath = getAgentPath('claude')

  const options: Options = {
    model: req.model,
    abortController,
    persistSession: true,
    includePartialMessages: true,
    permissionMode: permMode as any,
    ...(permMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    thinking: thinkingConfig as any,
    // AskUserQuestion must be intercepted regardless of permission mode so the
    // agent's question actually reaches the user. Everything else honours permMode.
    canUseTool: async (toolName: string, input: Record<string, unknown>, toolOptions: any) => {
      if (toolName === 'AskUserQuestion') {
        try {
          const rawQuestions = (input as { questions?: unknown })?.questions
          const questions: AskUserQuestionItem[] = Array.isArray(rawQuestions)
            ? (rawQuestions as AskUserQuestionItem[]).filter(q => q && typeof q.question === 'string' && Array.isArray(q.options))
            : []
          if (questions.length > 0) {
            const toolUseID = typeof toolOptions?.toolUseID === 'string' ? toolOptions.toolUseID : null
            const { answers, annotations } = await awaitAskUserQuestionAnswer(scope, toolUseID, questions)
            return {
              behavior: 'allow',
              updatedInput: {
                ...(input as Record<string, unknown>),
                answers,
                ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
              },
              toolUseID: toolOptions?.toolUseID,
            }
          }
        } catch (err) {
          log('AskUserQuestion interception error:', (err as Error).message)
        }
        // No questions or error — just allow the tool through unchanged.
        return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions?.toolUseID }
      }

      // Read the live mode so mid-thread switches take effect immediately.
      const currentMode = cardPermissionModes.get(scopeKey) ?? permMode
      if (currentMode === 'bypassPermissions') {
        return await allowToolWithCheckpoint(req, toolName, input, toolOptions)
      }

      const permissionRequest: ToolPermissionRequest = {
        provider: 'claude',
        toolName,
        title: typeof toolOptions?.title === 'string' ? toolOptions.title : null,
        description: typeof toolOptions?.description === 'string' ? toolOptions.description : null,
        blockedPath: typeof toolOptions?.blockedPath === 'string' ? toolOptions.blockedPath : null,
        workspaceDir: req.workspaceDir,
      }

      const sdkToolUseID = typeof toolOptions?.toolUseID === 'string' ? toolOptions.toolUseID : null
      const result = await resolveInlineToolPermission(scope, permissionRequest, sdkToolUseID)

      if ('error' in result) {
        return {
          behavior: 'deny',
          message: result.error,
          toolUseID: result.toolUseID ?? toolOptions?.toolUseID,
        }
      }

      const { decision } = result
      if (decision === 'deny' || decision === 'never') {
        return {
          behavior: 'deny',
          message: decision === 'never'
            ? 'Tool permission permanently denied. Future calls will be auto-rejected.'
            : 'Tool permission denied by the user.',
          toolUseID: sdkToolUseID ?? toolOptions?.toolUseID,
        }
      }

      return await allowToolWithCheckpoint(req, toolName, input, toolOptions)
    },
    ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
    ...(disallowedPeerBridgeTools.length > 0 && { disallowedTools: disallowedPeerBridgeTools }),
    // Use detected system binary, not the SDK's bundled cli.js
    ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
    stderr: (data: string) => {
      claudeStderr.append(data)
    },
  }

  // Resume existing session for multi-turn
  if (existingSessionId) {
    options.resume = existingSessionId
  }

  // AgentMode.tools allow-list → restrict the built-in tools the model may use
  // (null/absent = all defaults; [] = deny-all per the SDK). Set BOTH the
  // top-level option (governs when no custom agent is active) AND the custom
  // agent definition below, since the active agent's own `tools` field governs
  // its toolset when `options.agent` is set.
  if (agentTools !== undefined) {
    options.tools = agentTools
  }

  try {
    log('calling query()...')
    // Inject system prompt via named agent definition if we have peer context
    if (systemPrompt) {
      options.agent = 'codesurf'
      options.agents = {
        codesurf: {
          description: 'CodeSurf canvas AI agent with peer block awareness',
          prompt: systemPrompt,
          ...(agentTools !== undefined ? { tools: agentTools } : {}),
        }
      }
    }
    const promptForQuery = buildClaudePromptWithImages(lastUserMsg.content, req.imageAttachments)
    const q = query({ prompt: promptForQuery, options })
    log('query() returned, consuming generator...', req.imageAttachments?.length
      ? `(with ${req.imageAttachments.length} image attachment${req.imageAttachments.length === 1 ? '' : 's'})`
      : '')
    activeQueries.set(scopeKey, q)

    // Consume the async generator in the background
    ;(async () => {
      let capturedSessionId = false
      const assistantText = new BoundedTextAccumulator(MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES)
      let sawAssistantOutput = false
      const noteAssistantOutput = (): void => {
        sawAssistantOutput = true
        markRoomPromptAccepted(scope)
      }
      // Track streamed text per content_block index so we can fall back to the
      // assembled `assistant` message for any text the partial stream missed.
      // Key format: `${turn}:${index}` — we bump `turn` on each assistant message.
      const streamedTextByIndex = new Map<string, { length: number, tail: string }>()
      let streamTurn = 0
      let currentThinkingId: string | null = null
      try {
        for await (const msg of q) {
          if (!isActiveQuery(scope, q)) {
            return
          }

          // Capture session_id from the first message we receive
          if (!capturedSessionId) {
            const sid = (msg as any).session_id
            if (sid) {
              log('captured session_id:', sid.slice(0, 8))
              setCardSessionId(scope, req.provider, sid)
              runtimeSession.sessionId = sid
              void upsertRuntimeSessionState(req, runtimeSession)
              sendStream(scope, { type: 'session', sessionId: sid })
              capturedSessionId = true
            }
          }

          log('msg received:', msg.type, msg.type === 'stream_event' ? (msg as any).event?.type : '')
          if (msg.type === 'stream_event') {
            const evt = msg.event as any
            if (evt.type === 'content_block_delta') {
              if (evt.delta?.type === 'text_delta' && evt.delta.text) {
                const key = `${streamTurn}:${evt.index ?? 0}`
                const prior = streamedTextByIndex.get(key) ?? { length: 0, tail: '' }
                if (!streamedTextByIndex.has(key) && streamedTextByIndex.size >= 256) {
                  const oldestKey = streamedTextByIndex.keys().next().value
                  if (oldestKey) streamedTextByIndex.delete(oldestKey)
                }
                streamedTextByIndex.set(key, {
                  length: prior.length + evt.delta.text.length,
                  tail: appendBoundedSuffix(prior.tail, evt.delta.text, MAX_PROVIDER_DEDUP_TAIL_BYTES),
                })
                assistantText.append(evt.delta.text)
                noteAssistantOutput()
                sendStream(scope, { type: 'text', text: evt.delta.text })
              } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
                noteAssistantOutput()
                sendStream(scope, { type: 'thinking', text: evt.delta.thinking, thinkingId: currentThinkingId })
              } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
                sendStream(scope, { type: 'tool_input', text: evt.delta.partial_json })
              }
            } else if (evt.type === 'content_block_start') {
              if (evt.content_block?.type === 'tool_use') {
                noteAssistantOutput()
                sendStream(scope, {
                  type: 'tool_start',
                  toolName: evt.content_block.name,
                  toolId: evt.content_block.id,
                })
              } else if (evt.content_block?.type === 'thinking') {
                const thinkingId = `think-${streamTurn}-${evt.index ?? 0}`
                currentThinkingId = thinkingId
                sendStream(scope, { type: 'thinking_start', thinkingId })
              }
            } else if (evt.type === 'content_block_stop') {
              sendStream(scope, { type: 'block_stop', index: evt.index, thinkingId: currentThinkingId })
              currentThinkingId = null
            }
          } else if (msg.type === 'assistant') {
            // Full assembled message -- forward tool_use blocks AND any text
            // that the partial stream missed (dropping text here is what caused
            // "lost chatter between tool uses").
            const message = (msg as any).message
            if (message?.content) {
              for (let idx = 0; idx < message.content.length; idx++) {
                const block = message.content[idx]
                if (block.type === 'tool_use') {
                  noteAssistantOutput()
                  const toolInputStr = JSON.stringify(block.input, null, 2)
                  sendStream(scope, {
                    type: 'tool_use',
                    toolName: block.name,
                    toolId: block.id,
                    toolInput: toolInputStr,
                  })
                  const fileChanges = buildAnthropicFileChanges(
                    block.name,
                    toolInputStr,
                    req.workspaceDir,
                  )
                  if (fileChanges.length > 0) {
                    sendStream(scope, {
                      type: 'tool_summary',
                      toolId: block.id,
                      toolName: block.name,
                      fileChanges,
                    })
                  }
                } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
                  const key = `${streamTurn}:${idx}`
                  const accumulated = assistantText.value
                  // Thinking blocks occupy stream indices the assembled message
                  // omits. Never re-emit a snapshot we already streamed.
                  if (accumulated === block.text || accumulated.endsWith(block.text)) continue
                  if (accumulated && block.text.startsWith(accumulated)) {
                    const caughtUp = block.text.slice(accumulated.length)
                    if (caughtUp.length > 0) {
                      assistantText.append(caughtUp)
                      noteAssistantOutput()
                      sendStream(scope, { type: 'text', text: caughtUp })
                    }
                    streamedTextByIndex.set(key, {
                      length: block.text.length,
                      tail: appendBoundedSuffix('', block.text, MAX_PROVIDER_DEDUP_TAIL_BYTES),
                    })
                    continue
                  }
                  const alreadyStreamed = streamedTextByIndex.get(key)
                  const matchesStreamedPrefix = Boolean(
                    alreadyStreamed
                    && block.text.length >= alreadyStreamed.length
                    && block.text.slice(
                      Math.max(0, alreadyStreamed.length - alreadyStreamed.tail.length),
                      alreadyStreamed.length,
                    ) === alreadyStreamed.tail,
                  )
                  if (matchesStreamedPrefix && block.text.length === alreadyStreamed?.length) continue
                  const tail = matchesStreamedPrefix && alreadyStreamed
                    ? block.text.slice(alreadyStreamed.length)
                    : block.text
                  if (tail.length > 0) {
                    assistantText.append(tail)
                    noteAssistantOutput()
                    sendStream(scope, { type: 'text', text: tail })
                    streamedTextByIndex.set(key, {
                      length: block.text.length,
                      tail: appendBoundedSuffix('', block.text, MAX_PROVIDER_DEDUP_TAIL_BYTES),
                    })
                  }
                }
              }
            }
            // includePartialMessages yields intermediate snapshots of the same
            // turn. Only advance the stream-index namespace after tool_use,
            // when the next assistant message is a new turn.
            const sawToolUse = Array.isArray(message?.content)
              && message.content.some((block: { type?: string }) => block.type === 'tool_use')
            if (sawToolUse) {
              const finishedTurnPrefix = `${streamTurn}:`
              for (const key of streamedTextByIndex.keys()) {
                if (key.startsWith(finishedTurnPrefix)) streamedTextByIndex.delete(key)
              }
              streamTurn += 1
            }
          } else if (msg.type === 'tool_use_summary') {
            sendStream(scope, {
              type: 'tool_summary',
              text: (msg as any).summary,
            })
            if (typeof (msg as any).summary === 'string' && (msg as any).summary.trim()) noteAssistantOutput()
          } else if (msg.type === 'tool_progress') {
            noteAssistantOutput()
            sendStream(scope, {
              type: 'tool_progress',
              toolName: (msg as any).tool_name,
              elapsed: (msg as any).elapsed_time_seconds,
            })
          } else if (msg.type === 'result') {
            if (!isActiveQuery(scope, q)) {
              return
            }
            const result = msg as any
            const resultText = typeof result.result === 'string' ? result.result.trim() : ''
            if (!assistantText.value.trim() && resultText) {
              assistantText.append(resultText)
              noteAssistantOutput()
              sendStream(scope, { type: 'text', text: resultText })
            }
            if (!sawAssistantOutput && !resultText) {
              runtimeSession.sessionId = result.session_id ?? runtimeSession.sessionId
              runtimeSession.isStreaming = false
              void upsertRuntimeSessionState(req, runtimeSession)
              sendStream(scope, {
                type: 'error',
                error: 'Claude finished without assistant output. Only preflight/context events were emitted, so the turn was not saved as a blank reply. Please resend the message.',
              })
              clearActiveClaudeQuery(scope, q)
              return
            }
            if (assistantText.value.trim()) {
              runtimeSession.messages = [
                ...runtimeMessages,
                { role: 'assistant', content: boundProviderHistoryText(assistantText.value) },
              ]
            }
            runtimeSession.sessionId = result.session_id ?? runtimeSession.sessionId
            runtimeSession.isStreaming = false
            void upsertRuntimeSessionState(req, runtimeSession)
            sendStream(scope, {
              type: 'done',
              cost: result.total_cost_usd,
              turns: result.num_turns,
              resultText: typeof result.result === 'string'
                ? boundProviderHistoryText(result.result)
                : result.result,
              sessionId: result.session_id,
            })
            clearActiveClaudeQuery(scope, q)
            // Also capture from result if we missed earlier
            if (result.session_id && !getCardSessionId(scope, req.provider)) {
              setCardSessionId(scope, req.provider, result.session_id)
            }
          }
        }

        // Generator finished -- ensure done is sent
        if (isActiveQuery(scope, q)) {
          if (!sawAssistantOutput && !assistantText.value.trim()) {
            runtimeSession.isStreaming = false
            void upsertRuntimeSessionState(req, runtimeSession)
            sendStream(scope, {
              type: 'error',
              error: 'Claude stream ended before producing assistant output. Only preflight/context events were emitted, so the turn was not saved as a blank reply. Please resend the message.',
            })
            clearActiveQuery(scope, q)
            return
          }
          if (assistantText.value.trim()) {
            runtimeSession.messages = [
              ...runtimeMessages,
              { role: 'assistant', content: boundProviderHistoryText(assistantText.value) },
            ]
          }
          runtimeSession.isStreaming = false
          void upsertRuntimeSessionState(req, runtimeSession)
          sendStream(scope, { type: 'done', sessionId: runtimeSession.sessionId ?? undefined })
          clearActiveQuery(scope, q)
        }
      } catch (err) {
        if (wasClaudeQueryIntentionallyClosed(q) || !isActiveQuery(scope, q)) {
          log('generator closed for inactive Claude query:', err instanceof Error ? err.message : String(err))
          clearActiveQuery(scope, q)
          return
        }
        const errorMessage = formatClaudeSdkError(err, claudeStderr.value)
        log('generator error:', errorMessage)
        if (assistantText.value.trim()) {
          runtimeSession.messages = [
            ...runtimeMessages,
            { role: 'assistant', content: boundProviderHistoryText(assistantText.value) },
          ]
        }
        runtimeSession.isStreaming = false
        void upsertRuntimeSessionState(req, runtimeSession)
        sendStream(scope, { type: 'error', error: errorMessage })
        clearActiveQuery(scope, q)
      } finally {
        await cleanupOwnedImageAttachments(req.imageAttachments)
      }
    })()
  } catch (err) {
    const errorMessage = formatClaudeSdkError(err, claudeStderr.value)
    log('query() threw:', errorMessage)
    sendStream(scope, { type: 'error', error: errorMessage })
    void cleanupOwnedImageAttachments(req.imageAttachments)
  }
}
