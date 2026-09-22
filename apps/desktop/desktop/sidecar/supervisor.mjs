/**
 * Native desktop local-sidecar supervisor.
 *
 * This program is deliberately dependency-free: the packaged Node runtime
 * executes it before the React WebView starts. It owns the loopback-only
 * terminal gateway and web-host, publishes their short-lived runtime config,
 * and terminates both processes when the Native window process exits.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(process.env.CODESURF_SIDECAR_APP_ROOT || join(sourceDir, 'app'))
const home = resolve(process.env.CODESURF_HOME?.trim() || join(homedir(), '.codesurf'))
const nodeRuntime = process.execPath
const nativeBinary = readArgument('--native-binary')
const readyFile = readArgument('--ready-file')
const nativeArgs = readPassthroughArgs()

let terminalChild = null
let hostChild = null
let nativeChild = null
let shuttingDown = false
let shutdownPromise = null

function readArgument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] || null : null
}

function readPassthroughArgs() {
  const separator = process.argv.indexOf('--')
  return separator >= 0 ? process.argv.slice(separator + 1) : []
}

function pathFromEnvOrDefault(name, fallback) {
  const value = process.env[name]?.trim()
  return value ? resolve(value) : fallback
}

function runtimeConfigPath() {
  const explicit = process.env.CODESURF_RUNTIME_CONFIG_PATH?.trim()
  if (explicit) return resolve(explicit)
  const dir = join(home, 'runtime')
  ensurePrivateDirectory(dir)
  return join(dir, `native-${process.pid}-${randomUUID()}.json`)
}

function ensurePrivateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Windows does not model POSIX modes. The gateway still binds loopback.
  }
}

function removeFile(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // A stale config must not stop shutdown.
  }
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function isLoopbackUrl(value, schemes) {
  if (typeof value !== 'string' || !value) return false
  try {
    const url = new URL(value)
    return schemes.includes(url.protocol) && url.hostname === '127.0.0.1' && Boolean(url.port)
  } catch {
    return false
  }
}

function isSecret(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x20\x7f]/.test(value)
}

function workspaceRoot() {
  const explicit = process.env.CODESURF_DESKTOP_WORKSPACE_ROOT?.trim()
  if (explicit) {
    const root = resolve(explicit)
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`CODESURF_DESKTOP_WORKSPACE_ROOT is not a directory: ${root}`)
    }
    return { root, configured: true }
  }

  // Never silently grant a terminal access to / or the whole home directory.
  // CodeSurf-managed workspaces remain useful out of the box; arbitrary local
  // projects require an explicit launch-time scope.
  const root = join(home, 'workspaces')
  ensurePrivateDirectory(root)
  return { root, configured: false }
}

function spawnService(label, script, env) {
  if (!existsSync(script)) throw new Error(`${label} entrypoint is missing: ${script}`)
  const child = spawn(nodeRuntime, [script], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.once('error', error => {
    if (!shuttingDown) fail(`${label} could not start: ${error.message}`)
  })
  child.once('exit', (code, signal) => {
    if (!shuttingDown) fail(`${label} exited before shutdown (${signal || code || 'unknown'})`)
  })
  return child
}

async function waitForJson(path, validate, label, child, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`${label} exited before it became ready`)
    const value = safeReadJson(path)
    if (value && validate(value)) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 75))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise(resolvePromise => child.once('exit', resolvePromise))
  child.kill('SIGTERM')
  const outcome = await Promise.race([
    exited,
    new Promise(resolvePromise => setTimeout(resolvePromise, 2_000)),
  ])
  if (outcome === undefined && child.exitCode === null) child.kill('SIGKILL')
}

async function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  shutdownPromise = (async () => {
    await Promise.allSettled([stopChild(nativeChild), stopChild(hostChild), stopChild(terminalChild)])
    if (runtimePath) removeFile(runtimePath)
    if (terminalRuntimePath) removeFile(terminalRuntimePath)
    if (readyFile) removeFile(readyFile)
    process.exitCode = exitCode
  })()
  return shutdownPromise
}

function fail(message) {
  if (shuttingDown) return
  console.error(`[codesurf-native-sidecar] ${message}`)
  void shutdown(1)
}

function writeReadyFile(path, config) {
  const dir = dirname(path)
  ensurePrivateDirectory(dir)
  // This is a readiness marker for the dev wrapper, not a token-bearing
  // general-purpose endpoint. The file itself remains owner-readable only.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // See ensurePrivateDirectory Windows note.
  }
}

let runtimePath = null
let terminalRuntimePath = null

async function main() {
  if (!existsSync(appRoot)) throw new Error(`sidecar app root is missing: ${appRoot}`)
  runtimePath = runtimeConfigPath()
  terminalRuntimePath = `${runtimePath}.terminal`
  ensurePrivateDirectory(dirname(runtimePath))
  removeFile(runtimePath)
  removeFile(terminalRuntimePath)

  const scope = workspaceRoot()
  const terminalToken = randomUUID()
  const terminalAllowedOrigins = process.env.CODESURF_TERMINAL_ALLOWED_ORIGINS?.trim() || 'zero://app'
  const tenants = JSON.stringify({
    native: {
      bearerToken: terminalToken,
      roots: [scope.root],
      workspaces: { repo: scope.root },
    },
  })

  const terminalScript = pathFromEnvOrDefault(
    'CODESURF_SIDECAR_TERMINAL_GATEWAY_SCRIPT',
    join(appRoot, 'packages', 'codesurf-terminal-gateway', 'bin', 'codesurf-terminal-gateway.mjs'),
  )
  const hostScript = pathFromEnvOrDefault(
    'CODESURF_SIDECAR_WEB_HOST_SCRIPT',
    join(appRoot, 'scripts', 'web-host.mjs'),
  )

  terminalChild = spawnService('terminal gateway', terminalScript, {
    ...process.env,
    CODESURF_HOME: home,
    CODESURF_TERMINAL_GATEWAY_BIND: '127.0.0.1',
    CODESURF_TERMINAL_GATEWAY_PORT: '0',
    CODESURF_TERMINAL_TOKEN: terminalToken,
    CODESURF_TERMINAL_TENANTS_JSON: tenants,
    CODESURF_TERMINAL_ADAPTER: 'local',
    CODESURF_TERMINAL_ENABLE_DOCKER: '0',
    // Packaged Native pages originate from zero://app. desktop:dev explicitly
    // adds the two Vite origins so terminal WebSocket handshakes stay strict
    // without making the production sidecar accept arbitrary localhost ports.
    CODESURF_TERMINAL_ALLOWED_ORIGINS: terminalAllowedOrigins,
    CODESURF_TERMINAL_RUNTIME_CONFIG_PATH: terminalRuntimePath,
  })

  const terminalConfig = await waitForJson(
    terminalRuntimePath,
    value => isLoopbackUrl(value?.endpoint, ['http:', 'ws:']) && isSecret(value?.token),
    'terminal gateway',
    terminalChild,
  )

  hostChild = spawnService('web host', hostScript, {
    ...process.env,
    CODESURF_HOME: home,
    CODESURF_WEB_HOST_BIND: '127.0.0.1',
    CODESURF_WEB_HOST_PORT: '0',
    CODESURF_RUNTIME_CONFIG_PATH: runtimePath,
    CODESURF_TERMINAL_GATEWAY_URL: terminalConfig.endpoint,
    CODESURF_TERMINAL_TOKEN: terminalConfig.token,
    CODESURF_TERMINAL_WORKSPACE_ROOT_CONFIGURED: scope.configured ? '1' : '0',
  })

  const config = await waitForJson(
    runtimePath,
    value => isLoopbackUrl(value?.hostBase, ['http:'])
      && isSecret(value?.hostToken)
      && isLoopbackUrl(value?.terminal?.endpoint, ['http:', 'ws:'])
      && isSecret(value?.terminal?.token),
    'web host',
    hostChild,
  )

  if (readyFile) writeReadyFile(resolve(readyFile), config)
  console.log(`[codesurf-native-sidecar] ready host=${config.hostBase} terminal=${config.terminal.endpoint}`)

  if (!nativeBinary) {
    await new Promise(resolvePromise => {
      process.once('SIGINT', resolvePromise)
      process.once('SIGTERM', resolvePromise)
    })
    await shutdown(0)
    return
  }

  const binary = isAbsolute(nativeBinary) ? nativeBinary : resolve(nativeBinary)
  if (!existsSync(binary)) throw new Error(`Native binary is missing: ${binary}`)
  nativeChild = spawn(binary, nativeArgs, {
    cwd: scope.root,
    env: {
      ...process.env,
      CODESURF_RUNTIME_CONFIG_PATH: runtimePath,
      CODESURF_DESKTOP_WORKSPACE_ROOT: scope.root,
    },
    stdio: 'inherit',
  })
  const exitCode = await new Promise(resolvePromise => {
    nativeChild.once('exit', code => resolvePromise(Number.isInteger(code) ? code : 1))
    nativeChild.once('error', () => resolvePromise(1))
  })
  await shutdown(exitCode)
}

process.once('SIGINT', () => void shutdown(130))
process.once('SIGTERM', () => void shutdown(143))

main().catch(error => {
  console.error('[codesurf-native-sidecar] startup failed')
  console.error(error instanceof Error ? error.message : error)
  void shutdown(1)
})
