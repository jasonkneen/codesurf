/**
 * Local MCP server for Collaborator kanban integration.
 * Agents call these tools to signal completion, update status, add notes.
 *
 * Exposes an HTTP server on a random port. Port is written to:
 *   ~/.clawd-collab/mcp-server.json
 *
 * MCP config for agents:
 *   { "mcpServers": { "kanban": { "type": "http", "url": "http://localhost:<port>/mcp" } } }
 */

import { bus } from './event-bus'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'

const getHome = (): string => app.getPath('home') || process.env.HOME || process.env.USERPROFILE || ''

// SSE client registry: cardId → response streams
const sseClients = new Map<string, Set<ServerResponse>>()

const getColabDir = (): string => join(getHome(), 'clawd-collab')

interface MCPRequest {
  jsonrpc: string
  id: number | string
  method: string
  params?: {
    name?: string
    arguments?: Record<string, unknown>
  }
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

function normalizeMcpServers(servers: Record<string, unknown>, collaboratorUrl?: string): Record<string, Record<string, unknown>> {
  const normalized: Record<string, Record<string, unknown>> = {}
  for (const [name, server] of Object.entries(servers ?? {})) {
    const fallbackUrl = name === 'collaborator' ? collaboratorUrl : undefined
    normalized[name] = normalizeMcpServer(server, fallbackUrl)
  }
  return normalized
}

const TOOLS = [
  // ── Canvas tools ──────────────────────────────────────────────────────────
  {
    name: 'canvas_create_tile',
    description: 'Create a new tile on the infinite canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        type:      { type: 'string', enum: ['terminal', 'code', 'note', 'image', 'kanban', 'browser'] },
        title:     { type: 'string' },
        file_path: { type: 'string', description: 'Absolute path to open in the tile (for code/note/image) or URL for browser' },
        x:         { type: 'number', description: 'World-space X position (optional)' },
        y:         { type: 'number', description: 'World-space Y position (optional)' }
      },
      required: ['type']
    }
  },
  {
    name: 'canvas_open_file',
    description: 'Open a file from the workspace as a tile on the canvas.',
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
    description: 'List all tiles currently on the canvas.',
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
  // ── Bus tools (universal) ────────────────────────────────────────────────
  {
    name: 'update_progress',
    description: 'Report progress on a task. Any tile subscribed to this channel will see the update.',
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
    description: 'Log an activity event. Appears in any subscribed activity feed or tile indicator.',
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
    description: 'Read the latest objective.md for a tile. Call this when you receive a reload signal or need to refresh your instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The tile ID whose objective to read' }
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
    description: 'Read all context files dropped into a tile\'s .collab context folder. Returns concatenated content of all notes and reference files.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The tile ID whose context to read' }
      },
      required: ['tile_id']
    }
  }
]

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

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  const cardId = args.card_id as string

  // ── Canvas tools ──────────────────────────────────────────────────────────

  if (name === 'canvas_create_tile') {
    sendToRenderer('canvas_create_tile', {
      type:     args.type,
      title:    args.title,
      filePath: args.file_path,
      x:        args.x,
      y:        args.y
    })
    return `Tile created: ${args.type}${args.title ? ` "${args.title}"` : ''}`
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
    return 'Tile list requested — canvas will emit canvas_tiles_response event'
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
    // Search all known workspace paths for .collab/{tileId}/objective.md
    try {
      const userConfigPath = join(getColabDir(), 'config.json')
      const raw = await fs.readFile(userConfigPath, 'utf8')
      const cfg = JSON.parse(raw) as { workspaces?: Array<{ path: string }> }
      if (cfg.workspaces) {
        for (const ws of cfg.workspaces) {
          const objPath = join(ws.path, '.collab', tileId, 'objective.md')
          try {
            const content = await fs.readFile(objPath, 'utf8')
            return content
          } catch { /* not in this workspace */ }
        }
      }
    } catch { /**/ }
    return `No objective.md found for tile ${tileId}`
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
      const userConfigPath = join(getColabDir(), 'config.json')
      const raw = await fs.readFile(userConfigPath, 'utf8')
      const cfg = JSON.parse(raw) as { workspaces?: Array<{ path: string }> }
      if (cfg.workspaces) {
        for (const ws of cfg.workspaces) {
          const ctxDir = join(ws.path, '.collab', tileId, 'context')
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
      }
    } catch { /**/ }
    return `No context files found for tile ${tileId}`
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
        serverInfo: { name: 'collaborator', version: '1.0.0' }
      }
    }
  }

  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } }
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

export async function startMCPServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Cache-Control'
        })
        res.end()
        return
      }

      // SSE: GET /events?card_id=xxx  — agent streams status to canvas
      if (req.method === 'GET' && url.pathname === '/events') {
        const cardId = url.searchParams.get('card_id') ?? 'global'
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
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

      // SSE push: POST /push — agent sends an event to the canvas
      if (req.method === 'POST' && url.pathname === '/push') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const { card_id, event, data } = JSON.parse(body)
            pushSSE(card_id, event, data)
            sendToRenderer(event, { cardId: card_id, ...data })
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
            res.end('{"ok":true}')
          } catch {
            res.writeHead(400); res.end()
          }
        })
        return
      }

      // Canvas → Agent: POST /inject — write a message into agent's terminal
      if (req.method === 'POST' && url.pathname === '/inject') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const { card_id, message, append_newline = true } = JSON.parse(body)
            // Tell renderer to write to the terminal
            BrowserWindow.getAllWindows().forEach(win => {
              win.webContents.send('mcp:inject', { cardId: card_id, message, appendNewline: append_newline })
            })
            // Also push SSE so other agents/subscribers know
            pushSSE(card_id, 'canvas_message', { message })
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
            res.end('{"ok":true}')
          } catch {
            res.writeHead(400); res.end()
          }
        })
        return
      }

      // MCP: POST /  or POST /mcp
      if (req.method !== 'POST') {
        res.writeHead(405); res.end(); return
      }

      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const mcpReq: MCPRequest = JSON.parse(body)
          const response = await handleMCP(mcpReq)
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          })
          res.end(JSON.stringify(response))
        } catch (e) {
          res.writeHead(400); res.end()
        }
      })
    })

    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address() as { port: number }
      serverPort = addr.port

      const baseUrl = `http://127.0.0.1:${serverPort}`
      const collaboratorUrl = `${baseUrl}/mcp`
      const configPath = join(getColabDir(), 'mcp-server.json')

      const COLLAB_DIR = getColabDir()
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
      const normalizedServers = normalizeMcpServers(existingServers, collaboratorUrl)
      normalizedServers['collaborator'] = {
        ...(normalizeMcpServer(existingConfig.mcpServers && typeof existingConfig.mcpServers === 'object' ? (existingConfig.mcpServers as Record<string, unknown>)['collaborator'] : undefined, collaboratorUrl) as Record<string, unknown>),
        type: 'http',
        url: collaboratorUrl
      }

      const mcpConfig = {
        ...(existingConfig ?? {}),
        port: serverPort,
        url: baseUrl,
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
      // sessions in terminal tiles auto-discover the collaborator MCP server
      try {
        const userConfigPath = join(getColabDir(), 'config.json')
        const userConfigRaw = await fs.readFile(userConfigPath, 'utf8')
        const userConfig = JSON.parse(userConfigRaw) as { workspaces?: Array<{ path: string }> }
        if (userConfig.workspaces) {
          for (const ws of userConfig.workspaces) {
            writeMCPConfigToWorkspace(ws.path).catch(() => {})
          }
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
 * in terminal tiles auto-discover the collaborator MCP server.
 * Also adds tool permissions so MCP tools don't need manual approval.
 */
export async function writeMCPConfigToWorkspace(workspacePath: string): Promise<void> {
  if (!serverPort) return
  const mcpJsonPath = join(workspacePath, '.mcp.json')
  const collaboratorUrl = `http://127.0.0.1:${serverPort}/mcp`

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

  existingServers['collaborator'] = {
    type: 'http',
    url: collaboratorUrl,
  }

  const config = {
    ...existing,
    mcpServers: existingServers,
  }

  await fs.writeFile(mcpJsonPath, JSON.stringify(config, null, 2))
  console.log(`[MCP] Wrote .mcp.json to ${workspacePath}`)
}
