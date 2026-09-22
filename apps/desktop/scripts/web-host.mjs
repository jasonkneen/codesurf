/**
 * CodeSurf web / Native host API (Agensis-style fixed port).
 *
 * Electron keeps full IPC. Browser + Native WebView talk here:
 *  - Proxies `/d/*` → live codesurfd with auth injected from pid.json
 *  - Serves canvas/settings/workspace helpers under `/host/*`
 *  - CORS for Vite (5173) and same-origin production
 *
 * Port: CODESURF_WEB_HOST_PORT (default 4177, 0 is allowed for a sidecar)
 */
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  constants as fsConstants,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve, basename, extname, normalize, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform as osPlatform } from 'node:os'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HOME = process.env.CODESURF_HOME?.trim() || join(homedir(), '.codesurf')
const PID_PATH = process.env.CODESURF_DAEMON_PID_PATH || join(HOME, 'daemon', 'pid.json')
const HOST_PORT = Number(process.env.CODESURF_WEB_HOST_PORT || 4177)
const requestedBind = process.env.CODESURF_WEB_HOST_BIND || '127.0.0.1'
const HOST_BIND = requestedBind === 'localhost' ? '127.0.0.1' : requestedBind
const MAX_BODY_BYTES = Number(process.env.CODESURF_WEB_HOST_MAX_BODY_BYTES || 1_048_576)
const RUNTIME_CONFIG_PATH = process.env.CODESURF_RUNTIME_CONFIG_PATH?.trim() || null
const TERMINAL_ENDPOINT = process.env.CODESURF_TERMINAL_GATEWAY_URL?.trim()
  || process.env.CODESURF_TERMINAL_ENDPOINT?.trim()
  || null
const TERMINAL_TOKEN = process.env.CODESURF_TERMINAL_TOKEN?.trim() || null
const HOST_TOKEN = process.env.CODESURF_WEB_HOST_TOKEN?.trim() || randomBytes(32).toString('base64url')
const HOST_UI_STATE_PATHS = new Map([
  // Renderer compatibility path. Keep this an exact allow-list rather than
  // exposing the CodeSurf home, which also contains daemon credentials.
  ['~/.codesurf/layout-templates.json', join(HOME, 'layout-templates.json')],
])
const DEFAULT_CORS_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4177',
  'http://localhost:4177',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'zero://app',
]
const CORS_ORIGINS = new Set([
  ...DEFAULT_CORS_ORIGINS,
  ...(process.env.CODESURF_WEB_HOST_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
])

for (const origin of CORS_ORIGINS) {
  if (origin === 'zero://app') continue
  let parsed
  try { parsed = new URL(origin) } catch { throw new Error(`Invalid CORS origin: ${origin}`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error(`CORS origins must be explicit http(s) origins: ${origin}`)
  }
}

if (!Number.isInteger(HOST_PORT) || HOST_PORT < 0 || HOST_PORT > 65535) {
  throw new Error(`CODESURF_WEB_HOST_PORT must be a TCP port, got ${HOST_PORT}`)
}

if (!['127.0.0.1', '::1'].includes(HOST_BIND)) {
  throw new Error('web-host is local-only: CODESURF_WEB_HOST_BIND must be 127.0.0.1 or ::1')
}

if (!Number.isInteger(MAX_BODY_BYTES) || MAX_BODY_BYTES < 1 || MAX_BODY_BYTES > 16 * 1024 * 1024) {
  throw new Error('CODESURF_WEB_HOST_MAX_BODY_BYTES must be between 1 byte and 16 MiB')
}

let boundPort = HOST_PORT
let ownedDaemon = null
let daemonStartPromise = null

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function atomicWriteJson(path, value) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

function hostBase() {
  const authority = HOST_BIND.includes(':') ? `[${HOST_BIND}]` : HOST_BIND
  return `http://${authority}:${boundPort}`
}

function writeRuntimeConfig() {
  if (!RUNTIME_CONFIG_PATH) return
  atomicWriteJson(RUNTIME_CONFIG_PATH, {
    hostBase: hostBase(),
    hostToken: HOST_TOKEN,
    terminal: {
      endpoint: TERMINAL_ENDPOINT,
      token: TERMINAL_TOKEN,
    },
  })
}

function requestOrigin(req) {
  const value = req.headers.origin
  return typeof value === 'string' ? value.trim() : ''
}

function isAllowedOrigin(origin) {
  // A non-browser client has no Origin header. It must still supply the
  // per-launch host token, and the listener is pinned to loopback.
  return !origin || CORS_ORIGINS.has(origin)
}

function setCors(req, res) {
  const origin = requestOrigin(req)
  if (!origin || !isAllowedOrigin(origin)) return
  res.setHeader('Vary', 'Origin')
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Codesurf-Host')
  res.setHeader('Access-Control-Max-Age', '600')
}

function tokenMatches(candidate, expected) {
  if (!candidate || !expected) return false
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function hasHostAccess(req) {
  const value = req.headers['x-codesurf-host']
  const token = Array.isArray(value) ? value[0] : value
  return typeof token === 'string' && tokenMatches(token, HOST_TOKEN)
}

function isPublicHostRoute(pathname) {
  return pathname === '/' || pathname === '/health' || pathname === '/host/health'
}

// `/d/*` carries the daemon's private bearer. It is a deliberately small
// browser-facing capability surface, not a transparent proxy: in particular
// it must never expose daemon host records, raw settings, PID state, or MCP
// credentials that happen to be available on localhost.
const DAEMON_ROUTE_POLICY = new Set([
  'GET /workspace/list',
  'GET /workspace/projects',
  'GET /workspace/active',
  'POST /workspace/create',
  'POST /workspace/create-with-path',
  'POST /workspace/create-from-folder',
  'POST /workspace/add-project-folder',
  'POST /workspace/remove-project-folder',
  'POST /workspace/project/rename',
  'POST /workspace/project/worktree',
  'POST /workspace/set-active',
  'GET /session/local/list',
  'GET /session/local/state',
  'POST /session/local/delete',
  'POST /session/local/rename',
  'POST /checkpoint/list',
  'POST /checkpoint/restore',
  'GET /settings',
  'POST /settings',
  'POST /chat/job/start',
  'GET /chat/job/state',
  'GET /chat/job/events',
  'POST /chat/job/permission/answer',
  'POST /chat/job/cancel',
  'GET /dashboard/api/jobs',
])

function daemonRouteIsAllowed(method, pathname) {
  if (DAEMON_ROUTE_POLICY.has(`${method} ${pathname}`)) return true
  // Workspace IDs are opaque daemon identifiers, never a path. Keep this
  // pattern narrow so encoded slashes or arbitrary daemon routes cannot pass.
  return method === 'DELETE' && /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pathname)
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readBuffer(req, maxBytes = MAX_BODY_BYTES) {
  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, `request body exceeds ${maxBytes} byte limit`)
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      throw new HttpError(413, `request body exceeds ${maxBytes} byte limit`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export function projectRegistryPath(homePath = HOME) {
  return join(homePath, 'projects', 'projects.json')
}

function configuredProjectRoots() {
  const projectDoc = readJson(projectRegistryPath(), { projects: [] })
  const projectRoots = Array.isArray(projectDoc?.projects)
    ? projectDoc.projects
      .map(project => typeof project?.path === 'string' ? project.path.trim() : '')
      .filter(Boolean)
    : []
  const explicitRoots = (process.env.CODESURF_WEB_HOST_ALLOWED_ROOTS || '')
    .split(',')
    .map(root => root.trim())
    .filter(Boolean)

  // Host metadata can be read/written only below workspaces; sensitive daemon
  // credentials live beside it, not inside it.
  return [...new Set([
    join(HOME, 'workspaces'),
    ...projectRoots,
    ...explicitRoots,
  ].map(root => resolve(root)))]
}

function pathIsInside(root, candidate) {
  const rel = relative(root, candidate)
  // path.relative yields a single native separator (`..\x` on Windows,
  // `../x` elsewhere). The Windows branch previously matched `..\\` (two
  // backslashes) and never fired, so escaping paths were treated as inside.
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

function realPathIfPresent(value) {
  try {
    return realpathSync(value)
  } catch {
    return null
  }
}

export function assertNoSymlinkPath(rootPath, targetPath, { allowMissing = true } = {}) {
  const root = resolve(rootPath)
  const target = resolve(targetPath)
  if (!pathIsInside(root, target)) throw new Error('Collab path escape blocked')

  const rootStat = lstatIfPresent(root)
  if (!rootStat) throw new Error('Collab workspace root does not exist')
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Collab workspace root must be a non-symlink directory')
  }
  const rootReal = realpathSync(root)

  let current = root
  const rel = relative(root, target)
  const parts = rel ? rel.split(/[\\/]+/).filter(Boolean) : []
  for (const part of parts) {
    current = join(current, part)
    const currentStat = lstatIfPresent(current)
    if (!currentStat) {
      if (!allowMissing) throw new Error('Collab path does not exist')
      break
    }
    if (currentStat.isSymbolicLink()) {
      throw new Error('Collab symlink or junction escape blocked')
    }
    const currentReal = realpathSync(current)
    if (!pathIsInside(rootReal, currentReal)) {
      throw new Error('Collab canonical path escape blocked')
    }
  }

  if (!allowMissing && !lstatIfPresent(target)) throw new Error('Collab path does not exist')
  return { root, rootReal, target }
}

function lstatIfPresent(value) {
  try {
    return lstatSync(value)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function ensureDirectoryTreeNoFollow(rootPath, targetPath) {
  const authorized = assertNoSymlinkPath(rootPath, targetPath)
  let current = authorized.root
  const rel = relative(authorized.root, authorized.target)
  const parts = rel ? rel.split(/[\\/]+/).filter(Boolean) : []

  for (const part of parts) {
    current = join(current, part)
    let currentStat = lstatIfPresent(current)
    if (!currentStat) {
      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      currentStat = lstatIfPresent(current)
    }
    if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error('Collab directory path contains a symlink, junction, or non-directory')
    }
    const currentReal = realpathSync(current)
    if (!pathIsInside(authorized.rootReal, currentReal)) {
      throw new Error('Collab canonical directory escape blocked')
    }
  }

  return authorized.target
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino
}

function assertCanonicalCollabTarget(authorized, targetPath, expectedCanonical) {
  const canonical = realPathIfPresent(targetPath)
  if (!canonical || !pathIsInside(authorized.rootReal, canonical)) {
    throw new Error('Collab canonical path changed during access')
  }
  if (expectedCanonical && canonical !== expectedCanonical) {
    throw new Error('Collab canonical path changed during access')
  }
  return canonical
}

function readCollabFileNoFollow(rootPath, filePath) {
  const authorized = assertNoSymlinkPath(rootPath, filePath, { allowMissing: false })
  const pathStat = lstatSync(filePath)
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error('Collab read target must be a non-symlink regular file')
  }
  // O_NOFOLLOW protects only the final component. Retain the canonical target
  // and re-check it after opening so an ancestor swap cannot redirect a read
  // between lexical authorization and the file-handle operation.
  const canonicalTarget = assertCanonicalCollabTarget(authorized, filePath)

  const fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = fstatSync(fd)
    if (
      !openedStat.isFile()
      || !sameFileIdentity(openedStat, pathStat)
    ) {
      throw new Error('Collab read target changed during access')
    }
    assertCanonicalCollabTarget(authorized, filePath, canonicalTarget)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function writeCollabFileNoFollow(rootPath, filePath, content) {
  const parentPath = dirname(filePath)
  ensureDirectoryTreeNoFollow(rootPath, parentPath)
  const authorized = assertNoSymlinkPath(rootPath, filePath)
  const canonicalParent = assertCanonicalCollabTarget(authorized, parentPath)
  const pathStat = lstatIfPresent(filePath)
  if (pathStat && (pathStat.isSymbolicLink() || !pathStat.isFile())) {
    throw new Error('Collab write target must be a non-symlink regular file')
  }
  const canonicalTarget = pathStat
    ? assertCanonicalCollabTarget(authorized, filePath)
    : null

  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_TRUNC
    | (fsConstants.O_NOFOLLOW ?? 0)
  const fd = openSync(filePath, flags, 0o600)
  try {
    const openedStat = fstatSync(fd)
    if (
      !openedStat.isFile()
      || (pathStat && !sameFileIdentity(openedStat, pathStat))
    ) {
      throw new Error('Collab write target changed during access')
    }
    // Revalidate both the parent and the final path after open. This closes
    // the common ancestor-replacement window while retaining a handle for the
    // actual write. A platform-native openat/unlinkat capability would be
    // required to eliminate every same-user race on Node-supported targets.
    assertCanonicalCollabTarget(authorized, parentPath, canonicalParent)
    assertCanonicalCollabTarget(authorized, filePath, canonicalTarget)
    writeFileSync(fd, content, { encoding: 'utf8' })
  } finally {
    closeSync(fd)
  }
}

function resolveAllowedFsPath(input, { allowMissing = true } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, 'path required')
  const normalizedInput = input.trim()
  const uiStatePath = HOST_UI_STATE_PATHS.get(normalizedInput)
  const candidate = resolve(uiStatePath ?? normalizedInput)
  const candidateReal = realPathIfPresent(candidate)

  if (uiStatePath) {
    const homeRoot = resolve(HOME)
    const homeRootReal = realPathIfPresent(homeRoot)
    if (!homeRootReal) throw new HttpError(503, 'CodeSurf home is unavailable')
    if (candidateReal && !pathIsInside(homeRootReal, candidateReal)) {
      throw new HttpError(403, 'UI state path escapes the CodeSurf home')
    }
    let parent = candidate
    while (!existsSync(parent)) {
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
    const parentReal = realPathIfPresent(parent)
    if (!parentReal || !pathIsInside(homeRootReal, parentReal)) {
      throw new HttpError(403, 'UI state parent escapes the CodeSurf home')
    }
    return candidate
  }

  for (const root of configuredProjectRoots()) {
    const rootReal = realPathIfPresent(root)
    if (!rootReal) continue
    if (!pathIsInside(root, candidate)) continue

    if (candidateReal && !pathIsInside(rootReal, candidateReal)) {
      continue
    }

    // For a new file, verify the nearest existing parent to prevent a symlink
    // placed between the root and target from escaping the allowlisted root.
    let parent = candidate
    while (!existsSync(parent)) {
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
    const parentReal = realPathIfPresent(parent)
    if (parentReal && !pathIsInside(rootReal, parentReal)) continue
    return candidate
  }

  if (!allowMissing && !existsSync(candidate)) throw new HttpError(404, 'path not found')
  throw new HttpError(403, 'path is outside registered CodeSurf workspace roots')
}

function safeId(id) {
  const s = String(id ?? '').trim()
  if (!s || /[\/\\]|\.\./.test(s)) throw new Error(`Unsafe id: ${id}`)
  return s
}

function canvasStatePath(workspaceId) {
  return join(HOME, 'workspaces', safeId(workspaceId), '.codesurf', 'canvas-state.json')
}

function tileStatePath(workspaceId, tileId) {
  return join(HOME, 'workspaces', safeId(workspaceId), '.codesurf', `tile-state-${safeId(tileId)}.json`)
}

function readDaemonInfo() {
  const parsed = readJson(PID_PATH, null)
  if (
    !parsed
    || !Number.isInteger(parsed.port)
    || parsed.port < 1
    || parsed.port > 65535
    || typeof parsed.token !== 'string'
    || parsed.token.length < 24
  ) {
    return null
  }
  return {
    pid: parsed.pid,
    port: parsed.port,
    token: parsed.token,
    startedAt: parsed.startedAt ?? null,
    protocolVersion: parsed.protocolVersion ?? parsed.version ?? null,
    appVersion: parsed.appVersion ?? null,
  }
}

async function daemonHealth(info) {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function startOwnedDaemon() {
  const daemonScript = resolve(ROOT, 'bin/codesurfd.mjs')
  if (!existsSync(daemonScript)) {
    throw new Error(`codesurfd not found at ${daemonScript}`)
  }

  ensureDir(join(HOME, 'daemon'))
  ownedDaemon = spawn(process.execPath, [daemonScript], {
    cwd: ROOT,
    detached: false,
    stdio: 'ignore',
    env: {
      ...process.env,
      CODESURF_HOME: HOME,
      CODESURF_APP_VERSION: process.env.CODESURF_APP_VERSION || '0.1.0-web',
    },
  })
  ownedDaemon.once('exit', () => { ownedDaemon = null })

  const start = Date.now()
  while (Date.now() - start < 20_000) {
    const info = readDaemonInfo()
    if (info && await daemonHealth(info)) return info
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  }
  throw new Error('Timed out waiting for codesurfd')
}

async function ensureDaemon() {
  const existing = readDaemonInfo()
  if (existing && await daemonHealth(existing)) return existing
  if (!daemonStartPromise) {
    daemonStartPromise = startOwnedDaemon().finally(() => { daemonStartPromise = null })
  }
  return daemonStartPromise
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req) {
  const raw = (await readBuffer(req)).toString('utf8')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function proxyDaemon(req, res, daemonPath) {
  const info = await ensureDaemon()
  const target = new URL(daemonPath, `http://127.0.0.1:${info.port}`)
  // Preserve query from original URL if present
  const incoming = new URL(req.url || '/', hostBase())
  for (const [k, v] of incoming.searchParams) target.searchParams.set(k, v)

  const method = req.method || 'GET'
  const headers = {
    Authorization: `Bearer ${info.token}`,
    Accept: req.headers.accept || '*/*',
  }
  let body
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readBuffer(req)
    if (body.length > 0) {
      headers['Content-Type'] = req.headers['content-type'] || 'application/json'
      headers['Content-Length'] = String(body.length)
    }
  }

  const controller = new AbortController()
  const headerTimeout = setTimeout(() => controller.abort(), 15_000)
  const abortForDisconnect = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abortForDisconnect)
  res.once('close', abortForDisconnect)

  let upstream
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      signal: controller.signal,
      redirect: 'error',
    })
  } finally {
    clearTimeout(headerTimeout)
  }

  const outHeaders = {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  }
  if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
    outHeaders['Cache-Control'] = 'no-cache'
    outHeaders['Connection'] = 'keep-alive'
    outHeaders['X-Accel-Buffering'] = 'no'
  }
  res.writeHead(upstream.status, outHeaders)
  if (!upstream.body) {
    res.end()
    return
  }
  try {
    for await (const chunk of upstream.body) {
      if (res.destroyed) break
      if (!res.write(chunk)) {
        await new Promise(resolveDrain => res.once('drain', resolveDrain))
      }
    }
    if (!res.writableEnded) res.end()
  } finally {
    req.removeListener('aborted', abortForDisconnect)
    res.removeListener('close', abortForDisconnect)
  }
}

async function daemonJson(path, { method = 'GET', body = undefined } = {}) {
  const info = await ensureDaemon()
  const headers = {
    Authorization: `Bearer ${info.token}`,
    Accept: 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(new URL(path, `http://127.0.0.1:${info.port}`), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  })
  const text = await res.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = { error: text } }
  if (!res.ok) throw new HttpError(res.status, typeof payload?.error === 'string' ? payload.error : `daemon request failed: ${res.status}`)
  return payload
}

function listDirSafe(dirPath) {
  const entries = readdirSync(dirPath, { withFileTypes: true })
  return entries.map(entry => ({
    name: entry.name,
    path: join(dirPath, entry.name),
    isDir: entry.isDirectory(),
    ext: entry.isDirectory() ? '' : extname(entry.name).replace(/^\./, ''),
  }))
}

async function handleHost(req, res, url) {
  const method = req.method || 'GET'
  const path = url.pathname

  if (method === 'GET' && path === '/host/health') {
    const daemon = readDaemonInfo()
    const daemonOk = daemon ? await daemonHealth(daemon) : false
    return sendJson(res, 200, {
      ok: true,
      host: 'codesurf-web-host',
      platform: 'web-host',
      daemon: { running: daemonOk },
    })
  }

  if (method === 'GET' && path === '/host/config') {
    await ensureDaemon()
    return sendJson(res, 200, {
      hostBase: hostBase(),
      capabilities: {
        workspace: true,
        canvas: true,
        settings: true,
        chatJobs: true,
        sessions: true,
        fs: true,
        terminal: Boolean(TERMINAL_ENDPOINT && TERMINAL_TOKEN),
        terminalWorkspaceRootConfigured: process.env.CODESURF_TERMINAL_WORKSPACE_ROOT_CONFIGURED !== '0',
        extensions: false,
        nodePty: false,
      },
    })
  }

  if (method === 'GET' && path === '/host/settings') {
    return sendJson(res, 200, await daemonJson('/settings'))
  }

  if (method === 'POST' && path === '/host/settings') {
    const body = await readBody(req)
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'expected object' })
    return sendJson(res, 200, await daemonJson('/settings', {
      method: 'POST',
      body: { settings: body.settings && typeof body.settings === 'object' ? body.settings : body },
    }))
  }

  if (method === 'GET' && path === '/host/canvas/load') {
    const workspaceId = url.searchParams.get('workspaceId')
    if (!workspaceId) return sendJson(res, 400, { error: 'workspaceId required' })
    const file = canvasStatePath(workspaceId)
    if (!existsSync(file)) return sendJson(res, 200, null)
    return sendJson(res, 200, readJson(file, null))
  }

  if (method === 'POST' && path === '/host/canvas/save') {
    const body = await readBody(req)
    const workspaceId = body?.workspaceId
    if (!workspaceId) return sendJson(res, 400, { error: 'workspaceId required' })
    atomicWriteJson(canvasStatePath(workspaceId), body.state ?? null)
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'GET' && path === '/host/canvas/tile') {
    const workspaceId = url.searchParams.get('workspaceId')
    const tileId = url.searchParams.get('tileId')
    if (!workspaceId || !tileId) return sendJson(res, 400, { error: 'workspaceId and tileId required' })
    const file = tileStatePath(workspaceId, tileId)
    if (!existsSync(file)) return sendJson(res, 200, null)
    return sendJson(res, 200, readJson(file, null))
  }

  if (method === 'POST' && path === '/host/canvas/tile') {
    const body = await readBody(req)
    if (!body?.workspaceId || !body?.tileId) return sendJson(res, 400, { error: 'workspaceId and tileId required' })
    atomicWriteJson(tileStatePath(body.workspaceId, body.tileId), body.state ?? null)
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'GET' && path === '/host/fs/readDir') {
    const dir = url.searchParams.get('path')
    if (!dir) return sendJson(res, 400, { error: 'path required' })
    try {
      return sendJson(res, 200, listDirSafe(resolveAllowedFsPath(dir, { allowMissing: false })))
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'GET' && path === '/host/fs/readFile') {
    const filePath = url.searchParams.get('path')
    if (!filePath) return sendJson(res, 400, { error: 'path required' })
    try {
      const abs = resolveAllowedFsPath(filePath)
      if (!existsSync(abs)) {
        // Missing optional config files are normal (skills.json, etc.)
        return sendJson(res, 200, { content: null, missing: true })
      }
      const raw = readFileSync(abs, 'utf8')
      return sendJson(res, 200, { content: raw, missing: false })
    } catch (err) {
      const code = err?.code || ''
      if (code === 'ENOENT') return sendJson(res, 200, { content: null, missing: true })
      return sendJson(res, err?.status || 400, { error: String(err?.message || err), code })
    }
  }

  if (method === 'GET' && path === '/host/fs/readFilePrefix') {
    const filePath = url.searchParams.get('path')
    const maxBytes = Number(url.searchParams.get('maxBytes'))
    if (!filePath) return sendJson(res, 400, { error: 'path required' })
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) {
      return sendJson(res, 400, { error: 'maxBytes must be an integer between 1 and 65536' })
    }
    let fd = null
    try {
      const abs = resolveAllowedFsPath(filePath)
      if (!existsSync(abs)) return sendJson(res, 200, { content: null, missing: true })
      const pathStat = lstatSync(abs)
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new HttpError(400, 'path must be a regular non-symbolic file')
      fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const openedStat = fstatSync(fd)
      if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) throw new HttpError(400, 'path changed during access')
      const allocation = Math.min(openedStat.size, maxBytes)
      const buffer = Buffer.allocUnsafe(allocation)
      let offset = 0
      while (offset < allocation) {
        const bytesRead = readSync(fd, buffer, offset, allocation - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      return sendJson(res, 200, { content: buffer.subarray(0, offset).toString('utf8'), missing: false })
    } catch (err) {
      const code = err?.code || ''
      if (code === 'ENOENT') return sendJson(res, 200, { content: null, missing: true })
      return sendJson(res, err?.status || 400, { error: String(err?.message || err), code })
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }

  if (method === 'POST' && path === '/host/fs/writeFile') {
    const body = await readBody(req)
    if (!body?.path || typeof body.content !== 'string') {
      return sendJson(res, 400, { error: 'path and content required' })
    }
    try {
      const filePath = resolveAllowedFsPath(body.path)
      ensureDir(dirname(filePath))
      writeFileSync(filePath, body.content, { encoding: 'utf8', mode: 0o600 })
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/fs/mkdir') {
    const body = await readBody(req)
    if (!body?.path) return sendJson(res, 400, { error: 'path required' })
    try {
      ensureDir(resolveAllowedFsPath(body.path))
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/fs/remove') {
    const body = await readBody(req)
    if (!body?.path) return sendJson(res, 400, { error: 'path required' })
    try {
      rmSync(resolveAllowedFsPath(body.path, { allowMissing: false }), { recursive: true, force: true })
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, err?.status || 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'GET' && path === '/host/fs/stat') {
    const filePath = url.searchParams.get('path')
    if (!filePath) return sendJson(res, 400, { error: 'path required' })
    try {
      const st = statSync(resolveAllowedFsPath(filePath, { allowMissing: false }))
      return sendJson(res, 200, {
        size: st.size,
        mtimeMs: st.mtimeMs,
        isFile: st.isFile(),
        isDir: st.isDirectory(),
      })
    } catch (err) {
      if (err?.status) return sendJson(res, err.status, { error: String(err.message || err) })
      return sendJson(res, 200, null)
    }
  }

  if (method === 'GET' && path === '/host/fs/basename') {
    const filePath = url.searchParams.get('path') || ''
    return sendJson(res, 200, { name: basename(filePath) })
  }

  // ── Collab protocol (matches Electron tile dirs under .codesurf/{tileId}) ──
  function collabTileTarget(workspacePath, tileId) {
    const safeTile = String(tileId || '').trim()
    if (!safeTile || /[\/\\]|\.\./.test(safeTile)) throw new Error(`Unsafe tileId: ${tileId}`)
    const workspaceRoot = resolveAllowedFsPath(String(workspacePath || ''), { allowMissing: false })
    const tileDir = join(workspaceRoot, '.codesurf', safeTile)
    assertNoSymlinkPath(workspaceRoot, tileDir)
    return { workspaceRoot, tileDir }
  }

  function collabFileTarget(workspacePath, tileId, relativeFile) {
    const target = collabTileTarget(workspacePath, tileId)
    const rel = String(relativeFile || '').replace(/^\/+/, '')
    if (!rel || rel.includes('..')) throw new Error(`Unsafe file path: ${relativeFile}`)
    const filePath = normalize(join(target.tileDir, rel))
    if (!pathIsInside(target.tileDir, filePath)) throw new Error('Path escape blocked')
    assertNoSymlinkPath(target.workspaceRoot, filePath)
    return { ...target, filePath }
  }

  if (method === 'POST' && path === '/host/collab/ensureDir') {
    const body = await readBody(req)
    try {
      const { workspaceRoot, tileDir } = collabTileTarget(body?.workspacePath, body?.tileId)
      ensureDirectoryTreeNoFollow(workspaceRoot, tileDir)
      ensureDirectoryTreeNoFollow(workspaceRoot, join(tileDir, 'context'))
      for (const mailbox of ['inbox', 'sent', 'memory', 'bin']) {
        ensureDirectoryTreeNoFollow(workspaceRoot, join(tileDir, 'messages', mailbox))
      }
      return sendJson(res, 200, { ok: true, path: tileDir })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/write') {
    const body = await readBody(req)
    try {
      const { workspaceRoot, filePath } = collabFileTarget(body?.workspacePath, body?.tileId, body?.file)
      writeCollabFileNoFollow(workspaceRoot, filePath, String(body?.content ?? ''))
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/read') {
    const body = await readBody(req)
    try {
      const { workspaceRoot, filePath } = collabFileTarget(body?.workspacePath, body?.tileId, body?.file)
      if (!existsSync(filePath)) return sendJson(res, 200, { content: null })
      return sendJson(res, 200, { content: readCollabFileNoFollow(workspaceRoot, filePath) })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/list') {
    const body = await readBody(req)
    try {
      const { workspaceRoot, filePath: dirPath } = collabFileTarget(body?.workspacePath, body?.tileId, body?.dir || '.')
      if (!existsSync(dirPath)) return sendJson(res, 200, { entries: [] })
      assertNoSymlinkPath(workspaceRoot, dirPath, { allowMissing: false })
      const dirStat = lstatSync(dirPath)
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw new Error('Collab list target must be a non-symlink directory')
      }
      const entries = readdirSync(dirPath, { withFileTypes: true }).map(entry => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        isDir: entry.isDirectory(),
      }))
      return sendJson(res, 200, { entries })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/remove') {
    const body = await readBody(req)
    try {
      const { workspaceRoot, filePath } = collabFileTarget(body?.workspacePath, body?.tileId, body?.file)
      if (existsSync(filePath)) assertNoSymlinkPath(workspaceRoot, filePath, { allowMissing: false })
      rmSync(filePath, { force: true })
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/removeDir') {
    const body = await readBody(req)
    try {
      const { workspaceRoot, tileDir } = collabTileTarget(body?.workspacePath, body?.tileId)
      if (existsSync(tileDir)) assertNoSymlinkPath(workspaceRoot, tileDir, { allowMissing: false })
      rmSync(tileDir, { recursive: true, force: true })
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  // ── Native OS dialogs (local web-host only; never window.prompt) ─────────
  // Browser clients call these so the host machine shows a real folder picker
  // and returns an absolute path the daemon can use.
  if (method === 'POST' && path === '/host/dialog/openFolder') {
    try {
      const body = await readBody(req)
      const prompt = String(body?.prompt || 'Choose project folder').slice(0, 120)
      const picked = await openNativeFolderDialog(prompt)
      return sendJson(res, 200, { path: picked, cancelled: !picked })
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message || err), path: null })
    }
  }

  if (method === 'POST' && path === '/host/dialog/openFile') {
    try {
      const body = await readBody(req)
      const prompt = String(body?.prompt || 'Choose file').slice(0, 120)
      const picked = await openNativeFileDialog(prompt)
      return sendJson(res, 200, { path: picked, cancelled: !picked })
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message || err), path: null })
    }
  }

  return sendJson(res, 404, { error: `unknown host route ${path}` })
}

/**
 * Show a real OS folder picker on the machine running web-host.
 * Returns absolute path or null if cancelled.
 */
function openNativeFolderDialog(promptText) {
  return new Promise((resolvePromise, reject) => {
    const plat = osPlatform()
    let child
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolvePromise(value)
    }

    if (plat === 'darwin') {
      // AppleScript choose folder → POSIX path (trailing slash stripped)
      const script = [
        `try`,
        `  set theFolder to choose folder with prompt ${JSON.stringify(promptText)}`,
        `  return POSIX path of theFolder`,
        `on error`,
        `  return ""`,
        `end try`,
      ].join('\n')
      child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    } else if (plat === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        `$d.Description = ${JSON.stringify(promptText)}`,
        '$d.ShowNewFolderButton = $true',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  [Console]::Out.Write($d.SelectedPath)',
        '}',
      ].join('; ')
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } else {
      // Linux: prefer zenity, then kdialog
      const zenity = spawnSync('which', ['zenity'], { encoding: 'utf8' })
      const kdialog = spawnSync('which', ['kdialog'], { encoding: 'utf8' })
      if (zenity.status === 0) {
        child = spawn('zenity', ['--file-selection', '--directory', `--title=${promptText}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else if (kdialog.status === 0) {
        child = spawn('kdialog', ['--getexistingdirectory', homedir(), promptText], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else {
        done(new Error('No folder dialog backend (install zenity or kdialog)'))
        return
      }
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (err) => done(err))
    child.on('close', (code) => {
      const raw = stdout.trim().replace(/\r/g, '')
      // Cancel → empty or non-zero without path
      if (!raw) {
        done(null, null)
        return
      }
      // macOS choose folder returns trailing slash
      const pathOut = raw.replace(/\/+$/, '') || raw
      if (existsSync(pathOut)) {
        done(null, pathOut)
        return
      }
      // Still return the path string if OS gave one (race/permissions)
      if (code === 0 && pathOut.length > 0) {
        done(null, pathOut)
        return
      }
      if (stderr && code !== 0 && code !== 1) {
        done(new Error(stderr.trim() || `folder dialog exited ${code}`))
        return
      }
      done(null, null)
    })
  })
}

function openNativeFileDialog(promptText) {
  return new Promise((resolvePromise, reject) => {
    const plat = osPlatform()
    let child
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolvePromise(value)
    }

    if (plat === 'darwin') {
      const script = [
        `try`,
        `  set theFile to choose file with prompt ${JSON.stringify(promptText)}`,
        `  return POSIX path of theFile`,
        `on error`,
        `  return ""`,
        `end try`,
      ].join('\n')
      child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    } else if (plat === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        `$d.Title = ${JSON.stringify(promptText)}`,
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  [Console]::Out.Write($d.FileName)',
        '}',
      ].join('; ')
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } else {
      const zenity = spawnSync('which', ['zenity'], { encoding: 'utf8' })
      if (zenity.status === 0) {
        child = spawn('zenity', ['--file-selection', `--title=${promptText}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else {
        done(new Error('No file dialog backend (install zenity)'))
        return
      }
    }

    let stdout = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', (err) => done(err))
    child.on('close', () => {
      const raw = stdout.trim().replace(/\r/g, '')
      done(null, raw || null)
    })
  })
}

async function main() {
  await ensureDaemon()

  const server = createServer(async (req, res) => {
    const origin = requestOrigin(req)
    if (origin && !isAllowedOrigin(origin)) {
      return sendJson(res, 403, { error: 'origin is not allowed' })
    }
    setCors(req, res)
    if (req.method === 'OPTIONS') {
      if (!origin) return sendJson(res, 400, { error: 'Origin is required for CORS preflight' })
      res.writeHead(204)
      res.end()
      return
    }

    try {
      const url = new URL(req.url || '/', hostBase())

      if (!isPublicHostRoute(url.pathname) && !hasHostAccess(req)) {
        return sendJson(res, 401, { error: 'missing or invalid CodeSurf host token' })
      }

      if (url.pathname === '/' || url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, service: 'codesurf-web-host' })
      }

      if (url.pathname.startsWith('/host/')) {
        return await handleHost(req, res, url)
      }

      if (url.pathname.startsWith('/d/')) {
        const daemonPath = url.pathname.slice(2) // keep leading /
        // /d/workspace/list → /workspace/list
        const pathOnly = daemonPath.startsWith('/') ? daemonPath : `/${daemonPath}`
        if (!daemonRouteIsAllowed(req.method || 'GET', pathOnly)) {
          return sendJson(res, 404, { error: 'daemon route is not available to web clients' })
        }
        // Reattach query: proxyDaemon reads req.url
        req.url = pathOnly + url.search
        return await proxyDaemon(req, res, pathOnly)
      }

      sendJson(res, 404, { error: 'not found', hint: 'use /host/* or /d/*' })
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status >= 500) console.error('[web-host]', err)
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, status, { error: String(err?.message || err) })
      }
    }
  })

  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(HOST_PORT, HOST_BIND, () => resolveListen())
  })

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('web-host did not expose a TCP listen address')
  boundPort = address.port
  writeRuntimeConfig()

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    if (ownedDaemon && !ownedDaemon.killed) {
      try { ownedDaemon.kill('SIGTERM') } catch { /* best effort */ }
    }
    if (RUNTIME_CONFIG_PATH) {
      try { rmSync(RUNTIME_CONFIG_PATH, { force: true }) } catch { /* best effort */ }
    }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2_000).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  console.log(`[web-host] listening on ${hostBase()}`)
  console.log('[web-host] daemon proxy: /d/*  host APIs: /host/*  loopback-only')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('[web-host] failed to start', err)
    if (ownedDaemon && !ownedDaemon.killed) {
      try { ownedDaemon.kill('SIGTERM') } catch { /* best effort */ }
    }
    process.exit(1)
  })
}
