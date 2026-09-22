// Pure wire helpers for the Omnigent provider runner.
//
// Mirrors codex-sdk-provider.mjs: the fetch/spawn/abort logic lives in the
// runOmnigentJob closure inside chat-jobs.mjs; everything here is pure and
// side-effect free so it can be unit tested without importing the Claude SDK
// (and so the runner reads like the codex runner, which imports its helpers).
//
// Wire protocol (see omnigent/server/API.md — the backend source of truth):
//   POST /v1/sessions                      -> create persistent session
//   GET  /v1/sessions/{id}/stream          -> live SSE tail (stays open!)
//   POST /v1/sessions/{id}/events          -> push user message / interrupt
//   GET  /v1/agents                        -> agent discovery

export const OMNIGENT_DEFAULT_BASE_URL = 'http://127.0.0.1:6767'
export const OMNIGENT_DEFAULT_CLI = 'omni'
export const OMNIGENT_FALLBACK_MODEL_ID = 'omnigent:default'
const OMNIGENT_MODEL_PREFIX = 'omnigent:'

// Trim trailing slashes and a trailing /v1 so callers can pass either the
// server root or the OpenAI-style /v1 base interchangeably.
export function normalizeOmnigentServerRoot(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '')
  return trimmed.replace(/\/v1$/i, '') || OMNIGENT_DEFAULT_BASE_URL
}

export function omnigentEndpointUrl(baseUrl, path) {
  return `${normalizeOmnigentServerRoot(baseUrl)}${path}`
}

export function omnigentAuthHeaders(apiKey) {
  const token = String(apiKey ?? '').trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// `omnigent:<encoded-agent-id>` -> agent id; the fallback row resolves to null
// so the runner falls back to the configured agent id / first available agent.
export function decodeOmnigentModelId(modelId) {
  const id = String(modelId ?? '')
  if (id === OMNIGENT_FALLBACK_MODEL_ID) return null
  if (!id.startsWith(OMNIGENT_MODEL_PREFIX)) return null
  const encoded = id.slice(OMNIGENT_MODEL_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    // Malformed percent-encoding: return null (mirrors the CLI provider) rather
    // than the raw encoded string, which could become a bogus agent lookup.
    return null
  }
}

// Precedence mirrors the CLI provider exactly (id, then session_id, then
// conversation_id — flat keys first, then the nested `session` object) so the
// daemon persists the SAME session id the CLI would for a given response.
export function extractOmnigentSessionId(payload) {
  const record = payload && typeof payload === 'object' ? payload : null
  for (const key of ['id', 'session_id', 'conversation_id']) {
    const value = record?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const nested = record?.session && typeof record.session === 'object' ? record.session : null
  const nestedId = nested?.id ?? nested?.session_id ?? nested?.conversation_id
  return typeof nestedId === 'string' && nestedId.trim() ? nestedId.trim() : null
}

// Normalize the /v1/hosts response into `{ id, name, status }` rows. Mirrors the
// CLI provider's parseOmnigentHosts: accept a bare array, `{ hosts: [...] }`, or
// `{ data: [...] }`, and prefer `host_id` over `id` for the runner id (the
// backend keys runner registration on host_id). Rows without an id are dropped.
export function parseOmnigentHosts(payload) {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(record.hosts)
      ? record.hosts
      : Array.isArray(record.data)
        ? record.data
        : []
  return rows
    .map(item => {
      const row = item && typeof item === 'object' ? item : null
      const id = typeof row?.host_id === 'string' && row.host_id.trim()
        ? row.host_id.trim()
        : typeof row?.id === 'string' && row.id.trim()
          ? row.id.trim()
          : ''
      if (!id) return null
      const name = typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : undefined
      const status = typeof row?.status === 'string' && row.status.trim() ? row.status.trim() : undefined
      return { id, name, status }
    })
    .filter(Boolean)
}

// Pick the runner host to bind a new session to: the first host reporting status
// `online`, else the first host (covers backends that omit status). Status is
// compared case-insensitively — backends/CLIs report ONLINE/Online/online — so a
// non-lowercase online host isn't missed in favor of a stale first host. Mirrors
// the CLI provider's chooseOmnigentHost. Returns the chosen row or null when empty.
export function chooseOmnigentHost(hosts) {
  const rows = Array.isArray(hosts) ? hosts : []
  return rows.find(host => String(host?.status ?? '').toLowerCase() === 'online') ?? rows[0] ?? null
}

// Build the POST /v1/sessions request body. Pure + exported (mirrors
// buildCodexExecArgs in chat-jobs.mjs) so the daemon test can assert host_id is
// included alongside agent_id without importing the Claude SDK that chat-jobs.mjs
// pulls in. host_id is the load-bearing field: without it the Omnigent backend
// never binds a runner and every turn fails with runner_unavailable.
export function buildOmnigentSessionBody({ agentId, hostId, title, workspace } = {}) {
  return {
    agent_id: agentId,
    ...(hostId ? { host_id: hostId } : {}),
    title,
    ...(workspace ? { workspace } : {}),
  }
}

export function parseOmnigentServerUrl(output) {
  const match = String(output ?? '').match(/https?:\/\/[^\s)]+/i)
  return match ? normalizeOmnigentServerRoot(match[0]) : null
}

export function parseOmnigentStatusJson(output) {
  const text = String(output ?? '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    const parsed = JSON.parse(text.slice(first, last + 1))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

// Parse one SSE record (the text between two blank-line boundaries) into its
// `event:` name and joined `data:` payload.
export function parseOmnigentSseChunk(chunk) {
  const lines = String(chunk ?? '').split('\n')
  const eventLines = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim())
  const dataLines = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
  return {
    eventName: eventLines[0] ?? null,
    data: dataLines.length > 0 ? dataLines.join('\n') : null,
  }
}

function omnigentFunctionCallId(item) {
  const callId = typeof item?.call_id === 'string' && item.call_id.trim() ? item.call_id.trim() : null
  if (callId) return callId
  return typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : null
}

function omnigentFailureMessage(event) {
  const response = event?.response && typeof event.response === 'object' ? event.response : null
  const error = response?.error && typeof response.error === 'object' ? response.error : null
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim()
  if (typeof event?.error === 'object' && typeof event.error?.message === 'string' && event.error.message.trim()) {
    return event.error.message.trim()
  }
  if (typeof event?.error === 'string' && event.error.trim()) return event.error.trim()
  if (typeof event?.message === 'string' && event.message.trim()) return event.message.trim()
  return 'Omnigent turn failed.'
}

// Map a single Omnigent SSE event to a normalized descriptor the runner turns
// into daemon events. Pure + stateless: tool-call dedup (lazy tool_start) is the
// runner's job because the typed-event table only guarantees output_item.done.
//
// Returns one of:
//   { kind: 'text', text }
//   { kind: 'thinking', text }
//   { kind: 'thinking_start' }
//   { kind: 'tool_call', toolId, toolName, toolInput|null }  (toolInput set on .done)
//   { kind: 'tool_result', toolId, output }
//   { kind: 'terminal', stop: 'done' }
//   { kind: 'terminal', stop: 'error', error }
//   null  (heartbeat / status / unknown -> ignore)
export function mapOmnigentStreamEvent(raw) {
  const event = raw && typeof raw === 'object' ? raw : null
  const type = typeof event?.type === 'string' ? event.type : ''

  switch (type) {
    case 'response.output_text.delta': {
      const text = typeof event?.delta === 'string' ? event.delta : ''
      return text ? { kind: 'text', text } : null
    }
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta': {
      const text = typeof event?.delta === 'string' ? event.delta : ''
      return text ? { kind: 'thinking', text } : null
    }
    case 'response.reasoning.started':
      return { kind: 'thinking_start' }
    // The CLI omnigent-provider does not map output_item events, so it is silent
    // on tool calls. The function_call / function_call_output item shapes below
    // are taken from the BACKEND source of truth — omnigent/server/schemas.py
    // (OutputItemDoneEvent docstring, which gives an explicit function_call
    // example) and omnigent/entities/conversation.py (FunctionCallData: name,
    // arguments, call_id; FunctionCallOutputData: call_id, output). They have NOT
    // been exercised against a captured live SSE sample; if behaviour drifts,
    // re-confirm field names against those classes before changing the mapping.
    case 'response.output_item.added':
    case 'response.output_item.done': {
      const item = event?.item && typeof event.item === 'object' ? event.item : null
      const itemType = typeof item?.type === 'string' ? item.type : ''
      if (itemType === 'function_call') {
        const toolId = omnigentFunctionCallId(item)
        if (!toolId) return null
        const toolName = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : 'tool'
        const toolInput = type === 'response.output_item.done' && typeof item?.arguments === 'string'
          ? item.arguments
          : null
        return { kind: 'tool_call', toolId, toolName, toolInput }
      }
      if (itemType === 'function_call_output' && type === 'response.output_item.done') {
        const toolId = typeof item?.call_id === 'string' && item.call_id.trim() ? item.call_id.trim() : null
        if (!toolId) return null
        const output = typeof item?.output === 'string' ? item.output : ''
        return { kind: 'tool_result', toolId, output }
      }
      // message / reasoning items are surfaced through the delta events above.
      return null
    }
    case 'response.completed':
    case 'response.incomplete':
    case 'response.cancelled':
      return { kind: 'terminal', stop: 'done' }
    case 'response.failed':
    case 'response.error':
      return { kind: 'terminal', stop: 'error', error: omnigentFailureMessage(event) }
    case 'session.status': {
      const status = typeof event?.status === 'string'
        ? event.status
        : typeof event?.data?.status === 'string'
          ? event.data.status
          : ''
      if (status === 'failed') return { kind: 'terminal', stop: 'error', error: omnigentFailureMessage(event) }
      return null
    }
    default:
      return null
  }
}
