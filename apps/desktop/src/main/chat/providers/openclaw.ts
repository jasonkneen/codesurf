/**
 * OpenClaw provider — runs `openclaw agent --json` subprocess.
 */

import { spawn, execFileSync } from 'child_process'
import { getAgentPath, getShellEnvPath } from '../../agent-paths'
import { buildSafeSpawnEnv } from '../../ipc/terminal-helpers'
import {
  normalizeOpenClawThinking,
  parseBoundedOpenClawOutput,
} from '../../agents/agent-cli-contracts'
import {
  BoundedTextAccumulator,
  MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES,
  MAX_PROVIDER_DIAGNOSTIC_BYTES,
  boundProviderHistoryText,
} from '../bounded-output'
import type { ChatRequest } from '../types'
import {
  log,
  markRoomPromptAccepted,
  sendStream,
  getPreparedMessages,
  chatRequestScope,
  chatStreamScopeKey,
  isCurrentChatProcess,
  processTreeSpawnOptions,
  registerActiveChatProcess,
  stopActiveChatProcess,
  terminateProcessTree,
  type ChatStreamScope,
} from '../runtime'
import {
  clearStableSessionContext,
  completeStableContextCliTurn,
  hasNonEmptyProviderResult,
  invalidateStableContextSelection,
  selectStableContextForTurn,
} from '../stable-session-context'

// Store OpenClaw session IDs by workspace/card for multi-turn resume.
const openclawSessionIds = new Map<string, string>()

function resolveOpenClawBinary(): string | null {
  const detected = getAgentPath('openclaw')
  if (detected) return detected
  try {
    const shellPath = getShellEnvPath()
    return execFileSync('which', ['openclaw'], {
      encoding: 'utf-8',
      env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    }).trim() || null
  } catch {
    return null
  }
}

function normalizeModelRef(model?: string | null): string {
  return (model ?? '').trim().toLowerCase()
}

function parseOpenClawAgents(openclawBin: string, shellPath?: string | null): Array<{ id: string; name?: string; model?: string; isDefault?: boolean }> {
  try {
    const raw = execFileSync(openclawBin, ['agents', 'list', '--json'], {
      encoding: 'utf-8',
      env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    }).trim()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function selectOpenClawAgentId(openclawBin: string, shellPath?: string | null, preferredModel?: string | null): string | null {
  const agents = parseOpenClawAgents(openclawBin, shellPath)
  if (agents.length === 0) return 'main'

  const requested = normalizeModelRef(preferredModel)
  const isStable = (id: string): boolean => !id.startsWith('mc-gateway-') && !/^lead-[0-9a-f-]+$/i.test(id)

  if (requested) {
    const directStable = agents.find(agent => isStable(agent.id) && normalizeModelRef(agent.id) === requested)
    if (directStable) return directStable.id

    const directAny = agents.find(agent => normalizeModelRef(agent.id) === requested)
    if (directAny) return directAny.id

    const exactStable = agents.find(agent => isStable(agent.id) && normalizeModelRef(agent.model) === requested)
    if (exactStable) return exactStable.id

    const exactAny = agents.find(agent => normalizeModelRef(agent.model) === requested)
    if (exactAny) return exactAny.id

    return null
  }

  return agents.find(agent => agent.isDefault)?.id ?? agents[0]?.id ?? 'main'
}

export function clearOpenclawSession(scope: ChatStreamScope): void {
  openclawSessionIds.delete(chatStreamScopeKey(scope))
  clearStableSessionContext(scope, 'openclaw')
}

export function listOpenclawAgents(): { agents: Array<{ id: string; label: string; description: string }> } {
  const openclawBin = resolveOpenClawBinary()
  if (!openclawBin) {
    return { agents: [] }
  }

  const shellPath = getShellEnvPath()
  const agents = parseOpenClawAgents(openclawBin, shellPath).map(agent => ({
    id: agent.id,
    label: agent.name ? `${agent.name}${agent.isDefault ? ' (default)' : ''}` : `${agent.id}${agent.isDefault ? ' (default)' : ''}`,
    description: agent.model ?? agent.id,
  }))

  return { agents }
}

export function chatOpenclaw(req: ChatRequest): void {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  const lastUserMsg = [...getPreparedMessages(req)].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(scope, { type: 'error', error: 'No user message' })
    return
  }

  const openclawBin = resolveOpenClawBinary()
  if (!openclawBin) {
    sendStream(scope, { type: 'error', error: 'OpenClaw CLI not found. Install: npm install -g openclaw' })
    return
  }

  const shellPath = getShellEnvPath()
  if (req.sessionId && !openclawSessionIds.has(scopeKey)) {
    openclawSessionIds.set(scopeKey, req.sessionId)
  }
  const existingSessionId = openclawSessionIds.get(scopeKey)
  const selectedAgentId = existingSessionId ? null : selectOpenClawAgentId(openclawBin, shellPath, req.model)

  if (!existingSessionId && req.model && !selectedAgentId) {
    const agents = parseOpenClawAgents(openclawBin, shellPath)
    const available = agents
      .map(agent => agent.model || agent.id)
      .filter((value, index, all): value is string => typeof value === 'string' && value.trim().length > 0 && all.indexOf(value) === index)
    const details = available.length > 0 ? ` Available: ${available.join(', ')}` : ''
    sendStream(scope, { type: 'error', error: `OpenClaw model must match exactly: ${req.model}.${details}` })
    sendStream(scope, { type: 'done' })
    return
  }

  const stableContext = selectStableContextForTurn({
    scope,
    provider: req.provider,
    sessionId: existingSessionId,
    contextPrompt: req.contextPrompt,
  })

  log('chatOpenclaw starting', {
    model: req.model,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
    agentId: selectedAgentId,
  })

  const args = ['agent', '--json']
  if (existingSessionId) {
    args.push('--session-id', existingSessionId)
  } else {
    args.push('--agent', selectedAgentId ?? 'main')
  }

  const thinking = normalizeOpenClawThinking(req.thinking)
  if (thinking) {
    args.push('--thinking', thinking)
  }

  // OpenClaw has no system channel. Install stable host context once per
  // session/version; volatile user/room/file context is already in this turn.
  const contextPrompt = stableContext.contextPrompt
  const openClawMessage = contextPrompt
    ? `${contextPrompt}\n\n---\n\n${lastUserMsg.content}`
    : lastUserMsg.content
  args.push('--message', openClawMessage)

  const proc = spawn(openclawBin, args, processTreeSpawnOptions({
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    ...(req.workspaceDir && { cwd: req.workspaceDir }),
  }))

  if (!registerActiveChatProcess(scopeKey, proc)) {
    void terminateProcessTree(proc).then(termination => {
      sendStream(scope, {
        type: 'error',
        error: termination.confirmed
          ? 'OpenClaw launch refused because the previous chat process is still active'
          : `Duplicate OpenClaw process could not be terminated: ${termination.detail}`,
      })
      if (termination.confirmed) sendStream(scope, { type: 'done' })
    })
    return
  }

  // H-9: identity-guard — only clean up / emit done|error if this proc is
  // still the active one for this card. A rapid re-send replaces the map
  // entry before the old proc's close handler fires, so we must check first.
  const isCurrent = (): boolean => isCurrentChatProcess(scopeKey, proc)

  const stdoutBuf = new BoundedTextAccumulator(MAX_PROVIDER_ACCUMULATED_OUTPUT_BYTES)
  proc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf.append(chunk.toString()) })

  const stderrBuf = new BoundedTextAccumulator(MAX_PROVIDER_DIAGNOSTIC_BYTES)
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf.append(chunk.toString()) })

  proc.on('close', (code) => {
    if (!isCurrent()) return // superseded by a new turn — suppress stale done/error
    void (async () => {
      const termination = await stopActiveChatProcess(scopeKey)
      if (!termination?.confirmed) {
        invalidateStableContextSelection(stableContext)
        sendStream(scope, {
          type: 'error',
          error: `OpenClaw process-tree exit could not be confirmed: ${termination?.detail ?? 'process ownership was lost'}`,
        })
        return
      }
      if (code !== 0) {
        invalidateStableContextSelection(stableContext)
        sendStream(scope, {
          type: 'error',
          error: stderrBuf.value.trim() || stdoutBuf.value.trim() || `OpenClaw exited with ${code}`,
        })
        sendStream(scope, { type: 'done' })
        return
      }

      const parsed = parseBoundedOpenClawOutput(stdoutBuf.value, stdoutBuf.truncated)
      if (!parsed.ok) {
        invalidateStableContextSelection(stableContext)
        sendStream(scope, { type: 'error', error: parsed.error })
        sendStream(scope, { type: 'done' })
        return
      }

      const sessionId = parsed.output.sessionId ?? undefined
      const resultText = parsed.output.text
      const hasRealResult = hasNonEmptyProviderResult(resultText)
      if (sessionId) {
        openclawSessionIds.set(scopeKey, sessionId)
        sendStream(scope, { type: 'session', sessionId })
      }
      completeStableContextCliTurn(stableContext, {
        exitCode: code,
        sawProviderAcceptance: hasRealResult,
        sessionId: sessionId ?? existingSessionId,
      })
      if (hasRealResult) {
        markRoomPromptAccepted(scope)
        sendStream(scope, { type: 'text', text: boundProviderHistoryText(resultText) })
      }
      sendStream(scope, { type: 'done', sessionId })
    })().catch(error => {
      invalidateStableContextSelection(stableContext)
      sendStream(scope, {
        type: 'error',
        error: `OpenClaw process finalization failed: ${error instanceof Error ? error.message : String(error)}`,
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
          ? 'OpenClaw CLI not found. Install: npm install -g openclaw'
          : err.message,
      })
      if (!termination?.confirmed) {
        sendStream(scope, {
          type: 'error',
          error: `OpenClaw process-tree exit could not be confirmed: ${termination?.detail ?? 'process ownership was lost'}`,
        })
        return
      }
      sendStream(scope, { type: 'done' })
    })().catch(error => {
      sendStream(scope, {
        type: 'error',
        error: `OpenClaw process finalization failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  })
}
