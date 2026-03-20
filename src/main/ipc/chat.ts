/**
 * Chat IPC — uses @anthropic-ai/claude-agent-sdk for Claude sessions.
 * No API keys needed — the SDK uses the Claude CLI's own auth.
 * Codex uses codex CLI, OpenCode uses @opencode-ai/sdk via local server.
 *
 * Multi-turn: stores sessionId per card, uses `resume` on subsequent turns.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { query, type Query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { spawn, ChildProcess, execFileSync } from 'child_process'
import * as net from 'net'
import { getMCPPort } from '../mcp-server'
// Lazy-loaded: @opencode-ai/sdk only exports ESM, Electron main is CJS.
// externalizeDepsPlugin converts dynamic import() to require() which can't
// resolve ESM-only exports — wrap in try/catch so the app still starts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _createOpencodeClient: any = null
async function getOpencodeClient(): Promise<any> {
  if (!_createOpencodeClient) {
    try {
      const mod = await import('@opencode-ai/sdk/v2/client')
      _createOpencodeClient = mod.createOpencodeClient
    } catch {
      throw new Error(
        'OpenCode SDK could not be loaded (ESM/CJS mismatch). ' +
        'Use the opencode CLI directly or check @opencode-ai/sdk compatibility.'
      )
    }
  }
  return _createOpencodeClient
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ChatRequest {
  cardId: string
  provider: 'claude' | 'codex' | 'opencode'
  model: string
  messages: ChatMessage[]
  mode?: string
  thinking?: string
}

function log(...args: unknown[]): void {
  console.log('[Chat]', ...args)
}

function sendStream(cardId: string, event: Record<string, unknown>): void {
  log('sendStream', event.type, event.text ? `"${String(event.text).slice(0, 50)}"` : '', event.error ?? '')
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('agent:stream', { cardId, ...event })
    }
  })
}

// Active Claude SDK queries
const activeQueries = new Map<string, Query>()
// Active CLI subprocesses (codex)
const activeProcesses = new Map<string, ChildProcess>()
// Stored session IDs for multi-turn conversations
const sessionIds = new Map<string, string>()

// --- OpenCode Server Manager (spawns `opencode serve`, manages lifecycle) --------

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      server.close(() => resolve(addr.port))
    })
    server.on('error', reject)
  })
}

function resolveOpenCodeBinary(): string | null {
  try {
    return execFileSync('which', ['opencode'], { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

class OpenCodeServerManager {
  private static instance: OpenCodeServerManager | null = null
  private server: ChildProcess | null = null
  private port: number | null = null
  private startPromise: Promise<{ port: number; url: string }> | null = null

  static getInstance(): OpenCodeServerManager {
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager()
    }
    return OpenCodeServerManager.instance
  }

  async ensureRunning(): Promise<{ port: number; url: string }> {
    if (this.startPromise) return this.startPromise

    if (this.server && this.port && !this.server.killed) {
      return { port: this.port, url: `http://127.0.0.1:${this.port}` }
    }

    this.startPromise = this.startServer()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async startServer(): Promise<{ port: number; url: string }> {
    const binary = resolveOpenCodeBinary()
    if (!binary) throw new Error('opencode CLI not found. Install: go install github.com/opencodeco/opencode@latest')

    this.port = await findAvailablePort()
    const url = `http://127.0.0.1:${this.port}`

    return new Promise((resolve, reject) => {
      this.server = spawn(binary, ['serve', '--port', String(this.port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })

      let started = false
      const timeout = setTimeout(() => {
        if (!started) reject(new Error('OpenCode server startup timeout (30s)'))
      }, 30_000)

      this.server.stdout?.on('data', (data: Buffer) => {
        const output = data.toString()
        log('opencode stdout:', output.trim().slice(0, 200))
        if (output.includes('listening on') && !started) {
          started = true
          clearTimeout(timeout)
          resolve({ port: this.port!, url })
        }
      })

      this.server.stderr?.on('data', (data: Buffer) => {
        log('opencode stderr:', data.toString().trim().slice(0, 200))
      })

      this.server.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })

      this.server.on('exit', (code) => {
        if (!started) {
          clearTimeout(timeout)
          reject(new Error(`OpenCode server exited with code ${code}`))
        }
        this.server = null
        this.port = null
      })
    })
  }

  async shutdown(): Promise<void> {
    if (this.server && !this.server.killed) {
      this.server.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { this.server?.kill('SIGKILL'); resolve() }, 5000)
        this.server?.on('exit', () => { clearTimeout(t); resolve() })
      })
    }
    this.server = null
    this.port = null
  }

  isRunning(): boolean {
    return !!(this.server && this.port && !this.server.killed)
  }
}

// Cached model list
let cachedOpenCodeModels: Array<{ id: string; label: string; description?: string }> = []

async function fetchOpenCodeModels(): Promise<Array<{ id: string; label: string; description?: string }>> {
  const mgr = OpenCodeServerManager.getInstance()
  const { url } = await mgr.ensureRunning()
  const createClient = await getOpencodeClient()
  const client = createClient({ baseUrl: url })

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('OpenCode provider.list timed out after 10s')), 10_000)
  })

  const response = await Promise.race([
    client.provider.list(),
    timeoutPromise,
  ])

  if ((response as any).error) {
    throw new Error(`Failed to fetch OpenCode providers: ${JSON.stringify((response as any).error)}`)
  }

  const providers = (response as any).data
  if (!providers) return []

  const connectedIds = new Set<string>(providers.connected ?? [])
  if (connectedIds.size === 0) {
    log('OpenCode: no connected providers found')
    return []
  }

  const models: Array<{ id: string; label: string; description?: string }> = []
  for (const provider of (providers.all ?? [])) {
    if (!connectedIds.has(provider.id)) continue

    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const m = model as any
      models.push({
        id: `${provider.id}/${modelId}`,
        label: m.name ?? modelId,
        description: `${provider.name ?? provider.id} - ${m.family ?? ''}`.trim(),
      })
    }
  }

  log(`OpenCode: fetched ${models.length} models from ${connectedIds.size} connected providers`)
  cachedOpenCodeModels = models
  return models
}

// --- Claude via Agent SDK --------------------------------------------------------

function chatClaude(req: ChatRequest): void {
  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  const existingSessionId = sessionIds.get(req.cardId)
  log('chatClaude starting', {
    model: req.model,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
    sessionId: existingSessionId?.slice(0, 8),
  })

  const abortController = new AbortController()

  // Map mode from UI to SDK permission mode
  const modeMap: Record<string, string> = {
    default: 'default',
    acceptEdits: 'acceptEdits',
    plan: 'plan',
    bypassPermissions: 'bypassPermissions',
  }
  const permMode = modeMap[req.mode ?? ''] ?? 'bypassPermissions'

  // Map thinking option from UI to SDK thinking config
  const thinkingMap: Record<string, { type: string; budget_tokens?: number }> = {
    adaptive: { type: 'adaptive' },
    none: { type: 'disabled' },
    low: { type: 'enabled', budget_tokens: 2048 },
    medium: { type: 'enabled', budget_tokens: 8192 },
    high: { type: 'enabled', budget_tokens: 32768 },
    max: { type: 'enabled', budget_tokens: 131072 },
  }
  const thinkingConfig = thinkingMap[req.thinking ?? ''] ?? { type: 'adaptive' }

  // Wire up the collaborator MCP server so agents can use canvas/kanban tools
  const mcpPort = getMCPPort()
  const mcpServers: Record<string, { type: 'http'; url: string }> = {}
  const mcpToolNames = [
    'canvas_create_tile', 'canvas_open_file', 'canvas_pan_to', 'canvas_list_tiles',
    'card_complete', 'card_update', 'card_error', 'canvas_event', 'request_input',
    'update_progress', 'log_activity', 'create_task', 'update_task', 'notify', 'ask',
    // Collab tools
    'reload_objective', 'pause_task', 'get_context',
  ]
  if (mcpPort) {
    mcpServers['collaborator'] = { type: 'http', url: `http://127.0.0.1:${mcpPort}/mcp` }
    log('MCP server attached at port', mcpPort)
  }

  const options: Options = {
    model: req.model,
    abortController,
    persistSession: true,
    includePartialMessages: true,
    permissionMode: permMode as any,
    thinking: thinkingConfig as any,
    ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
    // Auto-allow all collaborator MCP tools so agents don't need manual approval
    allowedTools: mcpToolNames.map(t => `mcp__collaborator__${t}`),
  }

  // Resume existing session for multi-turn
  if (existingSessionId) {
    options.resume = existingSessionId
  }

  try {
    log('calling query()...')
    const q = query({ prompt: lastUserMsg.content, options })
    log('query() returned, consuming generator...')
    activeQueries.set(req.cardId, q)

    // Consume the async generator in the background
    ;(async () => {
      let capturedSessionId = false
      try {
        for await (const msg of q) {
          // Capture session_id from the first message we receive
          if (!capturedSessionId) {
            const sid = (msg as any).session_id
            if (sid) {
              log('captured session_id:', sid.slice(0, 8))
              sessionIds.set(req.cardId, sid)
              sendStream(req.cardId, { type: 'session', sessionId: sid })
              capturedSessionId = true
            }
          }

          log('msg received:', msg.type, msg.type === 'stream_event' ? (msg as any).event?.type : '')
          if (msg.type === 'stream_event') {
            const evt = msg.event as any
            if (evt.type === 'content_block_delta') {
              if (evt.delta?.type === 'text_delta' && evt.delta.text) {
                sendStream(req.cardId, { type: 'text', text: evt.delta.text })
              } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
                sendStream(req.cardId, { type: 'thinking', text: evt.delta.thinking })
              } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
                sendStream(req.cardId, { type: 'tool_input', text: evt.delta.partial_json })
              }
            } else if (evt.type === 'content_block_start') {
              if (evt.content_block?.type === 'tool_use') {
                sendStream(req.cardId, {
                  type: 'tool_start',
                  toolName: evt.content_block.name,
                  toolId: evt.content_block.id,
                })
              } else if (evt.content_block?.type === 'thinking') {
                sendStream(req.cardId, { type: 'thinking_start' })
              }
            } else if (evt.type === 'content_block_stop') {
              sendStream(req.cardId, { type: 'block_stop', index: evt.index })
            }
          } else if (msg.type === 'assistant') {
            // Full assembled message -- extract tool results
            const message = (msg as any).message
            if (message?.content) {
              for (const block of message.content) {
                if (block.type === 'tool_use') {
                  sendStream(req.cardId, {
                    type: 'tool_use',
                    toolName: block.name,
                    toolId: block.id,
                    toolInput: JSON.stringify(block.input, null, 2),
                  })
                }
              }
            }
          } else if (msg.type === 'tool_use_summary') {
            sendStream(req.cardId, {
              type: 'tool_summary',
              text: (msg as any).summary,
            })
          } else if (msg.type === 'tool_progress') {
            sendStream(req.cardId, {
              type: 'tool_progress',
              toolName: (msg as any).tool_name,
              elapsed: (msg as any).elapsed_time_seconds,
            })
          } else if (msg.type === 'result') {
            const result = msg as any
            sendStream(req.cardId, {
              type: 'done',
              cost: result.total_cost_usd,
              turns: result.num_turns,
              resultText: result.result,
              sessionId: result.session_id,
            })
            activeQueries.delete(req.cardId)
            // Also capture from result if we missed earlier
            if (result.session_id && !sessionIds.has(req.cardId)) {
              sessionIds.set(req.cardId, result.session_id)
            }
          }
        }

        // Generator finished -- ensure done is sent
        if (activeQueries.has(req.cardId)) {
          sendStream(req.cardId, { type: 'done' })
          activeQueries.delete(req.cardId)
        }
      } catch (err: any) {
        log('generator error:', err.message ?? String(err))
        sendStream(req.cardId, { type: 'error', error: err.message ?? String(err) })
        activeQueries.delete(req.cardId)
      }
    })()
  } catch (err: any) {
    log('query() threw:', err.message ?? String(err))
    sendStream(req.cardId, { type: 'error', error: err.message ?? String(err) })
  }
}

// --- Codex via Codex CLI ---------------------------------------------------------

function chatCodex(req: ChatRequest): void {
  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  // Map mode to codex --approval-mode flag
  const codexMode = req.mode ?? 'auto'
  const proc = spawn('codex', ['exec', '--model', req.model, '--approval-mode', codexMode, lastUserMsg.content], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  activeProcesses.set(req.cardId, proc)

  proc.stdout?.on('data', (chunk: Buffer) => {
    sendStream(req.cardId, { type: 'text', text: chunk.toString() })
  })

  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })

  proc.on('close', (code) => {
    activeProcesses.delete(req.cardId)
    if (code !== 0 && stderrBuf.trim()) {
      sendStream(req.cardId, { type: 'error', error: stderrBuf.trim() })
    }
    sendStream(req.cardId, { type: 'done' })
  })

  proc.on('error', (err) => {
    activeProcesses.delete(req.cardId)
    sendStream(req.cardId, { type: 'error', error: err.message.includes('ENOENT')
      ? 'Codex CLI not found. Install: npm install -g @openai/codex'
      : err.message })
  })
}

// --- OpenCode (placeholder — will use @opencode-ai/sdk in future) ----------------

function chatOpencode(req: ChatRequest): void {
  // Placeholder: OpenCode integration requires the opencode server to be running.
  // For now, return an informative message. Full implementation will use
  // @opencode-ai/sdk/v2/client similar to Paseo's OpenCodeAgentClient.
  sendStream(req.cardId, {
    type: 'text',
    text: `OpenCode provider selected (model: ${req.model}). ` +
      'Full OpenCode integration is pending — install opencode CLI and ensure the server is running.',
  })
  sendStream(req.cardId, { type: 'done' })
}

// --- IPC Registration ------------------------------------------------------------

export function registerChatIPC(): void {
  log('registerChatIPC: handlers registered')
  ipcMain.handle('chat:send', async (_, req: ChatRequest) => {
    log('chat:send received', { provider: req.provider, model: req.model, msgCount: req.messages.length })
    // Kill existing query/process for this card
    const existingQuery = activeQueries.get(req.cardId)
    if (existingQuery) {
      existingQuery.close()
      activeQueries.delete(req.cardId)
    }
    const existingProc = activeProcesses.get(req.cardId)
    if (existingProc) {
      existingProc.kill('SIGTERM')
      activeProcesses.delete(req.cardId)
    }

    switch (req.provider) {
      case 'claude': chatClaude(req); break
      case 'codex': chatCodex(req); break
      case 'opencode': chatOpencode(req); break
    }

    return { ok: true }
  })

  ipcMain.handle('chat:stop', async (_, cardId: string) => {
    const q = activeQueries.get(cardId)
    if (q) {
      q.close()
      activeQueries.delete(cardId)
    }
    const proc = activeProcesses.get(cardId)
    if (proc) {
      proc.kill('SIGTERM')
      activeProcesses.delete(cardId)
    }
    sendStream(cardId, { type: 'done' })
  })

  // Clear session for a card (start fresh conversation)
  ipcMain.handle('chat:clearSession', async (_, cardId: string) => {
    sessionIds.delete(cardId)
    log('session cleared for card', cardId)
    return { ok: true }
  })

  // List available OpenCode models — spawns server if needed, queries provider.list
  ipcMain.handle('chat:opencodeModels', async () => {
    log('opencodeModels: fetching from OpenCode server...')
    try {
      const models = await fetchOpenCodeModels()
      if (models.length === 0) {
        // Return static fallback if no providers are connected
        log('opencodeModels: no connected providers, returning fallback list')
        return {
          models: [
            { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
            { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
            { id: 'openai/o4-mini', label: 'o4-mini' },
            { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
          ],
          source: 'fallback',
        }
      }
      return { models, source: 'opencode' }
    } catch (err: any) {
      log('opencodeModels error:', err.message)
      // Graceful fallback — return static list so UI still works
      return {
        models: cachedOpenCodeModels.length > 0 ? cachedOpenCodeModels : [
          { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
          { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
          { id: 'openai/o4-mini', label: 'o4-mini' },
          { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        ],
        source: 'fallback',
        error: err.message,
      }
    }
  })
}
