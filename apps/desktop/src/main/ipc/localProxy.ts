import { ipcMain } from 'electron'
import * as http from 'http'
import * as net from 'net'
import { randomUUID } from 'crypto'
import { readSettingsSync } from './workspace'
import { bus } from '../event-bus'
import { createGuardedLocalProxyBackendRequest } from '../chat/local-proxy-backend-request.ts'
import {
  DEFAULT_MANAGED_LOCAL_PROXY_PORT,
  MANAGED_LOCAL_PROXY_PORT_ERROR,
  resolveManagedLocalProxyPort,
  resolveReportedManagedLocalProxyPort,
} from './terminal-helpers.ts'
import {
  assertForwardableLocalProxyRole,
  BoundedProxyBody,
  BoundedProxyLineDecoder,
  BoundedProxyLineQueue,
  findFirstLiveLocalProxyBackend,
  GenerationOwnedProxyResource,
  isVerifiedLocalProxyBackendProbe,
  localProxyClientCanContinue,
  type LocalProxyBackendProbeKind,
  LocalProxyLimitError,
  MANAGED_LOCAL_PROXY_LIMITS,
  OneShotProxyLifecycle,
  type ProxyResourceLease,
  ProxyBackpressureGate,
  ProxyLifecycleEpoch,
  reportManagedProxyStreamFailure,
  revokeManagedProxyResource,
  SerializedProxyOperationLane,
} from '../chat/local-proxy-resource-limits'

interface ConnectionRecord {
  id: string
  remoteAddr: string
  model: string
  backend: string
  startedAt: number
  requestCount: number
}

interface ProxyStats {
  requestsServed: number
  requestsFailed: number
  startedAt: number | null
  activeConnections: ConnectionRecord[]
}

interface BackendChatPayload {
  message?: { content?: unknown }
  choices?: Array<{
    delta?: { content?: unknown }
    message?: { content?: unknown }
    finish_reason?: unknown
  }>
  done?: unknown
  model?: unknown
}

interface LocalBackendProbe {
  path: string
  kind: LocalProxyBackendProbeKind
}

interface LocalBackend {
  name: string
  base: string
  chatPath: string
  format: 'ollama' | 'openai'
  probes: readonly LocalBackendProbe[]
}

interface ProxyRuntime {
  server: http.Server
  port: number | null
  token: string
  state: 'starting' | 'running'
  cancelStartup: ((reason: string) => void) | null
}

const proxyRuntimeOwner = new GenerationOwnedProxyResource<ProxyRuntime>()
const proxyLifecycleLane = new SerializedProxyOperationLane()
const proxyLifecycleEpoch = new ProxyLifecycleEpoch()
let stats: ProxyStats = {
  requestsServed: 0,
  requestsFailed: 0,
  startedAt: null,
  activeConnections: [],
}
let connCounter = 0

// Known local backends to probe in order
const LOCAL_BACKENDS: readonly LocalBackend[] = [
  {
    name: 'Ollama',
    base: 'http://localhost:11434',
    chatPath: '/api/chat',
    format: 'ollama',
    probes: [{ path: '/api/tags', kind: 'ollama-tags' }],
  },
  {
    name: 'LM Studio',
    base: 'http://localhost:1234',
    chatPath: '/v1/chat/completions',
    format: 'openai',
    probes: [
      { path: '/api/v1/models', kind: 'lmstudio-v1-models' },
      { path: '/api/v0/models', kind: 'lmstudio-v0-models' },
    ],
  },
  {
    name: 'llama.cpp',
    base: 'http://localhost:8080',
    chatPath: '/v1/chat/completions',
    format: 'openai',
    probes: [{ path: '/health', kind: 'llamacpp-health' }],
  },
]

async function probeBackend(
  base: string,
  probe: LocalBackendProbe,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise(resolve => {
    const lifecycle = new OneShotProxyLifecycle()
    let req: http.ClientRequest | null = null
    let deadline: NodeJS.Timeout | null = null
    const handleAbort = (): void => {
      req?.destroy()
      finish(false)
    }
    const finish = (live: boolean): void => {
      if (!lifecycle.finish()) return
      if (deadline) clearTimeout(deadline)
      signal?.removeEventListener('abort', handleAbort)
      resolve(live)
    }
    if (signal?.aborted) {
      finish(false)
      return
    }
    const url = new URL(base)
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: probe.path,
      method: 'GET',
      timeout: 800,
      headers: { Accept: 'application/json' },
    }
    req = http.request(options, res => {
      if (res.statusCode !== 200) {
        res.resume()
        res.destroy()
        req?.destroy()
        finish(false)
        return
      }

      const body = new BoundedProxyBody(
        MANAGED_LOCAL_PROXY_LIMITS.backendProbeBytes,
        'backend-body',
      )
      res.on('data', (chunk: Buffer) => {
        if (!lifecycle.active) return
        try {
          body.append(chunk)
        } catch {
          res.destroy()
          req?.destroy()
          finish(false)
        }
      })
      res.on('end', () => {
        finish(isVerifiedLocalProxyBackendProbe(
          probe.kind,
          res.statusCode,
          res.headers['content-type'],
          body.toString(),
        ))
      })
      res.on('aborted', () => finish(false))
      res.on('error', () => finish(false))
      res.on('close', () => {
        if (!res.complete) finish(false)
      })
    })
    req.on('error', () => finish(false))
    req.on('timeout', () => {
      req?.destroy()
      finish(false)
    })
    signal?.addEventListener('abort', handleAbort, { once: true })
    if (signal?.aborted) {
      handleAbort()
      return
    }
    deadline = setTimeout(() => {
      req?.destroy()
      finish(false)
    }, 800)
    req.end()
  })
}

async function probeConfiguredBackend(
  backend: LocalBackend,
  signal?: AbortSignal,
): Promise<boolean> {
  for (const probe of backend.probes) {
    if (signal?.aborted) return false
    if (await probeBackend(backend.base, probe, signal)) return true
  }
  return false
}

async function findLiveBackend(signal?: AbortSignal): Promise<LocalBackend | null> {
  return findFirstLiveLocalProxyBackend(
    LOCAL_BACKENDS,
    probeConfiguredBackend,
    signal,
  )
}

// Transform Anthropic messages request → OpenAI chat completions request
function anthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = []

  if (typeof body.system === 'string' && body.system) {
    messages.push({ role: 'system', content: body.system })
  }

  const incoming = body.messages ?? []
  if (!Array.isArray(incoming)) {
    throw new Error('Messages must be an array')
  }
  for (const rawMessage of incoming) {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
      throw new Error('Each message must be an object')
    }
    const m = rawMessage as { role?: unknown; content?: unknown }
    const role = assertForwardableLocalProxyRole(m.role)
    let text = ''
    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      // content blocks — extract text parts
      text = m.content
        .filter((block): block is { type: 'text'; text?: unknown } => (
          Boolean(block)
          && typeof block === 'object'
          && !Array.isArray(block)
          && (block as { type?: unknown }).type === 'text'
        ))
        .map(block => typeof block.text === 'string' ? block.text : '')
        .join('')
    } else {
      throw new Error('Message content must be text or content blocks')
    }
    messages.push({ role, content: text })
  }

  return {
    model: body.model ?? 'default',
    messages,
    max_tokens: body.max_tokens ?? 4096,
    temperature: body.temperature ?? 1,
    stream: body.stream ?? false,
    stop: body.stop_sequences ?? undefined,
  }
}

// Transform an OpenAI-compatible body → Ollama format
function openAIToOllama(openai: Record<string, unknown>): Record<string, unknown> {
  return {
    model: openai.model,
    messages: openai.messages,
    stream: openai.stream,
    options: { temperature: openai.temperature },
  }
}

function bufferBody(res: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new BoundedProxyBody(maxBytes, 'backend-body')
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (error !== undefined) reject(error)
      else resolve(body.toString())
    }
    res.on('data', (chunk: Buffer) => {
      if (settled) return
      try {
        body.append(chunk)
      } catch (error) {
        finish(error)
        res.destroy(error instanceof Error ? error : undefined)
      }
    })
    res.on('end', () => finish())
    res.on('aborted', () => finish(new Error('Backend response aborted')))
    res.on('error', error => finish(error))
    res.on('close', () => {
      if (!res.complete) finish(new Error('Backend response closed before completion'))
    })
  })
}

// Forward a proxied request and pipe back the response
function forwardRequest(
  backendBase: string,
  backendPath: string,
  outgoingBody: string,
  stream: boolean,
  clientRes: http.ServerResponse,
  onDone: (ok: boolean) => void,
): void {
  const url = new URL(backendBase)
  const options: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || 80,
    path: backendPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(outgoingBody),
    },
    timeout: 120_000,
  }

  const lifecycle = new OneShotProxyLifecycle()
  const backpressure = new ProxyBackpressureGate()
  let backendReq: http.ClientRequest | null = null
  let backendRes: http.IncomingMessage | null = null
  let flushPendingLines: (() => void) | null = null
  let handleDrain = (): void => {}

  const settle = (ok: boolean, endClient = false): boolean => {
    if (!lifecycle.finish()) return false
    backpressure.finish()
    clientRes.removeListener('drain', handleDrain)
    if (endClient && !clientRes.writableEnded && !clientRes.destroyed) {
      clientRes.end()
    }
    if (backendRes && !backendRes.destroyed) backendRes.destroy()
    if (backendReq && !backendReq.destroyed) backendReq.destroy()
    onDone(ok)
    return true
  }

  const writeClient = (value: string): boolean => {
    if (backpressure.isBlocked || clientRes.writableEnded || clientRes.destroyed) return false
    let wrote = false
    lifecycle.runIfActive(() => {
      wrote = clientRes.write(value)
    })
    if (!wrote && lifecycle.active) {
      const newlyBlocked = backpressure.block(() => backendRes?.pause())
      if (newlyBlocked) clientRes.once('drain', handleDrain)
    }
    return wrote
  }

  handleDrain = (): void => {
    if (!lifecycle.active || !backpressure.release()) return
    flushPendingLines?.()
    if (lifecycle.active && !backpressure.isBlocked) backendRes?.resume()
  }

  const fail = (message: string): void => {
    if (!lifecycle.active) return
    if (clientRes.headersSent) {
      if (stream) {
        const errorFrame = `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message },
        })}\n\n`
        reportManagedProxyStreamFailure(message, {
          backpressureBlocked: backpressure.isBlocked,
          writeError: () => writeClient(errorFrame),
          finishGracefully: () => { settle(false, true) },
          destroyTransport: error => {
            settle(false)
            clientRes.destroy(error)
          },
        })
        return
      }
      settle(false)
      clientRes.destroy(new Error(message))
      return
    }
    const responseBody = JSON.stringify({
      error: { type: 'api_error', message },
    })
    clientRes.writeHead(502, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(responseBody),
      Connection: 'close',
    })
    clientRes.end(responseBody)
    settle(false)
  }

  const streamStopEvents = (
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`
    + `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`
    + `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  )

  backendReq = createGuardedLocalProxyBackendRequest(options, {
    onResponse: response => {
      backendRes = response
      if (!lifecycle.active) {
        response.destroy()
        return
      }

      if (response.statusCode !== undefined && response.statusCode >= 400) {
        void bufferBody(response, MANAGED_LOCAL_PROXY_LIMITS.backendBodyBytes)
          .then(() => fail(`Backend returned HTTP ${response.statusCode}`))
          .catch(() => fail('Backend error response exceeded the limit'))
        return
      }

      if (stream) {
      const decoder = new BoundedProxyLineDecoder(
        MANAGED_LOCAL_PROXY_LIMITS.streamLineBytes,
        MANAGED_LOCAL_PROXY_LIMITS.streamAggregateBytes,
      )

      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      const msgId = `msg_${Date.now().toString(36)}`
      writeClient(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: '', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
      })}\n\n`
        + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)

      const pendingLines = new BoundedProxyLineQueue(
        MANAGED_LOCAL_PROXY_LIMITS.streamBackpressureBytes,
      )
      let backendEnded = false

      const processLine = (line: string): boolean => {
        if (!lifecycle.active) return false
        const trimmed = line.trim()
        if (!trimmed) return true
        const dataPart = trimmed.startsWith('data:')
          ? trimmed.slice(5).trimStart()
          : trimmed
        if (dataPart === '[DONE]') {
          writeClient(streamStopEvents)
          settle(true, true)
          return false
        }

        let parsed: BackendChatPayload
        try {
          parsed = JSON.parse(dataPart) as BackendChatPayload
        } catch {
          return true
        }

        const candidate = parsed.message?.content
          ?? parsed.choices?.[0]?.delta?.content
        const done = parsed.done === true
          || parsed.choices?.[0]?.finish_reason != null
        let output = ''
        if (typeof candidate === 'string' && candidate) {
          output += `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: candidate },
          })}\n\n`
        }
        if (done) output += streamStopEvents
        const ready = !output || writeClient(output)
        if (done) {
          settle(true, true)
          return false
        }
        return ready
      }

      const queueLines = (lines: string[], startIndex: number): boolean => {
        try {
          for (let index = startIndex; index < lines.length; index += 1) {
            pendingLines.append(lines[index])
          }
          return true
        } catch {
          fail('Client consumed the proxy stream too slowly')
          return false
        }
      }

      const processLines = (lines: string[], startIndex = 0): void => {
        for (let index = startIndex; index < lines.length; index += 1) {
          if (!lifecycle.active) return
          if (backpressure.isBlocked) {
            queueLines(lines, index)
            return
          }
          if (!processLine(lines[index])) {
            if (lifecycle.active) queueLines(lines, index + 1)
            return
          }
        }
      }

      flushPendingLines = (): void => {
        if (!lifecycle.active) return
        const lines = pendingLines.drain()
        processLines(lines)
        if (backendEnded
          && lifecycle.active
          && !backpressure.isBlocked
          && pendingLines.length === 0) {
          fail('Backend stream ended before a terminal event')
        }
      }

      response.on('data', (chunk: Buffer) => {
        if (!lifecycle.active) return
        try {
          processLines(decoder.push(chunk))
        } catch (error) {
          fail(error instanceof LocalProxyLimitError
            ? 'Backend stream exceeded the managed proxy limit'
            : 'Backend stream error')
        }
      })

      response.on('end', () => {
        if (!lifecycle.active) return
        backendEnded = true
        try {
          const finalLine = decoder.flush()
          if (finalLine !== null) processLines([finalLine])
        } catch (error) {
          fail(error instanceof LocalProxyLimitError
            ? 'Backend stream exceeded the managed proxy limit'
            : 'Backend stream error')
          return
        }
        if (lifecycle.active
          && !backpressure.isBlocked
          && pendingLines.length === 0) {
          fail('Backend stream ended before a terminal event')
        }
      })

      response.on('aborted', () => fail('Backend stream aborted'))
      response.on('error', () => fail('Backend stream error'))
      response.on('close', () => {
        if (!response.complete) fail('Backend stream closed before completion')
      })
      if (backpressure.isBlocked) response.pause()
        return
      }

      void bufferBody(response, MANAGED_LOCAL_PROXY_LIMITS.backendBodyBytes)
        .then(raw => {
          if (!lifecycle.active) return
          let parsed: BackendChatPayload
          try {
            parsed = JSON.parse(raw) as BackendChatPayload
          } catch {
            fail('Backend parse error')
            return
          }

          let text = ''
          if (typeof parsed.message?.content === 'string') {
            text = parsed.message.content
          } else if (typeof parsed.choices?.[0]?.message?.content === 'string') {
            text = parsed.choices[0].message.content
          }
          const anthropicResponse = {
            id: `msg_${Date.now().toString(36)}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            model: typeof parsed.model === 'string' ? parsed.model : '',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
          const responseBody = JSON.stringify(anthropicResponse)
          clientRes.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(responseBody),
          })
          clientRes.end(responseBody)
          settle(true)
        })
        .catch(error => {
          fail(error instanceof LocalProxyLimitError
            ? 'Backend response exceeded the managed proxy limit'
            : 'Backend error')
        })
    },
    onFailure: fail,
  })

  clientRes.once('close', () => settle(false))
  clientRes.once('error', () => settle(false))
  backendReq.end(outgoingBody)
}

function createProxyServer(
  _port: number,
  token: string,
  isCurrentServer: () => boolean,
): http.Server {
  const server = http.createServer(async (req, clientRes) => {
    if (!isCurrentServer()) {
      clientRes.destroy()
      return
    }
    // CORS preflight — this server is loopback-only and called from the main
    // process (Node http.request) or via Electron IPC; no browser cross-origin
    // fetch should be reaching it.  Reject preflight requests outright rather
    // than advertising a wildcard origin that any local web page could exploit.
    if (req.method === 'OPTIONS') {
      clientRes.writeHead(405)
      clientRes.end()
      return
    }

    // Health check — no auth required (no sensitive data exposed)
    if (req.method === 'GET' && req.url === '/health') {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ status: 'ok', uptime: stats.startedAt ? Date.now() - stats.startedAt : 0 }))
      return
    }

    // Bearer token auth — prevent any local process from using the proxy
    // without presenting the per-session token.
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      clientRes.writeHead(401, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Missing or invalid bearer token' } }))
      return
    }

    // Only handle messages endpoint
    if (req.method !== 'POST' || req.url !== '/v1/messages') {
      clientRes.writeHead(404, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'not_found', message: 'Only /v1/messages is proxied' } }))
      return
    }

    const clientAbort = new AbortController()
    const abortClientWork = (): void => { clientAbort.abort() }
    req.once('aborted', abortClientWork)
    req.once('close', () => {
      if (!req.complete) abortClientWork()
    })
    clientRes.once('close', () => {
      if (!clientRes.writableEnded) abortClientWork()
    })
    const clientCanContinue = (): boolean => localProxyClientCanContinue(
      clientAbort.signal,
      clientRes.destroyed,
      clientRes.writableEnded,
    ) && isCurrentServer()

    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength)
      && declaredLength > MANAGED_LOCAL_PROXY_LIMITS.requestBodyBytes) {
      req.resume()
      clientRes.writeHead(413, {
        'Content-Type': 'application/json',
        Connection: 'close',
      })
      clientRes.end(JSON.stringify({
        error: { type: 'invalid_request_error', message: 'Request body exceeds the managed proxy limit' },
      }))
      return
    }

    const requestBody = new BoundedProxyBody(
      MANAGED_LOCAL_PROXY_LIMITS.requestBodyBytes,
      'request-body',
    )
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        requestBody.append(chunk)
      }
    } catch (error) {
      if (!clientRes.headersSent && !clientRes.destroyed) {
        const tooLarge = error instanceof LocalProxyLimitError
          && error.kind === 'request-body'
        clientRes.writeHead(tooLarge ? 413 : 400, {
          'Content-Type': 'application/json',
          Connection: 'close',
        })
        clientRes.end(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: tooLarge
              ? 'Request body exceeds the managed proxy limit'
              : 'Failed to read request body',
          },
        }))
      }
      return
    }
    if (!clientCanContinue()) return

    let body: Record<string, unknown>
    try {
      const parsed = JSON.parse(requestBody.toString()) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Request body must be an object')
      }
      body = parsed as Record<string, unknown>
    } catch {
      if (!clientCanContinue()) return
      clientRes.writeHead(400, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }))
      return
    }

    let openaiBody: Record<string, unknown>
    try {
      openaiBody = anthropicToOpenAI(body)
    } catch (error) {
      if (!clientCanContinue()) return
      clientRes.writeHead(400, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: error instanceof Error ? error.message : 'Invalid messages',
        },
      }))
      return
    }

    const backend = await findLiveBackend(clientAbort.signal)
    if (!clientCanContinue()) return
    if (!backend) {
      clientRes.writeHead(503, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'api_error', message: 'No local backend found. Start Ollama, LM Studio, or llama.cpp first.' } }))
      stats.requestsFailed++
      return
    }

    const stream = body.stream === true
    let outgoingBody: string
    if (backend.format === 'ollama') {
      outgoingBody = JSON.stringify(openAIToOllama(openaiBody))
    } else {
      outgoingBody = JSON.stringify(openaiBody)
    }
    if (!clientCanContinue()) return

    const connId = `conn_${++connCounter}`
    const conn: ConnectionRecord = {
      id: connId,
      remoteAddr: req.socket.remoteAddress ?? 'unknown',
      model: String(body.model ?? 'unknown'),
      backend: backend.name,
      startedAt: Date.now(),
      requestCount: 1,
    }
    stats.activeConnections.push(conn)

    forwardRequest(backend.base, backend.chatPath, outgoingBody, stream, clientRes, ok => {
      if (!isCurrentServer()) return
      if (ok) stats.requestsServed++
      else stats.requestsFailed++
      stats.activeConnections = stats.activeConnections.filter(c => c.id !== connId)
      bus.publish({ channel: 'localProxy:stats', type: 'data', source: 'localProxy', payload: { action: 'update', ...stats } })
    })
  })

  return server
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => { tester.close(); resolve(true) })
    tester.listen(port, '127.0.0.1')
  })
}

export function getProxyStatus(): { running: boolean; port: number; token: string | null; stats: ProxyStats } {
  const settings = readSettingsSync()
  const runtime = proxyRuntimeOwner.current
  const running = runtime?.state === 'running'
    && runtime.port !== null
    && resolveManagedLocalProxyPort(runtime.port) !== null
    && runtime.server.listening
  return {
    running,
    port: resolveReportedManagedLocalProxyPort(
      running ? runtime.port : null,
      settings.localProxyPort,
    ),
    token: running ? runtime.token : null,
    stats: { ...stats, activeConnections: [...stats.activeConnections] },
  }
}

function closeProxyServerImmediately(
  server: http.Server,
  onClosed: () => void = () => undefined,
): void {
  try {
    server.close(() => onClosed())
  } catch {
    onClosed()
  }
  try { server.closeAllConnections() } catch { /* already closed */ }
}

async function startProxyServerUnlocked(
  port: number,
  lifecycleEpoch: number,
): Promise<{ ok: boolean; port?: number; message?: string }> {
  if (!proxyLifecycleEpoch.isCurrent(lifecycleEpoch)) {
    return { ok: false, message: 'Proxy startup was superseded' }
  }
  const current = proxyRuntimeOwner.current
  if (current) {
    if (current.state === 'running' && current.port === port && current.server.listening) {
      return { ok: true, port }
    }
    return { ok: false, message: `Proxy already running on port ${current.port ?? 'unknown'}` }
  }

  const free = await isPortFree(port)
  if (!proxyLifecycleEpoch.isCurrent(lifecycleEpoch)) {
    return { ok: false, message: 'Proxy startup was superseded' }
  }
  if (!free) {
    return { ok: false, message: `Port ${port} is already in use` }
  }

  return new Promise(resolve => {
    const startup = new OneShotProxyLifecycle()
    let claimedLease: ProxyResourceLease<ProxyRuntime> | null = null
    let startupDeadline: NodeJS.Timeout | null = null
    const finish = (result: { ok: boolean; port?: number; message?: string }): void => {
      if (!startup.finish()) return
      if (startupDeadline) clearTimeout(startupDeadline)
      const runtime = claimedLease?.value
      if (runtime) runtime.cancelStartup = null
      resolve(result)
    }
    try {
      const token = randomUUID()
      let runtime: ProxyRuntime | null = null
      const server = createProxyServer(
        port,
        token,
        () => proxyRuntimeOwner.current === runtime,
      )
      runtime = {
        server,
        port: null,
        token,
        state: 'starting',
        cancelStartup: null,
      }
      const lease = proxyRuntimeOwner.claim(runtime)
      claimedLease = lease
      runtime.cancelStartup = (reason: string): void => {
        proxyRuntimeOwner.release(lease)
        closeProxyServerImmediately(server)
        finish({ ok: false, message: reason })
      }
      startupDeadline = setTimeout(() => {
        runtime?.cancelStartup?.('Proxy startup timed out')
      }, 2_000)
      startupDeadline.unref?.()

      server.on('error', (err: NodeJS.ErrnoException) => {
        const wasCurrent = proxyRuntimeOwner.release(lease)
        if (wasCurrent) {
          stats = { ...stats, startedAt: null, activeConnections: [] }
          bus.publish({ channel: 'localProxy:stats', type: 'data', source: 'localProxy', payload: { action: 'stopped' } })
        }
        closeProxyServerImmediately(server)
        finish({ ok: false, message: err.message })
      })
      server.listen(port, '127.0.0.1', () => {
        if (
          !proxyRuntimeOwner.owns(lease)
          || !proxyLifecycleEpoch.isCurrent(lifecycleEpoch)
        ) {
          proxyRuntimeOwner.release(lease)
          closeProxyServerImmediately(server)
          finish({ ok: false, message: 'Proxy startup was superseded' })
          return
        }
        runtime.port = port
        runtime.state = 'running'
        stats = { requestsServed: 0, requestsFailed: 0, startedAt: Date.now(), activeConnections: [] }
        bus.publish({ channel: 'localProxy:stats', type: 'data', source: 'localProxy', payload: { action: 'started', port } })
        finish({ ok: true, port })
      })
    } catch (err: unknown) {
      if (claimedLease) proxyRuntimeOwner.release(claimedLease)
      finish({ ok: false, message: String(err) })
    }
  })
}

export async function ensureLocalProxyRunning(portOverride?: number): Promise<{ ok: boolean; port?: number; message?: string }> {
  const settings = readSettingsSync()
  const configuredPort = portOverride
    ?? settings.localProxyPort
    ?? DEFAULT_MANAGED_LOCAL_PROXY_PORT
  const port = resolveManagedLocalProxyPort(configuredPort)
  if (port === null) {
    return {
      ok: false,
      message: MANAGED_LOCAL_PROXY_PORT_ERROR,
    }
  }
  const lifecycleEpoch = proxyLifecycleEpoch.capture()
  return proxyLifecycleLane.run(() => startProxyServerUnlocked(port, lifecycleEpoch))
}

async function stopProxyServer(): Promise<{ ok: boolean; message?: string }> {
  proxyLifecycleEpoch.invalidate()
  const lease = proxyRuntimeOwner.currentLease
  if (!lease) {
    // A start may still be probing the port before it has a server to claim.
    // The epoch invalidation above makes that start fail before listen(); do
    // not wait behind the probe just to report that no listener exists.
    return { ok: true, message: 'Not running' }
  }

  // Revoke immediately, before waiting for the serialized startup lane. This
  // makes the one-second stop bound cover the caller's whole shutdown wait and
  // prevents a half-started listener from being reported as running.
  const closed = new Promise<void>(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try { lease.value.server.closeAllConnections() } catch { /* already closed */ }
      finish()
    }, 1_000)
    timer.unref?.()

    const revoked = revokeManagedProxyResource(proxyRuntimeOwner, lease, runtime => {
      stats = { ...stats, startedAt: null, activeConnections: [] }
      bus.publish({ channel: 'localProxy:stats', type: 'data', source: 'localProxy', payload: { action: 'stopped' } })
      const cancelStartup = runtime.cancelStartup
      if (cancelStartup) {
        cancelStartup('Proxy startup was stopped')
        finish()
        return
      }
      closeProxyServerImmediately(runtime.server, finish)
    })
    if (!revoked) finish()
  })

  return proxyLifecycleLane.run(async () => {
    await closed
    return { ok: true }
  })
}

export function registerLocalProxyIPC(): void {
  ipcMain.handle('localProxy:start', async () => {
    return ensureLocalProxyRunning()
  })

  ipcMain.handle('localProxy:stop', () => stopProxyServer())

  ipcMain.handle('localProxy:getStatus', () => {
    const status = getProxyStatus()
    return {
      running: status.running,
      port: status.port,
      stats: status.stats,
    }
  })

  ipcMain.handle('localProxy:probeBackends', async () => {
    const results = await Promise.all(
      LOCAL_BACKENDS.map(async b => ({
        name: b.name,
        base: b.base,
        live: await probeConfiguredBackend(b),
      }))
    )
    return results
  })
}
