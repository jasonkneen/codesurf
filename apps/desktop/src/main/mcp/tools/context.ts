import { promises as fs } from 'fs'
import { join } from 'path'
import { bus } from '../../event-bus'
import { CODESURF_HOME } from '../../paths'
import {
  loadWorkspaceTileState,
  SKIP_WORKSPACE_TILE_STATE_WRITE,
  updateWorkspaceTileState,
} from '../../storage/workspaceArtifacts'
import * as peerState from '../../peer-state'
import * as agentRoom from '../../agent-room/index.ts'
import { broadcastToRenderer } from '../../utils/broadcast'
import { asString, type McpToolContext, type McpToolSchema } from '../types'
import { errorMessage } from '../../../shared/errors.ts'
import { assertTileScope } from '../auth'
import { authorizePeerTileTarget } from '../peer-bridge-authority.ts'
import { canvasStatePath, ensureWorkspaceStorageMigrated } from '../../storage/workspaceArtifacts'
import type { TileState } from '../../../shared/types'
import { projectEvent } from '../../agent-room/projection.ts'
import {
  MAX_MCP_RESULT_BYTES,
  MAX_MCP_RESULT_ESTIMATED_TOKENS,
  estimateTokenCount,
  truncateUtf8,
} from '../../agent-room/validation.ts'
import { tileContextChannel } from '../../../shared/tileContextScope.ts'

type UserConfigWorkspaceRef = {
  id: string
  path: string
}

const getContexDir = (): string => CODESURF_HOME

/**
 * Canvas state for peer-authority checks. Mirrors peer-bridge.ts's reader.
 */
async function readCanvasStateForAuthority(
  workspaceId: string,
): Promise<{ tiles?: TileState[]; lockedConnections?: unknown[] } | null> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  for (const storageId of storageIds) {
    try {
      const raw = await fs.readFile(canvasStatePath(storageId), 'utf8')
      const parsed = JSON.parse(raw) as { tiles?: TileState[]; lockedConnections?: unknown[] }
      if (Array.isArray(parsed.tiles)) return parsed
    } catch {
      // try next alias
    }
  }
  return null
}

export const MAX_TILE_CONTEXT_KEY_BYTES = 256
export const MAX_TILE_CONTEXT_VALUE_BYTES = 8 * 1024
export const MAX_TILE_CONTEXT_TOTAL_BYTES = 64 * 1024

type TileContextEntry = {
  key: string
  value: unknown
  updatedAt: number
  source: string
}

export function validateTileContextWrite(
  context: Record<string, TileContextEntry>,
  key: string,
  value: unknown,
  source: string,
  now = Date.now(),
): { ok: true, next: Record<string, TileContextEntry> } | { ok: false, error: string } {
  if (Buffer.byteLength(key, 'utf8') > MAX_TILE_CONTEXT_KEY_BYTES) {
    return { ok: false, error: 'Context key is too large' }
  }
  let serializedValue: string | undefined
  try {
    serializedValue = JSON.stringify(value)
  } catch {
    return { ok: false, error: 'Context value must be JSON-serializable' }
  }
  if (serializedValue === undefined) {
    return { ok: false, error: 'Context value must be JSON-serializable' }
  }
  if (Buffer.byteLength(serializedValue, 'utf8') > MAX_TILE_CONTEXT_VALUE_BYTES) {
    return { ok: false, error: 'Context value is too large' }
  }
  const next = {
    ...context,
    [key]: { key, value, updatedAt: now, source },
  }
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_TILE_CONTEXT_TOTAL_BYTES) {
    return { ok: false, error: 'Block context has reached its size limit' }
  }
  return { ok: true, next }
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

function assertMcpSafeId(id: string): string | null {
  return /[/\\]|\.\./.test(id) ? 'Unsafe ID' : null
}

function resolveWorkspaceScope(
  ctx: McpToolContext,
  args: Record<string, unknown>,
): { workspaceId: string } | { error: string } {
  const requestedWorkspaceId = asString(args.workspace_id)
  if (ctx.principal.kind === 'tile') {
    if (
      requestedWorkspaceId
      && requestedWorkspaceId !== ctx.principal.workspaceId
    ) return { error: 'Forbidden: token scope does not match the requested workspace' }
    return { workspaceId: ctx.principal.workspaceId }
  }
  if (!requestedWorkspaceId) return { error: 'Missing workspace_id' }
  return { workspaceId: requestedWorkspaceId }
}

function resolveSelfScope(
  ctx: McpToolContext,
  args: Record<string, unknown>,
  requestedTileId: string | undefined,
): { workspaceId: string, tileId: string } | { error: string } {
  const workspaceScope = resolveWorkspaceScope(ctx, args)
  if ('error' in workspaceScope) return workspaceScope
  const tileId = ctx.principal.kind === 'tile'
    ? ctx.principal.tileId
    : requestedTileId
  if (!tileId) return { error: 'Missing tile_id' }
  const scopeError = assertTileScope(ctx.principal, workspaceScope.workspaceId, tileId)
  if (scopeError) return { error: scopeError }
  return { workspaceId: workspaceScope.workspaceId, tileId }
}

function boundMcpResult(result: string): string {
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

function roomScopeProperty(): Record<string, unknown> {
  return {
    workspace_id: {
      type: 'string',
      description: 'Workspace ID (required for global-token callers; tile tokens are already scoped)',
    },
  }
}

export const CONTEXT_TOOLS: McpToolSchema[] = [
  {
    name: 'room_status',
    description: 'Show your agent room: room id, members, their status, and how many unread room events you have. Canvas wires place you in a room automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        tile_id: { type: 'string', description: 'Your block ID (use $CARD_ID)' },
      },
      required: ['tile_id'],
    },
  },
  {
    name: 'room_post',
    description: 'Post into the shared agent room (message, task, handoff, summary, question, …). Room peers receive it on their next turn (and via realtime bus). Prefer this over freeform guessing about peers.',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        tile_id: { type: 'string', description: 'Your block ID' },
        text: { type: 'string', description: 'Message body' },
        kind: {
          type: 'string',
          enum: ['message', 'task', 'handoff', 'summary', 'status', 'finding', 'blocker', 'question', 'decision'],
          description: 'Event kind (default message)',
        },
        to_tile_id: { type: 'string', description: 'Optional: target a single room member; omit for whole room' },
      },
      required: ['tile_id', 'text'],
    },
  },
  {
    name: 'room_consume',
    description: 'Drain unread room events for you and mark them consumed. Usually auto-injected each chat turn; call from terminals when you need pending traffic now.',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        tile_id: { type: 'string', description: 'Your block ID' },
      },
      required: ['tile_id'],
    },
  },
  {
    name: 'peer_set_state',
    description: 'Announce your work state to the agent room (status, task, files). Room peers see this via room_status / peer_get_state and realtime updates.',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        tile_id: { type: 'string', description: 'Your block ID (use $CARD_ID)' },
        tile_type: { type: 'string', description: 'Your block type (terminal, chat, etc.)' },
        status: { type: 'string', enum: ['idle', 'working', 'blocked', 'waiting', 'done'], description: 'Current status' },
        task: { type: 'string', description: 'What you are currently working on' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files you are actively editing' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_get_state',
    description: 'Snapshot of other members in your agent room (status, task, files). Prefer room traffic injection + room_status for coordination.',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        tile_id: { type: 'string', description: 'Your block ID — returns states of your room peers' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_send_message',
    description: 'Send a direct message to a room peer (posts into the room ledger targeted at them).',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        from_tile_id: { type: 'string', description: 'Your block ID' },
        to_tile_id: { type: 'string', description: 'Recipient peer block ID' },
        message: { type: 'string', description: 'Message text' },
      },
      required: ['from_tile_id', 'to_tile_id', 'message']
    }
  },
  {
    name: 'peer_read_messages',
    description: 'Consume unread room messages for you (same as room_consume).',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        tile_id: { type: 'string', description: 'Your block ID' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_add_todo',
    description: 'Add a todo and announce it to the room.',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        tile_id: { type: 'string', description: 'Your block ID' },
        text: { type: 'string', description: 'Todo item text' },
      },
      required: ['tile_id', 'text']
    }
  },
  {
    name: 'peer_complete_todo',
    description: 'Mark one of your todos as done and announce it to the room.',
    inputSchema: {
      type: 'object',
      properties: {
        ...roomScopeProperty(),
        tile_id: { type: 'string', description: 'Your block ID' },
        todo_id: { type: 'string', description: 'The todo ID to complete' },
      },
      required: ['tile_id', 'todo_id']
    }
  },
  {
    name: 'tile_context_get',
    description: 'Read context entries from a block in the authenticated workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID to read context from' },
        workspace_id: { type: 'string', description: 'Workspace ID (required for global-token callers)' },
        tag: { type: 'string', description: 'Filter by tag prefix (e.g., "ctx:design"; optional)' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'tile_context_set',
    description: 'Write a context entry to a block in the authenticated workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID to write context to' },
        workspace_id: { type: 'string', description: 'Workspace ID (required for global-token callers)' },
        key: { type: 'string', description: 'Context key (e.g., "ctx:design:palette")' },
        value: { description: 'Context value (any JSON-serializable value)' },
      },
      required: ['tile_id', 'key', 'value']
    }
  },
  {
    name: 'ext_invoke_action',
    description: 'Invoke a registered action on an extension block. Extensions declare actions that connected blocks can call (e.g. generate, setHtml). Use tile_context_get to read extension state afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Target extension block ID' },
        workspace_id: { type: 'string', description: 'Workspace ID (required for global-token callers)' },
        action: { type: 'string', description: 'Action name to invoke (e.g. "generate", "setHtml")' },
        params: { type: 'object', description: 'Parameters for the action' },
      },
      required: ['tile_id', 'action']
    }
  },
]

const CONTEXT_TOOL_NAMES = new Set(CONTEXT_TOOLS.map(tool => tool.name))

export async function handleContextTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  const result = await handleContextToolUnbounded(name, args, ctx)
  return result === null ? null : boundMcpResult(result)
}

async function handleContextToolUnbounded(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  if (!CONTEXT_TOOL_NAMES.has(name)) return null

  if (name === 'room_status') {
    const scope = resolveSelfScope(ctx, args, asString(args.tile_id))
    if ('error' in scope) return scope.error
    const d = agentRoom.digest(scope.workspaceId, scope.tileId)
    if (!d.roomId) {
      return JSON.stringify({
        inRoom: false,
        message: 'Not in an agent room. Wire this block to another chat/terminal on the canvas first.',
      }, null, 2)
    }
    return JSON.stringify({
      inRoom: true,
      roomId: d.roomId,
      unconsumed: d.unconsumed,
      members: d.members,
      standing: d.standingText,
    }, null, 2)
  }

  if (name === 'room_post') {
    const text = asString(args.text)
    if (!text) return 'Missing tile_id or text'
    const scope = resolveSelfScope(ctx, args, asString(args.tile_id))
    if ('error' in scope) return scope.error
    const kindRaw = asString(args.kind) ?? 'message'
    const allowedKinds = new Set([
      'message', 'task', 'handoff', 'summary', 'status', 'finding', 'blocker', 'question', 'decision',
    ])
    const kind = (allowedKinds.has(kindRaw) ? kindRaw : 'message') as agentRoom.RoomEventKind
    const to = asString(args.to_tile_id)
    const event = agentRoom.post(scope.workspaceId, {
      fromTileId: scope.tileId,
      text,
      kind,
      targetTileIds: to ? [to] : undefined,
    })
    if (!event) {
      return 'Not in an agent room (or empty text). Wire this block to peers on the canvas first.'
    }
    return JSON.stringify({ ok: true, event: projectEvent(event) })
  }

  if (name === 'room_consume') {
    const scope = resolveSelfScope(ctx, args, asString(args.tile_id))
    if ('error' in scope) return scope.error
    const result = agentRoom.consume(scope.workspaceId, scope.tileId)
    if (!result.roomId) return 'Not in an agent room.'
    if (result.text) return result.text
    if (result.events.length === 0) return 'No unread room events.'
    return JSON.stringify(result.events, null, 2)
  }

  if (name === 'peer_set_state') {
    const scope = resolveSelfScope(ctx, args, asString(args.tile_id))
    if ('error' in scope) return scope.error
    const state = peerState.setState(scope.workspaceId, scope.tileId, {
      tileType: asString(args.tile_type) ?? undefined,
      status: (() => {
        const s = asString(args.status)
        if (s === 'idle' || s === 'working' || s === 'blocked' || s === 'waiting' || s === 'done') return s
        return undefined
      })(),
      task: asString(args.task) ?? undefined,
      files: Array.isArray(args.files) ? args.files.filter(f => typeof f === 'string') as string[] : undefined,
    })
    return JSON.stringify(state)
  }

  if (name === 'peer_get_state') {
    const scope = resolveSelfScope(ctx, args, asString(args.tile_id))
    if ('error' in scope) return scope.error
    const room = agentRoom.getRoomForTile(scope.workspaceId, scope.tileId)
    const peerStates = peerState.getLinkedPeerStates(scope.workspaceId, scope.tileId)
    if (!room) {
      return JSON.stringify({
        inRoom: false,
        peers: [],
        message: 'Not in an agent room. Wire this block to another on the canvas.',
      }, null, 2)
    }
    return JSON.stringify({
      inRoom: true,
      roomId: room.id,
      peers: peerStates.states,
      ...(peerStates.truncation ? { truncation: peerStates.truncation } : {}),
      members: room.members,
    })
  }

  if (name === 'peer_send_message') {
    // to_tile_id is intentionally cross-tile (the whole point is messaging a
    // peer). from_tile_id is a sender-identity claim: a tile-scoped
    // principal can't lie about who sent it, so stamp it from the token
    // rather than trusting the caller-supplied value.
    const to = asString(args.to_tile_id)
    const message = asString(args.message)
    if (!to || !message) return 'Missing from_tile_id, to_tile_id, or message'
    const scope = resolveSelfScope(ctx, args, asString(args.from_tile_id))
    if ('error' in scope) return scope.error
    const msg = peerState.sendMessage(scope.workspaceId, scope.tileId, to, message)
    if (!msg) return 'Recipient is not an active member of the sender room.'
    return JSON.stringify({ ok: true, message: msg })
  }

  if (name === 'peer_read_messages') {
    const scope = resolveSelfScope(ctx, args, asString(args.tile_id))
    if ('error' in scope) return scope.error
    const result = peerState.readMessages(scope.workspaceId, scope.tileId)
    if (result.messages.length === 0) return 'No messages.'
    return JSON.stringify(result)
  }

  if (name === 'peer_add_todo') {
    const text = asString(args.text)
    if (!text) return 'Missing tile_id or text'
    const scope = resolveSelfScope(ctx, args, asString(args.tile_id))
    if ('error' in scope) return scope.error
    try {
      const todo = peerState.addTodo(scope.workspaceId, scope.tileId, text)
      return JSON.stringify({ ok: true, todo })
    } catch (err) {
      return errorMessage(err)
    }
  }

  if (name === 'peer_complete_todo') {
    const todoId = asString(args.todo_id)
    if (!todoId) return 'Missing tile_id or todo_id'
    const scope = resolveSelfScope(ctx, args, asString(args.tile_id))
    if ('error' in scope) return scope.error
    const ok = peerState.completeTodo(scope.workspaceId, scope.tileId, todoId)
    return JSON.stringify({ ok })
  }

  if (name === 'tile_context_get') {
    const tileId = asString(args.tile_id)
    const tagPrefix = asString(args.tag)
    if (!tileId) return 'Missing tile_id'
    const workspaceScope = resolveWorkspaceScope(ctx, args)
    if ('error' in workspaceScope) return workspaceScope.error
    const workspaceId = workspaceScope.workspaceId
    const tileIdErr = assertMcpSafeId(tileId)
    if (tileIdErr) return tileIdErr
    const wsErr = assertMcpSafeId(workspaceId)
    if (wsErr) return wsErr

    // Same authority as ext_invoke_action: tile context is read back by the
    // target tile as trusted state (ctx:image:path steers the image tools), so
    // writing it into a tile the caller has no wire to is a cross-tile dispatch.
    const setAuthority = authorizePeerTileTarget({
      principal: ctx.principal,
      workspaceId,
      targetTileId: tileId,
      canvas: await readCanvasStateForAuthority(workspaceId),
      // A tile writing its own context is the normal, intended case.
      allowSelf: true,
    })
    if (!setAuthority.ok) return setAuthority.error

    try {
      const workspaceRefs = await readWorkspaceRefsFromUserConfig()
      const workspace = workspaceRefs.find(ws => ws.id === workspaceId)

      if (!workspace) return 'Workspace not found'

      try {
        const state = await loadWorkspaceTileState<{ _context?: Record<string, any> }>(workspace.id, tileId, {})
        const ctx = state._context ?? {}
        const entries = Object.values(ctx)

        if (tagPrefix) {
          return JSON.stringify(entries.filter((e: { key?: string }) => e.key?.startsWith(tagPrefix)), null, 2)
        }
        return JSON.stringify(entries, null, 2)
      } catch {
        return '[]'
      }
    } catch (err) {
      return `Error reading context: ${errorMessage(err)}`
    }
  }

  if (name === 'ext_invoke_action') {
    const tileId = asString(args.tile_id)
    const action = asString(args.action)
    if (!tileId || !action) return 'Missing tile_id or action'
    const workspaceScope = resolveWorkspaceScope(ctx, args)
    if ('error' in workspaceScope) return workspaceScope.error
    if (!peerState.getState(workspaceScope.workspaceId, tileId)) {
      return 'Target block is not registered in this workspace.'
    }
    // An existence check is not authority. ExtensionTile turns this broadcast
    // into a codesurf-action-invoke postMessage inside the extension iframe and
    // acts on it unconditionally, so require the same peer authority every other
    // cross-tile dispatch does: same workspace, not the caller's own tile, and a
    // currently connected peer.
    const extAuthority = authorizePeerTileTarget({
      principal: ctx.principal,
      workspaceId: workspaceScope.workspaceId,
      targetTileId: tileId,
      canvas: await readCanvasStateForAuthority(workspaceScope.workspaceId),
      allowSelf: true,
    })
    if (!extAuthority.ok) return extAuthority.error
    const params = typeof args.params === 'object' && args.params ? args.params as Record<string, unknown> : {}
    broadcastToRenderer('tileContext:changed', {
      workspaceId: workspaceScope.workspaceId,
      tileId,
      key: '_action',
      value: { action, params, ts: Date.now() },
    })
    return JSON.stringify({ ok: true })
  }

  if (name === 'tile_context_set') {
    const tileId = asString(args.tile_id)
    const key = asString(args.key)
    const value = args.value
    if (!tileId || !key) return 'Missing tile_id or key'
    const workspaceScope = resolveWorkspaceScope(ctx, args)
    if ('error' in workspaceScope) return workspaceScope.error
    const workspaceId = workspaceScope.workspaceId
    const tileIdErrS = assertMcpSafeId(tileId)
    if (tileIdErrS) return tileIdErrS
    const wsErr = assertMcpSafeId(workspaceId)
    if (wsErr) return wsErr

    try {
      const workspaceRefs = await readWorkspaceRefsFromUserConfig()
      const workspace = workspaceRefs.find(ws => ws.id === workspaceId)

      if (!workspace) return 'Workspace not found'

      let validationError: string | null = null
      await updateWorkspaceTileState(workspace.id, tileId, existing => {
        const state = existing && typeof existing === 'object' && !Array.isArray(existing)
          ? existing as {
              _context?: Record<string, TileContextEntry>
              [stateKey: string]: unknown
            }
          : {}
        const validated = validateTileContextWrite(
          state._context ?? {},
          key,
          value,
          tileId,
        )
        if (!validated.ok) {
          validationError = validated.error
          return SKIP_WORKSPACE_TILE_STATE_WRITE
        }
        return { ...state, _context: validated.next }
      })
      if (validationError) return validationError

      bus.publish({
        channel: tileContextChannel(workspaceId, tileId),
        type: 'data',
        source: 'mcp:context',
        payload: { action: 'context_changed', key, value, workspaceId, tileId },
      })

      return JSON.stringify({ ok: true })
    } catch (err) {
      return `Error writing context: ${errorMessage(err)}`
    }
  }

  return null
}
