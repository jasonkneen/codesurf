import { promises as fs } from 'fs'
import { join } from 'path'
import { CODESURF_HOME } from '../../paths'
import { canvasStatePath, ensureWorkspaceStorageMigrated } from '../../storage/workspaceArtifacts'
import { getNodeToolSchemaByName, getPeerBridgeNodeTools } from '../../../shared/nodeTools'
import type { TileState } from '../../../shared/types'
import { asString, type McpToolContext } from '../types'
import { requestToolPermission } from '../../permissions'
import { assertSafePathSegment } from '../../security/pathSegments'
import { isValidAgentRoomId } from '../../agent-room/validation'
import { resolvePeerWorkspaceScope } from '../peer-scope'
import { authorizePeerBridgeTarget } from '../peer-bridge-authority.ts'
import {
  appendAuthorizedNoteFile,
  authorizeWorkspaceNoteFile,
  readAuthorizedNoteFile,
  writeAuthorizedNoteFile,
  type NoteFileIntent,
} from '../note-file-boundary.ts'
import {
  type ValidatedFsPath,
} from '../../ipc/fs.ts'

// SECURITY: terminal_send_input writes arbitrary text (+ Enter) directly into
// a terminal tile, giving any MCP caller that holds the bearer token from
// .mcp.json the ability to execute arbitrary shell commands in the user's
// running terminal. The token is per-session and is protected by 0o600 on
// .mcp.json, but compromise of that file (or a rogue MCP server entry added
// to .mcp.json) yields full command execution. This tool is therefore
// gated behind the existing user-permission-prompt flow so the user can
// approve/deny/block it, rather than auto-approving every call.
//
// What's still needed for a fuller fix:
//   - Per-tile token scoping: each terminal tile should have its own token so
//     a leaked token for tile A cannot drive terminal on tile B.
//   - Audit log: log terminal_send_input calls to ~/.codesurf/audit.log.
//   - UI surface for per-tile grant management in the permissions panel.
let _terminalSendInputWarningEmitted = false

function asBoolean(value: unknown): boolean {
  return value === true
}
import { executeImageEditTool, publishPeerCommand } from './generation'

type UserConfigWorkspaceRef = {
  id: string
  path: string
}

async function readWorkspaceRefsFromUserConfig(): Promise<UserConfigWorkspaceRef[]> {
  try {
    const userConfigPath = join(CODESURF_HOME, 'config.json')
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

async function readCanvasState(workspaceId: string): Promise<{ tiles?: TileState[]; lockedConnections?: unknown[] } | null> {
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

async function readCanvasStateTiles(workspaceId: string): Promise<TileState[]> {
  return (await readCanvasState(workspaceId))?.tiles ?? []
}

async function findNoteTileBackingFile(
  workspaceId: string,
  tileId: string,
  intent: NoteFileIntent,
): Promise<ValidatedFsPath | null> {
  // Validate before using tileId as a path segment: prevents traversal via
  // MCP-supplied tile_id values like '../../../etc/passwd'.
  assertSafePathSegment(tileId, 'tile_id')
  const workspaces = await readWorkspaceRefsFromUserConfig()
  for (const ws of workspaces) {
    if (ws.id !== workspaceId) continue
    const validateCandidate = (candidate: string): Promise<ValidatedFsPath> => (
      authorizeWorkspaceNoteFile(candidate, ws.path, intent)
    )
    try {
      const notePath = join(ws.path, '.codesurf', tileId, 'context', 'note.txt')
      const stat = await fs.stat(notePath).catch(() => null)
      if (stat?.isFile()) return await validateCandidate(notePath)
    } catch {
      // ignore
    }

    try {
      const tiles = await readCanvasStateTiles(ws.id)
      const tile = tiles.find(entry => entry?.id === tileId && entry?.type === 'note')
      const filePath = typeof tile?.filePath === 'string' ? tile.filePath.trim() : ''
      if (filePath) return await validateCandidate(filePath)
    } catch {
      // ignore
    }
  }
  return null
}

/**
 * Best-effort resolution of which workspace a tile lives in. Used to key
 * permission grants per workspace — without it every MCP-sourced grant lands
 * on the null (global) workspace and one "Always" click silently authorizes
 * the tool against every workspace's tiles forever.
 */
export async function resolveTileWorkspaceDir(
  tileId: string,
  workspaceId?: string,
): Promise<string | null> {
  try {
    assertSafePathSegment(tileId, 'tile_id')
    const workspaces = await readWorkspaceRefsFromUserConfig()
    for (const ws of workspaces) {
      if (workspaceId && ws.id !== workspaceId) continue
      const protocolDir = await fs.stat(join(ws.path, '.codesurf', tileId)).catch(() => null)
      if (protocolDir?.isDirectory()) return ws.path
      const tiles = await readCanvasStateTiles(ws.id)
      if (tiles.some(entry => entry?.id === tileId)) return ws.path
    }
  } catch {
    // Resolution is intentionally best-effort for callers that only need a
    // lookup. Permission-gated peer tools must reject a null result instead of
    // turning it into an unscoped (global) permission request.
  }
  return null
}

function unresolvedPermissionWorkspaceError(toolName: string, tileId: string): string {
  return `Permission denied: ${toolName} requires an authoritative workspace scope for tile "${tileId}"`
}

// Every tool here takes tile_id as a TARGET peer block, not the caller's own
// block. Cross-tile dispatch is intentional, but it remains workspace-bound:
// a tile token can reach peers only in its authenticated workspace, while a
// global caller must provide workspace_id.
export async function handlePeerBridgeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  const toolSchema = getNodeToolSchemaByName(name)
  const nodeToolNames = new Set(getPeerBridgeNodeTools().map(tool => tool.name))
  if (!toolSchema || !nodeToolNames.has(name)) return null

  const tileId = asString(args.tile_id)
  if (!tileId) {
    // The kanban_* names are claimed by BOTH this bridge and the board-level
    // handler in tools/kanban.ts, and TOOL_HANDLERS puts this one first — so a
    // non-null return here stopped dispatch. getAllTools() advertises the BOARD
    // schema (title + board_tile_id/workspace_id, no tile_id), so an agent
    // calling exactly as documented got "Missing tile_id", and the entire
    // persisted-board branch was unreachable except kanban_get_board. Fall
    // through so the handler whose schema is advertised actually runs; a call
    // that does pass tile_id still routes here to the connected peer.
    if (name.startsWith('kanban_')) return null
    return 'Missing tile_id'
  }
  if (!isValidAgentRoomId(tileId)) return 'Invalid tile_id'
  const workspaceScope = resolvePeerWorkspaceScope(ctx.principal, args.workspace_id)
  if (!workspaceScope.ok) return workspaceScope.error
  const workspaceId = workspaceScope.workspaceId
  const canvas = await readCanvasState(workspaceId)
  const targetAuthority = authorizePeerBridgeTarget({
    principal: ctx.principal,
    workspaceId,
    targetTileId: tileId,
    toolName: name,
    canvas,
  })
  if (!targetAuthority.ok) return targetAuthority.error

  if (name.startsWith('browser_') || name === 'browser_set_mode') {
    const mode = asString(args.mode)
    const url = asString(args.url)
    if (name === 'browser_navigate' && !url) return 'Missing url'
    if (name === 'browser_set_mode' && (mode !== 'desktop' && mode !== 'mobile')) return 'Invalid mode'
    return publishPeerCommand(workspaceId, tileId, name, { url: url ?? '', mode: mode }, ctx)
  }

  if (name === 'terminal_send_input') {
    const input = asString(args.input)
    if (!input) return 'Missing input'

    // Emit a one-time startup warning so the risk is visible in logs.
    if (!_terminalSendInputWarningEmitted) {
      _terminalSendInputWarningEmitted = true
      console.warn(
        '[MCP][SECURITY] terminal_send_input is a high-risk tool: it executes arbitrary ' +
        'commands in a live terminal tile. Calls are gated by user permission prompt. ' +
        'Any MCP client holding a valid bearer token can invoke this tool.',
      )
    }

    const workspaceDir = await resolveTileWorkspaceDir(tileId, workspaceId)
    if (!workspaceDir) {
      return unresolvedPermissionWorkspaceError('terminal_send_input', tileId)
    }
    const permissionRequest = {
      provider: 'mcp',
      toolName: 'terminal_send_input',
      workspaceDir,
      // Scope the grant to THIS terminal. The dialog already names the tile;
      // without this the grant key was only (provider, toolName, workspaceDir),
      // so "Always" for one terminal authorised every terminal in the workspace.
      resourceId: tileId,
      title: 'Terminal input from MCP agent',
      description: `An MCP agent wants to type into terminal tile "${tileId}":\n${input.slice(0, 200)}${input.length > 200 ? '...' : ''}`,
    }
    const allowed = await requestToolPermission(permissionRequest, /* interactive */ true)
    if (!allowed) return 'Permission denied: terminal_send_input was not approved'

    return publishPeerCommand(workspaceId, tileId, name, {
      input,
      enter: args.enter === undefined ? true : asBoolean(args.enter),
    }, ctx)
  }

  if (name === 'chat_send_message' || name === 'chat_acknowledge') {
    const message = asString(args.message) ?? asString(args.note)
    if (!message) return 'Missing message'
    return publishPeerCommand(workspaceId, tileId, name, { message }, ctx)
  }

  if (name === 'code_open_file') {
    const filePath = asString(args.file_path)
    if (!filePath) return 'Missing file_path'
    return publishPeerCommand(workspaceId, tileId, name, { filePath }, ctx)
  }

  if (name === 'note_read_content') {
    try {
      const notePath = await findNoteTileBackingFile(workspaceId, tileId, 'read')
      if (notePath) return await readAuthorizedNoteFile(notePath)
    } catch (err) {
      console.warn(`[peer-bridge] note_read_content failed for ${tileId}:`, err)
    }
    return `Note block ${tileId} is empty or not found`
  }

  if (name === 'note_write_content') {
    const content = asString(args.content)
    if (content === undefined) return 'Missing content'
    // Gated like terminal_send_input: the backing file may be any path the
    // canvas state references, so an ungated write is an arbitrary-file
    // overwrite primitive for any token holder.
    const workspaceDir = await resolveTileWorkspaceDir(tileId, workspaceId)
    if (!workspaceDir) {
      return unresolvedPermissionWorkspaceError('note_write_content', tileId)
    }
    const notePath = await findNoteTileBackingFile(workspaceId, tileId, 'write')
    const allowed = await requestToolPermission({
      provider: 'mcp',
      toolName: 'note_write_content',
      workspaceDir,
      title: 'Note overwrite from MCP agent',
      description: `An MCP agent wants to replace the contents of note tile "${tileId}"${notePath ? ` (${notePath.displayPath})` : ''}:\n${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`,
    }, /* interactive */ true)
    if (!allowed) return 'Permission denied: note_write_content was not approved'
    try {
      if (notePath) {
        await writeAuthorizedNoteFile(notePath, content)
      }
    } catch (err) {
      console.warn(`[peer-bridge] note_write_content failed for ${tileId}:`, err)
      return `Failed to write note: ${(err as Error).message}`
    }
    return publishPeerCommand(workspaceId, tileId, name, { content }, ctx)
  }

  if (name === 'note_append_context' || name === 'file_open_context' || name === 'image_annotate' || name === 'kanban_set_status') {
    const content = asString((name === 'kanban_set_status' ? args.message : args.snippet ?? args.context ?? args.note ?? args.message))
    if (!content) return 'Missing message'
    if (name === 'note_append_context') {
      // Same write primitive as note_write_content — gate it the same way.
      const workspaceDir = await resolveTileWorkspaceDir(tileId, workspaceId)
      if (!workspaceDir) {
        return unresolvedPermissionWorkspaceError('note_append_context', tileId)
      }
      const notePath = await findNoteTileBackingFile(workspaceId, tileId, 'write')
      const allowed = await requestToolPermission({
        provider: 'mcp',
        toolName: 'note_append_context',
        workspaceDir,
        title: 'Note append from MCP agent',
        description: `An MCP agent wants to append to note tile "${tileId}"${notePath ? ` (${notePath.displayPath})` : ''}:\n${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`,
      }, /* interactive */ true)
      if (!allowed) return 'Permission denied: note_append_context was not approved'
      try {
        if (notePath) {
          await appendAuthorizedNoteFile(notePath, content)
        }
      } catch (err) {
        console.warn(`[peer-bridge] note_append_context failed for ${tileId}:`, err)
      }
    }
    return publishPeerCommand(workspaceId, tileId, name, { content }, ctx)
  }

  if (name === 'image_edit_request' || name === 'image_generate_variation') {
    return executeImageEditTool(workspaceId, tileId, name, args, ctx)
  }

  if (name === 'image_replace_source') {
    const filePath = asString(args.file_path)
    if (!filePath) return 'Missing file_path'
    return publishPeerCommand(workspaceId, tileId, name, {
      filePath,
      note: asString(args.note) ?? '',
    }, ctx)
  }

  if (name === 'kanban_create_card' || name === 'kanban_update_card' || name === 'kanban_move_card' || name === 'kanban_pause_card' || name === 'kanban_delete_card' || name === 'kanban_create_column' || name === 'kanban_rename_column' || name === 'kanban_delete_column') {
    return publishPeerCommand(workspaceId, tileId, name, { ...args }, ctx)
  }

  return publishPeerCommand(workspaceId, tileId, name, {}, ctx)
}
