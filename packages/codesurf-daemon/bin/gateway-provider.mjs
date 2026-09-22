/**
 * AI Gateway provider for daemon chat jobs — streaming inference + canvas
 * tool loop via the AI SDK (v7), mirroring src/main/chat/providers/gateway.ts
 * (kept separate because the daemon is a self-contained Node ESM process; the
 * test/daemon suite imports BOTH sides and asserts the shared pure helpers
 * agree, guarding against drift).
 *
 * Key: `AI_GATEWAY_API_KEY` in the daemon's environment. The desktop app
 * injects it from the encrypted secrets store when it spawns the daemon;
 * standalone daemon-server deployments set it themselves.
 *
 * Tools: when the daemon shares a filesystem with a running desktop app, the
 * tile-scoped MCP config (~/.codesurf/workspaces/{ws}/tiles/{tile}/
 * mcp-server.json) carries the canvas server URL + bearer token, and the tool
 * loop calls the canvas MCP server over loopback HTTP with the same
 * tile-scoped principal the desktop path uses. Headless daemons (no canvas
 * running) degrade to plain streaming chat.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createGateway } from '@ai-sdk/gateway'
import { jsonSchema, stepCountIs, streamText, tool } from 'ai'
import { normalizeToolName, resolveAgentToolAllowList } from './agent-mode-tools.mjs'

const MAX_TOOL_STEPS = 24
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const BRIDGE_TIMEOUT_MS = 30_000

export function resolveGatewayApiKey(env = process.env) {
  const key = typeof env.AI_GATEWAY_API_KEY === 'string' ? env.AI_GATEWAY_API_KEY.trim() : ''
  return key || null
}

// ── Pure helpers (drift-tested against src/main/chat/gateway-tools.ts) ──────

export function selectGatewayTools(all, allowList) {
  if (allowList == null) return all
  if (allowList.length === 0) return []
  const allowed = new Set(allowList.map(normalizeToolName))
  return all.filter(entry => allowed.has(normalizeToolName(entry.name)))
}

function formatPricing(pricing) {
  if (!pricing) return null
  const perMillion = (raw) => {
    const perToken = Number(raw)
    if (!Number.isFinite(perToken) || perToken <= 0) return null
    const value = perToken * 1_000_000
    return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 100) / 100)
  }
  const input = perMillion(pricing.input)
  const output = perMillion(pricing.output)
  if (!input || !output) return null
  return `$${input}/M in · $${output}/M out`
}

export function mapGatewayModels(entries) {
  const options = []
  for (const entry of entries ?? []) {
    if (typeof entry?.id !== 'string' || !entry.id.trim()) continue
    if (entry.modelType != null && entry.modelType !== 'language') continue
    const label = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : entry.id
    const pricing = formatPricing(entry.pricing)
    const description = [entry.description?.trim(), pricing].filter(Boolean).join(' — ') || undefined
    options.push({ id: entry.id, label, ...(description ? { description } : {}) })
  }
  return options
}

// ── Model listing (GET /chat/gateway-models) ────────────────────────────────

let modelsCache = null

export async function fetchGatewayModels(env = process.env) {
  const apiKey = resolveGatewayApiKey(env)
  if (!apiKey) return { models: [], source: 'none', error: 'AI Gateway key not configured (set AI_GATEWAY_API_KEY for the daemon)' }
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

export function invalidateGatewayModelsCache() {
  modelsCache = null
}

// ── Canvas tool bridge (tile-scoped MCP over loopback HTTP) ─────────────────

function codesurfHome(env = process.env) {
  const explicit = typeof env.CODESURF_HOME === 'string' ? env.CODESURF_HOME.trim() : ''
  return explicit || join(homedir(), '.codesurf')
}

export function tileMcpConfigPath(workspaceId, tileId, env = process.env) {
  // Path segments must be plain ids — refuse anything that could traverse.
  const safe = (value) => {
    const segment = String(value ?? '').trim()
    return segment && !/[/\\]|\.\./.test(segment) ? segment : null
  }
  const ws = safe(workspaceId)
  const tile = safe(tileId)
  if (!ws || !tile) return null
  return join(codesurfHome(env), 'workspaces', ws, 'tiles', tile, 'mcp-server.json')
}

/**
 * Read the tile-scoped MCP config and return a bridge for tools/list +
 * tools/call, or null when the canvas server is unreachable (headless daemon,
 * desktop app not running, stale config).
 */
export async function loadCanvasToolBridge({ workspaceId, tileId, env = process.env, fetchImpl = fetch } = {}) {
  const configPath = tileMcpConfigPath(workspaceId, tileId, env)
  if (!configPath) return null

  let config
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    return null
  }
  const token = typeof config?.token === 'string' ? config.token.trim() : ''
  const baseUrl = typeof config?.url === 'string' ? config.url.trim().replace(/\/$/, '') : ''
  if (!token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) return null
  const endpoint = `${baseUrl}/mcp`

  let nextId = 1
  const rpc = async (method, params) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`canvas MCP server responded ${response.status}`)
      const payload = await response.json()
      if (payload?.error) throw new Error(String(payload.error.message ?? 'canvas MCP error'))
      return payload?.result
    } finally {
      clearTimeout(timer)
    }
  }

  let tools
  try {
    const listed = await rpc('tools/list', {})
    tools = (listed?.tools ?? []).filter(entry =>
      typeof entry?.name === 'string'
      && entry.inputSchema
      && typeof entry.inputSchema === 'object',
    )
  } catch {
    return null
  }
  if (!tools.length) return null

  return {
    tools,
    call: async (name, args) => {
      const result = await rpc('tools/call', { name, arguments: args ?? {} })
      const text = result?.content?.find?.(part => part?.type === 'text')?.text
      return typeof text === 'string' ? text : JSON.stringify(result ?? null)
    },
  }
}

// ── Chat job ────────────────────────────────────────────────────────────────

function buildGatewayMessages(request) {
  const messages = []
  for (const message of request.messages ?? []) {
    const role = message?.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
    const content = String(message?.content ?? '')
    if (!content.trim()) continue
    messages.push({ role, content })
  }
  return messages
}

function toolOutputText(output) {
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  return text.length > TOOL_OUTPUT_MAX_CHARS ? `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}…` : text
}

/**
 * Run one gateway chat turn as a daemon job. The A-PR1 agent-mode fail-closed
 * guard runs at the shared job-start chokepoint in chat-jobs.mjs, before any
 * provider is reached — this function can trust request.agentMode.
 */
export async function runGatewayJob(job, request, workspaceDir, instructionPrompt, hooks) {
  const { appendEvent, contextPrompt } = hooks

  const apiKey = resolveGatewayApiKey()
  if (!apiKey) {
    await appendEvent(job.id, {
      type: 'error',
      error: 'AI Gateway key missing. On desktop, add it under Settings → Providers → AI Gateway; for a standalone daemon set AI_GATEWAY_API_KEY in its environment (get a key at vercel.com → AI Gateway).',
    })
    await appendEvent(job.id, { type: 'done' })
    return
  }

  const messages = buildGatewayMessages(request)
  if (!messages.some(message => message.role === 'user')) {
    await appendEvent(job.id, { type: 'error', error: 'No user message' })
    await appendEvent(job.id, { type: 'done' })
    return
  }

  const abortController = new AbortController()
  job.cancel = () => { try { abortController.abort() } catch {} }
  if (job.cancelRequested) return

  const system = [request.agentMode?.systemPrompt, contextPrompt, instructionPrompt]
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('\n\n')

  // Canvas tools ride the tile-scoped MCP bridge when the desktop canvas is
  // reachable; otherwise this is a plain streaming chat turn.
  const allowList = resolveAgentToolAllowList(request.agentMode)
  let bridge = null
  if (allowList == null || allowList.length > 0) {
    bridge = await loadCanvasToolBridge({
      workspaceId: request.workspaceId,
      tileId: request.cardId,
    }).catch(() => null)
  }
  if (job.cancelRequested) return

  const tools = {}
  for (const schema of selectGatewayTools(bridge?.tools ?? [], allowList)) {
    tools[schema.name] = tool({
      description: schema.description ?? '',
      inputSchema: jsonSchema(schema.inputSchema),
      execute: async (input) => {
        try {
          const args = input && typeof input === 'object' ? input : {}
          return await bridge.call(schema.name, args)
        } catch (err) {
          return `Tool ${schema.name} failed: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    })
  }
  const toolCount = Object.keys(tools).length

  try {
    const gateway = createGateway({ apiKey })
    const result = streamText({
      model: gateway(request.model),
      ...(system ? { system } : {}),
      messages,
      ...(toolCount > 0 ? { tools, stopWhen: stepCountIs(MAX_TOOL_STEPS) } : {}),
      abortSignal: abortController.signal,
    })

    for await (const part of result.fullStream) {
      if (job.cancelRequested) return
      switch (part.type) {
        case 'text-delta': {
          const text = String(part.text ?? '')
          if (text) await appendEvent(job.id, { type: 'text', text })
          break
        }
        case 'reasoning-delta': {
          const text = String(part.text ?? '')
          if (text) await appendEvent(job.id, { type: 'thinking', text, thinkingId: 'think-gateway-0' })
          break
        }
        case 'tool-call': {
          await appendEvent(job.id, { type: 'tool_start', toolName: part.toolName, toolId: part.toolCallId })
          await appendEvent(job.id, {
            type: 'tool_use',
            toolName: part.toolName,
            toolId: part.toolCallId,
            toolInput: JSON.stringify(part.input ?? {}, null, 2),
          })
          break
        }
        case 'tool-result': {
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId: part.toolCallId,
            toolName: part.toolName,
            text: toolOutputText(part.output),
          })
          break
        }
        case 'tool-error': {
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId: part.toolCallId,
            toolName: part.toolName,
            text: `Tool error: ${part.error instanceof Error ? part.error.message : String(part.error ?? 'unknown')}`,
          })
          break
        }
        case 'error': {
          const raw = part.error
          throw raw instanceof Error ? raw : new Error(String(raw ?? 'AI Gateway stream error'))
        }
        default:
          break
      }
    }

    await appendEvent(job.id, { type: 'done' })
  } catch (err) {
    if (abortController.signal.aborted || job.cancelRequested) {
      await appendEvent(job.id, { type: 'done' })
      return
    }
    await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    await appendEvent(job.id, { type: 'done' })
  }
}
