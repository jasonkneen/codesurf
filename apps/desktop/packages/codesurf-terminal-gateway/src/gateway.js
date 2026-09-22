import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

import { bearerMatchesTenant, normalizeGatewayConfig, normalizeOrigin } from './config.js'
import { createConfiguredAdapter } from './adapters.js'
import { removeRuntimeConfig, writeRuntimeConfig } from './runtime-config.js'
import { TerminalLaunchContractError, validateTerminalLaunch } from './launch-contract.js'

const SESSION_PATH = '/v1/terminal/sessions'
const ATTACH_PATH = '/v1/terminal/attach'
const ATTACH_TOKEN_BYTES = 32

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer)
}

function schedule(delay, callback) {
  const timer = setTimeout(callback, delay)
  timer.unref?.()
  return timer
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest()
}

function attachmentTokenMatches(session, token) {
  if (!session.attachTokenHash || typeof token !== 'string') return false
  const candidate = tokenHash(token)
  return candidate.length === session.attachTokenHash.length && timingSafeEqual(candidate, session.attachTokenHash)
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function responseJson(response, status, payload, origin) {
  const body = JSON.stringify(payload)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers.vary = 'Origin'
  }
  response.writeHead(status, headers)
  response.end(body)
}

function responseError(response, error, origin) {
  const status = error instanceof HttpError ? error.status : 500
  const code = error instanceof HttpError ? error.code : 'internal_error'
  const message = error instanceof HttpError ? error.message : 'terminal gateway failed to process the request'
  responseJson(response, status, { error: { code, message } }, origin)
}

function parseAuthorization(value) {
  if (typeof value !== 'string') return null
  const match = /^Bearer ([^\s,]+)$/.exec(value)
  return match?.[1] || null
}

function getRequestOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string') return null
  try {
    return normalizeOrigin(origin)
  } catch {
    return null
  }
}

async function parseJsonBody(request, limit) {
  const declared = request.headers['content-length']
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new HttpError(413, 'body_too_large', 'request body exceeds the configured size limit')
  }
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > limit) throw new HttpError(413, 'body_too_large', 'request body exceeds the configured size limit')
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    return parsed
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be a JSON object')
  }
}

function validateInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'invalid_request', `${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function validateSessionRequest(body, limits) {
  const allowed = new Set(['cwd', 'workspaceId', 'cols', 'rows', 'launchBin', 'launchArgs'])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new HttpError(400, 'invalid_request', `unsupported terminal session field: ${key}`)
  }
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || body.cwd.length === 0 || body.cwd.length > 4_096)) {
    throw new HttpError(400, 'invalid_request', 'cwd must be a non-empty path string up to 4096 characters')
  }
  if (body.workspaceId !== undefined && (typeof body.workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.workspaceId))) {
    throw new HttpError(400, 'invalid_request', 'workspaceId must be a CodeSurf workspace identifier')
  }
  let launch
  try {
    launch = validateTerminalLaunch(body.launchBin, body.launchArgs)
  } catch (error) {
    if (error instanceof TerminalLaunchContractError) {
      throw new HttpError(400, 'invalid_request', error.message)
    }
    throw error
  }
  return {
    cwd: body.cwd,
    workspaceId: body.workspaceId,
    cols: validateInteger(body.cols, 'cols', limits.minCols, limits.maxCols),
    rows: validateInteger(body.rows, 'rows', limits.minRows, limits.maxRows),
    ...launch,
  }
}

function* splitUtf8(value, maxBytes) {
  if (byteLength(value) <= maxBytes) {
    yield value
    return
  }
  let chunk = ''
  let chunkBytes = 0
  for (const character of value) {
    const characterBytes = byteLength(character)
    if (chunk && chunkBytes + characterBytes > maxBytes) {
      yield chunk
      chunk = ''
      chunkBytes = 0
    }
    if (characterBytes > maxBytes) continue
    chunk += character
    chunkBytes += characterBytes
  }
  if (chunk) yield chunk
}

function closeWebSocket(socket, code = 1000, reason = '') {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.close(code, reason.slice(0, 120))
    } catch {
      socket.terminate()
    }
  }
}

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`)
  socket.destroy()
}

function makeEndpoint(address) {
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `http://${host}:${address.port}`
}

function toWebSocketBase(httpBase) {
  const url = new URL(httpBase)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

function messageError(socket, code, message, closeCode = 1008) {
  if (socket.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({ type: 'error', code, message })
    try { socket.send(payload) } catch {}
  }
  closeWebSocket(socket, closeCode, code)
}

export class TerminalGateway {
  constructor({ config, adapter } = {}) {
    this.config = normalizeGatewayConfig(config)
    this.adapter = adapter || createConfiguredAdapter(this.config)
    this.sessions = new Map()
    this.server = null
    this.wsServer = null
    this.endpoint = null
    this.closed = false
    this.runtimeConfigWritten = false
  }

  async listen() {
    if (this.server) throw new Error('terminal gateway is already listening')
    await this.#canonicalizeTenantPaths()
    this.server = createServer(this.#handleRequest.bind(this))
    this.wsServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: this.config.limits.messageBytes,
      perMessageDeflate: false,
    })
    this.server.on('upgrade', this.#handleUpgrade.bind(this))
    this.server.on('clientError', (_error, socket) => socket.destroy())

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server?.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.config.port, this.config.bindHost)
    })
    this.endpoint = makeEndpoint(this.server.address())

    if (this.config.runtimeConfigPath) {
      if (!this.config.runtimeToken) {
        await this.close()
        throw new Error('CODESURF_TERMINAL_RUNTIME_CONFIG_PATH requires CODESURF_TERMINAL_TOKEN or exactly one tenant')
      }
      await writeRuntimeConfig(this.config.runtimeConfigPath, {
        endpoint: this.endpoint,
        token: this.config.runtimeToken,
      })
      this.runtimeConfigWritten = true
    }
    return this.endpoint
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const session of [...this.sessions.values()]) {
      this.#finishSession(session, { exitCode: null, signal: null, reason: 'gateway_shutdown' }, { notify: true, terminate: true })
    }
    if (this.wsServer) this.wsServer.close()
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()))
    }
    if (this.runtimeConfigWritten && this.config.runtimeConfigPath) {
      await removeRuntimeConfig(this.config.runtimeConfigPath).catch(() => {})
    }
  }

  getSnapshot() {
    return {
      endpoint: this.endpoint,
      sessions: this.sessions.size,
      adapter: this.config.adapter.type,
    }
  }

  async #canonicalizeTenantPaths() {
    for (const tenant of this.config.tenants) {
      tenant.roots = await Promise.all(tenant.roots.map((root) => this.#resolveDirectory(root, `tenant ${tenant.id} root`)))
      tenant.workspaces = Object.fromEntries(await Promise.all(Object.entries(tenant.workspaces).map(async ([id, workspace]) => {
        const resolved = await this.#resolveDirectory(workspace, `tenant ${tenant.id} workspace ${id}`)
        if (!tenant.roots.some((root) => isWithin(root, resolved))) {
          throw new Error(`tenant ${tenant.id} workspace ${id} must be contained by a configured root`)
        }
        return [id, resolved]
      })))
    }
  }

  async #resolveDirectory(candidate, description) {
    let resolved
    try {
      resolved = await realpath(candidate)
      const metadata = await stat(resolved)
      if (!metadata.isDirectory()) throw new Error('not a directory')
    } catch {
      throw new Error(`${description} must resolve to an existing directory`)
    }
    return resolved
  }

  #findTenant(bearer) {
    let matched = null
    for (const tenant of this.config.tenants) {
      const isMatch = bearerMatchesTenant(tenant, bearer)
      if (isMatch) matched = tenant
    }
    return matched
  }

  #originAllowedForTenant(origin, tenant) {
    return Boolean(origin && tenant.allowedOrigins.has(origin))
  }

  #originAllowedGlobally(origin) {
    return Boolean(origin && this.config.allowedOrigins.includes(origin))
  }

  async #handleRequest(request, response) {
    const url = new URL(request.url || '/', 'http://localhost')
    const origin = getRequestOrigin(request)

    if (request.method === 'OPTIONS' && url.pathname === SESSION_PATH) {
      if (!this.#originAllowedGlobally(origin)) {
        responseError(response, new HttpError(403, 'forbidden_origin', 'origin is not allowed'))
        return
      }
      response.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
        'cache-control': 'no-store',
      })
      response.end()
      return
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      responseJson(response, 200, { ok: true }, origin && this.#originAllowedGlobally(origin) ? origin : undefined)
      return
    }

    if (request.method !== 'POST' || url.pathname !== SESSION_PATH || url.search) {
      responseError(response, new HttpError(404, 'not_found', 'route not found'))
      return
    }

    try {
      if (!this.#originAllowedGlobally(origin)) {
        throw new HttpError(403, 'forbidden_origin', 'origin is not allowed')
      }
      if (!/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) {
        throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json')
      }
      const bearer = parseAuthorization(request.headers.authorization)
      const tenant = bearer ? this.#findTenant(bearer) : null
      if (!tenant) throw new HttpError(401, 'unauthorized', 'a valid bearer token is required')
      if (!this.#originAllowedForTenant(origin, tenant)) {
        throw new HttpError(403, 'forbidden_origin', 'origin is not allowed for this tenant')
      }
      const body = validateSessionRequest(await parseJsonBody(request, this.config.limits.bodyBytes), this.config.limits)
      const target = await this.#resolveSessionTarget(tenant, body)
      this.#assertSessionCapacity(tenant.id)
      const created = this.#createSession(tenant, target, body)
      responseJson(response, 201, {
        sessionId: created.id,
        attachToken: created.attachToken,
        websocketUrl: this.#websocketUrl(request),
      }, origin)
    } catch (error) {
      responseError(response, error, origin && this.#originAllowedGlobally(origin) ? origin : undefined)
    }
  }

  async #resolveSessionTarget(tenant, request) {
    // CodeSurf workspace IDs are dynamic UI metadata. Only an ID explicitly
    // mapped by the tenant narrows the scope; an unknown ID still has to pass
    // the tenant-root check for cwd and is never trusted as a filesystem path.
    const workspaceRoot = request.workspaceId ? tenant.workspaces[request.workspaceId] : null
    const base = workspaceRoot || tenant.roots[0]
    const requested = request.cwd === undefined ? base : path.isAbsolute(request.cwd) ? request.cwd : path.resolve(base, request.cwd)
    let cwd
    try {
      cwd = await this.#resolveDirectory(requested, 'cwd')
    } catch {
      throw new HttpError(400, 'invalid_cwd', 'cwd must resolve to an existing permitted directory')
    }
    if (workspaceRoot && !isWithin(workspaceRoot, cwd)) {
      throw new HttpError(403, 'cwd_not_allowed', 'cwd is outside the selected workspace')
    }
    const mountRoot = workspaceRoot || tenant.roots.find((root) => isWithin(root, cwd))
    if (!mountRoot) {
      throw new HttpError(403, 'cwd_not_allowed', 'cwd is outside this tenant\'s permitted filesystem roots')
    }
    return { cwd, mountRoot, workspaceId: request.workspaceId || null }
  }

  #assertSessionCapacity(tenantId) {
    if (this.sessions.size >= this.config.limits.maxSessions) {
      throw new HttpError(429, 'session_limit_reached', 'terminal session capacity is exhausted')
    }
    let tenantSessions = 0
    for (const session of this.sessions.values()) if (session.tenant.id === tenantId) tenantSessions += 1
    if (tenantSessions >= this.config.limits.maxSessionsPerTenant) {
      throw new HttpError(429, 'tenant_session_limit_reached', 'tenant terminal session capacity is exhausted')
    }
  }

  #createSession(tenant, target, request) {
    const attachToken = randomBytes(ATTACH_TOKEN_BYTES).toString('base64url')
    const session = {
      id: randomUUID(),
      tenant,
      cwd: target.cwd,
      mountRoot: target.mountRoot,
      workspaceId: target.workspaceId,
      cols: request.cols,
      rows: request.rows,
      launchBin: request.launchBin,
      launchArgs: request.launchArgs,
      attachTokenHash: tokenHash(attachToken),
      state: 'pending',
      terminal: null,
      socket: null,
      outputQueue: [],
      outputQueueBytes: 0,
      outputTimer: null,
      attachTimer: null,
      expiryTimer: null,
      closeTimer: null,
      dataSubscription: null,
      exitSubscription: null,
      readySent: false,
      earlyExit: null,
      pendingExit: null,
      closeReason: null,
      exitSent: false,
      ended: false,
    }
    session.attachTimer = schedule(this.config.limits.attachTtlMs, () => {
      this.#finishSession(session, { exitCode: null, signal: null, reason: 'attach_expired' }, { notify: false, terminate: true })
    })
    session.expiryTimer = schedule(this.config.limits.sessionTtlMs, () => {
      this.#requestTerminalClose(session, 'session_expired')
    })
    this.sessions.set(session.id, session)
    return { ...session, attachToken }
  }

  #websocketUrl(request) {
    const base = this.config.publicUrl || `http://${request.headers.host || new URL(this.endpoint).host}`
    const url = toWebSocketBase(base)
    url.pathname = `${url.pathname.replace(/\/$/, '')}${ATTACH_PATH}`
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  #handleUpgrade(request, socket, head) {
    if (this.closed || !this.wsServer) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const url = new URL(request.url || '/', 'http://localhost')
    const origin = getRequestOrigin(request)
    if (url.pathname !== ATTACH_PATH || url.search) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    if (!this.#originAllowedGlobally(origin)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
      this.#handleSocket(websocket, origin)
    })
  }

  #handleSocket(socket, origin) {
    let session = null
    let processing = Promise.resolve()
    const attachTimer = schedule(this.config.limits.attachTtlMs, () => {
      if (!session) messageError(socket, 'attach_timeout', 'attach message was not received before timeout')
    })

    socket.on('message', (raw, isBinary) => {
      processing = processing.then(async () => {
        if (isBinary) {
          messageError(socket, 'protocol_error', 'binary websocket messages are not supported')
          return
        }
        if (byteLength(String(raw)) > this.config.limits.messageBytes) {
          messageError(socket, 'message_too_large', 'websocket message exceeds the configured size limit', 1009)
          return
        }
        let message
        try {
          message = JSON.parse(String(raw))
        } catch {
          messageError(socket, 'invalid_json', 'websocket message must be JSON')
          return
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          messageError(socket, 'protocol_error', 'websocket message must be an object')
          return
        }
        if (!session) {
          session = await this.#attach(socket, origin, message)
          if (session) clearTimer(attachTimer)
          return
        }
        this.#handleTerminalMessage(session, socket, message)
      }).catch(() => {
        messageError(socket, 'gateway_error', 'terminal gateway could not process websocket message', 1011)
      })
    })

    socket.on('close', () => {
      clearTimer(attachTimer)
      if (session) this.#finishSession(session, { exitCode: null, signal: null, reason: 'socket_closed' }, { notify: false, terminate: true })
    })
    socket.on('error', () => {})
  }

  async #attach(socket, origin, message) {
    if (message.type !== 'attach' || typeof message.attachToken !== 'string' || Object.keys(message).some((key) => !['type', 'attachToken'].includes(key))) {
      messageError(socket, 'protocol_error', 'the first websocket message must be attach with attachToken')
      return null
    }
    const session = this.#findPendingSessionByAttachToken(message.attachToken)
    if (!session) {
      messageError(socket, 'invalid_attach', 'terminal session is unavailable')
      return null
    }
    if (!this.#originAllowedForTenant(origin, session.tenant)) {
      messageError(socket, 'forbidden_origin', 'origin is not allowed for this terminal session')
      return null
    }

    session.state = 'attaching'
    session.socket = socket
    clearTimer(session.attachTimer)
    try {
      const terminal = await this.adapter.spawn({
        tenantId: session.tenant.id,
        cwd: session.cwd,
        mountRoot: session.mountRoot,
        workspaceId: session.workspaceId,
        cols: session.cols,
        rows: session.rows,
        sessionId: session.id,
        launchBin: session.launchBin,
        launchArgs: session.launchArgs,
      })
      if (!terminal || typeof terminal.write !== 'function' || typeof terminal.resize !== 'function' || typeof terminal.kill !== 'function' || typeof terminal.onData !== 'function' || typeof terminal.onExit !== 'function') {
        throw new Error('terminal adapter returned an invalid PTY handle')
      }
      if (session.ended || socket.readyState !== WebSocket.OPEN) {
        try { terminal.kill() } catch {}
        return null
      }
      session.terminal = terminal
      session.dataSubscription = terminal.onData((data) => this.#queueOutput(session, data))
      session.exitSubscription = terminal.onExit((event) => {
        if (!session.readySent) {
          session.earlyExit = event
          return
        }
        this.#handlePtyExit(session, event)
      })
      session.state = 'active'
      if (!this.#sendJson(socket, { type: 'ready', sessionId: session.id, cols: session.cols, rows: session.rows })) {
        this.#finishSession(session, { exitCode: null, signal: null, reason: 'socket_write_failed' }, { notify: false, terminate: true })
        return null
      }
      session.readySent = true
      this.#flushOutput(session)
      if (session.earlyExit) this.#handlePtyExit(session, session.earlyExit)
      return session
    } catch {
      this.#finishSession(session, { exitCode: null, signal: null, reason: 'spawn_failed' }, { notify: false, terminate: false })
      messageError(socket, 'terminal_start_failed', 'terminal could not be started', 1011)
      return null
    }
  }

  #findPendingSessionByAttachToken(attachToken) {
    let matched = null
    // Session capacity is bounded. Compare every stored hash instead of using a
    // client-controlled session id, and only accept a still-pending session.
    for (const candidate of this.sessions.values()) {
      const isMatch = attachmentTokenMatches(candidate, attachToken)
      if (candidate.state === 'pending' && isMatch) matched = candidate
    }
    return matched
  }

  #handlePtyExit(session, event) {
    if (session.ended) return
    // An explicitly closed/backpressured session is being torn down; do not
    // prolong it trying to drain output. For a natural exit, however, drain
    // already-queued data before sending the terminal event and close frame.
    if (session.closeReason) {
      this.#finishSession(session, event, { notify: true, terminate: false })
      return
    }
    session.pendingExit = event
    this.#flushOutput(session)
  }

  #handleTerminalMessage(session, socket, message) {
    if (session.ended || session.socket !== socket || session.state !== 'active') return
    if (message.type === 'write') {
      if (Object.keys(message).some((key) => !['type', 'data'].includes(key)) || typeof message.data !== 'string') {
        messageError(socket, 'protocol_error', 'write requires a string data field')
        return
      }
      if (byteLength(message.data) > this.config.limits.inputBytes) {
        messageError(socket, 'input_too_large', 'write data exceeds the configured input limit', 1009)
        return
      }
      try {
        session.terminal.write(message.data)
      } catch {
        this.#requestTerminalClose(session, 'write_failed')
      }
      return
    }
    if (message.type === 'resize') {
      if (Object.keys(message).some((key) => !['type', 'cols', 'rows'].includes(key))) {
        messageError(socket, 'protocol_error', 'resize accepts only cols and rows')
        return
      }
      try {
        session.cols = validateInteger(message.cols, 'cols', this.config.limits.minCols, this.config.limits.maxCols)
        session.rows = validateInteger(message.rows, 'rows', this.config.limits.minRows, this.config.limits.maxRows)
        session.terminal.resize(session.cols, session.rows)
      } catch {
        messageError(socket, 'invalid_resize', 'resize dimensions are outside the configured limits')
      }
      return
    }
    if (message.type === 'close' && Object.keys(message).length === 1) {
      this.#requestTerminalClose(session, 'client_closed')
      return
    }
    messageError(socket, 'protocol_error', 'unsupported terminal websocket message')
  }

  #queueOutput(session, data) {
    if (session.ended || typeof data !== 'string') return
    // JSON can expand a terminal control byte to six ASCII bytes (for example
    // ESC becomes `\\u001b`), so keep well below the WebSocket payload limit.
    const maxChunkBytes = Math.max(128, Math.floor((this.config.limits.messageBytes - 128) / 6))
    for (const chunk of splitUtf8(data, maxChunkBytes)) {
      const bytes = byteLength(chunk)
      session.outputQueueBytes += bytes
      if (session.outputQueueBytes + (session.socket?.bufferedAmount || 0) > this.config.limits.outputBacklogBytes) {
        this.#requestTerminalClose(session, 'output_backpressure')
        return
      }
      session.outputQueue.push(chunk)
    }
    if (session.readySent) this.#flushOutput(session)
  }

  #flushOutput(session) {
    if (session.ended || !session.socket || session.socket.readyState !== WebSocket.OPEN) return
    const socket = session.socket
    while (session.outputQueue.length > 0 && socket.bufferedAmount <= this.config.limits.outboundHighWaterBytes) {
      const chunk = session.outputQueue.shift()
      session.outputQueueBytes -= byteLength(chunk)
      if (!this.#sendJson(socket, { type: 'data', data: chunk })) {
        this.#finishSession(session, { exitCode: null, signal: null, reason: 'socket_write_failed' }, { notify: false, terminate: true })
        return
      }
    }
    if (session.outputQueue.length > 0) {
      clearTimer(session.outputTimer)
      session.outputTimer = schedule(25, () => this.#flushOutput(session))
    } else if (session.pendingExit) {
      const exit = session.pendingExit
      session.pendingExit = null
      this.#finishSession(session, exit, { notify: true, terminate: false })
    }
  }

  #sendJson(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return false
    const payload = JSON.stringify(message)
    if (byteLength(payload) > this.config.limits.messageBytes) return false
    try {
      socket.send(payload)
      return true
    } catch {
      return false
    }
  }

  #requestTerminalClose(session, reason) {
    if (session.ended) return
    session.state = 'closing'
    session.closeReason = reason
    clearTimer(session.closeTimer)
    session.closeTimer = schedule(this.config.limits.closeGraceMs, () => {
      this.#finishSession(session, { exitCode: null, signal: null, reason }, { notify: true, terminate: true })
    })
    try {
      session.terminal?.kill()
    } catch {
      this.#finishSession(session, { exitCode: null, signal: null, reason }, { notify: true, terminate: false })
    }
  }

  #finishSession(session, event, { notify, terminate }) {
    if (session.ended) return
    session.ended = true
    session.state = 'ended'
    this.sessions.delete(session.id)
    clearTimer(session.attachTimer)
    clearTimer(session.expiryTimer)
    clearTimer(session.closeTimer)
    clearTimer(session.outputTimer)
    try { session.dataSubscription?.dispose?.() } catch {}
    try { session.exitSubscription?.dispose?.() } catch {}
    if (terminate) {
      try { session.terminal?.kill() } catch {}
    }
    if (notify && session.socket && !session.exitSent && session.socket.readyState === WebSocket.OPEN) {
      session.exitSent = true
      const exit = {
        type: 'exit',
        exitCode: Number.isInteger(event?.exitCode) ? event.exitCode : null,
        signal: Number.isInteger(event?.signal) ? event.signal : null,
      }
      if (event?.reason) exit.reason = event.reason
      this.#sendJson(session.socket, exit)
      closeWebSocket(session.socket, 1000, event?.reason || 'terminal exited')
    }
  }
}

export function createTerminalGateway(options) {
  return new TerminalGateway(options)
}
