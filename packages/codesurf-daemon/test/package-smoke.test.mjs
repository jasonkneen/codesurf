import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const PUBLIC_EXPORTS = [
  '@codesurf/daemon',
  '@codesurf/daemon/manager',
  '@codesurf/daemon/client',
  '@codesurf/daemon/sse',
  '@codesurf/daemon/chat-cli',
  '@codesurf/daemon/chat-session-store',
  '@codesurf/daemon/chat-policy',
  '@codesurf/daemon/paths',
  '@codesurf/daemon/context-budget',
  '@codesurf/daemon/process-tree',
  '@codesurf/daemon/secure-file-reader',
  '@codesurf/daemon/context-composer',
  '@codesurf/daemon/prompt-conventions',
  '@codesurf/daemon/peer-context-policy',
  '@codesurf/daemon/peer-authority-policy',
  '@codesurf/daemon/peer-context-serialization',
  '@codesurf/daemon/node-tools',
  '@codesurf/daemon/package-layout',
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })
  assert.equal(
    result.status,
    0,
    `Command failed: ${command} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`,
  )
  return result.stdout.trim()
}

function parsePackJson(output) {
  const jsonStart = output.search(/\[\s*\{\s*"id"/)
  if (jsonStart < 0) throw new Error(`npm pack did not emit JSON metadata:\n${output}`)
  return JSON.parse(output.slice(jsonStart))
}

async function waitForDaemon(pidPath, child, stderr) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged daemon exited with ${child.exitCode}: ${stderr.join('')}`)
    }
    if (existsSync(pidPath)) {
      const info = JSON.parse(await readFile(pidPath, 'utf8'))
      if (Number.isInteger(info.port) && typeof info.token === 'string') return info
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Packaged daemon did not publish ${pidPath}: ${stderr.join('')}`)
}

async function stopDaemon(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise(resolvePromise => child.once('exit', resolvePromise))
  }
}

test('clean tarball consumer imports compiled exports and boots native-backed codesurfd', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'codesurf-daemon-consumer-'))
  const packDir = join(fixture, 'pack')
  const consumerDir = join(fixture, 'consumer')
  const cacheDir = join(fixture, 'npm-cache')
  const homeDir = join(fixture, 'codesurf-home')
  let daemon = null
  t.after(async () => {
    if (daemon) await stopDaemon(daemon)
    await rm(fixture, { recursive: true, force: true })
  })
  await Promise.all([mkdir(packDir), mkdir(consumerDir)])

  const packOutput = run(
    NPM_COMMAND,
    ['pack', '--json', '--pack-destination', packDir],
    {
      cwd: DAEMON_DIR,
      env: { ...process.env, npm_config_cache: cacheDir },
    },
  )
  const packed = parsePackJson(packOutput)[0]
  assert.ok(packed)
  const packedPaths = packed.files.map(file => file.path)
  assert.equal(packedPaths.some(path => path === 'src' || path.startsWith('src/')), false)
  assert.ok(packedPaths.includes('dist/index.js'))
  assert.ok(packedPaths.includes('dist/index.d.ts'))

  const [tarballName] = await readdir(packDir)
  const tarball = join(packDir, tarballName)
  await writeFile(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'codesurf-daemon-consumer', private: true, type: 'module' })}\n`,
  )
  run(
    NPM_COMMAND,
    ['install', tarball, '--no-audit', '--no-fund'],
    {
      cwd: consumerDir,
      env: { ...process.env, npm_config_cache: cacheDir },
    },
  )

  const importProbe = [
    `const exportsToLoad = ${JSON.stringify(PUBLIC_EXPORTS)}`,
    'await Promise.all(exportsToLoad.map(specifier => import(specifier)))',
    "const { default: Database } = await import('better-sqlite3')",
    "const database = new Database(':memory:')",
    "database.exec('CREATE TABLE smoke (value TEXT)')",
    'database.close()',
    "process.stdout.write('compiled-imports-and-native-ok')",
  ].join(';')
  const importOutput = run(
    process.execPath,
    ['--no-experimental-strip-types', '--input-type=module', '-e', importProbe],
    { cwd: consumerDir },
  )
  assert.equal(importOutput, 'compiled-imports-and-native-ok')

  const daemonEntry = join(consumerDir, 'node_modules', '@codesurf', 'daemon', 'bin', 'codesurfd.mjs')
  const daemonStderr = []
  daemon = spawn(process.execPath, ['--no-experimental-strip-types', daemonEntry], {
    cwd: consumerDir,
    env: {
      ...process.env,
      CODESURF_HOME: homeDir,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  daemon.stderr.on('data', chunk => daemonStderr.push(String(chunk)))
  const info = await waitForDaemon(join(homeDir, 'daemon', 'pid.json'), daemon, daemonStderr)
  const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
    headers: { authorization: `Bearer ${info.token}` },
  })
  const health = await response.json()
  assert.equal(response.ok, true)
  assert.equal(health.ok, true)
  assert.equal(health.pid, daemon.pid)
})
