/**
 * Local MCP server for CodeSurf kanban integration.
 * Agents call these tools to signal completion, update status, add notes.
 *
 * Exposes an HTTP server on a random port. Port is written to:
 *   ~/.codesurf/mcp-server.json
 *
 * MCP config for agents:
 *   { "mcpServers": { "kanban": { "type": "http", "url": "http://localhost:<port>/mcp" } } }
 */

import { bus } from './event-bus'
import { createServer, type Server, IncomingMessage, ServerResponse } from 'http'
import { constants as fsConstants, promises as fs } from 'fs'
import { join, sep } from 'path'
import { randomUUID } from 'node:crypto'
import type { ExtensionRegistry } from './extensions/registry'
import { broadcastToRenderer } from './utils/broadcast'
import { log } from './utils/logger.ts'

const mcpLog = log.scope('MCP')
import { getAllNodeTools, getPeerBridgeNodeTools } from '../shared/nodeTools'
import { CODESURF_HOME } from './paths'
import { assertSafePathSegment } from './security/pathSegments'
import { dispatchTool, getAllStaticTools } from './mcp/registry'
import { executeImageEditTool as executeImageEditToolImpl } from './mcp/tools/generation'
import { resolveTileWorkspaceDir } from './mcp/tools/peer-bridge'
import { requestToolPermission } from './permissions'
import type { McpToolContext, McpToolSchema } from './mcp/types'
import {
  resolvePrincipal,
  assertTileScope,
  type McpPrincipal,
  type TileTokenRecord,
} from './mcp/auth'
import {
  MAX_MCP_RESULT_BYTES,
  MAX_MCP_RESULT_ESTIMATED_TOKENS,
  estimateTokenCount,
  truncateUtf8,
} from './agent-room/validation.ts'

const MCP_TOKEN = randomUUID()
const MAX_BODY = 1024 * 1024 // 1MB
const MAX_CONTEXT_FILES = 32
const MAX_CONTEXT_SOURCE_BYTES = 8 * 1024
const MAX_SSE_CLIENTS = 128

// Per-tile token registry — limits blast radius if a tile's token leaks.
// The global MCP_TOKEN remains for server discovery and renderer IPC.
const tileTokens = new Map<string, TileTokenRecord>()

function tileTokenKey(workspaceId: string, tileId: string): string {
  return `${workspaceId}\0${tileId}`
}

/** Generate a per-tile token for scoped MCP auth. */
export function generateTileToken(workspaceId: string, tileId: string): string {
  const key = tileTokenKey(workspaceId, tileId)
  const existing = tileTokens.get(key)
  if (existing) return existing.token
  const token = randomUUID()
  tileTokens.set(key, { workspaceId, tileId, token })
  return token
}

/** Revoke a tile's MCP token (call on tile deletion). */
export function revokeTileToken(workspaceId: string, tileId: string): void {
  tileTokens.delete(tileTokenKey(workspaceId, tileId))
}

/** Get a tile-specific token, generating one if needed. */
export function getTileToken(workspaceId: string, tileId: string): string {
  return generateTileToken(workspaceId, tileId)
}

// SSE client registry: workspace/card scope → response streams.
// The two wildcard keys preserve the operator-facing global stream while
// allowing workspace UI surfaces to avoid cross-workspace event delivery.
const sseClients = new Map<string, Set<ServerResponse>>()
const GLOBAL_SSE_SCOPE = 'global'

function workspaceSseScopeKey(workspaceId: string): string {
  return JSON.stringify(['workspace', workspaceId])
}

function cardSseScopeKey(workspaceId: string, cardId: string): string {
  return JSON.stringify(['card', workspaceId, cardId])
}

function isSafeMcpScopeId(value: unknown, label: string): value is string {
  if (typeof value !== 'string') return false
  try {
    assertSafePathSegment(value, label)
    return true
  } catch {
    return false
  }
}

export function requireMcpPermissionWorkspace(
  workspaceDir: string | null | undefined,
  operation: string,
): string {
  const scopedWorkspaceDir = String(workspaceDir ?? '').trim()
  if (!scopedWorkspaceDir) {
    throw new Error(`${operation} requires an authoritative workspace scope`)
  }
  return scopedWorkspaceDir
}

export function isValidSseEventName(event: unknown): event is string {
  return typeof event === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(event)
}

function totalSseClients(): number {
  let total = 0
  for (const clients of sseClients.values()) total += clients.size
  return total
}

const getContexDir = (): string => CODESURF_HOME

interface MCPRequest {
  jsonrpc: string
  id: number | string
  method: string
  params?: {
    name?: string
    arguments?: Record<string, unknown>
  }
}

type UserConfigWorkspaceRef = {
  id: string
  path: string
}

async function readWorkspaceRefsFromUserConfig(): Promise<UserConfigWorkspaceRef[]> {
  try {
    const userConfigPath = join(getContexDir(), 'config.json')
    const raw = await fs.readFile(userConfigPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      projects?: Array<{ id?: string; path?: string }>
      workspaces?: Array<{ id?: string; path?: string; projectIds?: string[]; primaryProjectId?: string | null }>
    }

    if (Array.isArray(parsed.projects) && Array.isArray(parsed.workspaces)) {
      const projectsById = new Map(
        parsed.projects
          .filter(project => typeof project?.id === 'string' && typeof project?.path === 'string' && project.path.trim())
          .map(project => [String(project.id), String(project.path).trim()] as const),
      )

      return parsed.workspaces.flatMap(workspace => {
        const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
        if (!workspaceId) return []

        const directPath = typeof workspace?.path === 'string' ? workspace.path.trim() : ''
        if (directPath) return [{ id: workspaceId, path: directPath }]

        const primaryProjectId = typeof workspace?.primaryProjectId === 'string' ? workspace.primaryProjectId : null
        const projectIds = Array.isArray(workspace?.projectIds) ? workspace.projectIds : []
        const projectPath = (primaryProjectId && projectsById.get(primaryProjectId))
          || projectIds.map(projectId => projectsById.get(String(projectId))).find(Boolean)
          || ''
        return projectPath ? [{ id: workspaceId, path: projectPath }] : []
      })
    }

    if (Array.isArray(parsed.workspaces)) {
      return parsed.workspaces.flatMap(workspace => {
        const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
        const workspacePath = typeof workspace?.path === 'string' ? workspace.path.trim() : ''
        return workspaceId && workspacePath ? [{ id: workspaceId, path: workspacePath }] : []
      })
    }
  } catch {
    // ignore missing or invalid config
  }

  return []
}

function normalizeMcpServer(entry: unknown, fallbackUrl?: string): Record<string, unknown> {
  if (!entry || typeof entry !== 'object') return fallbackUrl ? { type: 'http', url: fallbackUrl } : {}

  const server = { ...(entry as Record<string, unknown>) }

  if (server.url && typeof server.url === 'string') {
    server.url = server.url.replace(/\/$/, '')
  }

  if (!server.command && server.cmd && typeof server.cmd === 'string') {
    const parts = String(server.cmd).trim().split(/\s+/)
    if (parts.length > 0 && parts[0]) {
      server.command = parts[0]
      if (parts.length > 1) server.args = parts.slice(1)
    }
  }

  if (!server.type) {
    if (server.command) {
      server.type = 'stdio'
    } else if (server.url || fallbackUrl) {
      server.type = 'http'
    }
  }

  if (!server.url && fallbackUrl) {
    server.url = fallbackUrl
  }

  if (server.enabled === undefined) {
    server.enabled = true
  }

  return server
}

function normalizeMcpServers(servers: Record<string, unknown>, contexUrl?: string): Record<string, Record<string, unknown>> {
  const normalized: Record<string, Record<string, unknown>> = {}
  for (const [name, server] of Object.entries(servers ?? {})) {
    const fallbackUrl = name === 'codesurf' || name === 'contex' ? contexUrl : undefined
    normalized[name] = normalizeMcpServer(server, fallbackUrl)
  }
  return normalized
}

let extensionRegistryProvider: (() => ExtensionRegistry | null) | null = null

export function setExtensionRegistryProvider(provider: () => ExtensionRegistry | null): void {
  extensionRegistryProvider = provider
}

function getExtensionTools() {
  return extensionRegistryProvider?.()?.getMCPTools() ?? []
}

/** Tools not yet extracted into mcp/tools modules (bus ask + collab helpers). */
const LOCAL_TOOLS: McpToolSchema[] = [
  {
    name: 'ask',
    description: 'Ask the canvas operator a question. Returns when they respond.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional choices' }
      },
      required: ['channel', 'question']
    }
  },
  {
    name: 'reload_objective',
    description: 'Read the latest objective.md for a block. Call this when you receive a reload signal or need to refresh your instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID (required for global-token callers)' },
        tile_id: { type: 'string', description: 'The block ID whose objective to read' }
      },
      required: ['tile_id']
    }
  },
  {
    name: 'pause_task',
    description: 'Pause a task. The drawer UI will show it as paused and the operator can resume it.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish to (e.g. tile:abc123)' },
        task_id: { type: 'string' },
        reason: { type: 'string', description: 'Why the task is being paused' }
      },
      required: ['channel', 'task_id']
    }
  },
  {
    name: 'get_context',
    description: 'Read all context files dropped into a block\'s .codesurf context folder. Returns concatenated content of all notes and reference files.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID (required for global-token callers)' },
        tile_id: { type: 'string', description: 'The block ID whose context to read' }
      },
      required: ['tile_id']
    }
  },
]

function getAllTools() {
  const peerBridgeToolNames = new Set(getPeerBridgeNodeTools().map(tool => tool.name))
  const tools = [
    ...getAllStaticTools(),
    ...LOCAL_TOOLS,
    ...getAllNodeTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: peerBridgeToolNames.has(tool.name)
        ? {
            ...tool.inputSchema,
            properties: {
              workspace_id: {
                type: 'string',
                description: 'Workspace ID (required for global-token callers; inferred for tile tokens)',
              },
              ...tool.inputSchema.properties,
            },
          }
        : tool.inputSchema,
    })),
    ...getExtensionTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  ]
  const seen = new Set<string>()
  return tools.filter(tool => {
    if (seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

export function getMCPToken(): string {
  return MCP_TOKEN
}

export function buildContexHttpMcpServerEntry(
  contexUrl: string,
  scope?: { workspaceId: string, tileId: string },
): Record<string, unknown> {
  const token = scope
    ? getTileToken(scope.workspaceId, scope.tileId)
    : MCP_TOKEN
  return {
    type: 'http',
    url: contexUrl.replace(/\/$/, ''),
    headers: { Authorization: `Bearer ${token}` },
  }
}

/**
 * Path for a per-tile MCP config that embeds the tile-scoped bearer token.
 * Spawned agents (terminal CLI, Codex, etc.) should point at this file instead
 * of the global `~/.codesurf/mcp-server.json` so plan-010 tile scope guards
 * actually fire (SEC-05).
 */
export function tileMcpConfigPath(workspaceId: string, tileId: string): string {
  return join(
    getContexDir(),
    'workspaces',
    assertSafePathSegment(workspaceId, 'workspaceId'),
    'tiles',
    assertSafePathSegment(tileId, 'tileId'),
    'mcp-server.json',
  )
}

/**
 * Write (or refresh) a tile-scoped MCP config. Returns the absolute path, or
 * null when the server is not yet listening / tileId is invalid.
 */
export async function writeTileMcpConfig(
  workspaceId: string,
  tileId: string,
): Promise<string | null> {
  if (!serverPort || !workspaceId || !tileId) return null
  let safeWorkspaceId: string
  let safeTileId: string
  try {
    safeWorkspaceId = assertSafePathSegment(workspaceId, 'workspaceId')
    safeTileId = assertSafePathSegment(tileId, 'tileId')
  } catch {
    return null
  }

  const configPath = tileMcpConfigPath(safeWorkspaceId, safeTileId)
  const baseUrl = `http://127.0.0.1:${serverPort}`
  const contexUrl = `${baseUrl}/mcp`
  const config = {
    port: serverPort,
    url: baseUrl,
    // tile token only — not the global MCP_TOKEN
    token: getTileToken(safeWorkspaceId, safeTileId),
    workspaceId: safeWorkspaceId,
    tileId: safeTileId,
    updatedAt: new Date().toISOString(),
    mcpServers: {
      codesurf: buildContexHttpMcpServerEntry(contexUrl, {
        workspaceId: safeWorkspaceId,
        tileId: safeTileId,
      }),
    },
  }
  await fs.mkdir(join(
    getContexDir(),
    'workspaces',
    safeWorkspaceId,
    'tiles',
    safeTileId,
  ), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  await fs.chmod(configPath, 0o600).catch(() => {})
  return configPath
}

/** Names of all tools returned by tools/list (static + node bridge + extensions). */
export function getContexMcpToolNames(): string[] {
  return Array.from(new Set([
    ...getAllStaticTools().map(t => t.name),
    ...LOCAL_TOOLS.map(t => t.name),
    ...getAllNodeTools().map(t => t.name),
    ...getExtensionTools().map(t => t.name),
  ]))
}

function writeSseEvent(scopeKey: string, payload: string): void {
  const clients = sseClients.get(scopeKey)
  clients?.forEach(res => {
    try {
      if (!res.write(payload)) {
        clients.delete(res)
        res.end()
      }
    } catch {
      clients.delete(res)
    }
  })
  if (clients?.size === 0) sseClients.delete(scopeKey)
}

function pushSSE(
  workspaceId: string,
  cardId: string,
  event: string,
  data: unknown,
): void {
  if (!isValidSseEventName(event)) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  if (workspaceId && cardId) {
    writeSseEvent(cardSseScopeKey(workspaceId, cardId), payload)
  }
  if (workspaceId) writeSseEvent(workspaceSseScopeKey(workspaceId), payload)
  writeSseEvent(GLOBAL_SSE_SCOPE, payload)
}

function sendToRenderer(event: string, data: unknown): void {
  broadcastToRenderer('mcp:kanban', { event, data })
}

export async function readContextFilesBounded(
  ctxDir: string,
  allowedRoot?: string,
): Promise<string> {
  if (allowedRoot) {
    try {
      const [realRoot, realContext] = await Promise.all([
        fs.realpath(allowedRoot),
        fs.realpath(ctxDir),
      ])
      if (
        realContext !== realRoot
        && !realContext.startsWith(`${realRoot}${sep}`)
      ) return ''
    } catch {
      return ''
    }
  }
  let entries
  try {
    entries = await fs.readdir(ctxDir, { withFileTypes: true })
  } catch {
    return ''
  }

  const parts: string[] = []
  let retainedBytes = 0
  for (const entry of entries
    .filter(candidate => !candidate.name.startsWith('.') && candidate.isFile())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_CONTEXT_FILES)) {
    const separatorBytes = parts.length > 0 ? 2 : 0
    const header = `--- ${entry.name} ---\n`
    const headerBytes = Buffer.byteLength(header, 'utf8')
    const remaining = MAX_CONTEXT_SOURCE_BYTES
      - retainedBytes
      - separatorBytes
      - headerBytes
    if (remaining <= 0) break

    let handle
    try {
      handle = await fs.open(
        join(ctxDir, entry.name),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      )
      const stat = await handle.stat()
      if (!stat.isFile()) continue
      const buffer = Buffer.alloc(Math.min(remaining, Number(stat.size)))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const content = buffer.subarray(0, bytesRead).toString('utf8')
      parts.push(`${header}${content}`)
      retainedBytes += separatorBytes + headerBytes + Buffer.byteLength(content, 'utf8')
    } catch {
      // Ignore entries replaced by symlinks or removed during enumeration.
    } finally {
      await handle?.close().catch(() => {})
    }
  }
  return parts.join('\n\n')
}

function buildMcpToolContext(principal: McpPrincipal): McpToolContext {
  return {
    sendToRenderer,
    pushSSE,
    getExtensionRegistry: () => extensionRegistryProvider?.() ?? null,
    principal,
  }
}

export async function executeChatAgentTool(
  name: string,
  args: Record<string, unknown>,
  principal: McpPrincipal,
): Promise<string> {
  // Called from chat/providers/gateway.ts — a direct main-process call made on
  // behalf of an in-app chat turn, not an external MCP client. The principal
  // still scopes tile-targeted tools exactly like an HTTP caller's would.
  return handleTool(name, args, principal)
}

export async function executeImageEditTool(
  workspaceId: string,
  tileId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Called from ipc/image.ts — a direct main-process call triggered by the
  // renderer UI, not an external MCP client. Treat as fully trusted.
  let safeWorkspaceId: string
  let safeTileId: string
  try {
    safeWorkspaceId = assertSafePathSegment(workspaceId, 'workspaceId')
    safeTileId = assertSafePathSegment(tileId, 'tileId')
  } catch {
    return 'Invalid image workspace or block id'
  }
  return executeImageEditToolImpl(
    safeWorkspaceId,
    safeTileId,
    name,
    args,
    buildMcpToolContext({ kind: 'global' }),
  )
}

async function handleLocalTool(name: string, args: Record<string, unknown>, principal: McpPrincipal): Promise<string | null> {
  if (name === 'ask') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'ask',
      source: 'mcp',
      payload: { question: args.question, options: args.options ?? [] }
    })
    sendToRenderer('bus:event', evt)
    return `Question asked on ${args.channel}: "${args.question}"`
  }

  if (name === 'reload_objective') {
    const workspaceId = principal.kind === 'tile'
      ? principal.workspaceId
      : typeof args.workspace_id === 'string' ? args.workspace_id : ''
    let tileId: string
    try { tileId = assertSafePathSegment(args.tile_id as string, 'tile_id') }
    catch { return 'Invalid tile_id' }
    if (!workspaceId) return 'Missing workspace_id'
    const scopeError = assertTileScope(principal, workspaceId, tileId)
    if (scopeError) return scopeError
    try {
      const workspaces = await readWorkspaceRefsFromUserConfig()
      const workspace = workspaces.find(candidate => candidate.id === workspaceId)
      if (!workspace) return 'Workspace not found'
      const objPath = join(workspace.path, '.codesurf', tileId, 'objective.md')
      try {
        return await fs.readFile(objPath, 'utf8')
      } catch { /* no objective in this workspace */ }
    } catch { /**/ }
    return 'No objective.md found for this block'
  }

  if (name === 'pause_task') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'task',
      source: 'mcp',
      payload: { task_id: args.task_id, status: 'paused', action: 'update', reason: args.reason }
    })
    sendToRenderer('bus:event', evt)
    return `Task ${args.task_id} paused${args.reason ? `: ${args.reason}` : ''}`
  }

  if (name === 'get_context') {
    const workspaceId = principal.kind === 'tile'
      ? principal.workspaceId
      : typeof args.workspace_id === 'string' ? args.workspace_id : ''
    let tileId: string
    try { tileId = assertSafePathSegment(args.tile_id as string, 'tile_id') }
    catch { return 'Invalid tile_id' }
    if (!workspaceId) return 'Missing workspace_id'
    const scopeError = assertTileScope(principal, workspaceId, tileId)
    if (scopeError) return scopeError
    try {
      const workspaces = await readWorkspaceRefsFromUserConfig()
      const workspace = workspaces.find(candidate => candidate.id === workspaceId)
      if (!workspace) return 'Workspace not found'
      const ctxDir = join(workspace.path, '.codesurf', tileId, 'context')
      const context = await readContextFilesBounded(ctxDir, workspace.path)
      if (context) return context
    } catch { /**/ }
    return 'No context files found for this block'
  }

  return null
}

function boundMcpToolResult(result: string): string {
  if (
    Buffer.byteLength(result, 'utf8') <= MAX_MCP_RESULT_BYTES
    && estimateTokenCount(result) <= MAX_MCP_RESULT_ESTIMATED_TOKENS
  ) return result
  let previewBytes = Math.max(256, Math.floor(MAX_MCP_RESULT_BYTES / 2))
  while (previewBytes >= 256) {
    const preview = truncateUtf8(result, previewBytes, {
      maxEstimatedTokens: Math.max(
        64,
        Math.floor(MAX_MCP_RESULT_ESTIMATED_TOKENS * 0.7),
      ),
    })
    const bounded = JSON.stringify({
      truncated: true,
      originalBytes: Buffer.byteLength(result, 'utf8'),
      originalEstimatedTokens: estimateTokenCount(result),
      preview,
    })
    if (
      Buffer.byteLength(bounded, 'utf8') <= MAX_MCP_RESULT_BYTES
      && estimateTokenCount(bounded) <= MAX_MCP_RESULT_ESTIMATED_TOKENS
    ) return bounded
    previewBytes = Math.floor(previewBytes / 2)
  }
  return JSON.stringify({
    truncated: true,
    originalBytes: Buffer.byteLength(result, 'utf8'),
    originalEstimatedTokens: estimateTokenCount(result),
  })
}

async function handleTool(name: string, args: Record<string, unknown>, principal: McpPrincipal): Promise<string> {
  return boundMcpToolResult(await handleToolUnbounded(name, args, principal))
}

async function handleToolUnbounded(
  name: string,
  args: Record<string, unknown>,
  principal: McpPrincipal,
): Promise<string> {
  const ctx = buildMcpToolContext(principal)
  const dispatched = await dispatchTool(name, args, ctx)
  if (dispatched !== null) return dispatched

  const local = await handleLocalTool(name, args, principal)
  if (local !== null) return local

  const extensionTool = getExtensionTools().find(tool => tool.name === name)
  if (extensionTool) {
    if (!extensionTool.handler) {
      return `Extension tool ${name} is declared but has no handler`
    }
    return extensionTool.handler(args)
  }

  return 'Unknown tool'
}

async function handleMCP(req: MCPRequest, principal: McpPrincipal): Promise<unknown> {
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codesurf', version: '1.0.0' },
        instructions: [
          'You are connected to the CodeSurf agent-room collaboration server.',
          'Your block ID is in the CARD_ID environment variable.',
          'Canvas wires place you in a shared agent room with other blocks.',
          '',
          'IMMEDIATELY call room_status(tile_id=$CARD_ID) to see your room and members.',
          'Then call peer_set_state to announce idle/working status.',
          'Use room_post for handoffs/tasks; room_consume for unread room traffic.',
          'Chat agents auto-receive room traffic each turn; terminals should room_consume when needed.',
        ].join('\n'),
      }
    }
  }

  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id: req.id, result: { tools: getAllTools() } }
  }

  if (req.method === 'tools/call') {
    const name = req.params?.name ?? ''
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>
    const result = await handleTool(name, args, principal)
    return {
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: result }] }
    }
  }

  return {
    jsonrpc: '2.0', id: req.id,
    error: { code: -32601, message: 'Method not found' }
  }
}

let serverPort: number | null = null
let mcpHttpServer: Server | null = null

function setCorsHeaders(res: ServerResponse, req?: IncomingMessage): void {
  // Restrictive CORS: allow only known Electron origins. DNS-rebinding defense
  // is isLoopbackHost() below — every request that reaches a handler has a
  // loopback Host. CORS restricts which browser origins can read responses.
  // Non-browser clients (agents/MCP transport) don't send Origin and work fine.
  const origin = req?.headers.origin
  const isAllowedOrigin = !origin ||
    origin === 'null' ||                              // file:// in production
    origin.startsWith('http://localhost:') ||          // dev server
    origin === 'http://localhost' ||
    origin.startsWith('app://') ||                    // custom Electron schemes
    origin === 'app://codesurf'
  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    if (origin) res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Authorization')
}

// Reject requests whose Host header is not loopback. This defeats DNS-rebinding:
// a malicious site that resolves its hostname to 127.0.0.1 still sends its own
// hostname in the Host header, which we refuse. Legitimate local clients always
// address 127.0.0.1/localhost, so they are unaffected.
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase().trim()
  if (!host) return false
  const name = host.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

// Every non-OPTIONS request requires auth. This is a blanket fail-closed policy:
// adding a new route never accidentally becomes unauthenticated.
function isSensitiveMcpRoute(_method: string | undefined, _isEvents: boolean): boolean {
  return true
}

function readBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ')) return null
  return auth.slice('Bearer '.length)
}

function readQueryToken(url: URL): string | null {
  return url.searchParams.get('token') ?? url.searchParams.get('access_token')
}

/**
 * Authenticate a request and return the principal that authenticated it.
 * Returns null when auth fails — the 401 response has already been written.
 */
export function requireMcpAuth(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { allowQueryToken?: boolean, url?: URL },
): McpPrincipal | null {
  const bearer = readBearerToken(req)
  const queryToken = options?.allowQueryToken && options.url
    ? readQueryToken(options.url)
    : null
  const token = bearer ?? queryToken

  const principal = resolvePrincipal(token, MCP_TOKEN, tileTokens)
  if (principal) return principal

  setCorsHeaders(res, req)
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unauthorized' }))
  return null
}

export function stopMCPServer(): Promise<void> {
  return new Promise(resolve => {
    const server = mcpHttpServer
    if (!server) {
      sseClients.clear()
      resolve()
      return
    }
    mcpHttpServer = null
    serverPort = null

    // Long-lived SSE responses and keep-alive sockets otherwise keep the
    // Electron main process alive after app.quit has already emitted.
    for (const responses of sseClients.values()) {
      for (const response of responses) {
        try {
          response.end()
        } catch {
          response.destroy()
        }
      }
    }
    sseClients.clear()

    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

export async function startMCPServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      const pathname = url.pathname.replace(/\/+$/, '') || '/'
      const normalizedEventsPath = pathname.endsWith('/events') ? '/events' : pathname
      const isEvents = req.method === 'GET' && normalizedEventsPath === '/events'

      // Reject non-loopback Host headers (DNS-rebinding defense) before doing
      // any work. Applies to every method including OPTIONS preflight.
      if (!isLoopbackHost(req)) {
        setCorsHeaders(res, req)
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: non-loopback Host header' }))
        return
      }

      // CORS preflight
      if (req.method === 'OPTIONS') {
        setCorsHeaders(res, req)
        res.writeHead(200)
        res.end()
        return
      }

      // isSensitiveMcpRoute is a blanket fail-closed policy — it always
      // returns true today, so every route below goes through requireMcpAuth
      // and `principal` is always populated. The { kind: 'global' } fallback
      // only matters if a future route is ever marked non-sensitive.
      // `principal` is assigned once (const) below so its non-null type is
      // preserved inside the request-body closures further down.
      let resolvedPrincipal: McpPrincipal = { kind: 'global' }
      if (isSensitiveMcpRoute(req.method, isEvents)) {
        const authedPrincipal = requireMcpAuth(req, res, { allowQueryToken: isEvents, url })
        if (!authedPrincipal) return
        resolvedPrincipal = authedPrincipal
      }
      const principal = resolvedPrincipal

      // SSE: GET /events?card_id=xxx  — agent streams status to canvas
      if (isEvents) {
        const cardId = url.searchParams.get('card_id') ?? 'global'
        const requestedWorkspaceId = url.searchParams.get('workspace_id')
        const workspaceId = principal.kind === 'tile'
          ? principal.workspaceId
          : requestedWorkspaceId
        if (
          (workspaceId && !isSafeMcpScopeId(workspaceId, 'workspace_id'))
          || (cardId !== 'global' && !isSafeMcpScopeId(cardId, 'card_id'))
        ) {
          setCorsHeaders(res, req)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid event stream scope' }))
          return
        }
        // A tile-scoped token may only subscribe to its own card's stream;
        // 'global'/absent card subscriptions require the global token.
        const scopeError = assertTileScope(
          principal,
          requestedWorkspaceId ?? workspaceId,
          cardId,
        )
        if (scopeError) {
          setCorsHeaders(res, req)
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: scopeError }))
          return
        }
        if (cardId !== 'global' && !workspaceId) {
          setCorsHeaders(res, req)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing workspace_id' }))
          return
        }
        const clientScopeKey = cardId === 'global'
          ? workspaceId
            ? workspaceSseScopeKey(workspaceId)
            : GLOBAL_SSE_SCOPE
          : cardSseScopeKey(workspaceId!, cardId)
        if (totalSseClients() >= MAX_SSE_CLIENTS) {
          setCorsHeaders(res, req)
          res.writeHead(429, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Too many event stream clients' }))
          return
        }
        setCorsHeaders(res, req)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
        res.write(':connected\n\n')

        if (!sseClients.has(clientScopeKey)) sseClients.set(clientScopeKey, new Set())
        sseClients.get(clientScopeKey)!.add(res)

        // Keepalive ping every 15s
        const ping = setInterval(() => {
          try {
            if (!res.write(':ping\n\n')) {
              clearInterval(ping)
              res.end()
            }
          } catch {
            clearInterval(ping)
          }
        }, 15000)

        req.on('close', () => {
          clearInterval(ping)
          const set = sseClients.get(clientScopeKey)
          if (set) {
            set.delete(res)
            if (set.size === 0) sseClients.delete(clientScopeKey)
          }
        })
        return
      }

      // SSE push: POST /push — agent sends an event to the canvas
      if (req.method === 'POST' && url.pathname === '/push') {
        let body = ''
        let bodySize = 0
        req.on('data', (chunk: Buffer | string) => {
          bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
          if (bodySize > MAX_BODY) {
            setCorsHeaders(res, req)
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request body too large' }))
            req.destroy()
            return
          }
          body += chunk
        })
        req.on('end', () => {
          try {
            const { workspace_id, card_id, event, data } = JSON.parse(body)
            if (!isValidSseEventName(event)) {
              setCorsHeaders(res, req)
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid event name' }))
              return
            }
            if (
              (workspace_id !== undefined
                && !isSafeMcpScopeId(workspace_id, 'workspace_id'))
              || (card_id !== 'global'
                && !isSafeMcpScopeId(card_id, 'card_id'))
            ) {
              setCorsHeaders(res, req)
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid push scope' }))
              return
            }
            const workspaceId = principal.kind === 'tile'
              ? principal.workspaceId
              : workspace_id
            const scopeError = assertTileScope(
              principal,
              workspace_id ?? workspaceId,
              card_id,
            )
            if (scopeError) {
              setCorsHeaders(res, req)
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: scopeError }))
              return
            }
            if (card_id !== 'global' && !workspaceId) {
              setCorsHeaders(res, req)
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing workspace_id' }))
              return
            }
            const eventData = data && typeof data === 'object' && !Array.isArray(data)
              ? data as Record<string, unknown>
              : {}
            pushSSE(String(workspaceId ?? ''), String(card_id ?? ''), event, {
              ...eventData,
              workspaceId: workspaceId ?? null,
              cardId: card_id,
            })
            sendToRenderer(event, {
              ...eventData,
              workspaceId: workspaceId ?? null,
              cardId: card_id,
            })
            setCorsHeaders(res, req)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          } catch {
            setCorsHeaders(res, req)
            res.writeHead(400); res.end()
          }
        })
        return
      }

      // Canvas → Agent: POST /inject — write a message into agent's terminal
      if (req.method === 'POST' && url.pathname === '/inject') {
        let body = ''
        let bodySize = 0
        req.on('data', (chunk: Buffer | string) => {
          bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
          if (bodySize > MAX_BODY) {
            setCorsHeaders(res, req)
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request body too large' }))
            req.destroy()
            return
          }
          body += chunk
        })
        req.on('end', async () => {
          try {
            const {
              workspace_id,
              card_id,
              message,
              append_newline = true,
            } = JSON.parse(body)
            if (
              (workspace_id !== undefined
                && !isSafeMcpScopeId(workspace_id, 'workspace_id'))
              || !isSafeMcpScopeId(card_id, 'card_id')
            ) {
              setCorsHeaders(res, req)
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid inject scope' }))
              return
            }
            const workspaceId = principal.kind === 'tile'
              ? principal.workspaceId
              : workspace_id
            const scopeError = assertTileScope(
              principal,
              workspace_id ?? workspaceId,
              card_id,
            )
            if (scopeError) {
              setCorsHeaders(res, req)
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: scopeError }))
              return
            }
            if (!workspaceId) {
              setCorsHeaders(res, req)
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Missing workspace_id' }))
              return
            }
            // /inject writes into a live terminal — the same capability class
            // as terminal_send_input, so gate it behind the same permission
            // prompt instead of leaving it as an ungated bypass route.
            const workspaceDir = await resolveTileWorkspaceDir(
              String(card_id ?? ''),
              typeof workspaceId === 'string' ? workspaceId : undefined,
            )
            let permissionWorkspace: string
            try {
              permissionWorkspace = requireMcpPermissionWorkspace(workspaceDir, '/inject')
            } catch (error) {
              setCorsHeaders(res, req)
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: (error as Error).message }))
              return
            }
            const allowed = await requestToolPermission({
              provider: 'mcp',
              toolName: 'terminal_send_input',
              workspaceDir: permissionWorkspace,
              title: 'Terminal input via /inject',
              description: `An MCP agent wants to write into terminal tile "${card_id}" via /inject:\n${String(message ?? '').slice(0, 200)}${String(message ?? '').length > 200 ? '...' : ''}`,
            }, /* interactive */ true)
            if (!allowed) {
              setCorsHeaders(res, req)
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Permission denied: /inject was not approved' }))
              return
            }
            // Tell renderer to write to the terminal
            broadcastToRenderer('mcp:inject', {
              workspaceId,
              cardId: card_id,
              message,
              appendNewline: append_newline,
            })
            // Also push SSE so other agents/subscribers know
            pushSSE(workspaceId, card_id, 'canvas_message', {
              workspaceId,
              cardId: card_id,
              message,
            })
            setCorsHeaders(res, req)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          } catch {
            setCorsHeaders(res, req)
            res.writeHead(400); res.end()
          }
        })
        return
      }

      // MCP: POST /  or POST /mcp
      if (req.method !== 'POST') {
        setCorsHeaders(res, req)
        res.writeHead(405); res.end(); return
      }

      let body = ''
      let bodySize = 0
      req.on('data', (chunk: Buffer | string) => {
        bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        if (bodySize > MAX_BODY) {
          setCorsHeaders(res, req)
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Request body too large' }))
          req.destroy()
          return
        }
        body += chunk
      })
      req.on('end', async () => {
        try {
          const mcpReq: MCPRequest = JSON.parse(body)
          const response = await handleMCP(mcpReq, principal)
          setCorsHeaders(res, req)
          res.writeHead(200, {
            'Content-Type': 'application/json'
          })
          res.end(JSON.stringify(response))
        } catch (e) {
          mcpLog.debug('MCP request failed', e)
          setCorsHeaders(res, req)
          res.writeHead(400); res.end()
        }
      })
    })

    mcpHttpServer = server
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address() as { port: number }
      serverPort = addr.port

      const baseUrl = `http://127.0.0.1:${serverPort}`
      const contexUrl = `${baseUrl}/mcp`
      const configPath = join(getContexDir(), 'mcp-server.json')

      const COLLAB_DIR = getContexDir()
      await fs.mkdir(COLLAB_DIR, { recursive: true })

      let existingConfig: Record<string, unknown> = {}
      try {
        const existingRaw = await fs.readFile(configPath, 'utf8')
        const parsed = JSON.parse(existingRaw)
        if (parsed && typeof parsed === 'object') existingConfig = parsed as Record<string, unknown>
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[mcp] Failed to read existing config for merge:', err)
        }
      }

      const existingServers = typeof existingConfig.mcpServers === 'object' && existingConfig.mcpServers !== null
        ? existingConfig.mcpServers as Record<string, unknown>
        : {}
      const normalizedServers = normalizeMcpServers(existingServers, contexUrl)
      // The global principal is trusted UI state, not an agent credential.
      // Persist discovery metadata only; scoped agent configs are written
      // separately by writeTileMcpConfig.
      normalizedServers['codesurf'] = { type: 'http', url: contexUrl }
      if (
        normalizedServers.contex
        && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp\/?$/.test(
          String(normalizedServers.contex.url ?? ''),
        )
      ) {
        delete normalizedServers.contex
      }
      const persistedConfig = { ...existingConfig }
      delete persistedConfig.token

      const mcpConfig = {
        ...persistedConfig,
        port: serverPort,
        url: baseUrl,
        updatedAt: new Date().toISOString(),
        mcpServers: normalizedServers,
        tools: getAllTools().map(t => ({ name: t.name, description: t.description })),
        endpoints: {
          mcp: baseUrl,
          events: `${baseUrl}/events`,
          push: `${baseUrl}/push`,
          inject: `${baseUrl}/inject`
        }
      }
      // Keep user-supplied server settings private even though CodeSurf's
      // global bearer is deliberately never persisted here.
      await fs.writeFile(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })
      await fs.chmod(configPath, 0o600).catch(() => {})

      // Scrub legacy workspace-global CodeSurf credentials. Terminal/chat
      // agents receive workspace/tile configs directly.
      try {
        const workspaceRefs = await readWorkspaceRefsFromUserConfig()
        for (const ws of workspaceRefs) {
          writeMCPConfigToWorkspace(ws.path).catch(() => {})
        }
      } catch { /* no workspaces yet */ }

      mcpLog.info(`Kanban server running on port ${serverPort}`)
      resolve(serverPort)
    })

    server.on('error', reject)
  })
}

export function getMCPPort(): number | null {
  return serverPort
}

/**
 * Remove a legacy workspace-global CodeSurf server entry while preserving
 * user-owned MCP servers and collaboration instructions. Agent processes get
 * only workspace/tile-scoped credentials through writeTileMcpConfig.
 */
export async function writeMCPConfigToWorkspace(workspacePath: string): Promise<void> {
  const mcpJsonPath = join(workspacePath, '.mcp.json')
  let existing: Record<string, unknown> | null = null
  try {
    const raw = await fs.readFile(mcpJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[mcp] Failed to inspect existing .mcp.json:', err)
  }

  if (existing) {
    const existingServers = typeof existing.mcpServers === 'object' && existing.mcpServers !== null
      ? { ...existing.mcpServers as Record<string, unknown> }
      : {}
    let changed = false
    for (const name of ['codesurf', 'contex']) {
      const managed = existingServers[name]
      const managedUrl = managed && typeof managed === 'object'
        ? String((managed as Record<string, unknown>).url ?? '')
        : ''
      if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp\/?$/.test(managedUrl)) continue
      delete existingServers[name]
      changed = true
    }
    if (changed) {
      await fs.writeFile(mcpJsonPath, JSON.stringify({
        ...existing,
        mcpServers: existingServers,
      }, null, 2), { mode: 0o600 })
      await fs.chmod(mcpJsonPath, 0o600).catch(() => {})
      mcpLog.info(`Removed legacy global CodeSurf credential from ${mcpJsonPath}`)
    }
  }

  // Write .claude/CLAUDE.md with peer collaboration instructions
  // Claude Code reads this automatically on every session
  await writeContexClaudeMd(workspacePath)
}

/**
 * Drop the CodeSurf peer-collaboration instructions into a workspace so Claude
 * Code sessions pick them up automatically.
 *
 * Data-safety: NEVER overwrite a hand-written CLAUDE.md. Three cases:
 *  1. File absent                → write the managed file.
 *  2. File present, has marker   → already ours, no-op.
 *  3. File present, no marker    → user-owned. Write a sidecar
 *                                 `.claude/codesurf.md` instead and append a
 *                                 single one-line `@codesurf.md` import to their
 *                                 CLAUDE.md (Claude Code's native include syntax).
 *                                 The import line is idempotent and reversible.
 */
async function writeContexClaudeMd(workspacePath: string): Promise<void> {
  const claudeDir = join(workspacePath, '.claude')
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')
  const sidecarPath = join(claudeDir, 'codesurf.md')
  const IMPORT_LINE = '@codesurf.md'

  let existing = ''
  let exists = false
  try {
    existing = await fs.readFile(claudeMdPath, 'utf8')
    exists = true
  } catch { /* doesn't exist yet */ }

  // Case 2: already managed by us.
  if (exists && existing.includes('<!-- codesurf-managed -->')) return

  await fs.mkdir(claudeDir, { recursive: true })

  // Case 3: user-owned file — don't touch it beyond a single reversible import line.
  if (exists) {
    if (existing.split(/\r?\n/).includes(IMPORT_LINE)) {
      // Import already wired; make sure the sidecar body is current.
      await fs.writeFile(sidecarPath, buildContexClaudeMdContent(), 'utf8')
      return
    }
    const next = `${existing.replace(/\s*$/, '')}\n\n${IMPORT_LINE}\n`
    await fs.writeFile(claudeMdPath, next, 'utf8')
    await fs.writeFile(sidecarPath, buildContexClaudeMdContent(), 'utf8')
    mcpLog.info(`Added @codesurf.md import to existing ${claudeMdPath}`)
    return
  }

  // Case 1: no file — write the full managed document.
  await fs.writeFile(claudeMdPath, buildContexClaudeMdContent(), 'utf8')
  mcpLog.info(`Wrote .claude/CLAUDE.md to ${workspacePath}`)
}

function buildContexClaudeMdContent(): string {
  return `<!-- codesurf-managed -->
# CodeSurf Canvas Agent

You are running inside CodeSurf, an infinite canvas workspace where multiple AI agents share agent rooms.
Your block ID is the environment variable \`CARD_ID\`. Wires on the canvas put you in a room with other blocks.

## MANDATORY: First Action on Every Session

\`\`\`
1. mcp__codesurf__room_status(tile_id=$CARD_ID)
2. mcp__codesurf__peer_set_state(tile_id=$CARD_ID, tile_type="terminal", status="idle", task="Ready")
3. mcp__codesurf__room_consume(tile_id=$CARD_ID)   # if unconsumed > 0
\`\`\`

Also read \`~/.codesurf/workspaces/$CODESURF_WORKSPACE_ID/agent-rooms/inboxes/$CARD_ID/ROOM.md\` for a live inbox dump.

## Agent Room Protocol

**When you receive a task:**
1. \`peer_set_state\` status=working with a short task description
2. \`room_status\` / \`peer_get_state\` to see room members
3. \`room_post\` kind=task|handoff when another block should act
4. Prefer room traffic over guessing what peers are doing

**During work:**
- \`room_consume\` when you need pending peer traffic
- \`room_post\` for findings, blockers, questions
- \`peer_set_state\` when files/tasks change

**On completion:**
- \`peer_set_state\` status=done
- \`room_post\` kind=summary with what you finished

**File conflict rule:**
NEVER edit a file another room member lists in their files without \`room_post\` / \`peer_send_message\` coordination first.

## Tool prefix

All tools: \`mcp__codesurf__*\`
- room_status / room_post / room_consume
- peer_set_state / peer_get_state / peer_send_message
- canvas_* / terminal_send_input / chat_send_message
`
}
