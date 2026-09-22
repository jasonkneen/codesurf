/**
 * Local production-web/PWA preview with an ephemeral runtime configuration.
 *
 * Secrets stay in this loopback process and are served at runtime with
 * Cache-Control: no-store. They never touch dist/. Deployed hosts must provide
 * the same path through their authenticated ingress instead of shipping it.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'
const distDir = path.join(root, 'dist')
const hostUrl = process.env.CODESURF_WEB_HOST_URL || 'http://127.0.0.1:4177'
const hostHealth = `${hostUrl.replace(/\/$/, '')}/host/health`
const hostToken = process.env.CODESURF_WEB_HOST_TOKEN || randomBytes(32).toString('base64url')
const usingExternalTerminal = Boolean(process.env.CODESURF_TERMINAL_ENDPOINT?.trim())
const previewTerminalPort = process.env.CODESURF_WEB_PREVIEW_TERMINAL_PORT || '4178'
const terminalUrl = process.env.CODESURF_TERMINAL_ENDPOINT?.trim() || `http://127.0.0.1:${previewTerminalPort}`
const terminalHealth = `${terminalUrl.replace(/\/$/, '')}/healthz`
const terminalToken = process.env.CODESURF_TERMINAL_TOKEN || randomBytes(32).toString('base64url')
const terminalGatewayScript = path.join(root, 'packages', 'codesurf-terminal-gateway', 'bin', 'codesurf-terminal-gateway.mjs')
const previewPort = process.env.CODESURF_WEB_PREVIEW_PORT || '4173'
const runtimeConfigPort = Number(process.env.CODESURF_WEB_PREVIEW_RUNTIME_PORT || 4174)

if (!Number.isInteger(runtimeConfigPort) || runtimeConfigPort < 1 || runtimeConfigPort > 65535) {
  throw new Error('CODESURF_WEB_PREVIEW_RUNTIME_PORT must be a valid TCP port')
}

const children = []
let shuttingDown = false
let runtimeConfigServer = null

function kill(child) {
  if (!child || child.killed) return
  try { child.kill('SIGTERM') } catch { /* best effort */ }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) kill(child)
  try { runtimeConfigServer?.close() } catch { /* best effort */ }
  if (exitCode !== 0) process.exitCode = exitCode
}

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  })
  children.push(child)
  child.once('exit', code => {
    if (!shuttingDown && options.fatal) {
      console.error(`[web:preview] ${options.label || command} exited (${code ?? '?'})`)
      shutdown(code ?? 1)
    }
  })
  return child
}

async function isUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitFor(url, label, timeoutMs = 45_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await isUp(url)) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`timed out waiting for ${label}: ${url}`)
}

async function ensureTerminalGateway() {
  if (await isUp(terminalHealth)) {
    if (!process.env.CODESURF_TERMINAL_TOKEN) {
      throw new Error(`terminal gateway is already running at ${terminalUrl}; set CODESURF_TERMINAL_TOKEN to its scoped bearer before previewing`)
    }
    return
  }
  if (usingExternalTerminal) throw new Error(`configured terminal gateway is unavailable: ${terminalUrl}`)
  if (!existsSync(terminalGatewayScript)) throw new Error(`terminal gateway is missing: ${terminalGatewayScript}`)

  const tenants = JSON.stringify({ preview: { roots: [root], workspaces: {} } })
  spawnTracked(process.execPath, [terminalGatewayScript], {
    label: 'terminal-gateway',
    fatal: true,
    env: {
      CODESURF_TERMINAL_GATEWAY_BIND: '127.0.0.1',
      CODESURF_TERMINAL_GATEWAY_PORT: previewTerminalPort,
      CODESURF_TERMINAL_TOKEN: terminalToken,
      CODESURF_TERMINAL_TENANTS_JSON: tenants,
      CODESURF_TERMINAL_ALLOWED_ORIGINS: `http://127.0.0.1:${previewPort},http://localhost:${previewPort}`,
      CODESURF_TERMINAL_ADAPTER: 'local',
    },
  })
  await waitFor(terminalHealth, 'terminal gateway')
}

async function ensureHost() {
  if (await isUp(hostHealth)) {
    if (!process.env.CODESURF_WEB_HOST_TOKEN) {
      throw new Error(`web-host is already running at ${hostUrl}; set CODESURF_WEB_HOST_TOKEN to that host's per-launch token before previewing`)
    }
    return
  }
  spawnTracked(process.execPath, [path.join(root, 'scripts', 'web-host.mjs')], {
    label: 'web-host',
    fatal: true,
    env: {
      CODESURF_WEB_HOST_TOKEN: hostToken,
      CODESURF_WEB_HOST_ORIGINS: `http://127.0.0.1:${previewPort}`,
      CODESURF_TERMINAL_GATEWAY_URL: terminalUrl,
      CODESURF_TERMINAL_TOKEN: terminalToken,
    },
  })
  await waitFor(hostHealth, 'web-host')
}

async function startRuntimeConfigServer() {
  const runtime = {
    __CODESURF_HOST__: hostUrl,
    __CODESURF_HOST_TOKEN__: hostToken,
    __CODESURF_TERMINAL_ENDPOINT__: terminalUrl,
    __CODESURF_TERMINAL_TOKEN__: terminalToken,
  }
  const json = JSON.stringify(runtime).replace(/</g, '\\u003c')
  const body = `Object.assign(window, ${json});\n`
  runtimeConfigServer = createServer((req, res) => {
    if (req.url !== '/codesurf-runtime-config.js') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(body)
  })
  await new Promise((resolveListen, reject) => {
    runtimeConfigServer.once('error', reject)
    runtimeConfigServer.listen(runtimeConfigPort, '127.0.0.1', resolveListen)
  })
}

async function main() {
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error('dist/ is missing; run npm run build:web before npm run web:preview')
  }
  process.once('SIGINT', () => shutdown())
  process.once('SIGTERM', () => shutdown())
  process.once('exit', () => shutdown())

  await ensureTerminalGateway()
  await ensureHost()
  await startRuntimeConfigServer()

  console.log(`[web:preview] open http://127.0.0.1:${previewPort}/`)
  const preview = spawnTracked(npmCmd, [
    'run', 'web:preview:vite', '--', '--host', '127.0.0.1', '--port', previewPort, '--strictPort',
  ], {
    label: 'vite-preview',
    fatal: true,
    env: {
      CODESURF_RUNTIME_CONFIG_PROXY_TARGET: `http://127.0.0.1:${runtimeConfigPort}`,
    },
  })
  preview.once('exit', code => {
    shutdown(code ?? 0)
    process.exit(code ?? 0)
  })
}

main().catch(error => {
  console.error('[web:preview] failed', error)
  shutdown(1)
})
