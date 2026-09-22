import { app, BrowserWindow, session, type KeyboardInputEvent, type MouseInputEvent } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { JsonRpcPeer as _JsonRpcPeer, type JsonValue as _JsonValue, type JsonObject as _JsonObject } from '../extensions/broker/json-rpc'

export type OwlRuntimeKind = 'electron'
// Re-export types from the shared module (owl/runtime.ts previously declared these locally)
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = _JsonValue
export type JsonObject = _JsonObject

export interface OwlSessionRecord {
  id: string
  appName: string
  createdAt: number
  buildFlavor?: string
}

export interface OwlProfileRecord {
  id: string
  sessionId: string
  name: string
  persistent: boolean
  partition: string
  createdAt: number
}

export interface OwlWebViewRecord {
  id: string
  profileId: string
  url: string | null
  width: number
  height: number
  deviceScaleFactor: number
  visible: boolean
  createdAt: number
}

export interface OwlCaptureResult {
  webViewId: string
  mimeType: 'image/png'
  dataBase64: string
  width: number
  height: number
}

export type OwlInputEvent =
  | { type: 'mouseDown' | 'mouseUp' | 'mouseMove'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'keyDown' | 'keyUp'; key: string; modifiers?: string[] }
  | { type: 'text'; text: string }

interface HostedWebView {
  record: OwlWebViewRecord
  profile: OwlProfileRecord
  window: BrowserWindow
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'about:'])

function assertAllowedUrl(raw: string, field: string): string {
  let protocol: string
  try {
    protocol = new URL(raw).protocol
  } catch {
    throw new Error(`${field}: invalid URL`)
  }
  if (!ALLOWED_URL_PROTOCOLS.has(protocol)) {
    throw new Error(`${field}: URL scheme '${protocol}' is not allowed (only http, https, about)`)
  }
  return raw
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function translateOwlInputToElectron(event: OwlInputEvent): Array<KeyboardInputEvent | MouseInputEvent> {
  switch (event.type) {
    case 'mouseDown':
    case 'mouseUp':
    case 'mouseMove':
      return [{ type: event.type, x: event.x, y: event.y, button: event.button ?? 'left' }]
    case 'keyDown':
    case 'keyUp':
      return [{ type: event.type, keyCode: event.key, modifiers: event.modifiers as KeyboardInputEvent['modifiers'] ?? [] }]
    case 'text':
      // One `char` event per Unicode code point so multi-char strings are not truncated
      return Array.from(event.text).map(ch => ({ type: 'char' as const, keyCode: ch }))
  }
}

// JsonRpcPeer alias — imported from the shared broker module above.
const JsonRpcPeer = _JsonRpcPeer

class ElectronOwlHost {
  readonly runtime: OwlRuntimeKind = 'electron'
  private sessions = new Map<string, OwlSessionRecord>()
  private profiles = new Map<string, OwlProfileRecord>()
  private webViews = new Map<string, HostedWebView>()

  async handle(method: string, params: JsonObject = {}): Promise<JsonValue> {
    switch (method) {
      case 'health':
        return { ok: true, runtime: this.runtime, pid: process.pid }
      case 'session.create':
        return this.createSession(params) as unknown as JsonValue
      case 'profile.create':
        return this.createProfile(params) as unknown as JsonValue
      case 'webview.create':
        return await this.createWebView(params) as unknown as JsonValue
      case 'webview.navigate':
        return await this.navigate(params) as unknown as JsonValue
      case 'webview.setGeometry':
        return this.setGeometry(params) as unknown as JsonValue
      case 'webview.dispatchInput':
        return this.dispatchInput(params) as unknown as JsonValue
      case 'webview.capture':
        return await this.capture(params) as unknown as JsonValue
      case 'webview.destroy':
        return this.destroy(params) as unknown as JsonValue
      case 'plugin.list':
        return { plugins: [] }
      default:
        throw new Error(`Unknown OWL method: ${method}`)
    }
  }

  destroyAll(): void {
    for (const hosted of this.webViews.values()) {
      if (!hosted.window.isDestroyed()) hosted.window.destroy()
    }
    this.webViews.clear()
  }

  private createSession(params: JsonObject): OwlSessionRecord {
    const record: OwlSessionRecord = {
      id: id('session'),
      appName: assertString(params.appName, 'appName'),
      createdAt: Date.now(),
      buildFlavor: optionalString(params.buildFlavor),
    }
    this.sessions.set(record.id, record)
    return record
  }

  private createProfile(params: JsonObject): OwlProfileRecord {
    const sessionId = assertString(params.sessionId, 'sessionId')
    if (!this.sessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`)

    const persistent = params.persistent === true && params.isolateForAgent !== true
    const name = optionalString(params.name) ?? (params.isolateForAgent ? 'agent-ephemeral' : 'default')
    const storageKey = optionalString(params.storageKey) ?? id(name.replace(/[^a-z0-9_-]/gi, '-'))
    const partition = persistent ? `persist:owl:${storageKey}` : `owl:memory:${storageKey}`
    session.fromPartition(partition)

    const record: OwlProfileRecord = { id: id('profile'), sessionId, name, persistent, partition, createdAt: Date.now() }
    this.profiles.set(record.id, record)
    return record
  }

  private async createWebView(params: JsonObject): Promise<OwlWebViewRecord> {
    const profile = this.profile(params.profileId)
    const rawUrl = optionalString(params.initialUrl)
    const checkedUrl = rawUrl ? assertAllowedUrl(rawUrl, 'initialUrl') : null
    const record: OwlWebViewRecord = {
      id: id('webview'),
      profileId: profile.id,
      url: checkedUrl,
      width: numberOr(params.width, 1280),
      height: numberOr(params.height, 800),
      deviceScaleFactor: numberOr(params.deviceScaleFactor, 1),
      visible: params.visible === true,
      createdAt: Date.now(),
    }
    const show = process.env.CODESURF_OWL_HOST_SHOW_WINDOWS === '1' && record.visible
    const window = new BrowserWindow({
      show,
      width: record.width,
      height: record.height,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        offscreen: true,
        sandbox: true,
        partition: profile.partition,
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.webViews.set(record.id, { record, profile, window })
    if (record.url) await window.loadURL(record.url)
    return record
  }

  private async navigate(params: JsonObject): Promise<OwlWebViewRecord> {
    const hosted = this.webView(params.webViewId)
    const url = assertAllowedUrl(assertString(params.url, 'url'), 'url')
    await hosted.window.loadURL(url)
    hosted.record = { ...hosted.record, url }
    return hosted.record
  }

  private setGeometry(params: JsonObject): OwlWebViewRecord {
    const hosted = this.webView(params.webViewId)
    const width = numberOr(params.width, hosted.record.width)
    const height = numberOr(params.height, hosted.record.height)
    const deviceScaleFactor = numberOr(params.deviceScaleFactor, hosted.record.deviceScaleFactor)
    hosted.window.setBounds({ width, height })
    hosted.record = { ...hosted.record, width, height, deviceScaleFactor }
    return hosted.record
  }

  private dispatchInput(params: JsonObject): { accepted: boolean; returnedToClient: boolean } {
    const hosted = this.webView(params.webViewId)
    if (params.route === 'browser') return { accepted: false, returnedToClient: true }
    const event = params.event
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('event must be an object')
    for (const inputEvent of translateOwlInputToElectron(event as OwlInputEvent)) {
      hosted.window.webContents.sendInputEvent(inputEvent)
    }
    return { accepted: true, returnedToClient: false }
  }

  private async capture(params: JsonObject): Promise<OwlCaptureResult> {
    const hosted = this.webView(params.webViewId)
    const image = await hosted.window.webContents.capturePage()
    const png = image.toPNG()
    return {
      webViewId: hosted.record.id,
      mimeType: 'image/png',
      dataBase64: png.toString('base64'),
      width: hosted.record.width,
      height: hosted.record.height,
    }
  }

  private destroy(params: JsonObject): { ok: true } {
    const hosted = this.webView(params.webViewId)
    if (!hosted.window.isDestroyed()) hosted.window.destroy()
    this.webViews.delete(hosted.record.id)
    return { ok: true }
  }

  private profile(profileId: unknown): OwlProfileRecord {
    const profile = this.profiles.get(assertString(profileId, 'profileId'))
    if (!profile) throw new Error(`Unknown profile: ${String(profileId)}`)
    return profile
  }

  private webView(webViewId: unknown): HostedWebView {
    const hosted = this.webViews.get(assertString(webViewId, 'webViewId'))
    if (!hosted) throw new Error(`Unknown webView: ${String(webViewId)}`)
    return hosted
  }
}

export function isOwlHostProcess(): boolean {
  return process.env.CODESURF_OWL_HOST === '1' || process.argv.includes('--codesurf-owl-host')
}

export async function runOwlHostProcess(): Promise<void> {
  await app.whenReady()
  const host = new ElectronOwlHost()
  const peer = new JsonRpcPeer(
    line => process.stdout.write(line + '\n'),
    (method, params) => host.handle(method, params),
  )

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => peer.feed(String(chunk)))
  process.stdin.on('end', () => app.quit())
  process.on('SIGTERM', () => app.quit())
  app.on('before-quit', () => {
    host.destroyAll()
    peer.close('OWL host process quitting')
  })
}

const OWL_RESTART_BACKOFF_BASE_MS = 250
const OWL_RESTART_BACKOFF_MAX_MS = 5_000

export class StdioOwlHostSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private peer: InstanceType<typeof _JsonRpcPeer> | null = null
  private stderr = ''
  /** Single in-flight start promise prevents concurrent double-starts. */
  private starting: Promise<void> | null = null
  /** Set to true on unexpected child exit; next call() rejects with a clear error then clears. */
  private restartedSinceLastCall = false
  private restartBackoffMs = OWL_RESTART_BACKOFF_BASE_MS

  async start(): Promise<void> {
    if (this.child && this.peer) return
    // Deduplicate concurrent start() calls
    if (this.starting) return this.starting
    this.starting = this._doStart().finally(() => { this.starting = null })
    return this.starting
  }

  private async _doStart(): Promise<void> {
    const args = process.defaultApp ? [app.getAppPath(), '--codesurf-owl-host'] : ['--codesurf-owl-host']
    const child = spawn(process.execPath, args, {
      cwd: app.getAppPath(),
      env: {
        ...process.env,
        CODESURF_OWL_HOST: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const peer = new JsonRpcPeer(line => child.stdin.write(line + '\n'))
    this.child = child
    this.peer = peer

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => peer.feed(String(chunk)))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      this.stderr += String(chunk)
      if (this.stderr.length > 128 * 1024) this.stderr = this.stderr.slice(-128 * 1024)
    })
    child.once('error', error => {
      peer.close(`OWL host process error: ${error.message}`)
      this.child = null
      this.peer = null
      this.restartedSinceLastCall = true
    })
    child.once('exit', (code, signal) => {
      peer.close(`OWL host process exited: code=${code ?? 'null'} signal=${signal ?? 'null'} stderr=${this.stderr.slice(-1000)}`)
      this.child = null
      this.peer = null
      this.restartedSinceLastCall = true
    })

    await peer.call('health', {}, 5000)
    // Successful start — reset backoff
    this.restartBackoffMs = OWL_RESTART_BACKOFF_BASE_MS
  }

  async call(method: string, params: JsonObject = {}): Promise<JsonValue> {
    if (this.restartedSinceLastCall) {
      this.restartedSinceLastCall = false
      throw new Error('OWL host restarted; session state lost. Please reinitialise the session.')
    }
    try {
      await this.start()
    } catch (err) {
      // Back off before the next restart attempt
      await new Promise<void>(res => setTimeout(res, this.restartBackoffMs))
      this.restartBackoffMs = Math.min(this.restartBackoffMs * 2, OWL_RESTART_BACKOFF_MAX_MS)
      throw err
    }
    if (!this.peer) throw new Error('OWL host is not started')
    return this.peer.call(method, params)
  }

  stop(): void {
    const child = this.child
    this.child = null
    this.peer?.close('OWL host supervisor stopped')
    this.peer = null
    this.starting = null
    if (!child) return
    child.stdin.end()
    child.kill('SIGTERM')
  }

  getStderrTail(): string {
    return this.stderr
  }
}

let supervisor: StdioOwlHostSupervisor | null = null

export function getOwlSupervisor(): StdioOwlHostSupervisor {
  supervisor ??= new StdioOwlHostSupervisor()
  return supervisor
}

export function stopOwlSupervisor(): void {
  supervisor?.stop()
  supervisor = null
}
