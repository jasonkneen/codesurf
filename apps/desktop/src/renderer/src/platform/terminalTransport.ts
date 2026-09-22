/**
 * Browser / Native terminal transport.
 *
 * The renderer never opens a local PTY. It asks a terminal gateway to create a
 * scoped session, then attaches with the short-lived token returned for that
 * session. This keeps the capability boundary on the gateway/sandbox side and
 * avoids putting credentials in a URL.
 */

import { resolveHostBase } from './hostConfig.ts'

const SESSION_PATH = '/v1/terminal/sessions'
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MAX_COLS = 500
const MAX_ROWS = 300
// Replay buffer held for a session with no live listeners (tile unmounted while
// output keeps arriving). It only seeds the next subscriber's snapshot, so cap
// it to a scrollback budget instead of letting `tail -f`/build output grow it
// without bound.
const MAX_PENDING_DATA_CHARS = 1024 * 1024

type WebSocketMessageEvent = { data: unknown }
type WebSocketLike = {
  onopen: (() => void) | null
  onmessage: ((event: WebSocketMessageEvent) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
type WebSocketConstructor = new (url: string) => WebSocketLike

export interface TerminalEndpointResolutionOptions {
  injectedEndpoint?: unknown
  envEndpoint?: unknown
  hostBase?: string
}

export interface TerminalTokenResolutionOptions {
  injectedToken?: unknown
}

export interface TerminalSessionRequest {
  cwd: string
  workspaceId?: string
  cols?: number
  rows?: number
  launchBin?: string
  launchArgs?: string[]
}

export interface TerminalSessionResult {
  sessionId: string
  buffer?: string
  cols: number
  rows: number
}

export interface TerminalTransportOptions {
  endpoint?: string
  token?: string | null
  fetchImpl?: typeof fetch | null
  webSocketConstructor?: WebSocketConstructor | null
  readyTimeoutMs?: number
}

interface GatewaySessionResponse {
  sessionId: string
  attachToken: string
  websocketUrl: string
}

interface TerminalListeners {
  data: Set<(data: string) => void>
  active: Set<() => void>
  exit: Set<(exitCode: number) => void>
}

interface TerminalSession {
  id: string
  socket: WebSocketLike | null
  ready: boolean
  closed: boolean
  exitReceived: boolean
  pendingData: string
  readyTimer: ReturnType<typeof setTimeout> | null
  resolveReady: ((result: TerminalSessionResult) => void) | null
  rejectReady: ((error: Error) => void) | null
  cols: number
  rows: number
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readViteTerminalEndpoint(): unknown {
  try {
    return (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_CODESURF_TERMINAL_ENDPOINT
  } catch {
    return undefined
  }
}

function runtimeTerminalEndpointOptions(): TerminalEndpointResolutionOptions {
  const w = typeof window === 'undefined'
    ? undefined
    : window as Window & { __CODESURF_TERMINAL_ENDPOINT__?: string }
  return {
    injectedEndpoint: w?.__CODESURF_TERMINAL_ENDPOINT__,
    envEndpoint: readViteTerminalEndpoint(),
    hostBase: resolveHostBase(),
  }
}

/**
 * Resolve the gateway base in a testable order. An endpoint may point either
 * at a gateway base or directly at the sessions route.
 */
export function resolveTerminalEndpoint(options: TerminalEndpointResolutionOptions = runtimeTerminalEndpointOptions()): string {
  return nonEmptyString(options.injectedEndpoint)
    ?? nonEmptyString(options.envEndpoint)
    ?? nonEmptyString(options.hostBase)
    ?? resolveHostBase()
}

/**
 * Terminal bearer credentials are runtime-injected only. In particular, never
 * read a terminal token from a URL or a build-time Vite variable.
 */
export function resolveTerminalToken(options?: TerminalTokenResolutionOptions): string | null {
  if (options) return nonEmptyString(options.injectedToken)
  if (typeof window === 'undefined') return null
  return nonEmptyString((window as Window & { __CODESURF_TERMINAL_TOKEN__?: string }).__CODESURF_TERMINAL_TOKEN__)
}

export function terminalSessionsUrl(base = resolveTerminalEndpoint()): string {
  const normalized = base
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/+$/, '')
  return normalized.endsWith(SESSION_PATH) ? normalized : `${normalized}${SESSION_PATH}`
}

function boundedDimension(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(value as number)))
}

function responseMessage(response: Response, body: string): string {
  const detail = body.trim().replace(/\s+/g, ' ').slice(0, 300)
  return detail
    ? `Terminal service rejected the session (${response.status}): ${detail}`
    : `Terminal service rejected the session (${response.status})`
}

function parseGatewaySession(value: unknown): GatewaySessionResponse {
  if (!value || typeof value !== 'object') {
    throw new TerminalUnavailableError('Terminal service returned an invalid session response')
  }
  const response = value as Record<string, unknown>
  const sessionId = nonEmptyString(response.sessionId)
  const attachToken = nonEmptyString(response.attachToken)
  const websocketUrl = nonEmptyString(response.websocketUrl)
  if (!sessionId || !attachToken || !websocketUrl) {
    throw new TerminalUnavailableError('Terminal service returned an incomplete session response')
  }
  return { sessionId, attachToken, websocketUrl }
}

function absoluteBaseFor(relativeTo: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(relativeTo)) return relativeTo
  if (typeof window !== 'undefined' && window.location?.origin && /^https?:$/i.test(window.location.protocol)) {
    return window.location.origin
  }
  return resolveHostBase()
}

export function resolveTerminalWebSocketUrl(websocketUrl: string, endpoint: string): string {
  let url: URL
  try {
    url = new URL(websocketUrl, absoluteBaseFor(endpoint))
  } catch {
    throw new TerminalUnavailableError('Terminal service returned an invalid WebSocket URL')
  }

  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new TerminalUnavailableError('Terminal service returned a non-WebSocket URL')
  }
  return url.toString()
}

export class TerminalUnavailableError extends Error {
  readonly code = 'TERMINAL_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'TerminalUnavailableError'
  }
}

function unavailableFrom(error: unknown, fallback: string): TerminalUnavailableError {
  if (error instanceof TerminalUnavailableError) return error
  const message = error instanceof Error && error.message ? error.message : fallback
  return new TerminalUnavailableError(message)
}

/**
 * A stateful client for one renderer. Tile listeners intentionally outlive an
 * individual session so UI observers can subscribe before a session is ready
 * or while it is respawning.
 */
export class TerminalTransport {
  private readonly endpoint: string
  private readonly token: string | null
  private readonly fetchImpl: typeof fetch | null
  private readonly WebSocketConstructor: WebSocketConstructor | null
  private readonly readyTimeoutMs: number
  private readonly sessions = new Map<string, TerminalSession>()
  /**
   * In-flight create() per tileId.
   *
   * create() awaits close(), then the session POST, and only then does
   * sessions.set() — with no guard in between. Two overlapping calls (a tile
   * unmounting and immediately remounting on a panel eject or tab switch) both
   * found no session, both created one on the gateway, and the second set()
   * overwrote the first. The loser was then unreachable from close()/destroy():
   * its WebSocket stayed open, `closed` stayed false, and handleSocketMessage
   * kept emitting into the same tile's listeners (emitData is keyed only by
   * tileId), so the tile interleaved two shells and one PTY leaked for the life
   * of the gateway process. Serializing means the second call runs after the
   * first has registered, and its close() then tears the first down properly.
   */
  private readonly pendingCreates = new Map<string, Promise<TerminalSessionResult>>()
  private readonly listeners = new Map<string, TerminalListeners>()
  private readonly pendingResizes = new Map<string, { cols: number, rows: number }>()
  private readonly completedExits = new Map<string, number>()

  constructor(options: TerminalTransportOptions = {}) {
    this.endpoint = nonEmptyString(options.endpoint) ?? resolveTerminalEndpoint()
    this.token = options.token === undefined ? resolveTerminalToken() : nonEmptyString(options.token)
    this.fetchImpl = options.fetchImpl === undefined
      ? (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
      : options.fetchImpl
    this.WebSocketConstructor = options.webSocketConstructor === undefined
      ? (typeof WebSocket === 'function' ? WebSocket as unknown as WebSocketConstructor : null)
      : options.webSocketConstructor
    this.readyTimeoutMs = Math.max(1_000, options.readyTimeoutMs ?? 15_000)
  }

  isAvailable(): boolean {
    return Boolean(this.endpoint && this.fetchImpl && this.WebSocketConstructor)
  }

  async create(tileId: string, request: TerminalSessionRequest): Promise<TerminalSessionResult> {
    const previous = this.pendingCreates.get(tileId)
    const run = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.createSession(tileId, request))
    this.pendingCreates.set(tileId, run)
    void run.catch(() => undefined).finally(() => {
      if (this.pendingCreates.get(tileId) === run) this.pendingCreates.delete(tileId)
    })
    return run
  }

  private async createSession(tileId: string, request: TerminalSessionRequest): Promise<TerminalSessionResult> {
    if (!this.fetchImpl) throw new TerminalUnavailableError('This runtime does not provide fetch for terminal sessions')
    if (!this.WebSocketConstructor) throw new TerminalUnavailableError('This runtime does not provide WebSocket terminal sessions')

    const cwd = request.cwd.trim()
    if (!cwd) throw new TerminalUnavailableError('Open a workspace before starting a terminal')

    const cols = boundedDimension(request.cols, DEFAULT_COLS, MAX_COLS)
    const rows = boundedDimension(request.rows, DEFAULT_ROWS, MAX_ROWS)
    const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''

    await this.close(tileId)
    this.completedExits.delete(tileId)

    const sessionUrl = terminalSessionsUrl(this.endpoint)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`

    let response: Response
    try {
      response = await this.fetchImpl(sessionUrl, {
        method: 'POST',
        headers,
        // Same-origin hosted deployments may authenticate the gateway with a
        // session cookie. Cross-origin local/native gateways use the explicit
        // bearer header instead, so never trigger credentialed CORS requests.
        credentials: 'same-origin',
        body: JSON.stringify({
          cwd,
          workspaceId,
          cols,
          rows,
          ...(request.launchBin ? { launchBin: request.launchBin, launchArgs: request.launchArgs ?? [] } : {}),
        }),
      })
    } catch (error) {
      throw unavailableFrom(error, 'Terminal service could not be reached')
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new TerminalUnavailableError(responseMessage(response, body))
    }

    let gatewaySession: GatewaySessionResponse
    try {
      gatewaySession = parseGatewaySession(await response.json())
    } catch (error) {
      throw unavailableFrom(error, 'Terminal service returned invalid JSON')
    }

    const session: TerminalSession = {
      id: gatewaySession.sessionId,
      socket: null,
      ready: false,
      closed: false,
      exitReceived: false,
      pendingData: '',
      readyTimer: null,
      resolveReady: null,
      rejectReady: null,
      cols,
      rows,
    }
    this.sessions.set(tileId, session)

    return new Promise<TerminalSessionResult>((resolve, reject) => {
      session.resolveReady = resolve
      session.rejectReady = reject
      this.openSocket(tileId, session, gatewaySession, sessionUrl)
    })
  }

  async write(tileId: string, data: string): Promise<void> {
    const session = this.sessions.get(tileId)
    if (!session || session.closed || !session.ready) {
      throw new TerminalUnavailableError('Terminal session is not available')
    }
    this.send(session, { type: 'write', data })
  }

  async resize(tileId: string, cols: number, rows: number): Promise<void> {
    const size = {
      cols: boundedDimension(cols, DEFAULT_COLS, MAX_COLS),
      rows: boundedDimension(rows, DEFAULT_ROWS, MAX_ROWS),
    }
    const session = this.sessions.get(tileId)
    if (!session || session.closed || !session.ready) {
      // xterm calculates dimensions before the remote session is ready. Keep
      // that first measurement rather than silently dropping it.
      this.pendingResizes.set(tileId, size)
      return
    }
    session.cols = size.cols
    session.rows = size.rows
    this.send(session, { type: 'resize', ...size })
  }

  async close(tileId: string): Promise<void> {
    this.pendingResizes.delete(tileId)
    const session = this.sessions.get(tileId)
    if (!session) return
    this.sessions.delete(tileId)
    if (!session.ready) {
      session.rejectReady?.(new TerminalUnavailableError('Terminal session was closed before it was ready'))
      session.resolveReady = null
      session.rejectReady = null
    }
    this.closeSession(session, false)
  }

  onData(tileId: string, callback: (data: string) => void): () => void {
    const listeners = this.listenersFor(tileId)
    listeners.data.add(callback)
    const session = this.sessions.get(tileId)
    if (session?.ready && session.pendingData) {
      const buffered = session.pendingData
      session.pendingData = ''
      callback(buffered)
    }
    return () => listeners.data.delete(callback)
  }

  onActive(tileId: string, callback: () => void): () => void {
    const listeners = this.listenersFor(tileId)
    listeners.active.add(callback)
    return () => listeners.active.delete(callback)
  }

  onExit(tileId: string, callback: (exitCode: number) => void): () => void {
    const listeners = this.listenersFor(tileId)
    listeners.exit.add(callback)
    const completedExit = this.completedExits.get(tileId)
    if (completedExit !== undefined) callback(completedExit)
    return () => listeners.exit.delete(callback)
  }

  private openSocket(
    tileId: string,
    session: TerminalSession,
    gatewaySession: GatewaySessionResponse,
    sessionUrl: string,
  ): void {
    let socket: WebSocketLike
    try {
      socket = new (this.WebSocketConstructor as WebSocketConstructor)(
        resolveTerminalWebSocketUrl(gatewaySession.websocketUrl, sessionUrl),
      )
    } catch (error) {
      this.failSession(tileId, session, unavailableFrom(error, 'Terminal WebSocket could not be opened'))
      return
    }

    session.socket = socket
    socket.onopen = () => {
      if (session.closed) return
      try {
        // Attach credentials are deliberately sent in a WebSocket frame, never
        // appended to websocketUrl where logs/proxies could retain them.
        this.send(session, { type: 'attach', attachToken: gatewaySession.attachToken })
      } catch (error) {
        this.failSession(tileId, session, unavailableFrom(error, 'Terminal WebSocket attach failed'))
      }
    }
    socket.onmessage = event => this.handleSocketMessage(tileId, session, event)
    socket.onerror = () => {
      if (!session.ready) this.failSession(tileId, session, new TerminalUnavailableError('Terminal WebSocket connection failed'))
    }
    socket.onclose = () => {
      if (session.closed) return
      if (!session.ready) {
        this.failSession(tileId, session, new TerminalUnavailableError('Terminal WebSocket closed before it was ready'))
        return
      }
      if (!session.exitReceived) this.emitExit(tileId, -1)
      this.sessions.delete(tileId)
      this.closeSession(session, true)
    }
    session.readyTimer = setTimeout(() => {
      this.failSession(tileId, session, new TerminalUnavailableError('Timed out waiting for terminal session readiness'))
    }, this.readyTimeoutMs)
  }

  private handleSocketMessage(tileId: string, session: TerminalSession, event: WebSocketMessageEvent): void {
    if (session.closed || typeof event.data !== 'string') return
    let message: unknown
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    const payload = message as Record<string, unknown>
    const type = payload.type

    if (type === 'ready') {
      this.handleReady(tileId, session, typeof payload.buffer === 'string' ? payload.buffer : '')
      return
    }
    if (type === 'data' && typeof payload.data === 'string') {
      this.emitActive(tileId)
      if (session.ready && this.listenersFor(tileId).data.size > 0) {
        this.emitData(tileId, payload.data)
      } else {
        session.pendingData += payload.data
        if (session.pendingData.length > MAX_PENDING_DATA_CHARS) {
          session.pendingData = session.pendingData.slice(-MAX_PENDING_DATA_CHARS)
        }
      }
      return
    }
    // Gateway errors are an extension to the minimal ready/data/exit protocol.
    // Handle them explicitly so an attach rejection is not reduced to a vague
    // "socket closed" message in the terminal tile.
    if (type === 'error') {
      const message = typeof payload.message === 'string' && payload.message.trim()
        ? payload.message
        : 'Terminal gateway rejected the session'
      if (!session.ready) {
        this.failSession(tileId, session, new TerminalUnavailableError(message))
        return
      }
      this.emitData(tileId, `\r\n\x1b[31m[terminal gateway error: ${message}]\x1b[0m\r\n`)
      session.exitReceived = true
      this.emitExit(tileId, -1)
      this.sessions.delete(tileId)
      this.closeSession(session, true)
      return
    }
    if (type === 'exit') {
      const exitCode = typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode)
        ? Math.trunc(payload.exitCode)
        : -1
      session.exitReceived = true
      if (!session.ready) {
        this.failSession(tileId, session, new TerminalUnavailableError(`Terminal exited before it was ready (code ${exitCode})`))
        return
      }
      this.emitExit(tileId, exitCode)
      this.sessions.delete(tileId)
      this.closeSession(session, true)
    }
  }

  private handleReady(tileId: string, session: TerminalSession, buffer: string): void {
    if (session.ready || session.closed) return
    session.ready = true
    if (session.readyTimer) clearTimeout(session.readyTimer)
    session.readyTimer = null
    const initialBuffer = buffer + session.pendingData
    session.pendingData = ''
    const listeners = this.listenersFor(tileId)
    if (listeners.data.size > 0 && initialBuffer) {
      this.emitData(tileId, initialBuffer)
    }
    this.emitActive(tileId)
    session.resolveReady?.({
      sessionId: session.id,
      // The tile that created the session owns the initial snapshot. Other
      // observers may receive it too, but never steal it from xterm.
      buffer: initialBuffer,
      cols: session.cols,
      rows: session.rows,
    })
    session.resolveReady = null
    session.rejectReady = null

    const pendingSize = this.pendingResizes.get(tileId)
    if (pendingSize) {
      this.pendingResizes.delete(tileId)
      void this.resize(tileId, pendingSize.cols, pendingSize.rows)
    }
  }

  private failSession(tileId: string, session: TerminalSession, error: TerminalUnavailableError): void {
    if (session.closed) return
    this.sessions.delete(tileId)
    this.closeSession(session, false)
    session.rejectReady?.(error)
    session.resolveReady = null
    session.rejectReady = null
  }

  private closeSession(session: TerminalSession, serverAlreadyExited: boolean): void {
    if (session.closed) return
    session.closed = true
    if (session.readyTimer) clearTimeout(session.readyTimer)
    session.readyTimer = null
    if (session.socket) {
      try {
        // Do not route through `send`: this is the one intentional frame sent
        // while transitioning the local session into its closed state.
        if (!serverAlreadyExited) session.socket.send(JSON.stringify({ type: 'close' }))
      } catch {
        // The socket is already gone; closing below still releases the client.
      }
      try {
        session.socket.close()
      } catch {
        // Closing is best-effort during renderer teardown.
      }
    }
  }

  private send(session: TerminalSession, message: Record<string, unknown>): void {
    if (!session.socket || session.closed) throw new TerminalUnavailableError('Terminal WebSocket is not available')
    session.socket.send(JSON.stringify(message))
  }

  private listenersFor(tileId: string): TerminalListeners {
    let listeners = this.listeners.get(tileId)
    if (!listeners) {
      listeners = { data: new Set(), active: new Set(), exit: new Set() }
      this.listeners.set(tileId, listeners)
    }
    return listeners
  }

  private emitData(tileId: string, data: string): void {
    for (const listener of this.listenersFor(tileId).data) listener(data)
  }

  private emitActive(tileId: string): void {
    for (const listener of this.listenersFor(tileId).active) listener()
  }

  private emitExit(tileId: string, exitCode: number): void {
    this.completedExits.set(tileId, exitCode)
    for (const listener of this.listenersFor(tileId).exit) listener(exitCode)
  }
}

export function createTerminalTransport(options?: TerminalTransportOptions): TerminalTransport {
  return new TerminalTransport(options)
}

export function isTerminalTransportAvailable(options?: TerminalTransportOptions): boolean {
  return new TerminalTransport(options).isAvailable()
}
