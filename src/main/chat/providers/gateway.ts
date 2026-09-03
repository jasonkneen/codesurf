/**
 * Vercel AI Gateway provider — streaming inference + canvas tool loop via the
 * AI SDK (v7).
 *
 * One key unlocks every gateway model id (`anthropic/...`, `openai/...`,
 * `google/...`, `xai/...`, ...). The key is resolved from the encrypted
 * secrets store (Settings → Providers → AI Gateway) with the
 * `AI_GATEWAY_API_KEY` environment variable as a fallback. Stateless between
 * turns: history is replayed from `req.messages` each turn. Within a turn the
 * model runs a multi-step tool loop over the in-process canvas MCP toolset,
 * scoped by the tile principal and the Persona tools allow-list.
 */

import { createGateway } from '@ai-sdk/gateway'
import { jsonSchema, stepCountIs, streamText, tool, type ToolSet } from 'ai'
import { getSecret } from '../../secrets'
import { getAllStaticTools } from '../../mcp/registry'
import { executeChatAgentTool } from '../../mcp-server'
import type { McpPrincipal } from '../../mcp/auth'
import type { ChatRequest } from '../types'
import {
  agentModeUnresolved,
  AGENT_MODE_UNRESOLVED_ERROR,
  resolveAgentToolAllowList,
} from '../agent-mode-tools'
import {
  GATEWAY_PRINCIPAL_UNRESOLVED_ERROR,
  GATEWAY_SECRET_NAME,
  mapGatewayModels,
  resolveGatewayApiKey as resolveGatewayApiKeyFrom,
  resolveGatewayPrincipal,
  selectGatewayTools,
  type GatewayModelOption,
} from '../gateway-tools'
import {
  chatRequestScope,
  chatStreamScopeKey,
  getPreparedMessages,
  log,
  markRoomPromptAccepted,
  sendStream,
  type ChatStreamScope,
} from '../runtime'

export { GATEWAY_SECRET_NAME }

const MAX_TOOL_STEPS = 24
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000

const activeGatewayTurns = new Map<string, AbortController>()

export function stopGatewayTurn(scope: ChatStreamScope): void {
  const scopeKey = chatStreamScopeKey(scope)
  const controller = activeGatewayTurns.get(scopeKey)
  if (!controller) return
  activeGatewayTurns.delete(scopeKey)
  controller.abort()
}

function resolveGatewayApiKey(): string | null {
  // Shared with the daemon spawn path so both resolve identically.
  return resolveGatewayApiKeyFrom(getSecret(GATEWAY_SECRET_NAME), process.env)
}

// ── Model listing (chat:gatewayModels) ──────────────────────────────────────

let modelsCache: { at: number; models: GatewayModelOption[] } | null = null

export async function getGatewayModelsSnapshot(): Promise<{
  models: GatewayModelOption[]
  source: 'gateway' | 'none'
  error?: string
}> {
  const apiKey = resolveGatewayApiKey()
  if (!apiKey) return { models: [], source: 'none', error: 'AI Gateway key not configured' }
  if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) {
    return { models: modelsCache.models, source: 'gateway' }
  }
  try {
    const metadata = await createGateway({ apiKey }).getAvailableModels()
    const models = mapGatewayModels(metadata.models)
    modelsCache = { at: Date.now(), models }
    return { models, source: 'gateway' }
  } catch (err) {
    return {
      models: modelsCache?.models ?? [],
      source: modelsCache ? 'gateway' : 'none',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Drop the cached model list (e.g. after the key changes). */
export function invalidateGatewayModelsCache(): void {
  modelsCache = null
}

// ── Chat turn ───────────────────────────────────────────────────────────────

interface GatewayChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function buildGatewayMessages(req: ChatRequest): GatewayChatMessage[] {
  const messages: GatewayChatMessage[] = []
  for (const message of getPreparedMessages(req)) {
    const role = message.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
    const content = String(message.content ?? '')
    if (!content.trim()) continue
    messages.push({ role, content })
  }
  return messages
}

function buildSystemPrompt(req: ChatRequest): string {
  return [req.agentMode?.systemPrompt, req.contextPrompt, req.memoryPrompt]
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

function buildToolSet(req: ChatRequest, scope: ChatStreamScope, principal: McpPrincipal): ToolSet {
  const allowList = resolveAgentToolAllowList(req.agentMode)
  const tools: ToolSet = {}
  for (const schema of selectGatewayTools(getAllStaticTools(), allowList)) {
    tools[schema.name] = tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (input: unknown) => {
        try {
          const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
          return await executeChatAgentTool(schema.name, args, principal)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log('gateway tool failed', { tool: schema.name, scope: chatStreamScopeKey(scope), error: message })
          return `Tool ${schema.name} failed: ${message}`
        }
      },
    })
  }
  return tools
}

function toolOutputText(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text
}

export function chatGateway(req: ChatRequest): void {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)

  const apiKey = resolveGatewayApiKey()
  if (!apiKey) {
    sendStream(scope, {
      type: 'error',
      error: 'AI Gateway key missing. Add it under Settings → Providers → AI Gateway (get a key at vercel.com → AI Gateway), or set AI_GATEWAY_API_KEY in the environment CodeSurf was launched from.',
    })
    sendStream(scope, { type: 'done' })
    return
  }

  // Fail closed: an agentId whose Persona has not resolved must never launch
  // unrestricted (A-PR1 BLOCKING-1 — same rule as the other providers).
  if (agentModeUnresolved(req)) {
    sendStream(scope, { type: 'error', error: AGENT_MODE_UNRESOLVED_ERROR })
    sendStream(scope, { type: 'done' })
    return
  }

  // Fail closed on identity for the same reason. This provider is the only one
  // that constructs an McpPrincipal from request fields rather than resolving a
  // tile token, so an unbound turn must be refused here — falling back to
  // { kind: 'global' } would hand the model an unscoped credential that
  // assertTileScope never checks.
  const principal = resolveGatewayPrincipal(req.workspaceId, req.cardId)
  if (!principal) {
    sendStream(scope, { type: 'error', error: GATEWAY_PRINCIPAL_UNRESOLVED_ERROR })
    sendStream(scope, { type: 'done' })
    return
  }

  const messages = buildGatewayMessages(req)
  if (!messages.some(message => message.role === 'user')) {
    sendStream(scope, { type: 'error', error: 'No user message' })
    sendStream(scope, { type: 'done' })
    return
  }

  // Supersede any in-flight turn for this card.
  activeGatewayTurns.get(scopeKey)?.abort()
  const controller = new AbortController()
  activeGatewayTurns.set(scopeKey, controller)
  const isCurrent = (): boolean => activeGatewayTurns.get(scopeKey) === controller
  const finish = (): void => {
    if (isCurrent()) activeGatewayTurns.delete(scopeKey)
  }

  const system = buildSystemPrompt(req)
  const tools = buildToolSet(req, scope, principal)
  const toolCount = Object.keys(tools).length
  log('chatGateway starting', { model: req.model, messages: messages.length, tools: toolCount })

  void (async () => {
    const gateway = createGateway({ apiKey })
    const result = streamText({
      model: gateway(req.model),
      ...(system ? { system } : {}),
      messages,
      ...(toolCount > 0 ? { tools, stopWhen: stepCountIs(MAX_TOOL_STEPS) } : {}),
      abortSignal: controller.signal,
    })

    let accepted = false
    const acceptPrompt = (): void => {
      if (accepted) return
      accepted = true
      markRoomPromptAccepted(scope)
    }

    for await (const part of result.fullStream) {
      if (!isCurrent()) return
      switch (part.type) {
        case 'text-delta': {
          const text = String((part as { text?: unknown }).text ?? '')
          if (text) {
            acceptPrompt()
            sendStream(scope, { type: 'text', text })
          }
          break
        }
        case 'reasoning-delta': {
          const text = String((part as { text?: unknown }).text ?? '')
          if (text) {
            acceptPrompt()
            sendStream(scope, { type: 'thinking', text })
          }
          break
        }
        case 'tool-call': {
          acceptPrompt()
          sendStream(scope, { type: 'tool_start', toolName: part.toolName, toolId: part.toolCallId })
          sendStream(scope, {
            type: 'tool_use',
            toolName: part.toolName,
            toolId: part.toolCallId,
            toolInput: JSON.stringify(part.input ?? {}, null, 2),
          })
          break
        }
        case 'tool-result': {
          sendStream(scope, {
            type: 'tool_summary',
            toolId: part.toolCallId,
            toolName: part.toolName,
            text: toolOutputText(part.output),
          })
          break
        }
        case 'tool-error': {
          const raw = (part as { error?: unknown }).error
          sendStream(scope, {
            type: 'tool_summary',
            toolId: part.toolCallId,
            toolName: part.toolName,
            text: `Tool error: ${raw instanceof Error ? raw.message : String(raw ?? 'unknown')}`,
          })
          break
        }
        case 'error': {
          const raw = (part as { error?: unknown }).error
          throw raw instanceof Error ? raw : new Error(String(raw ?? 'AI Gateway stream error'))
        }
        default:
          break
      }
    }

    if (!isCurrent()) return
    finish()
    sendStream(scope, { type: 'done' })
  })().catch((err: unknown) => {
    if (!isCurrent()) return
    finish()
    if (controller.signal.aborted) {
      sendStream(scope, { type: 'done' })
      return
    }
    sendStream(scope, {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
    sendStream(scope, { type: 'done' })
  })
}
