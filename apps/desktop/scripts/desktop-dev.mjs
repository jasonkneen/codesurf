/**
 * Native desktop development loop.
 *
 * The Native WebView stays a thin renderer shell. A local supervisor owns the
 * loopback web-host and terminal gateway, writes a 0600 runtime config, and is
 * stopped with the Native dev process. Electron's `npm run dev` path is not
 * touched.
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { requireNativeSdkPath } from './resolve-native-sdk.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = path.join(root, 'desktop')
const supervisor = path.join(desktopDir, 'sidecar', 'supervisor.mjs')
const home = path.resolve(process.env.CODESURF_HOME?.trim() || path.join(homedir(), '.codesurf'))
const workspaceRoot = path.resolve(process.env.CODESURF_DESKTOP_WORKSPACE_ROOT?.trim() || root)
const runtimeDir = path.join(home, 'runtime')
const runtimeConfigPath = path.resolve(process.env.CODESURF_RUNTIME_CONFIG_PATH?.trim()
  || path.join(runtimeDir, `native-dev-${process.pid}-${randomUUID()}.json`))
const readyPath = `${runtimeConfigPath}.ready`
const zigCommand = process.env.ZIG_BINARY?.trim() || (existsSync('/opt/homebrew/bin/zig') ? '/opt/homebrew/bin/zig' : 'zig')

let shuttingDown = false
let shutdownPromise = null
const children = []

function ensurePrivateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Windows does not model POSIX modes. The supervisor still uses loopback.
  }
}

function removeFile(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    // Cleanup should never hide the real exit code.
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isLoopbackHttp(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
  } catch {
    return false
  }
}

async function waitForReady(sidecar, timeoutMs = 25_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (sidecar.exitCode !== null) {
      throw new Error(`Native sidecar exited before readiness (${sidecar.exitCode})`)
    }
    const config = readJson(readyPath)
    if (config && isLoopbackHttp(config.hostBase) && typeof config.hostToken === 'string' && config.hostToken) {
      return config
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 75))
  }
  throw new Error(`Timed out waiting for Native sidecar readiness: ${readyPath}`)
}

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  })
  children.push(child)
  child.on('error', error => {
    if (!shuttingDown) {
      console.error(`[desktop:dev] ${options.label || command} failed to start: ${error.message}`)
      void shutdown(1)
    }
  })
  return child
}

function waitForExit(child) {
  return new Promise(resolvePromise => child.once('exit', code => resolvePromise(code ?? 0)))
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise(resolvePromise => child.once('exit', resolvePromise))
  child.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise(resolvePromise => setTimeout(resolvePromise, 2_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  shutdownPromise = (async () => {
    await Promise.allSettled(children.map(stopChild))
    removeFile(readyPath)
    removeFile(runtimeConfigPath)
    removeFile(`${runtimeConfigPath}.terminal`)
    process.exitCode = exitCode
  })()
  return shutdownPromise
}

async function main() {
  if (!existsSync(supervisor)) throw new Error(`Native sidecar supervisor is missing: ${supervisor}`)
  if (!existsSync(workspaceRoot)) throw new Error(`CODESURF_DESKTOP_WORKSPACE_ROOT is missing: ${workspaceRoot}`)
  ensurePrivateDirectory(runtimeDir)
  removeFile(readyPath)
  removeFile(runtimeConfigPath)
  removeFile(`${runtimeConfigPath}.terminal`)

  const nativeSdk = requireNativeSdkPath()
  console.log(`[desktop:dev] NATIVE_SDK_PATH=${nativeSdk}`)
  console.log(`[desktop:dev] terminal workspace root=${workspaceRoot}`)

  const sidecar = spawnTracked(process.execPath, [supervisor, '--ready-file', readyPath], {
    label: 'native sidecar',
    env: {
      CODESURF_SIDECAR_APP_ROOT: root,
      CODESURF_HOME: home,
      CODESURF_RUNTIME_CONFIG_PATH: runtimeConfigPath,
      CODESURF_DESKTOP_WORKSPACE_ROOT: workspaceRoot,
      CODESURF_TERMINAL_ALLOWED_ORIGINS: 'zero://app,http://127.0.0.1:5173,http://localhost:5173',
    },
  })
  sidecar.once('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[desktop:dev] Native sidecar exited unexpectedly (${signal || code || 'unknown'}); shutting down the Native shell.`)
    void shutdown(typeof code === 'number' && code !== 0 ? code : 1)
  })

  const config = await waitForReady(sidecar)
  console.log(`[desktop:dev] local host=${config.hostBase}`)

  const nativeProcess = spawnTracked(zigCommand, [
    'build',
    'dev',
    `-Dnative-sdk-path=${nativeSdk}`,
  ], {
    cwd: desktopDir,
    label: 'native',
    env: {
      BROWSER: 'none',
      NATIVE_SDK_PATH: nativeSdk,
      VITE_CODESURF_HOST: config.hostBase,
      CODESURF_RUNTIME_CONFIG_PATH: runtimeConfigPath,
      CODESURF_DESKTOP_WORKSPACE_ROOT: workspaceRoot,
    },
  })

  const exitCode = await waitForExit(nativeProcess)
  await shutdown(exitCode)
  return sidecar
}

process.once('SIGINT', () => void shutdown(130))
process.once('SIGTERM', () => void shutdown(143))

main().catch(async error => {
  console.error('[desktop:dev] Failed to start Native SDK desktop shell')
  console.error(error instanceof Error ? error.message : error)
  await shutdown(1)
})
