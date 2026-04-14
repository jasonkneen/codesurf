/**
 * Chat IPC — uses @anthropic-ai/claude-agent-sdk for Claude sessions.
 * No API keys needed — the SDK uses the Claude CLI's own auth.
 * Codex uses codex CLI, OpenCode uses @opencode-ai/sdk via local server.
 *
 * Multi-turn: stores sessionId per card, uses `resume` on subsequent turns.
 */

import { ipcMain, BrowserWindow, dialog } from 'electron'
import { query, type Query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { spawn, ChildProcess, execFileSync, execFile } from 'child_process'
import * as http from 'http'
import * as net from 'net'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import { getMCPPort, getMCPToken, getContexMcpToolNames } from '../mcp-server'
import { getAgentPath, getShellEnvPath } from '../agent-paths'
import { updateLinks } from '../peer-state'
import { parseClaudeStream } from '../agent-stream'
import { ensureLocalProxyRunning } from './localProxy'
import type { ExtensionChatTransportConfig } from '../../shared/types'
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

interface PeerAction {
  name: string
  description: string
}

interface PeerContext {
  peerId: string
  peerType: string
  tools: string[]
  actions?: PeerAction[]
  context?: Record<string, unknown>
}

interface ChatRequest {
  cardId: string
  provider: string
  model: string
  messages: ChatMessage[]
  mode?: string
  thinking?: string
  workspaceDir?: string
  negotiatedTools?: string[]
  peers?: PeerContext[]
  sessionId?: string | null
  providerTransport?: ExtensionChatTransportConfig | null
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
// Active HTTP requests (proxy-backed providers)
const activeHttpRequests = new Map<string, http.ClientRequest>()
// Stored session IDs for multi-turn conversations
const sessionIds = new Map<string, string>()
const execFileAsync = promisify(execFile)

interface StreamToolFileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

interface StreamToolCommandEntry {
  label: string
  command?: string
  output?: string
  kind?: 'search' | 'read' | 'command'
}

interface CodexFileSnapshot {
  displayPath: string
  changeType: StreamToolFileChange['changeType']
  existed: boolean
  content: string | null
}

function bufferHttpResponse(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', reject)
  })
}

function chatLocalProxy(req: ChatRequest): void {
  const transport = req.providerTransport
  if (!transport || transport.type !== 'local-proxy') {
    sendStream(req.cardId, { type: 'error', error: `Unsupported provider: ${req.provider}` })
    sendStream(req.cardId, { type: 'done' })
    return
  }

  void (async () => {
    if (transport.autoStart !== false) {
      const configuredPort = (() => {
        try {
          const url = new URL(transport.baseUrl)
          return url.port ? Number(url.port) : 80
        } catch {
          return undefined
        }
      })()
      const started = await ensureLocalProxyRunning(configuredPort)
      if (!started.ok) {
        throw new Error(started.message || 'Failed to start the local proxy')
      }
    }

    const baseUrl = transport.baseUrl.replace(/\/+$/, '')
    const targetUrl = new URL(`${baseUrl}/messages`)
    const body = JSON.stringify({
      model: req.model,
      stream: true,
      max_tokens: 4096,
      messages: req.messages.map(message => ({
        role: message.role,
        content: message.content,
      })),
    })

    const request = http.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port ? Number(targetUrl.port) : 80,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'anthropic-version': '2023-06-01',
        ...(transport.apiKey ? {
          'x-api-key': transport.apiKey,
          Authorization: `Bearer ${transport.apiKey}`,
        } : {}),
      },
      timeout: 120_000,
    }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        void bufferHttpResponse(res).then((raw) => {
          activeHttpRequests.delete(req.cardId)
          let errorMessage = `Proxy request failed (${res.statusCode ?? 500})`
          try {
            const parsed = JSON.parse(raw)
            errorMessage = parsed?.error?.message ?? errorMessage
          } catch {
            if (raw.trim()) errorMessage = raw.trim()
          }
          sendStream(req.cardId, { type: 'error', error: errorMessage })
          sendStream(req.cardId, { type: 'done' })
        }).catch((err: Error) => {
          activeHttpRequests.delete(req.cardId)
          sendStream(req.cardId, { type: 'error', error: err.message })
          sendStream(req.cardId, { type: 'done' })
        })
        return
      }

      res.on('close', () => {
        activeHttpRequests.delete(req.cardId)
      })
      parseClaudeStream(req.cardId, res)
    })

    request.on('timeout', () => {
      request.destroy(new Error('Proxy request timed out'))
    })

    request.on('error', (err) => {
      if (!activeHttpRequests.has(req.cardId)) return
      activeHttpRequests.delete(req.cardId)
      sendStream(req.cardId, { type: 'error', error: err.message })
      sendStream(req.cardId, { type: 'done' })
    })

    activeHttpRequests.set(req.cardId, request)
    request.write(body)
    request.end()
  })().catch((err: Error) => {
    activeHttpRequests.delete(req.cardId)
    sendStream(req.cardId, { type: 'error', error: err.message })
    sendStream(req.cardId, { type: 'done' })
  })
}

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
  // Use startup-detected path first
  const detected = getAgentPath('opencode')
  if (detected) return detected
  // Fallback to which
  try {
    const shellPath = getShellEnvPath()
    return execFileSync('which', ['opencode'], {
      encoding: 'utf-8',
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    }).trim() || null
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
      const shellPath = getShellEnvPath()
      this.server = spawn(binary, ['serve', '--port', String(this.port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
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
const OPEN_CODE_FALLBACK_MODELS: Array<{ id: string; label: string; description?: string }> = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
  { id: 'openai/o4-mini', label: 'o4-mini' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
]

let cachedOpenCodeModels: Array<{ id: string; label: string; description?: string }> = []
let openCodeModelsInflight: Promise<Array<{ id: string; label: string; description?: string }>> | null = null
let openCodeModelsRefreshPromise: Promise<void> | null = null
let cachedOpenCodeModelsAt = 0
const OPEN_CODE_MODELS_CACHE_MS = 15_000

function getOpenCodeFallbackModels(): Array<{ id: string; label: string; description?: string }> {
  return OPEN_CODE_FALLBACK_MODELS.map(model => ({ ...model }))
}

function broadcastOpenCodeModelsUpdated(payload: { models: Array<{ id: string; label: string; description?: string }>; source: string; error?: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('chat:opencodeModelsUpdated', payload)
  }
}

function refreshOpenCodeModelsInBackground(force = false): Promise<void> {
  if (openCodeModelsRefreshPromise && !force) return openCodeModelsRefreshPromise

  const isFresh = cachedOpenCodeModels.length > 0 && (Date.now() - cachedOpenCodeModelsAt) < OPEN_CODE_MODELS_CACHE_MS
  if (isFresh && !force) return Promise.resolve()

  openCodeModelsRefreshPromise = (async () => {
    try {
      const models = await fetchOpenCodeModels()
      const nextModels = models.length > 0 ? models : getOpenCodeFallbackModels()
      broadcastOpenCodeModelsUpdated({
        models: nextModels,
        source: models.length > 0 ? 'opencode' : 'fallback',
      })
    } catch (err: any) {
      log('refreshOpenCodeModelsInBackground error:', err.message ?? String(err))
      const nextModels = cachedOpenCodeModels.length > 0 ? cachedOpenCodeModels : getOpenCodeFallbackModels()
      broadcastOpenCodeModelsUpdated({
        models: nextModels,
        source: cachedOpenCodeModels.length > 0 ? 'cache' : 'fallback',
        error: err.message ?? String(err),
      })
    } finally {
      openCodeModelsRefreshPromise = null
    }
  })()

  return openCodeModelsRefreshPromise
}

export function warmOpenCodeModelsOnStartup(): void {
  // Startup warmup intentionally disabled.
}

async function fetchOpenCodeModels(): Promise<Array<{ id: string; label: string; description?: string }>> {
  const now = Date.now()
  if (cachedOpenCodeModels.length > 0 && (now - cachedOpenCodeModelsAt) < OPEN_CODE_MODELS_CACHE_MS) {
    return cachedOpenCodeModels
  }
  if (openCodeModelsInflight) return openCodeModelsInflight
  openCodeModelsInflight = (async () => {
    const { client } = await getOrCreateOpencodeClient()

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
    cachedOpenCodeModelsAt = Date.now()
    return models
  })()

  try {
    return await openCodeModelsInflight
  } finally {
    openCodeModelsInflight = null
  }
}

// --- Claude via Agent SDK --------------------------------------------------------

function chatClaude(req: ChatRequest): void {
  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  // Restore sessionId from frontend (survives app restart via tile state)
  if (req.sessionId && !sessionIds.has(req.cardId)) {
    sessionIds.set(req.cardId, req.sessionId)
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

  // Wire up the contex MCP server (Bearer auth matches mcp-server HTTP checks)
  const mcpPort = getMCPPort()
  const mcpServers: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> = {}
  if (mcpPort) {
    mcpServers.contex = {
      type: 'http',
      url: `http://127.0.0.1:${mcpPort}/mcp`,
      headers: { Authorization: `Bearer ${getMCPToken()}` },
    }
    log('MCP server attached at port', mcpPort)
  }

  const contexToolNames = getContexMcpToolNames()
  const contexAllowedTools = contexToolNames.map(t => `mcp__contex__${t}`)

  // Register peer links in the collaboration state store
  if (req.peers && req.peers.length > 0) {
    updateLinks(req.cardId, req.peers.map(p => p.peerId))
  }

  // Build system prompt context about connected peer blocks and their tools
  let systemPrompt: string | undefined
  if (req.peers && req.peers.length > 0) {
    log('Peer data:', JSON.stringify(req.peers.map(p => ({ id: p.peerId, type: p.peerType, tools: p.tools.length, actions: p.actions?.length ?? 0 }))))
    const hasExtensionActions = req.peers.some(p => p.actions && p.actions.length > 0)
    log('hasExtensionActions:', hasExtensionActions)
    const peerLines = req.peers.map(p => {
      const lines: string[] = []
      if (p.tools.length > 0) {
        lines.push('  Tools: ' + p.tools.join(', '))
      }
      if (p.actions && p.actions.length > 0) {
        lines.push('  Actions (call via ext_invoke_action):')
        for (const a of p.actions) {
          lines.push(`    - ${a.name}: ${a.description}`)
        }
      }
      if (p.context && Object.keys(p.context).length > 0) {
        lines.push('  Current context:')
        for (const [key, value] of Object.entries(p.context)) {
          const display = value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value)
          lines.push(`    ${key}: ${display}`)
        }
      }
      if (lines.length === 0) lines.push('  (no specific tools)')
      return `- Block "${p.peerId}" (${p.peerType}):\n${lines.join('\n')}`
    }).join('\n')
    const extActionGuide = hasExtensionActions ? [
      '',
      '## Extension Actions',
      'To control extension blocks, use ext_invoke_action(tile_id, action, params).',
      'To read extension state afterwards, use tile_context_get(tile_id, tag).',
      'IMPORTANT: For artifact/content generation, ALWAYS prefer the "generate" action over "setHtml".',
      'The "generate" action sends your prompt to the extension\'s own AI which streams content in real-time with live preview.',
      'Do NOT generate HTML yourself — let the extension handle it. Just describe what you want in the prompt.',
    ] : []
    systemPrompt = [
      'You are an AI agent running inside CodeSurf, an infinite canvas workspace.',
      '',
      'The following peer blocks are directly connected to you on the canvas:',
      peerLines,
      '',
      '## Peer Collaboration',
      'Use these MCP tools to coordinate with linked peers:',
      '- peer_set_state: Declare your status, task, and files (do this when starting work)',
      '- peer_get_state: See what peers are working on, their todos, and files',
      '- peer_send_message: Send a direct message to a peer',
      '- peer_read_messages: Read incoming messages from peers',
      '- peer_add_todo: Add a shared todo (peers are notified)',
      '- peer_complete_todo: Mark a todo done',
      '',
      'Peer bridge tools (for direct control) need a block ID from the list above (passed as tile_id).',
      'All tools are prefixed mcp__contex__ (e.g. mcp__contex__peer_get_state).',
      ...extActionGuide,
    ].join('\n')
    log('systemPrompt built for', req.peers.length, 'peers, contex tools:', contexToolNames.length)
  }

  // Resolve claude binary from startup detection
  const claudePath = getAgentPath('claude')

  const options: Options = {
    model: req.model,
    abortController,
    persistSession: true,
    includePartialMessages: true,
    permissionMode: permMode as any,
    thinking: thinkingConfig as any,
    ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
    // Match tools/list (canvas + bus + node bridge + extensions); avoids blocking peer tools
    ...(Object.keys(mcpServers).length > 0 && { allowedTools: contexAllowedTools }),
    // Use detected system binary, not the SDK's bundled cli.js
    ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
  }

  // Resume existing session for multi-turn
  if (existingSessionId) {
    options.resume = existingSessionId
  }

  try {
    log('calling query()...')
    // Inject system prompt via named agent definition if we have peer context
    if (systemPrompt) {
      options.agent = 'contex'
      options.agents = {
        contex: {
          description: 'CodeSurf canvas AI agent with peer block awareness',
          prompt: systemPrompt,
        }
      }
    }
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

function normalizeCodexShellCommand(command: string): string {
  const trimmed = command.trim()
  const quotedMatch = trimmed.match(/^\/bin\/zsh -lc '([\s\S]*)'$/)
  if (quotedMatch) return quotedMatch[1].replace(/'\\''/g, "'")
  const plainMatch = trimmed.match(/^\/bin\/zsh -lc (.+)$/)
  if (plainMatch) return plainMatch[1].trim()
  return trimmed
}

function classifyCodexCommand(command: string): StreamToolCommandEntry['kind'] {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat|ls)\b/.test(normalized)) return 'read'
  return 'command'
}

function buildExploreToolName(entries: StreamToolCommandEntry[]): string {
  const readCount = entries.filter(entry => entry.kind === 'read').length
  const searchCount = entries.filter(entry => entry.kind === 'search').length
  const labelParts: string[] = []
  if (readCount > 0) labelParts.push(`${readCount} file${readCount === 1 ? '' : 's'}`)
  if (searchCount > 0) labelParts.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`)
  return labelParts.length > 0 ? `Explored ${labelParts.join(', ')}` : 'Explored workspace'
}

function buildEditedToolName(fileChanges: StreamToolFileChange[]): string {
  return `Edited ${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'}`
}

function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function changeTypeFromCodexKind(kind: unknown): StreamToolFileChange['changeType'] {
  if (kind === 'add' || kind === 'delete' || kind === 'move') return kind
  return 'update'
}

function mergeFileChanges(fileChanges: StreamToolFileChange[]): StreamToolFileChange[] {
  const merged = new Map<string, StreamToolFileChange>()

  for (const change of fileChanges) {
    const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...change })
      continue
    }
    existing.additions += change.additions
    existing.deletions += change.deletions
    existing.diff = `${existing.diff}\n\n${change.diff}`.trim()
  }

  return Array.from(merged.values())
}

async function readSnapshotContent(filePath: string): Promise<{ existed: boolean; content: string | null }> {
  try {
    const buffer = await fs.readFile(filePath)
    if (buffer.includes(0)) return { existed: true, content: null }
    return { existed: true, content: buffer.toString('utf8') }
  } catch {
    return { existed: false, content: null }
  }
}

function getDisplayPath(filePath: string, workspaceDir?: string): string {
  const resolvedPath = resolve(filePath)
  const resolvedWorkspace = workspaceDir ? resolve(workspaceDir) : ''
  if (resolvedWorkspace && (resolvedPath === resolvedWorkspace || resolvedPath.startsWith(`${resolvedWorkspace}${sep}`))) {
    const rel = relative(resolvedWorkspace, resolvedPath)
    return rel || resolvedPath.split(sep).pop() || resolvedPath
  }
  return resolvedPath
}

function resolveCodexFilePath(filePath: string, workspaceDir?: string): string {
  if (workspaceDir && !filePath.startsWith('/')) return resolve(workspaceDir, filePath)
  return resolve(filePath)
}

function normalizeNoIndexDiffPaths(diff: string, beforePath: string | null, afterPath: string | null, displayPath: string): string {
  let normalized = diff
  if (beforePath) normalized = normalized.split(beforePath).join(`a/${displayPath}`)
  if (afterPath) normalized = normalized.split(afterPath).join(`b/${displayPath}`)
  return normalized.trim()
}

async function buildSnapshotDiff(before: CodexFileSnapshot, currentPath: string): Promise<Pick<StreamToolFileChange, 'diff' | 'additions' | 'deletions'>> {
  const after = await readSnapshotContent(currentPath)
  if (before.content == null || (after.existed && after.content == null)) {
    return { diff: '', additions: 0, deletions: 0 }
  }

  const tempRoot = await fs.mkdtemp(join(tmpdir(), 'codesurf-codex-diff-'))
  const beforeTempPath = before.existed ? join(tempRoot, 'before', before.displayPath) : null
  const afterTempPath = after.existed ? join(tempRoot, 'after', before.displayPath) : null

  try {
    if (beforeTempPath) {
      await fs.mkdir(dirname(beforeTempPath), { recursive: true })
      await fs.writeFile(beforeTempPath, before.content ?? '', 'utf8')
    }
    if (afterTempPath) {
      await fs.mkdir(dirname(afterTempPath), { recursive: true })
      await fs.writeFile(afterTempPath, after.content ?? '', 'utf8')
    }

    const args = ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--']
    args.push(beforeTempPath ?? '/dev/null', afterTempPath ?? '/dev/null')

    let diff = ''
    try {
      const result = await execFileAsync('git', args, { maxBuffer: 1024 * 1024 * 4 })
      diff = result.stdout || result.stderr || ''
    } catch (error: any) {
      if (error?.code === 1) {
        diff = error.stdout || error.stderr || ''
      } else {
        throw error
      }
    }

    const normalizedDiff = normalizeNoIndexDiffPaths(diff, beforeTempPath, afterTempPath, before.displayPath)
    const { additions, deletions } = countDiffStats(normalizedDiff)
    return { diff: normalizedDiff, additions, deletions }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function summarizeCodexFileChanges(
  changes: Array<{ path?: unknown; kind?: unknown }>,
  snapshots: Map<string, CodexFileSnapshot>,
  workspaceDir?: string,
): Promise<StreamToolFileChange[]> {
  const fileChanges: StreamToolFileChange[] = []

  for (const change of changes) {
    if (typeof change?.path !== 'string') continue
    const resolvedPath = resolveCodexFilePath(change.path, workspaceDir)
    const snapshot = snapshots.get(resolvedPath) ?? {
      displayPath: getDisplayPath(resolvedPath, workspaceDir),
      changeType: changeTypeFromCodexKind(change.kind),
      existed: false,
      content: null,
    }

    const diffSummary = await buildSnapshotDiff(snapshot, resolvedPath).catch(() => ({
      diff: '',
      additions: 0,
      deletions: 0,
    }))

    fileChanges.push({
      path: snapshot.displayPath,
      changeType: snapshot.changeType,
      additions: diffSummary.additions,
      deletions: diffSummary.deletions,
      diff: diffSummary.diff,
    })

    snapshots.delete(resolvedPath)
  }

  return mergeFileChanges(fileChanges)
}

function chatCodex(req: ChatRequest): void {
  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  const codexBin = getAgentPath('codex') || 'codex'
  const shellPath = getShellEnvPath()
  const args = ['exec', '--json', '--model', req.model, '--dangerously-bypass-approvals-and-sandbox']
  if (req.workspaceDir) {
    args.push('--skip-git-repo-check', '-C', req.workspaceDir)
  } else {
    args.push('--skip-git-repo-check')
  }
  args.push(lastUserMsg.content)

  const proc = spawn(codexBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
  })

  activeProcesses.set(req.cardId, proc)
  const pendingSnapshots = new Map<string, CodexFileSnapshot>()
  const aggregatedFileChanges = new Map<string, StreamToolFileChange>()
  const exploreEntries: StreamToolCommandEntry[] = []
  let editsStarted = false
  let exploreStarted = false
  let pendingStdout = ''
  let stdoutChain = Promise.resolve()

  const handleCodexJsonEvent = async (evt: any): Promise<void> => {
    if (!evt || typeof evt !== 'object') return

    if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
      sessionIds.set(req.cardId, evt.thread_id)
      sendStream(req.cardId, { type: 'session', sessionId: evt.thread_id })
      return
    }

    if (evt.type === 'item.started') {
      const item = evt.item
      if (item?.type === 'file_change' && Array.isArray(item.changes)) {
        for (const change of item.changes) {
          if (typeof change?.path !== 'string') continue
          const resolvedPath = resolveCodexFilePath(change.path, req.workspaceDir)
          const snapshot = await readSnapshotContent(resolvedPath)
          pendingSnapshots.set(resolvedPath, {
            displayPath: getDisplayPath(resolvedPath, req.workspaceDir),
            changeType: changeTypeFromCodexKind(change.kind),
            existed: snapshot.existed,
            content: snapshot.content,
          })
        }
      }
      return
    }

    if (evt.type !== 'item.completed') return
    const item = evt.item
    if (!item || typeof item !== 'object') return

    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      sendStream(req.cardId, { type: 'text', text: item.text })
      return
    }

    if (item.type === 'command_execution' && typeof item.command === 'string') {
      const command = normalizeCodexShellCommand(item.command)
      const kind = classifyCodexCommand(command)
      if (kind === 'search' || kind === 'read') {
        if (!exploreStarted) {
          sendStream(req.cardId, { type: 'tool_start', toolId: 'codex-explore', toolName: 'Exploring workspace' })
          exploreStarted = true
        }
        exploreEntries.push({
          label: command,
          command,
          output: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
          kind,
        })
        sendStream(req.cardId, {
          type: 'tool_summary',
          toolId: 'codex-explore',
          toolName: buildExploreToolName(exploreEntries),
          commandEntries: [...exploreEntries],
        })
      }
      return
    }

    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      const fileChanges = await summarizeCodexFileChanges(item.changes, pendingSnapshots, req.workspaceDir)
      if (fileChanges.length === 0) return
      for (const change of fileChanges) {
        const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
        aggregatedFileChanges.set(key, change)
      }
      const mergedFileChanges = Array.from(aggregatedFileChanges.values())
      if (!editsStarted) {
        sendStream(req.cardId, { type: 'tool_start', toolId: 'codex-file-changes', toolName: buildEditedToolName(mergedFileChanges) })
        editsStarted = true
      }
      sendStream(req.cardId, {
        type: 'tool_summary',
        toolId: 'codex-file-changes',
        toolName: buildEditedToolName(mergedFileChanges),
        fileChanges: mergedFileChanges,
      })
    }
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    pendingStdout += chunk.toString()
    const lines = pendingStdout.split(/\r?\n/)
    pendingStdout = lines.pop() ?? ''

    stdoutChain = stdoutChain.then(async () => {
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const evt = JSON.parse(trimmed)
          await handleCodexJsonEvent(evt)
        } catch {
          sendStream(req.cardId, { type: 'text', text: `${line}\n` })
        }
      }
    }).catch(() => {})
  })

  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })

  proc.on('close', (code) => {
    activeProcesses.delete(req.cardId)
    stdoutChain = stdoutChain.then(async () => {
      if (pendingStdout.trim()) {
        try {
          await handleCodexJsonEvent(JSON.parse(pendingStdout.trim()))
        } catch {
          sendStream(req.cardId, { type: 'text', text: pendingStdout })
        }
      }
      if (code !== 0 && stderrBuf.trim()) {
        sendStream(req.cardId, { type: 'error', error: stderrBuf.trim() })
      }
      sendStream(req.cardId, { type: 'done', sessionId: sessionIds.get(req.cardId) })
    }).catch(() => {
      if (code !== 0 && stderrBuf.trim()) {
        sendStream(req.cardId, { type: 'error', error: stderrBuf.trim() })
      }
      sendStream(req.cardId, { type: 'done', sessionId: sessionIds.get(req.cardId) })
    })
  })

  proc.on('error', (err) => {
    activeProcesses.delete(req.cardId)
    sendStream(req.cardId, { type: 'error', error: err.message.includes('ENOENT')
      ? 'Codex CLI not found. Install: npm install -g @openai/codex'
      : err.message })
  })
}

// --- OpenCode via @opencode-ai/sdk SSE streaming ---------------------------------

// Store opencode session IDs separately (keyed by cardId)
const opencodeSessionIds = new Map<string, string>()

// Cached SDK client — avoid re-creating on every message
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cachedOpencodeClient: any = null
let _cachedClientUrl: string | null = null

async function getOrCreateOpencodeClient(): Promise<{ client: any; url: string }> {
  const mgr = OpenCodeServerManager.getInstance()
  const { url } = await mgr.ensureRunning()

  // Reuse client if server URL hasn't changed
  if (_cachedOpencodeClient && _cachedClientUrl === url) {
    return { client: _cachedOpencodeClient, url }
  }

  const createClient = await getOpencodeClient()
  _cachedOpencodeClient = createClient({ baseUrl: url })
  _cachedClientUrl = url
  return { client: _cachedOpencodeClient, url }
}

function chatOpencode(req: ChatRequest): void {
  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  // Parse model string like "anthropic/claude-sonnet-4-6" into providerID + modelID
  const slashIdx = req.model.indexOf('/')
  const providerID = slashIdx > 0 ? req.model.slice(0, slashIdx) : 'anthropic'
  const modelID = slashIdx > 0 ? req.model.slice(slashIdx + 1) : req.model

  if (req.sessionId && !opencodeSessionIds.has(req.cardId)) {
    opencodeSessionIds.set(req.cardId, req.sessionId)
  }
  const existingSessionId = opencodeSessionIds.get(req.cardId)
  log('chatOpencode starting', {
    model: req.model,
    providerID,
    modelID,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
  })

  ;(async () => {
    try {
      // 1. Get cached client (server already warm from model list fetch)
      const { client } = await getOrCreateOpencodeClient()

      // 2. Create or reuse session
      let sessionID = existingSessionId
      if (!sessionID) {
        // Map UI mode to permissions — 'build' allows everything, 'plan' denies writes
        const isPlan = req.mode === 'plan'
        const permission = isPlan
          ? [
              { permission: 'read', pattern: '*', action: 'allow' as const },
              { permission: 'list', pattern: '*', action: 'allow' as const },
              { permission: 'grep', pattern: '*', action: 'allow' as const },
              { permission: 'glob', pattern: '*', action: 'allow' as const },
              { permission: 'edit', pattern: '*', action: 'deny' as const },
              { permission: 'bash', pattern: '*', action: 'deny' as const },
            ]
          : [
              { permission: 'read', pattern: '*', action: 'allow' as const },
              { permission: 'edit', pattern: '*', action: 'allow' as const },
              { permission: 'list', pattern: '*', action: 'allow' as const },
              { permission: 'grep', pattern: '*', action: 'allow' as const },
              { permission: 'glob', pattern: '*', action: 'allow' as const },
              { permission: 'bash', pattern: '*', action: 'allow' as const },
              { permission: 'task', pattern: '*', action: 'allow' as const },
            ]
        const sessionRes = await client.session.create({
          title: `Chat ${req.cardId.slice(0, 8)}`,
          permission,
          ...(req.workspaceDir && { directory: req.workspaceDir }),
        })
        const sessionData = (sessionRes as any).data ?? sessionRes
        sessionID = sessionData?.info?.id ?? sessionData?.id
        if (!sessionID) {
          throw new Error('Failed to create OpenCode session — no session ID returned')
        }
        opencodeSessionIds.set(req.cardId, sessionID)
        log('opencode session created:', sessionID, isPlan ? '(plan mode)' : '(build mode)')
      }

      // 3. Subscribe to SSE + send prompt concurrently
      const sseResult = await client.event.subscribe()
      const stream = (sseResult as any).stream

      // Track state for this response
      let assistantMessageId: string | null = null
      let isDone = false
      const seenParts = new Map<string, string>() // partID -> accumulated text
      const assistantPartIds = new Set<string>() // part IDs belonging to assistant messages
      const userMessageIds = new Set<string>() // message IDs that are user messages

      // Fire prompt without waiting — response arrives via SSE
      const promptPromise = client.session.prompt({
        sessionID,
        model: { providerID, modelID },
        parts: [{ type: 'text', text: lastUserMsg.content }],
      }).catch((err: any) => {
        if (!isDone) {
          log('opencode prompt error:', err.message)
          sendStream(req.cardId, { type: 'error', error: err.message ?? String(err) })
        }
      })

      // 4. Consume SSE stream for real-time updates
      const streamTimeout = setTimeout(() => {
        if (!isDone) {
          log('opencode SSE stream timeout (5min)')
          isDone = true
          sendStream(req.cardId, { type: 'done' })
        }
      }, 5 * 60_000)

      try {
        for await (const event of stream) {
          if (isDone) break
          const evt = event as any
          const evtType: string = evt?.type ?? ''

          // Skip noisy file-watcher events (git index.lock churn, etc.)
          if (evtType.startsWith('file.watcher')) continue

          // Log all event types for debugging (except high-frequency deltas)
          if (evtType !== 'message.part.delta') {
            log('opencode SSE event:', evtType, JSON.stringify(evt?.properties ?? {}).slice(0, 300))
          }

          // Filter events to our session
          const props = evt?.properties ?? {}
          const evtSessionID = props.sessionID ?? props.info?.sessionID ?? ''
          if (evtSessionID && evtSessionID !== sessionID) continue

          switch (evtType) {
            case 'message.updated': {
              const info = props.info
              if (info?.role === 'user') {
                // Track user message IDs so we can skip their parts
                userMessageIds.add(info.id)
              } else if (info?.role === 'assistant') {
                assistantMessageId = info.id
                // Report cost/token info when message completes
                if (info.finish) {
                  sendStream(req.cardId, {
                    type: 'done',
                    cost: info.cost,
                    tokens: info.tokens,
                    sessionId: sessionID,
                  })
                  isDone = true
                }
              }
              break
            }

            case 'message.part.updated': {
              const part = props.part
              if (!part) break
              // Skip parts from user messages (don't echo user input back)
              if (userMessageIds.has(part.messageID)) break
              // If we know the assistant message ID, only accept parts from it
              if (assistantMessageId && part.messageID !== assistantMessageId) break
              // Track this as an assistant part
              assistantPartIds.add(part.id)

              if (part.type === 'text') {
                const prev = seenParts.get(part.id) ?? ''
                if (part.text && part.text.length > prev.length) {
                  const newText = part.text.slice(prev.length)
                  seenParts.set(part.id, part.text)
                  sendStream(req.cardId, { type: 'text', text: newText })
                }
              } else if (part.type === 'tool') {
                const toolId = part.callID ?? part.id
                const toolName = part.tool ?? 'tool'
                const state = part.state
                const seenKey = `tool:${part.id}`
                const prevStatus = seenParts.get(seenKey)

                if (!prevStatus) {
                  // First time seeing this tool — send tool_start
                  sendStream(req.cardId, { type: 'tool_start', toolId, toolName })
                  if (state?.input) {
                    const inputStr = typeof state.input === 'string' ? state.input : JSON.stringify(state.input, null, 2)
                    sendStream(req.cardId, { type: 'tool_input', text: inputStr })
                  }
                }

                if (state?.status === 'running' && prevStatus !== 'running') {
                  // Tool started running — update with title if available
                  if (state.title) {
                    sendStream(req.cardId, { type: 'tool_use', toolName, toolInput: state.title })
                  }
                } else if (state?.status === 'completed') {
                  // Tool finished — send summary with output
                  const summary = state.title
                    ? `${state.title}${state.output ? '\n' + state.output.slice(0, 500) : ''}`
                    : state.output?.slice(0, 500) ?? 'Done'
                  sendStream(req.cardId, { type: 'tool_summary', text: summary, toolName })
                } else if (state?.status === 'error') {
                  sendStream(req.cardId, { type: 'tool_summary', text: `Error: ${state.error}`, toolName })
                }

                seenParts.set(seenKey, state?.status ?? 'unknown')
              } else if (part.type === 'reasoning') {
                const prev = seenParts.get(part.id) ?? ''
                if (part.text && part.text.length > prev.length) {
                  const newText = part.text.slice(prev.length)
                  seenParts.set(part.id, part.text)
                  sendStream(req.cardId, { type: 'reasoning', text: newText })
                }
              } else if (part.type === 'step-finish') {
                sendStream(req.cardId, {
                  type: 'step_finish',
                  cost: part.cost,
                  tokens: part.tokens,
                  reason: part.reason,
                })
              }
              break
            }

            case 'message.part.delta': {
              // Incremental text delta — most efficient streaming path
              const { partID, field, delta, messageID } = props
              // Skip deltas for user messages
              if (messageID && userMessageIds.has(messageID)) break
              // Only accept deltas for parts we've seen from assistant
              if (partID && !assistantPartIds.has(partID)) {
                // Could be a part we haven't seen via part.updated yet — but
                // if the messageID matches a user message, skip it
                if (messageID && assistantMessageId && messageID !== assistantMessageId) break
              }
              if (field === 'text' && delta) {
                const prev = seenParts.get(partID) ?? ''
                seenParts.set(partID, prev + delta)
                sendStream(req.cardId, { type: 'text', text: delta })
              }
              break
            }

            case 'session.status': {
              if (props.status?.type === 'idle' && assistantMessageId) {
                if (!isDone) {
                  isDone = true
                  sendStream(req.cardId, { type: 'done', sessionId: sessionID })
                }
              }
              break
            }

            case 'session.error': {
              isDone = true
              sendStream(req.cardId, {
                type: 'error',
                error: props.error ?? 'OpenCode session error',
              })
              break
            }

            case 'permission.asked': {
              // Auto-approve permission requests so tools don't block
              const permReq = props as any
              log('opencode permission asked:', permReq.permission, 'id:', permReq.id)
              try {
                await client.permission.reply({
                  requestID: permReq.id,
                  reply: 'always',
                })
                log('opencode permission auto-approved:', permReq.id)
              } catch (permErr: any) {
                log('opencode permission reply error:', permErr.message)
              }
              break
            }

            case 'question.asked': {
              // Auto-answer questions from the model
              const qReq = props as any
              log('opencode question asked:', qReq.id, JSON.stringify(qReq.questions ?? []).slice(0, 200))
              try {
                // Each question needs an answer array; default to first option or "yes"
                const answers = (qReq.questions ?? []).map((q: any) => {
                  if (q.options?.length > 0) return [q.options[0].value ?? q.options[0].label ?? 'yes']
                  return ['yes']
                })
                await client.question.reply({
                  requestID: qReq.id,
                  answers,
                })
                log('opencode question auto-answered:', qReq.id)
              } catch (qErr: any) {
                log('opencode question reply error:', qErr.message)
              }
              break
            }
          }
        }
      } finally {
        clearTimeout(streamTimeout)
      }

      await promptPromise

      if (!isDone) {
        sendStream(req.cardId, { type: 'done', sessionId: sessionID })
      }
    } catch (err: any) {
      log('chatOpencode error:', err.message ?? String(err))
      const errorMsg = err.message?.includes('opencode CLI not found')
        ? 'OpenCode CLI not found. Install: go install github.com/opencodeco/opencode@latest'
        : err.message?.includes('ESM/CJS')
          ? 'OpenCode SDK could not be loaded. Check @opencode-ai/sdk compatibility.'
          : err.message ?? String(err)
      sendStream(req.cardId, { type: 'error', error: errorMsg })
      sendStream(req.cardId, { type: 'done' })
    }
  })()
}

// --- OpenClaw via CLI (NDJSON stream) --------------------------------------------

// Store openclaw session IDs (keyed by cardId) for multi-turn resume
const openclawSessionIds = new Map<string, string>()

function resolveOpenClawBinary(): string | null {
  const detected = getAgentPath('openclaw')
  if (detected) return detected
  try {
    const shellPath = getShellEnvPath()
    return execFileSync('which', ['openclaw'], {
      encoding: 'utf-8',
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    }).trim() || null
  } catch {
    return null
  }
}

function normalizeModelRef(model?: string | null): string {
  return (model ?? '').trim().toLowerCase()
}

function parseOpenClawAgents(openclawBin: string, shellPath?: string | null): Array<{ id: string; name?: string; model?: string; isDefault?: boolean }> {
  try {
    const raw = execFileSync(openclawBin, ['agents', 'list', '--json'], {
      encoding: 'utf-8',
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    }).trim()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function selectOpenClawAgentId(openclawBin: string, shellPath?: string | null, preferredModel?: string | null): string {
  const agents = parseOpenClawAgents(openclawBin, shellPath)
  if (agents.length === 0) return 'main'

  const requested = normalizeModelRef(preferredModel)
  const isStable = (id: string): boolean => !id.startsWith('mc-gateway-') && !/^lead-[0-9a-f-]+$/i.test(id)

  if (requested) {
    const directStable = agents.find(agent => isStable(agent.id) && normalizeModelRef(agent.id) === requested)
    if (directStable) return directStable.id

    const directAny = agents.find(agent => normalizeModelRef(agent.id) === requested)
    if (directAny) return directAny.id

    const exactStable = agents.find(agent => isStable(agent.id) && normalizeModelRef(agent.model) === requested)
    if (exactStable) return exactStable.id

    const exactAny = agents.find(agent => normalizeModelRef(agent.model) === requested)
    if (exactAny) return exactAny.id

    const requestedFamily = requested.includes('/') ? requested.split('/')[0] : requested.split('-')[0]
    const familyStable = agents.find(agent => {
      if (!isStable(agent.id)) return false
      const model = normalizeModelRef(agent.model)
      return model.startsWith(`${requestedFamily}/`) || model.includes(requestedFamily)
    })
    if (familyStable) return familyStable.id
  }

  return agents.find(agent => agent.isDefault)?.id ?? agents[0]?.id ?? 'main'
}

function extractOpenClawTextPayload(payload: any): string {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.content === 'string') return payload.content
  if (typeof payload.message === 'string') return payload.message
  if (typeof payload.summary === 'string') return payload.summary
  if (Array.isArray(payload.parts)) {
    return payload.parts
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('')
  }
  return ''
}

function chatOpenclaw(req: ChatRequest): void {
  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  const openclawBin = resolveOpenClawBinary()
  if (!openclawBin) {
    sendStream(req.cardId, { type: 'error', error: 'OpenClaw CLI not found. Install: npm install -g openclaw' })
    return
  }

  const shellPath = getShellEnvPath()
  if (req.sessionId && !openclawSessionIds.has(req.cardId)) {
    openclawSessionIds.set(req.cardId, req.sessionId)
  }
  const existingSessionId = openclawSessionIds.get(req.cardId)
  const selectedAgentId = existingSessionId ? null : selectOpenClawAgentId(openclawBin, shellPath, req.model)

  log('chatOpenclaw starting', {
    model: req.model,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
    agentId: selectedAgentId,
  })

  const args = ['agent', '--json']
  if (existingSessionId) {
    args.push('--session-id', existingSessionId)
  } else {
    args.push('--agent', selectedAgentId ?? 'main')
  }

  const thinkingMap: Record<string, string> = {
    none: 'off',
    low: 'minimal',
    medium: 'medium',
    high: 'high',
    max: 'xhigh',
    adaptive: 'medium',
  }
  const thinking = thinkingMap[req.thinking ?? '']
  if (thinking) {
    args.push('--thinking', thinking)
  }

  args.push('--message', lastUserMsg.content)

  const proc = spawn(openclawBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    ...(req.workspaceDir && { cwd: req.workspaceDir }),
  })

  activeProcesses.set(req.cardId, proc)

  let stdoutBuf = ''
  proc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString() })

  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })

  proc.on('close', (code) => {
    activeProcesses.delete(req.cardId)
    if (code !== 0) {
      sendStream(req.cardId, { type: 'error', error: stderrBuf.trim() || stdoutBuf.trim() || `OpenClaw exited with ${code}` })
      sendStream(req.cardId, { type: 'done' })
      return
    }

    let sessionId: string | undefined
    let resultText = stdoutBuf.trim()
    try {
      const parsed = JSON.parse(stdoutBuf)
      const meta = parsed?.meta ?? parsed?.result?.meta
      const payloads = Array.isArray(parsed?.payloads)
        ? parsed.payloads
        : Array.isArray(parsed?.result?.payloads)
          ? parsed.result.payloads
          : []
      sessionId = meta?.sessionId ?? meta?.session_id ?? parsed?.sessionId ?? parsed?.session_id
      resultText = payloads
        .map((payload: any) => extractOpenClawTextPayload(payload))
        .filter(Boolean)
        .join('\n\n')
        || parsed?.summary
        || parsed?.result?.summary
        || resultText
    } catch {
      // Fall back to plain stdout
    }

    if (sessionId) {
      openclawSessionIds.set(req.cardId, sessionId)
      sendStream(req.cardId, { type: 'session', sessionId })
    }
    if (resultText) {
      sendStream(req.cardId, { type: 'text', text: resultText })
    }
    sendStream(req.cardId, { type: 'done', sessionId })
  })

  proc.on('error', (err) => {
    activeProcesses.delete(req.cardId)
    sendStream(req.cardId, {
      type: 'error',
      error: err.message.includes('ENOENT')
        ? 'OpenClaw CLI not found. Install: npm install -g openclaw'
        : err.message,
    })
  })
}

// --- Hermes via CLI (stdout streaming) -------------------------------------------

// Store hermes session IDs for multi-turn resume
const hermesSessionIds = new Map<string, string>()

function resolveHermesBinary(): string | null {
  const detected = getAgentPath('hermes')
  if (detected) return detected
  try {
    const shellPath = getShellEnvPath()
    return execFileSync('which', ['hermes'], {
      encoding: 'utf-8',
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    }).trim() || null
  } catch {
    return null
  }
}

function chatHermes(req: ChatRequest): void {
  const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  const hermesBin = resolveHermesBinary()
  if (!hermesBin) {
    sendStream(req.cardId, { type: 'error', error: 'Hermes CLI not found. Install: pip install hermes-agent' })
    return
  }

  const shellPath = getShellEnvPath()
  if (req.sessionId && !hermesSessionIds.has(req.cardId)) {
    hermesSessionIds.set(req.cardId, req.sessionId)
  }
  const existingSessionId = hermesSessionIds.get(req.cardId)

  log('chatHermes starting', {
    model: req.model,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
  })

  // Hermes requires the `chat` subcommand for non-interactive prompts.
  // `--quiet` suppresses banners/spinners but still prints the final response.
  const args = ['chat', '--query', lastUserMsg.content, '--quiet', '--source', 'tool']

  if (req.model) {
    args.push('--model', req.model)
  }

  if (existingSessionId) {
    args.push('--resume', existingSessionId)
  }

  // Map mode to hermes toolsets
  const modeMap: Record<string, string> = {
    'full': 'terminal,file,web,browser',
    'terminal': 'terminal,file',
    'web': 'web,browser',
    'query': '',
  }
  const toolsets = modeMap[req.mode ?? ''] ?? 'terminal,file,web'
  if (toolsets) {
    args.push('--toolsets', toolsets)
  }

  const proc = spawn(hermesBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    ...(req.workspaceDir && { cwd: req.workspaceDir }),
  })

  activeProcesses.set(req.cardId, proc)

  let stdoutBuf = ''
  const flushHermesOutput = (text: string, flushPartial = false): void => {
    stdoutBuf += text
    const lines = stdoutBuf.split(/\r?\n/)
    stdoutBuf = flushPartial ? '' : (lines.pop() ?? '')

    for (const line of lines) {
      const trimmed = line.trim()
      const sessionMatch = trimmed.match(/^(?:session_id|session)\s*:\s*(\S+)$/i)
      if (sessionMatch?.[1]) {
        const sid = sessionMatch[1]
        hermesSessionIds.set(req.cardId, sid)
        sendStream(req.cardId, { type: 'session', sessionId: sid })
        continue
      }
      sendStream(req.cardId, { type: 'text', text: line + '\n' })
    }
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    flushHermesOutput(chunk.toString(), false)
  })

  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })

  proc.on('close', (code) => {
    flushHermesOutput('', true)
    activeProcesses.delete(req.cardId)
    if (code !== 0 && stderrBuf.trim()) {
      sendStream(req.cardId, { type: 'error', error: stderrBuf.trim() })
    }
    sendStream(req.cardId, { type: 'done' })
  })

  proc.on('error', (err) => {
    activeProcesses.delete(req.cardId)
    sendStream(req.cardId, {
      type: 'error',
      error: err.message.includes('ENOENT')
        ? 'Hermes CLI not found. Install: pip install hermes-agent'
        : err.message,
    })
  })
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
    const existingHttpRequest = activeHttpRequests.get(req.cardId)
    if (existingHttpRequest) {
      existingHttpRequest.destroy()
      activeHttpRequests.delete(req.cardId)
    }

    switch (req.provider) {
      case 'claude': chatClaude(req); break
      case 'codex': chatCodex(req); break
      case 'opencode': chatOpencode(req); break
      case 'openclaw': chatOpenclaw(req); break
      case 'hermes': chatHermes(req); break
      default:
        if (req.providerTransport?.type === 'local-proxy') {
          chatLocalProxy(req)
        } else {
          sendStream(req.cardId, { type: 'error', error: `Unsupported provider: ${req.provider}` })
          sendStream(req.cardId, { type: 'done' })
        }
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
    const httpRequest = activeHttpRequests.get(cardId)
    if (httpRequest) {
      httpRequest.destroy()
      activeHttpRequests.delete(cardId)
    }
    // Abort any active OpenCode session
    const ocSessionId = opencodeSessionIds.get(cardId)
    if (ocSessionId) {
      try {
        const mgr = OpenCodeServerManager.getInstance()
        if (mgr.isRunning()) {
          const createClient = await getOpencodeClient()
          const { url } = await mgr.ensureRunning()
          const client = createClient({ baseUrl: url })
          await client.session.abort({ sessionID: ocSessionId })
          log('opencode session aborted:', ocSessionId)
        }
      } catch (err: any) {
        log('opencode abort error (non-fatal):', err.message)
      }
    }
    sendStream(cardId, { type: 'done' })
  })

  // Clear session for a card (start fresh conversation)
  ipcMain.handle('chat:clearSession', async (_, cardId: string) => {
    sessionIds.delete(cardId)
    opencodeSessionIds.delete(cardId)
    openclawSessionIds.delete(cardId)
    hermesSessionIds.delete(cardId)
    log('session cleared for card', cardId)
    return { ok: true }
  })

  // Open a file picker dialog for attachments
  ipcMain.handle('chat:selectFiles', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach Files',
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return result.filePaths
  })

  ipcMain.handle('chat:openclawAgents', async () => {
    const openclawBin = resolveOpenClawBinary()
    if (!openclawBin) {
      return { agents: [] }
    }

    const shellPath = getShellEnvPath()
    const agents = parseOpenClawAgents(openclawBin, shellPath).map(agent => ({
      id: agent.id,
      label: agent.name ? `${agent.name}${agent.isDefault ? ' (default)' : ''}` : `${agent.id}${agent.isDefault ? ' (default)' : ''}`,
      description: agent.model ?? agent.id,
    }))

    return { agents }
  })

  ipcMain.handle('chat:opencodeModels', async () => {
    const isFresh = cachedOpenCodeModels.length > 0 && (Date.now() - cachedOpenCodeModelsAt) < OPEN_CODE_MODELS_CACHE_MS
    if (!isFresh) void refreshOpenCodeModelsInBackground()
    const models = isFresh
      ? cachedOpenCodeModels
      : (cachedOpenCodeModels.length > 0 ? cachedOpenCodeModels : getOpenCodeFallbackModels())

    return {
      models,
      source: isFresh ? 'cache' : (cachedOpenCodeModels.length > 0 ? 'stale-cache' : 'fallback'),
      loading: openCodeModelsRefreshPromise !== null,
    }
  })
}
