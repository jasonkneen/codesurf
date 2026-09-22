import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, describe, it } from 'node:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  copyDeferredFrontendAssets,
  installSidecarIntoPackage,
  stageNativePackageFrontend,
  stageFrontend,
  stageRuntimeDependencies,
} from '../scripts/desktop-sidecar.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const supervisor = join(root, 'desktop', 'sidecar', 'supervisor.mjs')
const tempRoots = []

function makeTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function writeExecutable(path, source) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source, { mode: 0o755 })
  chmodSync(path, 0o755)
}

function readPngDimensions(path) {
  const contents = readFileSync(path)
  assert.deepEqual(contents.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(contents.subarray(12, 16).toString('ascii'), 'IHDR')
  return {
    contents,
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  }
}

function waitFor(condition, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval)
        resolvePromise()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(interval)
        reject(new Error('timed out waiting for condition'))
      }
    }, 25)
  })
}

function waitForExit(child) {
  return new Promise(resolvePromise => child.once('exit', (code, signal) => resolvePromise({ code, signal })))
}

after(() => {
  for (const rootPath of tempRoots) rmSync(rootPath, { recursive: true, force: true })
})

describe('Native desktop sidecar staging', () => {
  it('keeps Electron and Native package icon sources square and synchronized', () => {
    const electronIcon = readPngDimensions(join(root, 'resources', 'icon.png'))
    const nativeIcon = readPngDimensions(join(root, 'desktop', 'assets', 'icon.png'))

    assert.equal(electronIcon.width, electronIcon.height)
    assert.equal(nativeIcon.width, nativeIcon.height)
    assert.deepEqual(nativeIcon.contents, electronIcon.contents)
  })

  it('copies compiled daemon package files to both sidecar locations without source', () => {
    const fixture = makeTemp('codesurf-native-daemon-dist-')
    const rootDir = join(fixture, 'repo')
    const appRoot = join(fixture, 'sidecar-app')
    const daemonDir = join(rootDir, 'packages', 'codesurf-daemon')
    const gatewayDir = join(rootDir, 'packages', 'codesurf-terminal-gateway')
    const exports = Object.fromEntries(
      [
        ['.', 'index'],
        ['./manager', 'manager'],
        ['./client', 'client'],
        ['./sse', 'sse'],
        ['./chat-cli', 'chat-cli'],
        ['./chat-session-store', 'chat-session-store'],
        ['./paths', 'paths'],
      ].map(([subpath, stem]) => [
        subpath,
        {
          types: `./dist/${stem}.d.ts`,
          import: `./dist/${stem}.js`,
          default: `./dist/${stem}.js`,
        },
      ]),
    )
    mkdirSync(join(daemonDir, 'src'), { recursive: true })
    mkdirSync(join(daemonDir, 'bin'), { recursive: true })
    mkdirSync(join(daemonDir, 'vendor'), { recursive: true })
    for (const target of Object.values(exports)) {
      mkdirSync(dirname(join(daemonDir, target.import)), { recursive: true })
      writeFileSync(join(daemonDir, target.import), 'export {}\n')
      writeFileSync(join(daemonDir, target.types), 'export {}\n')
    }
    writeFileSync(join(daemonDir, 'src', 'index.ts'), 'export {}\n')
    writeFileSync(join(daemonDir, 'bin', 'codesurfd.mjs'), 'export {}\n')
    writeFileSync(join(daemonDir, 'vendor', 'dreaming.mjs'), 'export {}\n')
    writeFileSync(join(daemonDir, 'README.md'), '# daemon\n')
    writeFileSync(
      join(daemonDir, 'package.json'),
      `${JSON.stringify({
        name: '@codesurf/daemon',
        version: '0.1.0',
        files: ['bin/', 'dist/', 'vendor/', 'README.md'],
        exports,
      })}\n`,
    )
    mkdirSync(join(gatewayDir, 'bin'), { recursive: true })
    mkdirSync(join(gatewayDir, 'scripts'), { recursive: true })
    writeFileSync(join(gatewayDir, 'scripts', 'gateway-tool.mjs'), 'export {}\n')
    symlinkSync('../scripts/gateway-tool.mjs', join(gatewayDir, 'bin', 'gateway-tool'))
    writeFileSync(
      join(gatewayDir, 'package.json'),
      `${JSON.stringify({ name: '@codesurf/terminal-gateway', version: '0.1.0' })}\n`,
    )

    stageRuntimeDependencies({ root: rootDir, appRoot })

    for (const packageRoot of [
      join(appRoot, 'packages', 'codesurf-daemon'),
      join(appRoot, 'node_modules', '@codesurf', 'daemon'),
    ]) {
      assert.ok(existsSync(join(packageRoot, 'dist', 'index.js')))
      assert.equal(existsSync(join(packageRoot, 'src')), false)
    }

    const stagedGatewayLink = join(
      appRoot,
      'node_modules',
      '@codesurf',
      'terminal-gateway',
      'bin',
      'gateway-tool',
    )
    assert.equal(lstatSync(stagedGatewayLink).isSymbolicLink(), true)
    assert.equal(readlinkSync(stagedGatewayLink), '../scripts/gateway-tool.mjs')
    assert.equal(readFileSync(stagedGatewayLink, 'utf8'), 'export {}\n')
  })

  it('stages the root web build under the manifest-safe frontend path', () => {
    const fixture = makeTemp('codesurf-native-frontend-')
    const rootDir = join(fixture, 'repo')
    const desktopDir = join(rootDir, 'desktop')
    mkdirSync(join(rootDir, 'dist', 'assets'), { recursive: true })
    writeFileSync(join(rootDir, 'dist', 'index.html'), '<!doctype html>')
    writeFileSync(join(rootDir, 'dist', 'assets', 'app.js'), 'console.log("ok")')

    const staged = stageFrontend({ root: rootDir, desktop: desktopDir })
    assert.equal(staged, join(desktopDir, 'frontend'))
    assert.equal(readFileSync(join(staged, 'index.html'), 'utf8'), '<!doctype html>')
    assert.equal(readFileSync(join(staged, 'assets', 'app.js'), 'utf8'), 'console.log("ok")')
  })

  it('installs a compiled launcher and Node sidecar next to the Native executable', () => {
    const fixture = makeTemp('codesurf-native-package-')
    const desktopDir = join(fixture, 'desktop')
    const outputPath = join(fixture, 'CodeSurf.app')
    const stage = join(desktopDir, '.native-sidecar')
    const launcherPath = join(fixture, 'codesurf-sidecar-launcher')
    writeExecutable(join(outputPath, 'Contents', 'MacOS', 'codesurf'), '#!/bin/sh\nexit 0\n')
    writeExecutable(launcherPath, 'compiled-native-launcher\n')
    writeExecutable(join(stage, 'bin', 'node'), '#!/bin/sh\nexit 0\n')
    mkdirSync(join(stage, 'app', 'scripts'), { recursive: true })
    mkdirSync(join(stage, 'app', 'packages', 'codesurf-daemon', 'bin'), { recursive: true })
    mkdirSync(join(stage, 'app', 'packages', 'codesurf-daemon', 'dist'), { recursive: true })
    mkdirSync(join(stage, 'app', 'packages', 'codesurf-terminal-gateway', 'bin'), { recursive: true })
    writeFileSync(join(stage, 'supervisor.mjs'), 'export {}\n')
    writeFileSync(join(stage, 'app', 'scripts', 'web-host.mjs'), 'export {}\n')
    writeFileSync(join(stage, 'app', 'packages', 'codesurf-daemon', 'bin', 'codesurfd.mjs'), 'export {}\n')
    writeFileSync(join(stage, 'app', 'packages', 'codesurf-daemon', 'dist', 'index.js'), 'export {}\n')
    writeFileSync(join(stage, 'app', 'packages', 'codesurf-daemon', 'dist', 'chat-cli.js'), 'export {}\n')
    writeFileSync(join(stage, 'app', 'packages', 'codesurf-terminal-gateway', 'bin', 'codesurf-terminal-gateway.mjs'), 'export {}\n')

    assert.throws(
      () => installSidecarIntoPackage({ outputPath, target: 'macos', desktop: desktopDir }),
      /launcherPath/i,
    )

    const layout = installSidecarIntoPackage({ outputPath, target: 'macos', desktop: desktopDir, launcherPath })
    assert.equal(readFileSync(layout.nativeExecutable, 'utf8'), '#!/bin/sh\nexit 0\n')
    assert.equal(readFileSync(layout.executable, 'utf8'), 'compiled-native-launcher\n')
    assert.ok(statSync(layout.executable).mode & 0o111)
    assert.ok(existsSync(join(layout.resourcesDir, 'sidecar', 'bin', 'node')))
    assert.throws(
      () => installSidecarIntoPackage({ outputPath, target: 'macos', desktop: desktopDir, launcherPath }),
      /one owner/i,
    )
    assert.throws(
      () => installSidecarIntoPackage({ outputPath, target: 'windows', desktop: desktopDir, launcherPath }),
      /not implemented for windows/i,
    )
  })

  it('filters Native SDK oversized assets then restores them to Resources/frontend', () => {
    const fixture = makeTemp('codesurf-native-large-assets-')
    const desktopDir = join(fixture, 'desktop')
    const outputPath = join(fixture, 'CodeSurf.app')
    const source = join(desktopDir, 'frontend')
    mkdirSync(join(source, 'vad'), { recursive: true })
    writeFileSync(join(source, 'index.html'), '<!doctype html>')
    writeFileSync(join(source, 'small.js'), 'small')
    writeFileSync(join(source, 'vad', 'runtime.wasm'), Buffer.alloc(21, 7))

    const staged = stageNativePackageFrontend({ desktop: desktopDir, maxAssetBytes: 20 })
    assert.equal(readFileSync(join(staged.assetsDir, 'small.js'), 'utf8'), 'small')
    assert.equal(existsSync(join(staged.assetsDir, 'vad', 'runtime.wasm')), false)
    assert.deepEqual(staged.deferred, [{ path: join('vad', 'runtime.wasm'), byteLength: 21 }])

    mkdirSync(join(outputPath, 'Contents', 'Resources'), { recursive: true })
    const restored = copyDeferredFrontendAssets({ outputPath, target: 'macos', desktop: desktopDir })
    assert.deepEqual(restored, staged.deferred)
    assert.deepEqual(readFileSync(join(outputPath, 'Contents', 'Resources', 'frontend', 'vad', 'runtime.wasm')), Buffer.alloc(21, 7))
  })
})

describe('Native desktop sidecar lifecycle', () => {
  it('waits for both loopback services and tears them down with its owner', async () => {
    const fixture = makeTemp('codesurf-native-supervisor-')
    const appRoot = join(fixture, 'app')
    const home = join(fixture, 'home')
    const workspace = join(fixture, 'workspace')
    const runtimePath = join(home, 'runtime', 'native.json')
    const readyPath = `${runtimePath}.ready`
    const terminalPidPath = join(fixture, 'terminal.pid')
    const hostPidPath = join(fixture, 'host.pid')
    const originsPath = join(fixture, 'terminal.origins')
    const terminalScript = join(fixture, 'terminal.mjs')
    const hostScript = join(fixture, 'host.mjs')
    mkdirSync(appRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })

      writeFileSync(terminalScript, `
      import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
      import { dirname } from 'node:path'
      mkdirSync(dirname(process.env.CODESURF_TERMINAL_RUNTIME_CONFIG_PATH), { recursive: true })
      const temporary = process.env.CODESURF_TERMINAL_RUNTIME_CONFIG_PATH + '.tmp'
      writeFileSync(temporary, JSON.stringify({ endpoint: 'ws://127.0.0.1:45678', token: process.env.CODESURF_TERMINAL_TOKEN }), { mode: 0o600 })
      renameSync(temporary, process.env.CODESURF_TERMINAL_RUNTIME_CONFIG_PATH)
      chmodSync(process.env.CODESURF_TERMINAL_RUNTIME_CONFIG_PATH, 0o600)
      writeFileSync(process.env.TERMINAL_PID_PATH, String(process.pid))
      writeFileSync(process.env.TERMINAL_ORIGINS_PATH, process.env.CODESURF_TERMINAL_ALLOWED_ORIGINS)
      process.on('SIGTERM', () => process.exit(0))
      setInterval(() => {}, 1000)
    `)
    writeFileSync(hostScript, `
      import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
      import { dirname } from 'node:path'
      mkdirSync(dirname(process.env.CODESURF_RUNTIME_CONFIG_PATH), { recursive: true })
      const temporary = process.env.CODESURF_RUNTIME_CONFIG_PATH + '.tmp'
      writeFileSync(temporary, JSON.stringify({ hostBase: 'http://127.0.0.1:41234', hostToken: 'host-token', terminal: { endpoint: process.env.CODESURF_TERMINAL_GATEWAY_URL, token: process.env.CODESURF_TERMINAL_TOKEN } }), { mode: 0o600 })
      renameSync(temporary, process.env.CODESURF_RUNTIME_CONFIG_PATH)
      chmodSync(process.env.CODESURF_RUNTIME_CONFIG_PATH, 0o600)
      writeFileSync(process.env.HOST_PID_PATH, String(process.pid))
      process.on('SIGTERM', () => process.exit(0))
      setInterval(() => {}, 1000)
    `)

    const child = spawn(process.execPath, [supervisor, '--ready-file', readyPath], {
      cwd: fixture,
      env: {
        ...process.env,
        CODESURF_SIDECAR_APP_ROOT: appRoot,
        CODESURF_HOME: home,
        CODESURF_DESKTOP_WORKSPACE_ROOT: workspace,
        CODESURF_RUNTIME_CONFIG_PATH: runtimePath,
        CODESURF_SIDECAR_TERMINAL_GATEWAY_SCRIPT: terminalScript,
        CODESURF_SIDECAR_WEB_HOST_SCRIPT: hostScript,
        TERMINAL_PID_PATH: terminalPidPath,
        TERMINAL_ORIGINS_PATH: originsPath,
        HOST_PID_PATH: hostPidPath,
      },
      stdio: 'pipe',
    })

    try {
      await waitFor(() => existsSync(readyPath))
      const config = JSON.parse(readFileSync(readyPath, 'utf8'))
      assert.equal(config.hostBase, 'http://127.0.0.1:41234')
      assert.equal(config.terminal.endpoint, 'ws://127.0.0.1:45678')
      assert.equal(readFileSync(originsPath, 'utf8'), 'zero://app')
      assert.equal(statSync(runtimePath).mode & 0o777, 0o600)
      assert.equal(statSync(readyPath).mode & 0o777, 0o600)

      const terminalPid = Number(readFileSync(terminalPidPath, 'utf8'))
      const hostPid = Number(readFileSync(hostPidPath, 'utf8'))
      child.kill('SIGTERM')
      await waitForExit(child)
      await waitFor(() => {
        const alive = pid => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }
        return !alive(terminalPid) && !alive(hostPid)
      })
      assert.equal(existsSync(runtimePath), false)
      assert.equal(existsSync(readyPath), false)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  })
})
