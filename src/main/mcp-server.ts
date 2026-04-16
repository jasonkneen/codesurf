/**
 * Local MCP server for Contex kanban integration.
 * Agents call these tools to signal completion, update status, add notes.
 *
 * Exposes an HTTP server on a random port. Port is written to:
 *   ~/.contex/mcp-server.json
 *
 * MCP config for agents:
 *   { "mcpServers": { "kanban": { "type": "http", "url": "http://localhost:<port>/mcp" } } }
 */

import { bus } from './event-bus'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { promises as fs } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ExtensionRegistry } from './extensions/registry'
import { getAllNodeTools, getNodeToolSchemaByName } from '../shared/nodeTools'
import * as peerState from './peer-state'
import { CONTEX_HOME } from './paths'
import { loadWorkspaceTileState, saveWorkspaceTileState } from './storage/workspaceArtifacts'

const MCP_TOKEN = randomUUID()
const MAX_BODY = 1024 * 1024 // 1MB

// SSE client registry: cardId → response streams
const sseClients = new Map<string, Set<ServerResponse>>()

const getContexDir = (): string => CONTEX_HOME

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

function workspaceCanvasStatePath(workspaceId: string): string {
  return join(CONTEX_HOME, 'workspaces', workspaceId, '.contex', 'canvas-state.json')
}

async function findNoteTileBackingFile(tileId: string): Promise<string | null> {
  const workspaces = await readWorkspaceRefsFromUserConfig()
  for (const ws of workspaces) {
    try {
      const notePath = join(ws.path, '.contex', tileId, 'context', 'note.txt')
      const stat = await fs.stat(notePath).catch(() => null)
      if (stat?.isFile()) return notePath
    } catch {
      // ignore
    }

    try {
      const raw = await fs.readFile(workspaceCanvasStatePath(ws.id), 'utf8')
      const parsed = JSON.parse(raw) as { tiles?: Array<Record<string, unknown>> }
      const tile = parsed.tiles?.find(entry => entry?.id === tileId && entry?.type === 'note')
      const filePath = typeof tile?.filePath === 'string' ? tile.filePath.trim() : ''
      if (filePath) return filePath
    } catch {
      // ignore
    }
  }
  return null
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
    const fallbackUrl = name === 'contex' ? contexUrl : undefined
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

function getAllTools() {
  return [
    ...TOOLS,
    ...getAllNodeTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ...getExtensionTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  ]
}

interface MCPKanbanColumn {
  id: string
  title: string
}

interface MCPKanbanCard {
  id: string
  title: string
  description: string
  instructions: string
  columnId: string
  color: string
  linkedTileId?: string
  linkedTileType?: string
  linkedGroupId?: string
  linkedTileIds?: string[]
  justMoved?: boolean
  agent: string
  model?: string
  mcpConfig?: string
  mcpServers: Array<{ name: string; url?: string; cmd?: string }>
  tools: string[]
  skillsAndCommands: string[]
  fileRefs: string[]
  cardRefs: string[]
  hooks: string[]
  launched: boolean
  briefPath?: string
  launchPrompt?: string
  comments: Array<{ id: string; text: string; ts: number }>
  attachments: Array<{ id: string; name: string; path: string }>
}

interface MCPKanbanState {
  columns: MCPKanbanColumn[]
  cards: MCPKanbanCard[]
}

interface ResolvedKanbanTarget {
  workspaceId: string
  boardTileId: string
  path: string
  state: MCPKanbanState
}

async function listWorkspaceIds(): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(getContexDir(), 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as { workspaces?: Array<{ id: string }> }
    const ids = (cfg.workspaces ?? []).map(ws => ws.id).filter(Boolean)
    if (ids.length > 0) return ids
  } catch { /**/ }

  try {
    const entries = await fs.readdir(join(CONTEX_HOME, 'workspaces'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

function kanbanStateFile(workspaceId: string, boardTileId: string): string {
  return join(CONTEX_HOME, 'workspaces', workspaceId, '.contex', `kanban-${boardTileId}.json`)
}

async function resolveKanbanTarget(boardTileId?: string, workspaceId?: string): Promise<ResolvedKanbanTarget> {
  const workspaceIds = workspaceId ? [workspaceId] : await listWorkspaceIds()
  const candidates: Array<{ workspaceId: string; boardTileId: string; path: string }> = []

  for (const wsId of workspaceIds) {
    if (boardTileId) {
      const path = kanbanStateFile(wsId, boardTileId)
      try {
        await fs.access(path)
        candidates.push({ workspaceId: wsId, boardTileId, path })
      } catch { /**/ }
      continue
    }

    try {
      const dir = join(CONTEX_HOME, 'workspaces', wsId, '.contex')
      const entries = await fs.readdir(dir)
      for (const name of entries) {
        const match = /^kanban-(.+)\.json$/.exec(name)
        if (!match) continue
        candidates.push({ workspaceId: wsId, boardTileId: match[1], path: join(dir, name) })
      }
    } catch { /**/ }
  }

  if (candidates.length === 0) {
    throw new Error(boardTileId ? `Kanban board '${boardTileId}' not found` : 'No kanban boards found')
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple kanban boards found; specify board_tile_id (${candidates.map(c => c.boardTileId).join(', ')})`)
  }

  const target = candidates[0]
  const raw = await fs.readFile(target.path, 'utf8')
  const parsed = JSON.parse(raw) as Partial<MCPKanbanState>
  return {
    ...target,
    state: {
      columns: Array.isArray(parsed.columns) ? parsed.columns as MCPKanbanColumn[] : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards as MCPKanbanCard[] : [],
    },
  }
}

async function saveKanbanTarget(target: ResolvedKanbanTarget, state: MCPKanbanState): Promise<void> {
  await fs.mkdir(join(CONTEX_HOME, 'workspaces', target.workspaceId, '.contex'), { recursive: true })
  await fs.writeFile(target.path, JSON.stringify(state, null, 2))
}

function summarizeKanbanState(target: ResolvedKanbanTarget): string {
  return JSON.stringify({
    workspaceId: target.workspaceId,
    boardTileId: target.boardTileId,
    columns: target.state.columns,
    cards: target.state.cards.map(card => ({
      id: card.id,
      title: card.title,
      columnId: card.columnId,
      launched: card.launched,
      agent: card.agent,
      model: card.model,
      tools: card.tools,
      fileRefs: card.fileRefs,
      cardRefs: card.cardRefs,
    })),
  }, null, 2)
}

const TOOLS = [
  // ── Canvas tools ──────────────────────────────────────────────────────────
  {
    name: 'canvas_create_tile',
    description: 'Create a new block on the infinite canvas. Core types: terminal, code, note, image, kanban, browser. Extension blocks use the ext:<id> prefix, e.g. "ext:agent-kanban-board", "ext:api-proxy-config". Call list_extensions first to see installed extension block types.',
    inputSchema: {
      type: 'object',
      properties: {
        type:      { type: 'string', description: 'Block type. Core: terminal|code|note|image|kanban|browser. Extensions: ext:<block-type> (use list_extensions to discover).' },
        title:     { type: 'string' },
        file_path: { type: 'string', description: 'Absolute path to open in the block (for code/note/image) or URL for browser' },
        x:         { type: 'number', description: 'World-space X position (optional)' },
        y:         { type: 'number', description: 'World-space Y position (optional)' }
      },
      required: ['type']
    }
  },
  {
    name: 'canvas_open_file',
    description: 'Open a file from the workspace as a block on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute path' }
      },
      required: ['path']
    }
  },
  {
    name: 'canvas_pan_to',
    description: 'Pan the canvas viewport to a specific world-space position.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'canvas_list_tiles',
    description: 'List all blocks currently on the canvas.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_extensions',
    description: 'List all installed extensions with their block types and available actions. Call this before canvas_create_tile with an ext: type, or before ext_invoke_action, to discover what is available.',
    inputSchema: { type: 'object', properties: {} }
  },
  // ── Kanban tools ─────────────────────────────────────────────────────────
  {
    name: 'card_complete',
    description: 'Call this when your task is complete. Moves the card to the next column on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id:  { type: 'string', description: 'Your card ID — available as $CARD_ID' },
        summary:  { type: 'string', description: 'What was done' },
        next_col: { type: 'string', description: 'Override target column id (optional)' }
      },
      required: ['card_id', 'summary']
    }
  },
  {
    name: 'card_update',
    description: 'Stream a progress note to the canvas mid-task.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        note:    { type: 'string', description: 'Progress update visible on the canvas' },
        status:  { type: 'string', enum: ['working', 'blocked', 'waiting'], description: 'Optional status' }
      },
      required: ['card_id', 'note']
    }
  },
  {
    name: 'card_error',
    description: 'Signal that the task failed or needs human review.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        reason:  { type: 'string' }
      },
      required: ['card_id', 'reason']
    }
  },
  {
    name: 'canvas_event',
    description: 'Send a custom event to the canvas host.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        event:   { type: 'string' },
        payload: { type: 'object' }
      },
      required: ['card_id', 'event']
    }
  },
  {
    name: 'request_input',
    description: 'Ask the canvas operator for input or clarification. Blocks until the canvas responds via /inject.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id:  { type: 'string' },
        question: { type: 'string', description: 'What do you need from the human?' },
        options:  { type: 'array', items: { type: 'string' }, description: 'Optional choices to present' }
      },
      required: ['card_id', 'question']
    }
  },
  {
    name: 'kanban_get_board',
    description: 'Return columns and cards for a built-in kanban board. If multiple boards exist, specify board_tile_id.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' }
      }
    }
  },
  {
    name: 'kanban_create_card',
    description: 'Create a kanban card on a built-in kanban board.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        column_id: { type: 'string' },
        agent: { type: 'string' },
        model: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        file_refs: { type: 'array', items: { type: 'string' } },
        card_refs: { type: 'array', items: { type: 'string' } },
        color: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_update_card',
    description: 'Edit an existing kanban card on a built-in kanban board.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        card_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        column_id: { type: 'string' },
        agent: { type: 'string' },
        model: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        file_refs: { type: 'array', items: { type: 'string' } },
        card_refs: { type: 'array', items: { type: 'string' } },
        color: { type: 'string' },
        launched: { type: 'boolean' }
      },
      required: ['card_id']
    }
  },
  {
    name: 'kanban_move_card',
    description: 'Move a kanban card to another column.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        card_id: { type: 'string' },
        column_id: { type: 'string' }
      },
      required: ['card_id', 'column_id']
    }
  },
  {
    name: 'kanban_pause_card',
    description: 'Pause a running kanban card.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        card_id: { type: 'string' }
      },
      required: ['card_id']
    }
  },
  {
    name: 'kanban_delete_card',
    description: 'Delete a kanban card.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        card_id: { type: 'string' }
      },
      required: ['card_id']
    }
  },
  {
    name: 'kanban_create_column',
    description: 'Create a new kanban column/list.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        title: { type: 'string' },
        column_id: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_rename_column',
    description: 'Rename a kanban column/list.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        column_id: { type: 'string' },
        title: { type: 'string' }
      },
      required: ['column_id', 'title']
    }
  },
  {
    name: 'kanban_delete_column',
    description: 'Delete a kanban column/list and its cards.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        column_id: { type: 'string' }
      },
      required: ['column_id']
    }
  },
  // ── Bus tools (universal) ────────────────────────────────────────────────
  {
    name: 'update_progress',
    description: 'Report progress on a task. Any block subscribed to this channel will see the update.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish to (e.g. tile:abc123, task:xyz)' },
        status: { type: 'string', description: 'Current status text' },
        percent: { type: 'number', description: 'Progress 0-100 (optional)' },
        detail: { type: 'string', description: 'Additional detail (optional)' }
      },
      required: ['channel', 'status']
    }
  },
  {
    name: 'log_activity',
    description: 'Log an activity event. Appears in any subscribed activity feed or block indicator.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish to' },
        message: { type: 'string', description: 'Activity message' },
        level: { type: 'string', enum: ['info', 'warn', 'error', 'success'], description: 'Severity level' }
      },
      required: ['channel', 'message']
    }
  },
  {
    name: 'create_task',
    description: 'Create a new task visible to any subscribed task list or kanban.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish to' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] }
      },
      required: ['channel', 'title']
    }
  },
  {
    name: 'update_task',
    description: 'Update a task status.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
        title: { type: 'string', description: 'Updated title (optional)' },
        detail: { type: 'string', description: 'Status detail (optional)' }
      },
      required: ['channel', 'task_id', 'status']
    }
  },
  {
    name: 'notify',
    description: 'Send a notification to the canvas operator.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        title: { type: 'string' },
        message: { type: 'string' },
        level: { type: 'string', enum: ['info', 'warn', 'error', 'success'] }
      },
      required: ['channel', 'message']
    }
  },
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
  // ── Collab tools ────────────────────────────────────────────────────────
  {
    name: 'reload_objective',
    description: 'Read the latest objective.md for a block. Call this when you receive a reload signal or need to refresh your instructions.',
    inputSchema: {
      type: 'object',
      properties: {
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
    description: 'Read all context files dropped into a block\'s .contex context folder. Returns concatenated content of all notes and reference files.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID whose context to read' }
      },
      required: ['tile_id']
    }
  },
  // ── Peer collaboration tools ───────────────────────────────────────────
  {
    name: 'peer_set_state',
    description: 'Declare your current work state so linked peers can see what you are doing. Call this when you start a task, change status, or update your file list.',
    inputSchema: {
      type: 'object',
      properties: {
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
    description: 'Read the work state of all linked peers — their status, current task, todos, and files. Call this to coordinate and avoid duplicating work.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID — returns states of your linked peers' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_send_message',
    description: 'Send a direct message to a linked peer. The peer will see it as a notification and can read it with peer_read_messages.',
    inputSchema: {
      type: 'object',
      properties: {
        from_tile_id: { type: 'string', description: 'Your block ID' },
        to_tile_id: { type: 'string', description: 'Recipient peer block ID' },
        message: { type: 'string', description: 'Message text' },
      },
      required: ['from_tile_id', 'to_tile_id', 'message']
    }
  },
  {
    name: 'peer_read_messages',
    description: 'Read messages sent to you by linked peers. Returns all messages (marks unread as read).',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_add_todo',
    description: 'Add a todo item to your shared list. Linked peers are notified and can see your todos via peer_get_state.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID' },
        text: { type: 'string', description: 'Todo item text' },
      },
      required: ['tile_id', 'text']
    }
  },
  {
    name: 'peer_complete_todo',
    description: 'Mark one of your todos as done. Linked peers are notified.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID' },
        todo_id: { type: 'string', description: 'The todo ID to complete' },
      },
      required: ['tile_id', 'todo_id']
    }
  },
  // ── Context tools ───────────────────────────────────────────────────────
  {
    name: 'tile_context_get',
    description: 'Read context entries from a block. Agents can read/write any block context across workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID to read context from' },
        workspace_id: { type: 'string', description: 'The workspace ID (optional; uses first workspace if omitted)' },
        tag: { type: 'string', description: 'Filter by tag prefix (e.g., "ctx:design"; optional)' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'tile_context_set',
    description: 'Write a context entry to a block. Agents can read/write any block context across workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID to write context to' },
        workspace_id: { type: 'string', description: 'The workspace ID (optional; uses first workspace if omitted)' },
        key: { type: 'string', description: 'Context key (e.g., "ctx:design:palette")' },
        value: { description: 'Context value (any JSON-serializable value)' },
      },
      required: ['tile_id', 'key', 'value']
    }
  },
  // ── Extension action tools ──────────────────────────────────────────────
  {
    name: 'ext_invoke_action',
    description: 'Invoke a registered action on an extension block. Extensions declare actions that connected blocks can call (e.g. generate, setHtml). Use tile_context_get to read extension state afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Target extension block ID' },
        action: { type: 'string', description: 'Action name to invoke (e.g. "generate", "setHtml")' },
        params: { type: 'object', description: 'Parameters for the action' },
      },
      required: ['tile_id', 'action']
    }
  },
]

export function getMCPToken(): string {
  return MCP_TOKEN
}

/** Names of all tools returned by tools/list (static + node bridge + extensions). */
export function getContexMcpToolNames(): string[] {
  return Array.from(new Set([
    ...TOOLS.map(t => t.name),
    ...getAllNodeTools().map(t => t.name),
    ...getExtensionTools().map(t => t.name),
  ]))
}

function pushSSE(cardId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  // Push to card-specific listeners
  sseClients.get(cardId)?.forEach(res => {
    try { res.write(payload) } catch { /* client disconnected */ }
  })
  // Also push to global listeners
  sseClients.get('global')?.forEach(res => {
    try { res.write(payload) } catch { /* client disconnected */ }
  })
}

function sendToRenderer(event: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('mcp:kanban', { event, data })
  })
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function publishPeerCommand(tileId: string, command: string, payload: Record<string, unknown>): string {
  const evt = bus.publish({
    channel: `tile:${tileId}`,
    type: 'data',
    source: 'mcp:contex',
    payload: { command, ...payload },
  })
  sendToRenderer('bus:event', evt)
  return `Dispatched ${command} to ${tileId}`
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  const cardId = args.card_id as string

  // ── Node-to-node MCP bridge tools ────────────────────────────────────────
  const toolSchema = getNodeToolSchemaByName(name)
  const nodeToolNames = new Set(getAllNodeTools().map(tool => tool.name))
  if (toolSchema && nodeToolNames.has(name)) {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'

    if (name.startsWith('browser_') || name === 'browser_set_mode') {
      const mode = asString(args.mode)
      const url = asString(args.url)
      if (name === 'browser_navigate' && !url) return 'Missing url'
      if (name === 'browser_set_mode' && (mode !== 'desktop' && mode !== 'mobile')) return 'Invalid mode'
      return publishPeerCommand(tileId, name, { url: url ?? '', mode: mode })
    }

    if (name === 'terminal_send_input') {
      const input = asString(args.input)
      if (!input) return 'Missing input'
      return publishPeerCommand(tileId, name, { input, enter: asBoolean(args.enter) })
    }

    if (name === 'chat_send_message' || name === 'chat_acknowledge') {
      const message = asString(args.message) ?? asString(args.note)
      if (!message) return 'Missing message'
      return publishPeerCommand(tileId, name, { message })
    }

    if (name === 'code_open_file') {
      const filePath = asString(args.file_path)
      if (!filePath) return 'Missing file_path'
      return publishPeerCommand(tileId, name, { filePath })
    }

    if (name === 'note_read_content') {
      try {
        const notePath = await findNoteTileBackingFile(tileId)
        if (notePath) return await fs.readFile(notePath, 'utf8')
      } catch { /**/ }
      return `Note block ${tileId} is empty or not found`
    }

    if (name === 'note_write_content') {
      const content = asString(args.content)
      if (content === undefined) return 'Missing content'
      try {
        const notePath = await findNoteTileBackingFile(tileId)
        if (notePath) await fs.writeFile(notePath, content, 'utf8')
      } catch { /**/ }
      return publishPeerCommand(tileId, name, { content })
    }

    if (name === 'note_append_context' || name === 'file_open_context' || name === 'image_annotate' || name === 'kanban_set_status') {
      const content = asString((name === 'kanban_set_status' ? args.message : args.snippet ?? args.context ?? args.note ?? args.message))
      if (!content) return 'Missing message'
      if (name === 'note_append_context') {
        try {
          const notePath = await findNoteTileBackingFile(tileId)
          if (notePath) {
            const previous = await fs.readFile(notePath, 'utf8').catch(() => '')
            const next = previous ? `${previous}\n${content}` : content
            await fs.writeFile(notePath, next, 'utf8')
          }
        } catch { /**/ }
      }
      return publishPeerCommand(tileId, name, { content })
    }

    if (name === 'kanban_create_card' || name === 'kanban_update_card' || name === 'kanban_move_card' || name === 'kanban_pause_card' || name === 'kanban_delete_card' || name === 'kanban_create_column' || name === 'kanban_rename_column' || name === 'kanban_delete_column') {
      return publishPeerCommand(tileId, name, { ...args })
    }

    return publishPeerCommand(tileId, name, {})
  }


  // ── Canvas tools ──────────────────────────────────────────────────────────

  if (name === 'canvas_create_tile') {
    sendToRenderer('canvas_create_tile', {
      type:     args.type,
      title:    args.title,
      filePath: args.file_path,
      x:        args.x,
      y:        args.y
    })
    return `Block created: ${args.type}${args.title ? ` "${args.title}"` : ''}`
  }

  if (name === 'canvas_open_file') {
    sendToRenderer('canvas_open_file', { path: args.path })
    return `Opening file: ${args.path}`
  }

  if (name === 'canvas_pan_to') {
    sendToRenderer('canvas_pan_to', { x: args.x, y: args.y })
    return `Canvas panned to (${args.x}, ${args.y})`
  }

  if (name === 'canvas_list_tiles') {
    // Renderer responds async — for now signal the request
    sendToRenderer('canvas_list_tiles', {})
    return 'Block list requested — canvas will emit canvas_tiles_response event'
  }

  // ── Kanban tools ─────────────────────────────────────────────────────────

  if (name === 'card_complete') {
    const payload = { cardId, summary: args.summary, nextCol: args.next_col }
    pushSSE(cardId, 'card_complete', payload)
    sendToRenderer('card_complete', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'task',
      source: 'mcp',
      payload: { cardId, summary: args.summary, nextCol: args.next_col, action: 'complete' }
    })
    return `Card ${cardId} marked complete: ${args.summary}`
  }

  if (name === 'card_update') {
    const payload = { cardId, note: args.note, status: args.status }
    pushSSE(cardId, 'card_update', payload)
    sendToRenderer('card_update', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'progress',
      source: 'mcp',
      payload: { cardId, note: args.note, status: args.status }
    })
    return `Card ${cardId} updated`
  }

  if (name === 'card_error') {
    const payload = { cardId, reason: args.reason }
    pushSSE(cardId, 'card_error', payload)
    sendToRenderer('card_error', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'notification',
      source: 'mcp',
      payload: { cardId, reason: args.reason, level: 'error' }
    })
    return `Card ${cardId} flagged: ${args.reason}`
  }

  if (name === 'canvas_event') {
    const payload = { cardId, event: args.event, data: args.payload ?? {} }
    pushSSE(cardId, args.event as string, payload)
    sendToRenderer('canvas_event', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'data',
      source: 'mcp',
      payload: { cardId, event: args.event, data: args.payload ?? {} }
    })
    return `Event '${args.event}' sent to canvas`
  }

  if (name === 'request_input') {
    const payload = { cardId, question: args.question, options: args.options ?? [] }
    pushSSE(cardId, 'input_requested', payload)
    sendToRenderer('input_requested', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'ask',
      source: 'mcp',
      payload: { cardId, question: args.question, options: args.options ?? [] }
    })
    return `Input requested from canvas operator: "${args.question}"`
  }

  if (name.startsWith('kanban_')) {
    const boardTileId = asString(args.board_tile_id)
    const workspaceId = asString(args.workspace_id)
    try {
      const target = await resolveKanbanTarget(boardTileId, workspaceId)
      const state: MCPKanbanState = {
        columns: [...target.state.columns],
        cards: [...target.state.cards],
      }

      if (name === 'kanban_get_board') {
        return summarizeKanbanState(target)
      }

      if (name === 'kanban_create_card') {
        const title = asString(args.title)
        if (!title) return 'Missing title'
        const columnId = asString(args.column_id) ?? state.columns[0]?.id ?? 'backlog'
        const now = Date.now()
        const card: MCPKanbanCard = {
          id: `card-${target.boardTileId}-${now}`,
          title,
          description: asString(args.description) ?? '',
          instructions: asString(args.instructions) ?? '',
          columnId,
          color: asString(args.color) ?? 'rgba(88, 166, 255, 0.16)',
          agent: asString(args.agent) ?? 'claude',
          model: asString(args.model),
          mcpConfig: undefined,
          mcpServers: [],
          tools: Array.isArray(args.tools) ? args.tools.filter((v): v is string => typeof v === 'string') : ['all'],
          skillsAndCommands: [],
          fileRefs: Array.isArray(args.file_refs) ? args.file_refs.filter((v): v is string => typeof v === 'string') : [],
          cardRefs: Array.isArray(args.card_refs) ? args.card_refs.filter((v): v is string => typeof v === 'string') : [],
          hooks: [],
          launched: false,
          comments: [],
          attachments: [],
        }
        state.cards.push(card)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_created', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, card })
        return `Created card ${card.id} (${card.title}) on board ${target.boardTileId}`
      }

      if (name === 'kanban_update_card') {
        const targetCardId = asString(args.card_id)
        if (!targetCardId) return 'Missing card_id'
        const idx = state.cards.findIndex(card => card.id === targetCardId)
        if (idx < 0) return `Card ${targetCardId} not found`
        const current = state.cards[idx]
        const patch: Partial<MCPKanbanCard> = {}
        if (asString(args.title) !== undefined) patch.title = asString(args.title)!
        if (asString(args.description) !== undefined) patch.description = asString(args.description)!
        if (asString(args.instructions) !== undefined) patch.instructions = asString(args.instructions)!
        if (asString(args.column_id) !== undefined) patch.columnId = asString(args.column_id)!
        if (asString(args.agent) !== undefined) patch.agent = asString(args.agent)!
        if (asString(args.model) !== undefined) patch.model = asString(args.model)
        if (asString(args.color) !== undefined) patch.color = asString(args.color)!
        if (Array.isArray(args.tools)) patch.tools = args.tools.filter((v): v is string => typeof v === 'string')
        if (Array.isArray(args.file_refs)) patch.fileRefs = args.file_refs.filter((v): v is string => typeof v === 'string')
        if (Array.isArray(args.card_refs)) patch.cardRefs = args.card_refs.filter((v): v is string => typeof v === 'string')
        if (typeof args.launched === 'boolean') patch.launched = args.launched
        const card = { ...current, ...patch }
        state.cards[idx] = card
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_updated', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, cardId: targetCardId, patch })
        return `Updated card ${targetCardId}`
      }

      if (name === 'kanban_move_card') {
        const targetCardId = asString(args.card_id)
        const columnId = asString(args.column_id)
        if (!targetCardId || !columnId) return 'Missing card_id or column_id'
        const idx = state.cards.findIndex(card => card.id === targetCardId)
        if (idx < 0) return `Card ${targetCardId} not found`
        state.cards[idx] = { ...state.cards[idx], columnId }
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_moved', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, cardId: targetCardId, columnId })
        return `Moved card ${targetCardId} to ${columnId}`
      }

      if (name === 'kanban_pause_card') {
        const targetCardId = asString(args.card_id)
        if (!targetCardId) return 'Missing card_id'
        const idx = state.cards.findIndex(card => card.id === targetCardId)
        if (idx < 0) return `Card ${targetCardId} not found`
        const current = state.cards[idx]
        state.cards[idx] = { ...current, launched: false, columnId: current.columnId === 'running' ? 'backlog' : current.columnId }
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_paused', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, cardId: targetCardId })
        return `Paused card ${targetCardId}`
      }

      if (name === 'kanban_delete_card') {
        const targetCardId = asString(args.card_id)
        if (!targetCardId) return 'Missing card_id'
        state.cards = state.cards.filter(card => card.id !== targetCardId)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_deleted', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, cardId: targetCardId })
        return `Deleted card ${targetCardId}`
      }

      if (name === 'kanban_create_column') {
        const title = asString(args.title)
        if (!title) return 'Missing title'
        const column = { id: asString(args.column_id) ?? `col-${Date.now()}`, title }
        state.columns.push(column)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_column_created', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, column })
        return `Created column ${column.id} (${column.title})`
      }

      if (name === 'kanban_rename_column') {
        const columnId = asString(args.column_id)
        const title = asString(args.title)
        if (!columnId || !title) return 'Missing column_id or title'
        state.columns = state.columns.map(column => column.id === columnId ? { ...column, title } : column)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_column_renamed', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, columnId, title })
        return `Renamed column ${columnId} to ${title}`
      }

      if (name === 'kanban_delete_column') {
        const columnId = asString(args.column_id)
        if (!columnId) return 'Missing column_id'
        state.columns = state.columns.filter(column => column.id !== columnId)
        state.cards = state.cards.filter(card => card.columnId !== columnId)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_column_deleted', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, columnId })
        return `Deleted column ${columnId}`
      }
    } catch (err: any) {
      return `Kanban tool error: ${err.message}`
    }
  }

  // ── Bus tools (universal) ────────────────────────────────────────────────

  if (name === 'update_progress') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'progress',
      source: 'mcp',
      payload: { status: args.status, percent: args.percent, detail: args.detail }
    })
    sendToRenderer('bus:event', evt)
    return `Progress updated on ${args.channel}: ${args.status}`
  }

  if (name === 'log_activity') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'activity',
      source: 'mcp',
      payload: { message: args.message, level: args.level ?? 'info' }
    })
    sendToRenderer('bus:event', evt)
    return `Activity logged on ${args.channel}: ${args.message}`
  }

  if (name === 'create_task') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'task',
      source: 'mcp',
      payload: { title: args.title, description: args.description, status: args.status ?? 'pending', action: 'create' }
    })
    sendToRenderer('bus:event', evt)
    return `Task created on ${args.channel}: ${args.title}`
  }

  if (name === 'update_task') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'task',
      source: 'mcp',
      payload: { task_id: args.task_id, status: args.status, title: args.title, detail: args.detail, action: 'update' }
    })
    sendToRenderer('bus:event', evt)
    return `Task ${args.task_id} updated on ${args.channel}: ${args.status}`
  }

  if (name === 'notify') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'notification',
      source: 'mcp',
      payload: { title: args.title, message: args.message, level: args.level ?? 'info' }
    })
    sendToRenderer('bus:event', evt)
    return `Notification sent on ${args.channel}: ${args.message}`
  }

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

  // ── Collab tools ────────────────────────────────────────────────────────

  if (name === 'reload_objective') {
    const tileId = args.tile_id as string
    // Search all known workspace paths for .contex/{tileId}/objective.md
    try {
      const workspaces = await readWorkspaceRefsFromUserConfig()
      for (const ws of workspaces) {
        const objPath = join(ws.path, '.contex', tileId, 'objective.md')
        try {
          const content = await fs.readFile(objPath, 'utf8')
          return content
        } catch { /* not in this workspace */ }
      }
    } catch { /**/ }
    return `No objective.md found for block ${tileId}`
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
    const tileId = args.tile_id as string
    try {
      const workspaces = await readWorkspaceRefsFromUserConfig()
      for (const ws of workspaces) {
        const ctxDir = join(ws.path, '.contex', tileId, 'context')
        try {
          const entries = await fs.readdir(ctxDir)
          const parts: string[] = []
          for (const entry of entries) {
            if (entry.startsWith('.')) continue
            try {
              const content = await fs.readFile(join(ctxDir, entry), 'utf8')
              parts.push(`--- ${entry} ---\n${content}`)
            } catch { /**/ }
          }
          if (parts.length > 0) return parts.join('\n\n')
        } catch { /* not in this workspace */ }
      }
    } catch { /**/ }
    return `No context files found for block ${tileId}`
  }

  // ── Peer collaboration tools ─────────────────────────────────────────────

  if (name === 'peer_set_state') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    const state = peerState.setState(tileId, {
      tileType: asString(args.tile_type) ?? undefined,
      status: (asString(args.status) as any) ?? undefined,
      task: asString(args.task) ?? undefined,
      files: Array.isArray(args.files) ? args.files.filter(f => typeof f === 'string') as string[] : undefined,
    })
    return JSON.stringify(state, null, 2)
  }

  if (name === 'peer_get_state') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    const peerStates = peerState.getLinkedPeerStates(tileId)
    if (peerStates.length === 0) return 'No linked peers with registered state. Peers must call peer_set_state first.'
    return JSON.stringify(peerStates, null, 2)
  }

  if (name === 'peer_send_message') {
    const from = asString(args.from_tile_id)
    const to = asString(args.to_tile_id)
    const message = asString(args.message)
    if (!from || !to || !message) return 'Missing from_tile_id, to_tile_id, or message'
    const msg = peerState.sendMessage(from, to, message)
    return `Message sent to ${to}: "${message}" (id: ${msg.id})`
  }

  if (name === 'peer_read_messages') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    const msgs = peerState.readMessages(tileId)
    if (msgs.length === 0) return 'No messages.'
    return JSON.stringify(msgs, null, 2)
  }

  if (name === 'peer_add_todo') {
    const tileId = asString(args.tile_id)
    const text = asString(args.text)
    if (!tileId || !text) return 'Missing tile_id or text'
    try {
      const todo = peerState.addTodo(tileId, text)
      return `Todo added: "${text}" (id: ${todo.id})`
    } catch (err: any) {
      return err.message
    }
  }

  if (name === 'peer_complete_todo') {
    const tileId = asString(args.tile_id)
    const todoId = asString(args.todo_id)
    if (!tileId || !todoId) return 'Missing tile_id or todo_id'
    const ok = peerState.completeTodo(tileId, todoId)
    return ok ? `Todo ${todoId} marked done` : `Todo ${todoId} not found or already done`
  }

  // ── Context tools ───────────────────────────────────────────────────────

  // Reject IDs containing path separators or traversal sequences
  const assertMcpSafeId = (id: string): string | null =>
    /[/\\]|\.\./.test(id) ? `Unsafe ID: ${id}` : null

  if (name === 'tile_context_get') {
    const tileId = asString(args.tile_id)
    const workspaceId = asString(args.workspace_id)
    const tagPrefix = asString(args.tag)
    if (!tileId) return 'Missing tile_id'
    const tileIdErr = assertMcpSafeId(tileId)
    if (tileIdErr) return tileIdErr
    if (workspaceId) { const wsErr = assertMcpSafeId(workspaceId); if (wsErr) return wsErr }

    try {
      const workspaceRefs = await readWorkspaceRefsFromUserConfig()
      const workspace = workspaceId
        ? workspaceRefs.find(ws => ws.id === workspaceId)
        : workspaceRefs[0]

      if (!workspace) return 'Workspace not found'

      try {
        const state = await loadWorkspaceTileState<{ _context?: Record<string, any> }>(workspace.id, tileId, {})
        const ctx = state._context ?? {}
        const entries = Object.values(ctx)

        if (tagPrefix) {
          return JSON.stringify(entries.filter((e: any) => e.key?.startsWith(tagPrefix)), null, 2)
        }
        return JSON.stringify(entries, null, 2)
      } catch {
        return '[]'  // No context yet
      }
    } catch (err: any) {
      return `Error reading context: ${err.message}`
    }
  }

  if (name === 'ext_invoke_action') {
    const tileId = asString(args.tile_id)
    const action = asString(args.action)
    if (!tileId || !action) return 'Missing tile_id or action'
    // Guard: tile must be known to the peer registry
    if (!peerState.getState(tileId)) return `Block '${tileId}' is not registered — action refused`
    const params = typeof args.params === 'object' && args.params ? args.params as Record<string, unknown> : {}
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('tileContext:changed', {
        tileId,
        key: '_action',
        value: { action, params, ts: Date.now() },
      })
    })
    return `Action '${action}' dispatched to extension block ${tileId}`
  }

  if (name === 'tile_context_set') {
    const tileId = asString(args.tile_id)
    const workspaceId = asString(args.workspace_id)
    const key = asString(args.key)
    const value = args.value
    if (!tileId || !key) return 'Missing tile_id or key'
    const tileIdErrS = assertMcpSafeId(tileId)
    if (tileIdErrS) return tileIdErrS
    if (workspaceId) { const wsErr = assertMcpSafeId(workspaceId); if (wsErr) return wsErr }

    try {
      const workspaceRefs = await readWorkspaceRefsFromUserConfig()
      const workspace = workspaceId
        ? workspaceRefs.find(ws => ws.id === workspaceId)
        : workspaceRefs[0]

      if (!workspace) return 'Workspace not found'

      const state = await loadWorkspaceTileState<{ _context?: Record<string, any>; [k: string]: unknown }>(workspace.id, tileId, {})

      // Update context
      if (!state._context) state._context = {}
      state._context[key] = { key, value, updatedAt: Date.now(), source: tileId }

      // Save state
      await saveWorkspaceTileState(workspace.id, tileId, state)

      // Publish bus event
      bus.publish({
        channel: `ctx:${tileId}`,
        type: 'data',
        source: 'mcp:context',
        payload: { action: 'context_changed', key, value, tileId },
      })

      return `Context ${key} set to: ${JSON.stringify(value)}`
    } catch (err: any) {
      return `Error writing context: ${err.message}`
    }
  }

  if (name === 'list_extensions') {
    const registry = extensionRegistryProvider?.()
    if (!registry) return JSON.stringify([])
    const exts = registry.getAll().map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: m._enabled !== false,
      tileTypes: (m.contributes?.tiles ?? []).map(t => ({
        type: `ext:${t.type}`,
        label: t.label,
      })),
      actions: (m.contributes?.actions ?? []).map(a => ({
        name: a.name,
        description: a.description,
      })),
      contextProduces: m.contributes?.context?.produces ?? [],
      contextConsumes: m.contributes?.context?.consumes ?? [],
    }))
    return JSON.stringify(exts, null, 2)
  }

  const extensionTool = getExtensionTools().find(tool => tool.name === name)
  if (extensionTool) {
    if (!extensionTool.handler) {
      return `Extension tool ${name} is declared but has no handler`
    }
    return extensionTool.handler(args)
  }

  return 'Unknown tool'
}

async function handleMCP(req: MCPRequest): Promise<unknown> {
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'contex', version: '1.0.0' },
        instructions: [
          'You are connected to the CodeSurf canvas collaboration server.',
          'Your block ID is in the CARD_ID environment variable.',
          '',
          'IMMEDIATELY call peer_set_state with your tile_id, tile_type, and status="idle" to register yourself.',
          'Then call peer_get_state to see linked peers.',
          '',
          'Before editing any file, call peer_get_state to check if a peer is already working on it.',
          'When you see [contex] notifications, call peer_read_messages to read incoming messages.',
          'Always call peer_set_state when changing tasks or files.',
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
    const result = await handleTool(name, args)
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

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Authorization')
}

export async function startMCPServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      const pathname = url.pathname.replace(/\/+$/, '') || '/'
      const normalizedEventsPath = pathname.endsWith('/events') ? '/events' : pathname
      const isEvents = req.method === 'GET' && normalizedEventsPath === '/events'

      // CORS preflight
      if (req.method === 'OPTIONS') {
        setCorsHeaders(res)
        res.writeHead(200)
        res.end()
        return
      }

      // SSE: GET /events?card_id=xxx  — agent streams status to canvas
      if (isEvents) {
        const cardId = url.searchParams.get('card_id') ?? 'global'
        setCorsHeaders(res)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
        res.write(':connected\n\n')

        if (!sseClients.has(cardId)) sseClients.set(cardId, new Set())
        sseClients.get(cardId)!.add(res)

        // Keepalive ping every 15s
        const ping = setInterval(() => {
          try { res.write(':ping\n\n') } catch { clearInterval(ping) }
        }, 15000)

        req.on('close', () => {
          clearInterval(ping)
          sseClients.get(cardId)?.delete(res)
        })
        return
      }

      // Auth check disabled — MCP server is localhost-only
      // Token still written to config for future use if needed

      // SSE push: POST /push — agent sends an event to the canvas
      if (req.method === 'POST' && url.pathname === '/push') {
        let body = ''
        let bodySize = 0
        req.on('data', (chunk: Buffer | string) => {
          bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
          if (bodySize > MAX_BODY) {
            setCorsHeaders(res)
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request body too large' }))
            req.destroy()
            return
          }
          body += chunk
        })
        req.on('end', () => {
          try {
            const { card_id, event, data } = JSON.parse(body)
            pushSSE(card_id, event, data)
            sendToRenderer(event, { cardId: card_id, ...data })
            setCorsHeaders(res)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          } catch {
            setCorsHeaders(res)
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
            setCorsHeaders(res)
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request body too large' }))
            req.destroy()
            return
          }
          body += chunk
        })
        req.on('end', () => {
          try {
            const { card_id, message, append_newline = true } = JSON.parse(body)
            // Tell renderer to write to the terminal
            BrowserWindow.getAllWindows().forEach(win => {
              win.webContents.send('mcp:inject', { cardId: card_id, message, appendNewline: append_newline })
            })
            // Also push SSE so other agents/subscribers know
            pushSSE(card_id, 'canvas_message', { message })
            setCorsHeaders(res)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          } catch {
            setCorsHeaders(res)
            res.writeHead(400); res.end()
          }
        })
        return
      }

      // MCP: POST /  or POST /mcp
      if (req.method !== 'POST') {
        setCorsHeaders(res)
        res.writeHead(405); res.end(); return
      }

      let body = ''
      let bodySize = 0
      req.on('data', (chunk: Buffer | string) => {
        bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        if (bodySize > MAX_BODY) {
          setCorsHeaders(res)
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
          const response = await handleMCP(mcpReq)
          setCorsHeaders(res)
          res.writeHead(200, {
            'Content-Type': 'application/json'
          })
          res.end(JSON.stringify(response))
        } catch (e) {
          setCorsHeaders(res)
          res.writeHead(400); res.end()
        }
      })
    })

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
      } catch { /**/ }

      const existingServers = typeof existingConfig.mcpServers === 'object' && existingConfig.mcpServers !== null
        ? existingConfig.mcpServers as Record<string, unknown>
        : {}
      const normalizedServers = normalizeMcpServers(existingServers, contexUrl)
      normalizedServers['contex'] = {
        ...(normalizeMcpServer(existingConfig.mcpServers && typeof existingConfig.mcpServers === 'object' ? (existingConfig.mcpServers as Record<string, unknown>)['contex'] : undefined, contexUrl) as Record<string, unknown>),
        type: 'http',
        url: contexUrl
      }

      const mcpConfig = {
        ...(existingConfig ?? {}),
        port: serverPort,
        url: baseUrl,
        token: MCP_TOKEN,
        updatedAt: new Date().toISOString(),
        mcpServers: normalizedServers,
        tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
        endpoints: {
          mcp: baseUrl,
          events: `${baseUrl}/events`,
          push: `${baseUrl}/push`,
          inject: `${baseUrl}/inject`
        }
      }
      await fs.writeFile(configPath, JSON.stringify(mcpConfig, null, 2))

      // Write .mcp.json to all known workspace directories so Claude Code
      // sessions in terminal tiles auto-discover the contex MCP server
      try {
        const workspaceRefs = await readWorkspaceRefsFromUserConfig()
        for (const ws of workspaceRefs) {
          writeMCPConfigToWorkspace(ws.path).catch(() => {})
        }
      } catch { /* no workspaces yet */ }

      console.log(`[MCP] Kanban server running on port ${serverPort}`)
      resolve(serverPort)
    })

    server.on('error', reject)
  })
}

export function getMCPPort(): number | null {
  return serverPort
}

/**
 * Write a .mcp.json to a workspace directory so Claude Code sessions
 * in terminal tiles auto-discover the contex MCP server.
 * Also adds tool permissions so MCP tools don't need manual approval.
 */
export async function writeMCPConfigToWorkspace(workspacePath: string): Promise<void> {
  if (!serverPort) return
  const mcpJsonPath = join(workspacePath, '.mcp.json')
  const contexUrl = `http://127.0.0.1:${serverPort}/mcp`

  // Read existing .mcp.json to preserve user-added servers
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(mcpJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch { /**/ }

  const existingServers = typeof existing.mcpServers === 'object' && existing.mcpServers !== null
    ? existing.mcpServers as Record<string, unknown>
    : {}

  existingServers['contex'] = {
    type: 'http',
    url: contexUrl,
  }

  const config = {
    ...existing,
    mcpServers: existingServers,
  }

  await fs.writeFile(mcpJsonPath, JSON.stringify(config, null, 2))
  console.log(`[MCP] Wrote .mcp.json to ${workspacePath}`)

  // Write .claude/CLAUDE.md with peer collaboration instructions
  // Claude Code reads this automatically on every session
  await writeContexClaudeMd(workspacePath)
}

/**
 * Write a .claude/CLAUDE.md to the workspace so Claude Code sessions
 * automatically follow peer collaboration protocols.
 */
async function writeContexClaudeMd(workspacePath: string): Promise<void> {
  const claudeDir = join(workspacePath, '.claude')
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')

  // Don't overwrite if it already has the contex marker
  try {
    const existing = await fs.readFile(claudeMdPath, 'utf8')
    if (existing.includes('<!-- contex-managed -->')) return
  } catch { /* doesn't exist yet */ }

  await fs.mkdir(claudeDir, { recursive: true })

  const content = `<!-- contex-managed -->
# CodeSurf Canvas Agent

You are running inside CodeSurf, an infinite canvas workspace where multiple AI agents collaborate.
Your block ID is available as the environment variable \`CARD_ID\`.

## MANDATORY: First Action on Every Session

Before doing ANYTHING else, you MUST run these two commands:

\`\`\`
1. mcp__contex__peer_set_state(tile_id=$CARD_ID, tile_type="terminal", status="idle", task="Ready")
2. mcp__contex__peer_get_state(tile_id=$CARD_ID)
\`\`\`

This registers you with the collaboration system and shows you who else is working.

## Peer Collaboration Protocol

**When you receive a task:**
1. Call \`peer_set_state\` with status "working" and describe your task
2. Call \`peer_get_state\` to check what linked peers are doing
3. If a peer lists the same files in their state, call \`peer_send_message\` to coordinate BEFORE editing

**During work:**
- Call \`peer_set_state\` whenever you switch files or tasks
- Call \`peer_read_messages\` to check for incoming messages from peers
- Use \`peer_add_todo\` for work you need a peer to handle
- When you see a \`[contex]\` notification, call \`peer_read_messages\` immediately

**On completion:**
- Call \`peer_set_state\` with status "done" and a summary
- Call \`peer_complete_todo\` for any todos you finished

**File conflict rule:**
NEVER edit a file that a linked peer lists in their \`files\` array. Send them a \`peer_send_message\` first and wait for coordination.

## Available Tool Prefixes

All contex tools use the prefix \`mcp__contex__\`. Examples:
- \`mcp__contex__peer_set_state\` — declare your state
- \`mcp__contex__peer_get_state\` — read peer states
- \`mcp__contex__peer_send_message\` — message a peer
- \`mcp__contex__peer_read_messages\` — read your messages
- \`mcp__contex__peer_add_todo\` / \`peer_complete_todo\` — shared todos
- \`mcp__contex__canvas_create_tile\` — create blocks on the canvas
- \`mcp__contex__terminal_send_input\` — type into a peer terminal block
- \`mcp__contex__chat_send_message\` — message a peer chat block
`

  await fs.writeFile(claudeMdPath, content)
  console.log(`[MCP] Wrote .claude/CLAUDE.md to ${workspacePath}`)
}
