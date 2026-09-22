/**
 * CodeSurf hosted sandbox ingress.
 *
 * This is deliberately not a general-purpose CORS proxy. It owns two private
 * loopback sidecars (web-host + terminal gateway), serves the built renderer,
 * and exposes only the renderer's fixed same-origin API surface. Browser
 * clients authenticate with an HttpOnly session cookie; private sidecar
 * credentials never leave this process.
 */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import {
  createReadStream,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect as connectTcp, isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_MAX_TERMINAL_BODY_BYTES = 64 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_STATIC_BYTES = 64 * 1024 * 1024
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const DEFAULT_WS_IDLE_MS = 30 * 60 * 1000
const DEFAULT_MAX_WS_CONNECTIONS = 128
const DEFAULT_LOGIN_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_LOGIN_ATTEMPTS = 12
const MAX_HEADER_BYTES = 16 * 1024

class HostedGatewayError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.name = 'HostedGatewayError'
    this.status = status
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseBoolean(value, name) {
  if (value === true || value === '1' || value === 'true') return true
  if (value === false || value === undefined || value === null || value === '' || value === '0' || value === 'false') return false
  throw new HostedGatewayError(`${name} must be true/false or 1/0`)
}

function parseInteger(value, name, { min, max, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new HostedGatewayError(`${name} is required`)
  }
  const parsed = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HostedGatewayError(`${name} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function normalizePublicOrigin(value) {
  const source = nonEmpty(value)
  if (!source) throw new HostedGatewayError('CODESURF_HOSTED_PUBLIC_ORIGIN is required')
  let url
  try {
    url = new URL(source)
  } catch {
    throw new HostedGatewayError('CODESURF_HOSTED_PUBLIC_ORIGIN must be an exact http(s) origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname && url.pathname !== '/')
  ) {
    throw new HostedGatewayError('CODESURF_HOSTED_PUBLIC_ORIGIN must be scheme, host, and optional port only')
  }
  return url.origin
}

function isLoopbackHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || host === '127.0.0.1'
    || (isIP(host) === 4 && host.startsWith('127.'))
}

function isLoopbackBind(host) {
  return isLoopbackHostname(host)
}

function isLoopbackAddress(address) {
  if (!address) return false
  const host = String(address).replace(/^::ffff:/, '')
  return isLoopbackHostname(host)
}

function assertPrivateLoopbackUrl(value, name) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new HostedGatewayError(`${name} must be a valid loopback http URL`)
  }
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new HostedGatewayError(`${name} must be a loopback http URL without credentials, query, or hash`)
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}

function assertSecret(value, name) {
  const secret = nonEmpty(value)
  if (!secret || secret.length < 16) throw new HostedGatewayError(`${name} must be at least 16 characters`)
  return secret
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

function directoryRealPath(value, name) {
  const source = nonEmpty(value)
  if (!source || !isAbsolute(source)) throw new HostedGatewayError(`${name} must be an absolute directory path`)
  let real
  try {
    real = realpathSync(source)
    if (!statSync(real).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new HostedGatewayError(`${name} must resolve to an existing directory`)
  }
  return real
}

function asPath(value, root) {
  const source = nonEmpty(value)
  if (!source) return null
  return isAbsolute(source) ? resolve(source) : resolve(root, source)
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

function redactEndpoint(value) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return '[invalid endpoint]'
  }
}

/**
 * Validate the public ingress contract. `upstreams` is intentionally accepted
 * only as a programmatic test seam; the executable always owns its sidecars.
 */
export function createHostedGatewayConfig(options = {}) {
  const env = options.env || process.env
  const root = resolve(options.root || ROOT)
  const publicOrigin = normalizePublicOrigin(options.publicOrigin || env.CODESURF_HOSTED_PUBLIC_ORIGIN)
  const publicUrl = new URL(publicOrigin)
  const bindHost = nonEmpty(options.bindHost || env.CODESURF_HOSTED_BIND) || '0.0.0.0'
  const port = parseInteger(options.port ?? env.CODESURF_HOSTED_PORT, 'CODESURF_HOSTED_PORT', {
    min: 1,
    max: 65_535,
    fallback: 8080,
  })
  const loopback = isLoopbackBind(bindHost)
  const allowLoopbackDev = parseBoolean(options.allowLoopbackDev ?? env.CODESURF_HOSTED_ALLOW_LOOPBACK_DEV, 'CODESURF_HOSTED_ALLOW_LOOPBACK_DEV')
  const accessToken = nonEmpty(options.accessToken ?? env.CODESURF_HOSTED_ACCESS_TOKEN)

  if (!loopback && publicUrl.protocol !== 'https:') {
    throw new HostedGatewayError('non-loopback hosted ingress requires an https CODESURF_HOSTED_PUBLIC_ORIGIN')
  }
  if (!loopback && !accessToken) {
    throw new HostedGatewayError('CODESURF_HOSTED_ACCESS_TOKEN is required when CODESURF_HOSTED_BIND is not loopback')
  }
  if (!accessToken && !(loopback && allowLoopbackDev)) {
    throw new HostedGatewayError('set CODESURF_HOSTED_ACCESS_TOKEN, or explicitly enable CODESURF_HOSTED_ALLOW_LOOPBACK_DEV=1 on a loopback listener')
  }
  if (allowLoopbackDev && !loopback) {
    throw new HostedGatewayError('CODESURF_HOSTED_ALLOW_LOOPBACK_DEV is valid only for a loopback listener')
  }
  if (allowLoopbackDev && !isLoopbackHostname(publicUrl.hostname)) {
    throw new HostedGatewayError('loopback development mode requires a loopback CODESURF_HOSTED_PUBLIC_ORIGIN')
  }
  if (accessToken) assertSecret(accessToken, 'CODESURF_HOSTED_ACCESS_TOKEN')

  const distDir = asPath(options.distDir || env.CODESURF_HOSTED_DIST_DIR || join(root, 'dist'), root)
  if (!distDir) throw new HostedGatewayError('CODESURF_HOSTED_DIST_DIR is required')

  const hasInjectedUpstreams = Boolean(options.upstreams)
  const sandboxRootInput = options.sandboxRoot ?? env.CODESURF_HOSTED_SANDBOX_ROOT
  const sandboxRoot = hasInjectedUpstreams && !sandboxRootInput
    ? null
    : directoryRealPath(sandboxRootInput, 'CODESURF_HOSTED_SANDBOX_ROOT')

  let home = null
  if (!hasInjectedUpstreams) {
    const defaultHome = loopback && sandboxRoot ? join(sandboxRoot, '.codesurf-hosted') : null
    home = asPath(options.home || env.CODESURF_HOSTED_HOME || defaultHome, root)
    if (!home || !isAbsolute(home)) {
      throw new HostedGatewayError('CODESURF_HOSTED_HOME is required for a non-loopback hosted sandbox')
    }
  }

  const adapter = nonEmpty(options.terminalAdapter || env.CODESURF_HOSTED_TERMINAL_ADAPTER) || 'docker'
  if (!['docker', 'local'].includes(adapter)) {
    throw new HostedGatewayError('CODESURF_HOSTED_TERMINAL_ADAPTER must be docker or local')
  }
  const dockerImage = nonEmpty(options.dockerImage || env.CODESURF_HOSTED_DOCKER_IMAGE || env.CODESURF_TERMINAL_DOCKER_IMAGE)
  const allowDocker = parseBoolean(options.allowDocker ?? env.CODESURF_HOSTED_ENABLE_DOCKER_SANDBOX, 'CODESURF_HOSTED_ENABLE_DOCKER_SANDBOX')
  const assumeIsolatedSandbox = parseBoolean(options.assumeIsolatedSandbox ?? env.CODESURF_HOSTED_ASSUME_ISOLATED_SANDBOX, 'CODESURF_HOSTED_ASSUME_ISOLATED_SANDBOX')
  const allowLoopbackLocalPty = parseBoolean(options.allowLoopbackLocalPty ?? env.CODESURF_HOSTED_ALLOW_LOOPBACK_LOCAL_PTY, 'CODESURF_HOSTED_ALLOW_LOOPBACK_LOCAL_PTY')

  if (!hasInjectedUpstreams && adapter === 'docker') {
    if (!allowDocker) {
      throw new HostedGatewayError('Docker terminal sessions are fail-closed; set CODESURF_HOSTED_ENABLE_DOCKER_SANDBOX=1 after isolating the worker')
    }
    if (!dockerImage) throw new HostedGatewayError('CODESURF_HOSTED_DOCKER_IMAGE is required for docker terminal sessions')
  }
  if (!hasInjectedUpstreams && adapter === 'local') {
    const localPermitted = (loopback && allowLoopbackLocalPty) || assumeIsolatedSandbox
    if (!localPermitted) {
      throw new HostedGatewayError('local PTYs require CODESURF_HOSTED_ASSUME_ISOLATED_SANDBOX=1, or explicit loopback development opt-in')
    }
  }

  const sessionTtlMs = parseInteger(options.sessionTtlMs ?? env.CODESURF_HOSTED_SESSION_TTL_MS, 'CODESURF_HOSTED_SESSION_TTL_MS', {
    min: 60_000,
    max: 24 * 60 * 60 * 1000,
    fallback: DEFAULT_SESSION_TTL_MS,
  })
  const maxBodyBytes = parseInteger(options.maxBodyBytes ?? env.CODESURF_HOSTED_MAX_BODY_BYTES, 'CODESURF_HOSTED_MAX_BODY_BYTES', {
    min: 1024,
    max: 16 * 1024 * 1024,
    fallback: DEFAULT_MAX_BODY_BYTES,
  })
  const maxTerminalBodyBytes = parseInteger(options.maxTerminalBodyBytes ?? env.CODESURF_HOSTED_MAX_TERMINAL_BODY_BYTES, 'CODESURF_HOSTED_MAX_TERMINAL_BODY_BYTES', {
    min: 1024,
    max: maxBodyBytes,
    fallback: Math.min(DEFAULT_MAX_TERMINAL_BODY_BYTES, maxBodyBytes),
  })
  const maxResponseBytes = parseInteger(options.maxResponseBytes ?? env.CODESURF_HOSTED_MAX_RESPONSE_BYTES, 'CODESURF_HOSTED_MAX_RESPONSE_BYTES', {
    min: 1024,
    max: 64 * 1024 * 1024,
    fallback: DEFAULT_MAX_RESPONSE_BYTES,
  })
  const maxStaticBytes = parseInteger(options.maxStaticBytes ?? env.CODESURF_HOSTED_MAX_STATIC_BYTES, 'CODESURF_HOSTED_MAX_STATIC_BYTES', {
    min: 1024,
    max: 256 * 1024 * 1024,
    fallback: DEFAULT_MAX_STATIC_BYTES,
  })

  let upstreams = null
  if (options.upstreams) {
    upstreams = {
      hostUrl: assertPrivateLoopbackUrl(options.upstreams.hostUrl, 'upstreams.hostUrl'),
      terminalUrl: assertPrivateLoopbackUrl(options.upstreams.terminalUrl, 'upstreams.terminalUrl'),
      hostToken: assertSecret(options.upstreams.hostToken, 'upstreams.hostToken'),
      terminalToken: assertSecret(options.upstreams.terminalToken, 'upstreams.terminalToken'),
    }
  }

  return {
    root,
    publicOrigin,
    bindHost,
    port,
    loopback,
    allowLoopbackDev,
    accessToken,
    distDir,
    sandboxRoot,
    home,
    adapter,
    dockerImage,
    allowDocker,
    assumeIsolatedSandbox,
    allowLoopbackLocalPty,
    sessionTtlMs,
    maxBodyBytes,
    maxTerminalBodyBytes,
    maxResponseBytes,
    maxStaticBytes,
    wsIdleMs: parseInteger(options.wsIdleMs ?? env.CODESURF_HOSTED_WS_IDLE_MS, 'CODESURF_HOSTED_WS_IDLE_MS', {
      min: 60_000,
      max: 24 * 60 * 60 * 1000,
      fallback: DEFAULT_WS_IDLE_MS,
    }),
    maxWsConnections: parseInteger(options.maxWsConnections ?? env.CODESURF_HOSTED_MAX_WS_CONNECTIONS, 'CODESURF_HOSTED_MAX_WS_CONNECTIONS', {
      min: 1,
      max: 10_000,
      fallback: DEFAULT_MAX_WS_CONNECTIONS,
    }),
    loginWindowMs: parseInteger(options.loginWindowMs ?? env.CODESURF_HOSTED_LOGIN_WINDOW_MS, 'CODESURF_HOSTED_LOGIN_WINDOW_MS', {
      min: 10_000,
      max: 60 * 60 * 1000,
      fallback: DEFAULT_LOGIN_WINDOW_MS,
    }),
    maxLoginAttempts: parseInteger(options.maxLoginAttempts ?? env.CODESURF_HOSTED_MAX_LOGIN_ATTEMPTS, 'CODESURF_HOSTED_MAX_LOGIN_ATTEMPTS', {
      min: 1,
      max: 1_000,
      fallback: DEFAULT_LOGIN_ATTEMPTS,
    }),
    upstreams,
  }
}

function requestOrigin(request) {
  const origin = request.headers.origin
  return typeof origin === 'string' ? origin.trim() : ''
}

function acceptsHtml(request) {
  return /(?:^|,)\s*text\/html(?:\s*;|,|$)/i.test(String(request.headers.accept || ''))
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieValue(request, name) {
  const header = request.headers.cookie
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    if (part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim() || null
  }
  return null
}

function remoteAddress(request) {
  return request.socket?.remoteAddress || ''
}

function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('\r') || value.includes('\n')) return '/'
  return value
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function mimeType(file) {
  switch (extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.mjs': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.ico': return 'image/x-icon'
    case '.woff2': return 'font/woff2'
    case '.woff': return 'font/woff'
    case '.wasm': return 'application/wasm'
    case '.txt': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

function parseRequestUrl(request) {
  const raw = String(request.url || '/')
  if (!raw.startsWith('/') || raw.length > 8 * 1024) {
    throw new HostedGatewayError('invalid request path', 400)
  }
  const rawPath = raw.split('?', 1)[0]
  if (rawPath.includes('\\') || /%2f|%5c|%00/i.test(rawPath)) {
    throw new HostedGatewayError('unsafe request path', 400)
  }
  let decoded
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    throw new HostedGatewayError('malformed request path', 400)
  }
  if (decoded.includes('\0') || decoded.split('/').some(segment => segment === '..')) {
    throw new HostedGatewayError('unsafe request path', 400)
  }
  return new URL(raw, 'http://codesurf-hosted.invalid')
}

async function readBounded(request, maxBytes) {
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > maxBytes)) {
    throw new HostedGatewayError('request body exceeds the configured size limit', 413)
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new HostedGatewayError('request body exceeds the configured size limit', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes)
}

function responseHeadersForProxy(upstream, { streaming = false } = {}) {
  const headers = {}
  const contentType = upstream.headers['content-type']
  const cacheControl = upstream.headers['cache-control']
  const etag = upstream.headers.etag
  const lastModified = upstream.headers['last-modified']
  const disposition = upstream.headers['content-disposition']
  if (typeof contentType === 'string') headers['Content-Type'] = contentType
  if (typeof cacheControl === 'string') headers['Cache-Control'] = cacheControl
  if (typeof etag === 'string') headers.ETag = etag
  if (typeof lastModified === 'string') headers['Last-Modified'] = lastModified
  if (typeof disposition === 'string') headers['Content-Disposition'] = disposition
  if (streaming) {
    headers['Cache-Control'] = 'no-store'
    headers.Connection = 'keep-alive'
    headers['X-Accel-Buffering'] = 'no'
  }
  return headers
}

function isSseResponse(response) {
  return /(?:^|;)\s*text\/event-stream(?:;|$)/i.test(String(response.headers['content-type'] || ''))
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n`
    + 'Connection: close\r\n'
    + 'Cache-Control: no-store\r\n'
    + 'X-Content-Type-Options: nosniff\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
    + body,
  )
  socket.destroy()
}

function isSafeWebSocketHeader(value, maxLength = 1024) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\r\n]/.test(value)
}

export class HostedGateway {
  constructor(options = {}) {
    this.config = options.config || createHostedGatewayConfig(options)
    this.server = null
    this.distReal = null
    this.publicAddress = null
    this.privateHostUrl = this.config.upstreams?.hostUrl || null
    this.privateTerminalUrl = this.config.upstreams?.terminalUrl || null
    this.privateHostToken = this.config.upstreams?.hostToken || randomBytes(32).toString('base64url')
    this.privateTerminalToken = this.config.upstreams?.terminalToken || randomBytes(32).toString('base64url')
    this.children = []
    this.sessions = new Map()
    this.loginAttempts = new Map()
    this.httpSockets = new Set()
    this.wsConnections = new Set()
    this.cleanupTimer = null
    this.ready = false
    this.closing = false
  }

  async listen() {
    if (this.server) throw new HostedGatewayError('hosted gateway is already listening')
    this.distReal = directoryRealPath(this.config.distDir, 'CODESURF_HOSTED_DIST_DIR')
    if (!existsSync(join(this.distReal, 'index.html'))) {
      throw new HostedGatewayError('CODESURF_HOSTED_DIST_DIR must contain index.html; run npm run build:web first')
    }

    this.server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
      void this.#handleRequest(request, response)
    })
    this.server.maxHeadersCount = 80
    this.server.headersTimeout = 15_000
    this.server.requestTimeout = 30_000
    this.server.keepAliveTimeout = 10_000
    this.server.on('connection', socket => {
      this.httpSockets.add(socket)
      socket.once('close', () => this.httpSockets.delete(socket))
    })
    this.server.on('upgrade', (request, socket, head) => {
      this.#handleUpgrade(request, socket, head)
    })
    this.server.on('clientError', (_error, socket) => socket.destroy())

    await new Promise((resolveListen, rejectListen) => {
      this.server.once('error', rejectListen)
      this.server.listen(this.config.port, this.config.bindHost, () => {
        this.server.off('error', rejectListen)
        resolveListen()
      })
    })
    this.publicAddress = this.server.address()
    try {
      if (!this.config.upstreams) await this.#spawnPrivateSidecars()
      this.ready = true
      this.cleanupTimer = setInterval(() => this.#purgeExpiredSessions(), Math.min(this.config.sessionTtlMs, 60_000))
      this.cleanupTimer.unref?.()
      return this.config.publicOrigin
    } catch (error) {
      await this.close()
      throw error
    }
  }

  getSnapshot() {
    return {
      publicOrigin: this.config.publicOrigin,
      bindHost: this.config.bindHost,
      port: typeof this.publicAddress === 'object' && this.publicAddress ? this.publicAddress.port : this.config.port,
      ready: this.ready,
      sessions: this.sessions.size,
      webSockets: this.wsConnections.size,
      sidecars: this.children.length,
    }
  }

  async close() {
    if (this.closing) return
    this.closing = true
    this.ready = false
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
    this.sessions.clear()
    this.loginAttempts.clear()
    for (const connection of this.wsConnections) {
      try { connection.client.destroy() } catch {}
      try { connection.upstream.destroy() } catch {}
    }
    this.wsConnections.clear()
    for (const socket of this.httpSockets) {
      try { socket.destroy() } catch {}
    }
    this.httpSockets.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise(resolveClose => server.close(() => resolveClose()))
    }
    await Promise.all([...this.children].reverse().map(child => this.#stopChild(child)))
    this.children = []
  }

  #setSecurityHeaders(response) {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Content-Security-Policy', "base-uri 'none'; object-src 'none'; frame-ancestors 'none'")
  }

  #sendJson(response, status, body, headers = {}) {
    if (response.writableEnded || response.destroyed) return
    const payload = JSON.stringify(body)
    this.#setSecurityHeaders(response)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...headers,
    })
    response.end(payload)
  }

  #sendText(response, status, body, headers = {}) {
    if (response.writableEnded || response.destroyed) return
    this.#setSecurityHeaders(response)
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...headers,
    })
    response.end(body)
  }

  #redirect(response, location, headers = {}) {
    this.#setSecurityHeaders(response)
    response.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers })
    response.end()
  }

  #originIsAllowed(request, { required = false } = {}) {
    const origin = requestOrigin(request)
    if (!origin) return !required
    return origin === this.config.publicOrigin
  }

  #sessionForRequest(request) {
    const id = cookieValue(request, this.#cookieName())
    if (!id) return null
    const session = this.sessions.get(id)
    if (!session) return null
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id)
      return null
    }
    return session
  }

  #cookieName() {
    return new URL(this.config.publicOrigin).protocol === 'https:' ? '__Host-codesurf-session' : 'codesurf-session'
  }

  #sessionCookie(id, { expired = false } = {}) {
    const secure = new URL(this.config.publicOrigin).protocol === 'https:' ? '; Secure' : ''
    const age = expired ? 0 : Math.floor(this.config.sessionTtlMs / 1000)
    return `${this.#cookieName()}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`
  }

  #newSession() {
    const id = randomBytes(32).toString('base64url')
    this.sessions.set(id, { expiresAt: Date.now() + this.config.sessionTtlMs })
    return id
  }

  #purgeExpiredSessions() {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id)
    }
    for (const [ip, attempt] of this.loginAttempts) {
      if (attempt.resetAt <= now) this.loginAttempts.delete(ip)
    }
  }

  #isDevelopmentRequestAllowed(request) {
    return this.config.allowLoopbackDev && isLoopbackAddress(remoteAddress(request))
  }

  #loginAttemptAvailable(request) {
    const ip = remoteAddress(request) || 'unknown'
    const now = Date.now()
    const existing = this.loginAttempts.get(ip)
    if (!existing || existing.resetAt <= now) return true
    return existing.count < this.config.maxLoginAttempts
  }

  #recordLoginFailure(request) {
    const ip = remoteAddress(request) || 'unknown'
    const now = Date.now()
    const existing = this.loginAttempts.get(ip)
    if (!existing || existing.resetAt <= now) {
      this.loginAttempts.set(ip, { count: 1, resetAt: now + this.config.loginWindowMs })
      return
    }
    existing.count += 1
  }

  #clearLoginFailures(request) {
    this.loginAttempts.delete(remoteAddress(request) || 'unknown')
  }

  async #handleRequest(request, response) {
    try {
      const url = parseRequestUrl(request)
      const pathname = url.pathname
      if (requestOrigin(request) && !this.#originIsAllowed(request)) {
        return this.#sendJson(response, 403, { error: 'origin is not allowed' })
      }
      if (request.method === 'OPTIONS') {
        // This service is same-origin only. A CORS preflight from any other
        // origin is rejected above; same-origin browser requests never need it.
        this.#setSecurityHeaders(response)
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        return response.end()
      }
      if (request.method === 'GET' && pathname === '/healthz') {
        return this.#sendJson(response, this.ready ? 200 : 503, {
          ok: this.ready,
          service: 'codesurf-hosted-gateway',
        })
      }
      if (pathname === '/auth/login') return await this.#handleLogin(request, response, url)
      if (pathname === '/auth/logout') return this.#handleLogout(request, response)

      let session = this.#sessionForRequest(request)
      let sessionCookie = null
      if (!session && this.#isDevelopmentRequestAllowed(request)) {
        const id = this.#newSession()
        session = this.sessions.get(id)
        sessionCookie = this.#sessionCookie(id)
      }
      if (!session) {
        if (request.method === 'GET' && acceptsHtml(request) && !pathname.startsWith('/host/') && !pathname.startsWith('/d/') && !pathname.startsWith('/v1/')) {
          return this.#redirect(response, `/auth/login?next=${encodeURIComponent(safeNext(`${pathname}${url.search}`))}`)
        }
        return this.#sendJson(response, 401, { error: 'authentication required' })
      }
      if (!this.ready) return this.#sendJson(response, 503, { error: 'hosted sandbox is starting' })

      if (pathname === '/codesurf-runtime-config.js') {
        return this.#serveRuntimeConfig(response, sessionCookie)
      }
      if (pathname.startsWith('/host/') || pathname.startsWith('/d/')) {
        return await this.#proxyHostRequest(request, response, url, sessionCookie)
      }
      if (pathname === '/v1/terminal/sessions') {
        return await this.#proxyTerminalSession(request, response, url, sessionCookie)
      }
      if (pathname === '/v1/terminal/attach') {
        return this.#sendJson(response, 426, { error: 'WebSocket upgrade required' }, sessionCookie ? { 'Set-Cookie': sessionCookie } : {})
      }
      if (pathname.startsWith('/v1/terminal/')) {
        return this.#sendJson(response, 404, { error: 'terminal route not found' }, sessionCookie ? { 'Set-Cookie': sessionCookie } : {})
      }
      return await this.#serveStatic(request, response, url, sessionCookie)
    } catch (error) {
      const status = error instanceof HostedGatewayError ? error.status : 500
      if (status >= 500) console.error('[hosted-gateway]', error instanceof Error ? error.message : error)
      if (!response.writableEnded && !response.destroyed) {
        this.#sendJson(response, status, { error: status >= 500 ? 'hosted gateway request failed' : String(error.message || error) })
      }
    }
  }

  async #handleLogin(request, response, url) {
    if (!this.#originIsAllowed(request)) return this.#sendJson(response, 403, { error: 'origin is not allowed' })
    const next = safeNext(url.searchParams.get('next') || '/')
    if (request.method === 'GET') {
      if (this.#sessionForRequest(request)) return this.#redirect(response, next)
      const form = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CodeSurf sign in</title></head><body><main><h1>CodeSurf</h1><p>Enter the hosted access token for this sandbox.</p><form method="post" action="/auth/login?next=${encodeURIComponent(next)}"><label>Access token <input type="password" name="accessToken" autocomplete="current-password" required autofocus></label><button type="submit">Open workspace</button></form></main></body></html>`
      return this.#sendText(response, 200, form)
    }
    if (request.method !== 'POST') return this.#sendJson(response, 405, { error: 'method not allowed' })
    if (!this.#loginAttemptAvailable(request)) {
      return this.#sendJson(response, 429, { error: 'too many login attempts' }, { 'Retry-After': String(Math.ceil(this.config.loginWindowMs / 1000)) })
    }

    let supplied = null
    const authorization = request.headers.authorization
    if (typeof authorization === 'string') {
      const match = /^Bearer ([^\s,]+)$/.exec(authorization)
      supplied = match?.[1] || null
    }
    if (!supplied) {
      const body = await readBounded(request, 16 * 1024)
      const contentType = String(request.headers['content-type'] || '').toLowerCase()
      if (contentType.startsWith('application/json')) {
        try {
          const parsed = JSON.parse(body.toString('utf8'))
          supplied = nonEmpty(parsed?.accessToken)
        } catch {
          return this.#sendJson(response, 400, { error: 'invalid login JSON' })
        }
      } else if (contentType.startsWith('application/x-www-form-urlencoded')) {
        supplied = nonEmpty(new URLSearchParams(body.toString('utf8')).get('accessToken'))
      } else if (body.length > 0) {
        return this.#sendJson(response, 415, { error: 'login requires bearer, JSON, or form-urlencoded credentials' })
      }
    }

    const valid = this.config.accessToken
      ? constantTimeEqual(supplied || '', this.config.accessToken)
      : this.#isDevelopmentRequestAllowed(request)
    if (!valid) {
      this.#recordLoginFailure(request)
      if (acceptsHtml(request)) {
        return this.#sendText(response, 401, '<!doctype html><title>CodeSurf sign in</title><p>Invalid access token. <a href="/auth/login">Try again</a>.</p>')
      }
      return this.#sendJson(response, 401, { error: 'invalid access token' })
    }
    this.#clearLoginFailures(request)
    const id = this.#newSession()
    const cookie = this.#sessionCookie(id)
    if (acceptsHtml(request)) return this.#redirect(response, next, { 'Set-Cookie': cookie })
    return this.#sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookie })
  }

  #handleLogout(request, response) {
    if (request.method !== 'POST') return this.#sendJson(response, 405, { error: 'method not allowed' })
    if (!this.#originIsAllowed(request)) return this.#sendJson(response, 403, { error: 'origin is not allowed' })
    const id = cookieValue(request, this.#cookieName())
    if (id) this.sessions.delete(id)
    return this.#sendJson(response, 200, { ok: true }, { 'Set-Cookie': this.#sessionCookie('', { expired: true }) })
  }

  #serveRuntimeConfig(response, sessionCookie) {
    // Only endpoint metadata is present here. The renderer gets no long-lived
    // bearer: this ingress injects private credentials into sidecar requests.
    const script = `Object.assign(window,{__CODESURF_PLATFORM__:'web',__CODESURF_HOST__:window.location.origin,__CODESURF_TERMINAL_ENDPOINT__:window.location.origin});\n`
    this.#setSecurityHeaders(response)
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(script),
      'Cache-Control': 'no-store, private',
      ...(sessionCookie ? { 'Set-Cookie': sessionCookie } : {}),
    })
    response.end(script)
  }

  async #proxyHostRequest(request, response, url, sessionCookie) {
    const method = request.method || 'GET'
    if (!this.#originIsAllowed(request)) return this.#sendJson(response, 403, { error: 'origin is not allowed' })
    const body = await this.#readProxyBody(request, this.config.maxBodyBytes)
    const responseFromHost = await this.#openPrivateRequest(this.privateHostUrl, `${url.pathname}${url.search}`, {
      method,
      body,
      headers: {
        Accept: String(request.headers.accept || 'application/json'),
        Origin: this.config.publicOrigin,
        'X-Codesurf-Host': this.privateHostToken,
        ...(body.length ? { 'Content-Type': String(request.headers['content-type'] || 'application/json') } : {}),
      },
    })
    return await this.#relayPrivateResponse(response, responseFromHost, sessionCookie)
  }

  async #proxyTerminalSession(request, response, url, sessionCookie) {
    if (request.method !== 'POST' || url.search) return this.#sendJson(response, 404, { error: 'terminal route not found' })
    if (!this.#originIsAllowed(request, { required: true })) return this.#sendJson(response, 403, { error: 'origin is not allowed' })
    const body = await this.#readProxyBody(request, this.config.maxTerminalBodyBytes)
    const terminalResponse = await this.#openPrivateRequest(this.privateTerminalUrl, '/v1/terminal/sessions', {
      method: 'POST',
      body,
      headers: {
        Accept: 'application/json',
        Origin: this.config.publicOrigin,
        Authorization: `Bearer ${this.privateTerminalToken}`,
        'Content-Type': String(request.headers['content-type'] || 'application/json'),
      },
    })
    const raw = await this.#collectResponse(terminalResponse, this.config.maxResponseBytes)
    if (terminalResponse.statusCode !== 201) {
      return this.#sendPrivateBytes(response, terminalResponse.statusCode || 502, raw, terminalResponse.headers, sessionCookie)
    }
    let created
    try {
      created = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HostedGatewayError('terminal sidecar returned invalid session JSON', 502)
    }
    if (!nonEmpty(created?.sessionId) || !nonEmpty(created?.attachToken)) {
      throw new HostedGatewayError('terminal sidecar returned an incomplete session', 502)
    }
    // Do not reflect the loopback gateway's websocketUrl. The browser must
    // attach through this authenticated same-origin upgrade route.
    return this.#sendJson(response, 201, {
      sessionId: created.sessionId,
      attachToken: created.attachToken,
      websocketUrl: '/v1/terminal/attach',
    }, sessionCookie ? { 'Set-Cookie': sessionCookie } : {})
  }

  async #readProxyBody(request, maxBytes) {
    const method = request.method || 'GET'
    if ((method === 'GET' || method === 'HEAD') && Number(request.headers['content-length'] || 0) > 0) {
      throw new HostedGatewayError('GET and HEAD proxy requests cannot include a body', 400)
    }
    if (method === 'GET' || method === 'HEAD') return Buffer.alloc(0)
    return readBounded(request, maxBytes)
  }

  #openPrivateRequest(base, requestPath, { method, headers, body }) {
    if (!this.ready && !this.config.upstreams) return Promise.reject(new HostedGatewayError('sandbox is starting', 503))
    const upstream = new URL(base)
    const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
    return new Promise((resolveResponse, rejectResponse) => {
      const privateRequest = httpRequest({
        protocol: 'http:',
        hostname: upstream.hostname,
        port: upstream.port || 80,
        method,
        path,
        headers: {
          ...headers,
          ...(body.length ? { 'Content-Length': String(body.length) } : {}),
        },
        timeout: 15_000,
        agent: false,
      }, response => resolveResponse(response))
      privateRequest.once('timeout', () => privateRequest.destroy(new Error('private sidecar request timed out')))
      privateRequest.once('error', error => rejectResponse(new HostedGatewayError(`private sidecar is unavailable: ${error.message}`, 502)))
      privateRequest.end(body)
    })
  }

  async #relayPrivateResponse(response, upstream, sessionCookie) {
    if (isSseResponse(upstream)) {
      this.#setSecurityHeaders(response)
      response.writeHead(upstream.statusCode || 502, {
        ...responseHeadersForProxy(upstream, { streaming: true }),
        ...(sessionCookie ? { 'Set-Cookie': sessionCookie } : {}),
      })
      const abort = () => upstream.destroy()
      response.once('close', abort)
      try {
        for await (const chunk of upstream) {
          if (response.destroyed) break
          if (!response.write(chunk)) await once(response, 'drain')
        }
        if (!response.writableEnded) response.end()
      } finally {
        response.removeListener('close', abort)
      }
      return
    }
    const raw = await this.#collectResponse(upstream, this.config.maxResponseBytes)
    return this.#sendPrivateBytes(response, upstream.statusCode || 502, raw, upstream.headers, sessionCookie)
  }

  async #collectResponse(upstream, maxBytes) {
    const declared = Number(upstream.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      upstream.destroy()
      throw new HostedGatewayError('private sidecar response exceeds the configured size limit', 502)
    }
    const chunks = []
    let bytes = 0
    for await (const chunk of upstream) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        upstream.destroy()
        throw new HostedGatewayError('private sidecar response exceeds the configured size limit', 502)
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, bytes)
  }

  #sendPrivateBytes(response, status, body, upstreamHeaders, sessionCookie) {
    this.#setSecurityHeaders(response)
    const contentType = typeof upstreamHeaders['content-type'] === 'string'
      ? upstreamHeaders['content-type']
      : 'application/json; charset=utf-8'
    response.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      ...(sessionCookie ? { 'Set-Cookie': sessionCookie } : {}),
    })
    response.end(body)
  }

  async #serveStatic(request, response, url, sessionCookie) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return this.#sendJson(response, 405, { error: 'method not allowed' })
    let pathname = url.pathname
    if (pathname === '/') pathname = '/index.html'
    let file = this.#resolveStaticFile(pathname)
    if (!file && this.#isSpaRoute(pathname)) file = this.#resolveStaticFile('/index.html')
    if (!file) return this.#sendJson(response, 404, { error: 'not found' }, sessionCookie ? { 'Set-Cookie': sessionCookie } : {})
    let stats
    try {
      stats = statSync(file)
    } catch {
      return this.#sendJson(response, 404, { error: 'not found' })
    }
    if (!stats.isFile() || stats.size > this.config.maxStaticBytes) {
      return this.#sendJson(response, 404, { error: 'not found' })
    }
    this.#setSecurityHeaders(response)
    const isAsset = pathname.startsWith('/assets/')
    response.writeHead(200, {
      'Content-Type': mimeType(file),
      'Content-Length': stats.size,
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(sessionCookie ? { 'Set-Cookie': sessionCookie } : {}),
    })
    if (request.method === 'HEAD') return response.end()
    const stream = createReadStream(file)
    stream.once('error', () => {
      if (!response.writableEnded) response.destroy()
    })
    stream.pipe(response)
  }

  #resolveStaticFile(pathname) {
    if (pathname.includes('\\') || /%2f|%5c|%00/i.test(pathname)) return null
    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    if (!decoded.startsWith('/') || decoded.split('/').some(segment => segment === '..') || decoded.endsWith('.map')) return null
    const candidate = resolve(this.distReal, `.${decoded}`)
    if (!pathInside(this.distReal, candidate) || !existsSync(candidate)) return null
    try {
      const real = realpathSync(candidate)
      return pathInside(this.distReal, real) ? real : null
    } catch {
      return null
    }
  }

  #isSpaRoute(pathname) {
    if (pathname.startsWith('/assets/') || pathname.startsWith('/auth/') || pathname.startsWith('/host/') || pathname.startsWith('/d/') || pathname.startsWith('/v1/')) return false
    const finalSegment = pathname.split('/').pop() || ''
    return !finalSegment.includes('.')
  }

  #handleUpgrade(request, socket, head) {
    try {
      const url = parseRequestUrl(request)
      if (url.pathname !== '/v1/terminal/attach' || url.search) return rejectUpgrade(socket, 404, 'Not Found')
      if (!this.ready) return rejectUpgrade(socket, 503, 'Service Unavailable')
      if (!this.#sessionForRequest(request)) return rejectUpgrade(socket, 401, 'Unauthorized')
      if (!this.#originIsAllowed(request, { required: true })) return rejectUpgrade(socket, 403, 'Forbidden')
      if (this.wsConnections.size >= this.config.maxWsConnections) return rejectUpgrade(socket, 429, 'Too Many Requests')
      const key = request.headers['sec-websocket-key']
      if (!isSafeWebSocketHeader(key, 128) || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return rejectUpgrade(socket, 400, 'Bad Request')
      if (request.headers['sec-websocket-version'] !== '13') return rejectUpgrade(socket, 400, 'Bad Request')
      if (!/(?:^|,)\s*upgrade\s*(?:,|$)/i.test(String(request.headers.connection || '')) || String(request.headers.upgrade || '').toLowerCase() !== 'websocket') {
        return rejectUpgrade(socket, 400, 'Bad Request')
      }
      this.#proxyWebSocket(request, socket, head, key)
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
    }
  }

  #proxyWebSocket(request, client, head, key) {
    const target = new URL(this.privateTerminalUrl)
    const host = target.hostname
    const port = Number(target.port || 80)
    const upstream = connectTcp({ host, port })
    const connection = { client, upstream }
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      this.wsConnections.delete(connection)
      client.removeListener('error', onClientError)
      upstream.removeListener('error', onUpstreamError)
    }
    const onClientError = () => {
      try { upstream.destroy() } catch {}
      cleanup()
    }
    const onUpstreamError = () => {
      try { client.destroy() } catch {}
      cleanup()
    }
    upstream.once('error', onUpstreamError)
    client.once('error', onClientError)
    client.once('close', () => {
      try { upstream.destroy() } catch {}
      cleanup()
    })
    upstream.once('close', () => {
      try { client.destroy() } catch {}
      cleanup()
    })
    upstream.setTimeout(this.config.wsIdleMs, () => upstream.destroy())
    client.setTimeout(this.config.wsIdleMs, () => client.destroy())
    upstream.once('connect', () => {
      const protocol = request.headers['sec-websocket-protocol']
      const lines = [
        'GET /v1/terminal/attach HTTP/1.1',
        `Host: ${target.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Origin: ${this.config.publicOrigin}`,
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ]
      if (isSafeWebSocketHeader(protocol)) lines.push(`Sec-WebSocket-Protocol: ${protocol}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      this.wsConnections.add(connection)
      client.pipe(upstream)
      upstream.pipe(client)
    })
  }

  async #spawnPrivateSidecars() {
    const terminalScript = join(this.config.root, 'packages', 'codesurf-terminal-gateway', 'bin', 'codesurf-terminal-gateway.mjs')
    const webHostScript = join(this.config.root, 'scripts', 'web-host.mjs')
    if (!existsSync(terminalScript) || !existsSync(webHostScript)) {
      throw new HostedGatewayError('required private sidecar scripts are missing')
    }
    const tenantConfig = JSON.stringify({
      hosted: {
        roots: [this.config.sandboxRoot],
        workspaces: { sandbox: this.config.sandboxRoot },
      },
    })
    const terminalEnv = {
      ...process.env,
      CODESURF_HOME: this.config.home,
      CODESURF_TERMINAL_GATEWAY_BIND: '127.0.0.1',
      CODESURF_TERMINAL_GATEWAY_PORT: '0',
      CODESURF_TERMINAL_PUBLIC_URL: '',
      CODESURF_TERMINAL_RUNTIME_CONFIG_PATH: '',
      CODESURF_TERMINAL_TOKEN: this.privateTerminalToken,
      CODESURF_TERMINAL_TENANTS_JSON: tenantConfig,
      CODESURF_TERMINAL_ALLOWED_ORIGINS: this.config.publicOrigin,
      CODESURF_TERMINAL_ADAPTER: this.config.adapter,
      CODESURF_TERMINAL_ENABLE_DOCKER: this.config.adapter === 'docker' ? '1' : '0',
      CODESURF_TERMINAL_DOCKER_IMAGE: this.config.dockerImage || '',
    }
    this.privateTerminalUrl = await this.#spawnSidecar({
      label: 'terminal-gateway',
      script: terminalScript,
      env: terminalEnv,
      endpointPattern: /^CodeSurf terminal gateway listening on (http:\/\/[^\s]+)$/,
      healthPath: '/healthz',
    })

    const webHostEnv = {
      ...process.env,
      CODESURF_HOME: this.config.home,
      CODESURF_WEB_HOST_BIND: '127.0.0.1',
      CODESURF_WEB_HOST_PORT: '0',
      CODESURF_WEB_HOST_TOKEN: this.privateHostToken,
      CODESURF_WEB_HOST_ORIGINS: this.config.publicOrigin,
      CODESURF_WEB_HOST_ALLOWED_ROOTS: this.config.sandboxRoot,
      CODESURF_RUNTIME_CONFIG_PATH: '',
      CODESURF_TERMINAL_GATEWAY_URL: this.privateTerminalUrl,
      CODESURF_TERMINAL_TOKEN: this.privateTerminalToken,
      CODESURF_TERMINAL_WORKSPACE_ROOT_CONFIGURED: '1',
    }
    this.privateHostUrl = await this.#spawnSidecar({
      label: 'web-host',
      script: webHostScript,
      env: webHostEnv,
      endpointPattern: /^\[web-host\] listening on (http:\/\/[^\s]+)$/,
      healthPath: '/health',
    })
  }

  async #spawnSidecar({ label, script, env, endpointPattern, healthPath }) {
    const child = spawn(process.execPath, [script], {
      cwd: this.config.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    this.children.push(child)
    let outputBuffer = ''
    const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
      let finished = false
      const timeout = setTimeout(() => finish(new HostedGatewayError(`${label} did not report a loopback endpoint within 30 seconds`)), 30_000)
      const finish = (error, value) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        child.off('exit', onExit)
        child.off('error', onError)
        if (error) rejectEndpoint(error)
        else resolveEndpoint(value)
      }
      const onExit = (code, signal) => finish(new HostedGatewayError(`${label} exited before startup (${code ?? signal ?? 'unknown'})`))
      const onError = error => finish(new HostedGatewayError(`${label} failed to start: ${error.message}`))
      child.once('exit', onExit)
      child.once('error', onError)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', chunk => {
        outputBuffer += chunk
        const lines = outputBuffer.split(/\r?\n/)
        outputBuffer = lines.pop() || ''
        for (const line of lines) {
          const match = endpointPattern.exec(line.trim())
          if (!match) continue
          let privateUrl
          try {
            privateUrl = assertPrivateLoopbackUrl(match[1], `${label} endpoint`)
          } catch (error) {
            finish(error)
            return
          }
          finish(null, privateUrl)
          return
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', chunk => {
        // Sidecars never receive a public request body. Preserve useful launch
        // diagnostics but do not interpolate environment values here.
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) console.error(`[hosted-gateway:${label}] ${line}`)
        }
      })
    })
    await this.#waitForHealth(`${endpoint}${healthPath}`, label)
    return endpoint
  }

  async #waitForHealth(url, label) {
    const deadline = Date.now() + 30_000
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
        if (response.ok) return
        lastError = new Error(`status ${response.status}`)
      } catch (error) {
        lastError = error
      }
      await delay(150)
    }
    throw new HostedGatewayError(`${label} failed health check: ${lastError instanceof Error ? lastError.message : 'unknown error'}`)
  }

  async #stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode) return
    try { child.kill('SIGTERM') } catch { return }
    const exited = await Promise.race([
      once(child, 'exit').then(() => true).catch(() => true),
      delay(2_000).then(() => false),
    ])
    if (!exited && child.exitCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }
}

export function createHostedGateway(options = {}) {
  return new HostedGateway(options)
}

async function main() {
  const gateway = createHostedGateway()
  await gateway.listen()
  const snapshot = gateway.getSnapshot()
  console.log(`[hosted-gateway] listening for ${snapshot.publicOrigin} (bound ${snapshot.bindHost}:${snapshot.port})`)
  console.log('[hosted-gateway] renderer, daemon, and terminal routes are same-origin; private sidecar credentials are not exposed to the browser')
  if (gateway.config.allowLoopbackDev && !gateway.config.accessToken) {
    console.warn('[hosted-gateway] loopback development session mode is enabled; do not expose this listener')
  }
  let stopping = false
  const stop = async (exitCode) => {
    if (stopping) return
    stopping = true
    await gateway.close()
    process.exit(exitCode)
  }
  process.once('SIGINT', () => { void stop(0) })
  process.once('SIGTERM', () => { void stop(0) })
}

if (isMainModule()) {
  main().catch(error => {
    console.error(`[hosted-gateway] failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
