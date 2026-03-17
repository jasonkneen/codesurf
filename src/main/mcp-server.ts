/**
 * Local MCP server for Collaborator kanban integration.
 * Agents call these tools to signal completion, update status, add notes.
 *
 * Exposes an HTTP server on a random port. Port is written to:
 *   ~/.clawd-collab/mcp-server.json
 *
 * MCP config for agents:
 *   { "mcpServers": { "kanban": { "url": "http://localhost:<port>/mcp" } } }
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { BrowserWindow } from 'electron'

// SSE client registry: cardId → response streams
const sseClients = new Map<string, Set<ServerResponse>>()

const COLLAB_DIR = join(homedir(), 'clawd-collab')

interface MCPRequest {
  jsonrpc: string
  id: number | string
  method: string
  params?: {
    name?: string
    arguments?: Record<string, unknown>
  }
}

const TOOLS = [
  // ── Canvas tools ──────────────────────────────────────────────────────────
  {
    name: 'canvas_create_tile',
    description: 'Create a new tile on the infinite canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        type:      { type: 'string', enum: ['terminal', 'code', 'note', 'image', 'kanban'] },
        title:     { type: 'string' },
        file_path: { type: 'string', description: 'Absolute path to open in the tile (for code/note/image)' },
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

function handleTool(name: string, args: Record<string, unknown>): string {
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
    return `Card ${cardId} marked complete: ${args.summary}`
  }

  if (name === 'card_update') {
    const payload = { cardId, note: args.note, status: args.status }
    pushSSE(cardId, 'card_update', payload)
    sendToRenderer('card_update', payload)
    return `Card ${cardId} updated`
  }

  if (name === 'card_error') {
    const payload = { cardId, reason: args.reason }
    pushSSE(cardId, 'card_error', payload)
    sendToRenderer('card_error', payload)
    return `Card ${cardId} flagged: ${args.reason}`
  }

  if (name === 'canvas_event') {
    const payload = { cardId, event: args.event, data: args.payload ?? {} }
    pushSSE(cardId, args.event as string, payload)
    sendToRenderer('canvas_event', payload)
    return `Event '${args.event}' sent to canvas`
  }

  if (name === 'request_input') {
    const payload = { cardId, question: args.question, options: args.options ?? [] }
    pushSSE(cardId, 'input_requested', payload)
    sendToRenderer('input_requested', payload)
    return `Input requested from canvas operator: "${args.question}"`
  }

  return 'Unknown tool'
}

function handleMCP(req: MCPRequest): unknown {
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'collaborator-kanban', version: '1.0.0' }
      }
    }
  }

  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } }
  }

  if (req.method === 'tools/call') {
    const name = req.params?.name ?? ''
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>
    const result = handleTool(name, args)
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
      req.on('end', () => {
        try {
          const mcpReq: MCPRequest = JSON.parse(body)
          const response = handleMCP(mcpReq)
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

      // Write config file for agents
      await fs.mkdir(COLLAB_DIR, { recursive: true })
      const mcpConfig = {
        port: serverPort,
        url: `http://127.0.0.1:${serverPort}`,
        updatedAt: new Date().toISOString(),
        mcpServers: {
          collaborator: {
            url: `http://127.0.0.1:${serverPort}`,
            description: 'Collaborator canvas — kanban, tiles, workspace, files'
          }
        },
        tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
        endpoints: {
          mcp:    `http://127.0.0.1:${serverPort}`,
          events: `http://127.0.0.1:${serverPort}/events`,
          push:   `http://127.0.0.1:${serverPort}/push`,
          inject: `http://127.0.0.1:${serverPort}/inject`
        }
      }
      await fs.writeFile(
        join(COLLAB_DIR, 'mcp-server.json'),
        JSON.stringify(mcpConfig, null, 2)
      )

      console.log(`[MCP] Kanban server running on port ${serverPort}`)
      resolve(serverPort)
    })

    server.on('error', reject)
  })
}

export function getMCPPort(): number | null {
  return serverPort
}
