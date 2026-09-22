/**
 * Browser dev loop (Agensis-style web):
 *  - codesurfd via web-host
 *  - Vite renderer on :5173 with VITE_CODESURF_HOST pointing at web-host
 *
 * Same UI as desktop:dev Native shell; no Electron.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'
const HOST_URL = process.env.CODESURF_WEB_HOST_URL || 'http://127.0.0.1:4177'
const HOST_HEALTH = `${HOST_URL}/host/health`
const VITE_URL = 'http://127.0.0.1:5173/'
const HOST_TOKEN = process.env.CODESURF_WEB_HOST_TOKEN || randomBytes(32).toString('base64url')
const usingExternalTerminal = Boolean(process.env.CODESURF_TERMINAL_ENDPOINT?.trim())
const TERMINAL_URL = process.env.CODESURF_TERMINAL_ENDPOINT?.trim() || 'http://127.0.0.1:4178'
const TERMINAL_HEALTH = `${TERMINAL_URL.replace(/\/$/, '')}/healthz`
const TERMINAL_TOKEN = process.env.CODESURF_TERMINAL_TOKEN || randomBytes(32).toString('base64url')
const terminalGatewayScript = path.join(root, 'packages', 'codesurf-terminal-gateway', 'bin', 'codesurf-terminal-gateway.mjs')

let shuttingDown = false
const children = []

function killProcess(child) {
  if (!child || child.killed) return
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) killProcess(child)
}

async function isUp(url, headers = undefined) {
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs = 45_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isUp(url)) return
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function spawnTracked(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? root,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
  })
  children.push(child)
  child.on('exit', (code) => {
    if (!shuttingDown && opts.fatal) {
      console.error(`[web:dev] ${opts.label || cmd} exited (${code ?? '?'})`)
      shutdown()
      process.exit(code ?? 1)
    }
  })
  return child
}

async function main() {
  if (!(await isUp(TERMINAL_HEALTH))) {
    if (usingExternalTerminal) {
      throw new Error(`configured terminal gateway is unavailable: ${TERMINAL_URL}`)
    }
    if (!existsSync(terminalGatewayScript)) {
      throw new Error(`terminal gateway is missing: ${terminalGatewayScript}`)
    }
    console.log('[web:dev] starting loopback terminal gateway…')
    const tenantConfig = JSON.stringify({
      webDev: {
        roots: [root],
        workspaces: {},
      },
    })
    spawnTracked(process.execPath, [terminalGatewayScript], {
      label: 'terminal-gateway',
      fatal: true,
      env: {
        CODESURF_TERMINAL_GATEWAY_BIND: '127.0.0.1',
        CODESURF_TERMINAL_GATEWAY_PORT: '4178',
        CODESURF_TERMINAL_TOKEN: TERMINAL_TOKEN,
        CODESURF_TERMINAL_TENANTS_JSON: tenantConfig,
        // Vite serves the same port on both hostnames and web-host accepts both,
        // so the gateway must too or terminals 403 when opened via localhost.
        CODESURF_TERMINAL_ALLOWED_ORIGINS: [
          VITE_URL.replace(/\/$/, ''),
          VITE_URL.replace(/\/$/, '').replace('127.0.0.1', 'localhost'),
        ].join(','),
        CODESURF_TERMINAL_ADAPTER: 'local',
      },
    })
    await waitForServer(TERMINAL_HEALTH)
  } else if (!process.env.CODESURF_TERMINAL_TOKEN) {
    throw new Error(
      `terminal gateway is already running at ${TERMINAL_URL}; set CODESURF_TERMINAL_TOKEN to its scoped bearer before running web:dev`,
    )
  }

  if (!(await isUp(HOST_HEALTH))) {
    console.log('[web:dev] starting web-host (+ codesurfd)…')
    spawnTracked(process.execPath, [path.join(root, 'scripts/web-host.mjs')], {
      label: 'web-host',
      fatal: true,
      env: {
        CODESURF_WEB_HOST_TOKEN: HOST_TOKEN,
        CODESURF_TERMINAL_GATEWAY_URL: TERMINAL_URL,
        CODESURF_TERMINAL_TOKEN: TERMINAL_TOKEN,
      },
    })
    await waitForServer(HOST_HEALTH)
  } else if (!process.env.CODESURF_WEB_HOST_TOKEN) {
    throw new Error(
      `web-host is already running at ${HOST_URL}; set CODESURF_WEB_HOST_TOKEN to that host's per-launch token before running web:dev`,
    )
  }

  const cleanup = () => shutdown()
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', cleanup)

  console.log('[web:dev] starting Vite renderer…')
  console.log(`[web:dev] open ${VITE_URL}`)
  console.log(`[web:dev] host API ${HOST_URL}`)
  console.log(`[web:dev] terminal gateway ${TERMINAL_URL}`)

  const vite = spawnTracked(npmCmd, [
    'run',
    'web:vite',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    '5173',
    '--strictPort',
  ], {
    label: 'vite',
    fatal: true,
    env: {
      BROWSER: process.env.BROWSER ?? 'none',
      VITE_CODESURF_HOST: HOST_URL,
      CODESURF_WEB_HOST_URL: HOST_URL,
      CODESURF_WEB_HOST_TOKEN: HOST_TOKEN,
      CODESURF_TERMINAL_ENDPOINT: TERMINAL_URL,
      CODESURF_TERMINAL_TOKEN: TERMINAL_TOKEN,
      CODESURF_RUNTIME_CONFIG_INJECT: '1',
    },
  })

  vite.on('exit', (code) => {
    shutdown()
    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  console.error('[web:dev] failed', error)
  shutdown()
  process.exit(1)
})
