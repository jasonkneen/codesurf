import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const EXT_DIR = join(ROOT_DIR, 'bundled-extensions', 'test-loop')
const testLoop = require(join(EXT_DIR, 'main.js'))

function runNode(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', rejectPromise)
    child.once('close', code => resolvePromise({ code: code ?? 1, stdout, stderr }))
  })
}

test('test-loop is bundled as a host-backed test runner tile with MCP tools', async () => {
  const manifest = JSON.parse(await readFile(join(EXT_DIR, 'extension.json'), 'utf8'))

  assert.equal(manifest.id, 'test-loop')
  assert.equal(manifest.name, 'Test Loop')
  assert.equal(manifest.tier, 'power')
  assert.equal(manifest.main, 'main.js')
  assert.equal(manifest.ui.mode, 'native')

  const tile = manifest.contributes.tiles.find(entry => entry.type === 'test-loop')
  assert.ok(tile, 'expected test-loop tile contribution')
  assert.equal(tile.entry, 'tile/index.html')
  assert.deepEqual(tile.defaultSize, { w: 720, h: 560 })

  assert.deepEqual(manifest.contributes.context.produces, ['ctx:test-loop:last_run'])
  assert.ok(manifest.contributes.context.consumes.includes('ctx:qa-workbench:report'))

  const actionNames = manifest.contributes.actions.map(action => action.name).sort()
  assert.deepEqual(actionNames, ['cancelRun', 'detectProfiles', 'getLastRun', 'startRun'])

  const mcpNames = manifest.contributes.mcpTools.map(tool => tool.name).sort()
  assert.deepEqual(mcpNames, ['cancel_run', 'detect_profiles', 'get_last_run', 'start_run'])
})

test('test-loop detects safe package script profiles without watch scripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-test-loop-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      scripts: {
        test: 'vitest run',
        'test:unit': 'node --test',
        'test:watch': 'vitest --watch',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        build: 'vite build',
        dev: 'vite dev',
      },
    }, null, 2))

    const detected = await testLoop.__testing.detectProfiles(dir)
    const ids = detected.profiles.map(profile => profile.id)

    assert.equal(detected.packageManager, 'npm')
    assert.deepEqual(ids, [
      'package:test',
      'package:test:unit',
      'package:typecheck',
      'package:lint',
      'package:build',
    ])
    assert.equal(detected.profiles.find(profile => profile.id === 'package:test').command, 'npm')
    assert.deepEqual(detected.profiles.find(profile => profile.id === 'package:typecheck').args, ['run', 'typecheck'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('test-loop falls back to non-package test profiles and redacts secrets in output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-test-loop-'))
  try {
    await writeFile(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n')
    const detected = await testLoop.__testing.detectProfiles(dir)
    assert.deepEqual(detected.profiles.map(profile => profile.id), ['python:pytest'])

    const redacted = testLoop.__testing.redactText('Bearer abc.def.ghi\nOPENAI_API_KEY=sk-test\npassword: hunter2')
    assert.match(redacted, /Bearer \[REDACTED\]/)
    assert.match(redacted, /OPENAI_API_KEY=\[REDACTED\]/)
    assert.match(redacted, /password: \[REDACTED\]/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('test-loop tile calls the host run, cancel, and context APIs', async () => {
  const tileHtml = await readFile(join(EXT_DIR, 'tile', 'index.html'), 'utf8')
  assert.match(tileHtml, /ext\.invoke\('detectProfiles'/)
  assert.match(tileHtml, /ext\.invoke\('startRun'/)
  assert.match(tileHtml, /ext\.invoke\('cancelRun'/)
  assert.match(tileHtml, /ctx:test-loop:last_run/)
  assert.match(tileHtml, /Run selected/)
  assert.match(tileHtml, /Copy summary/)
})

test('validate-extension accepts bundled test-loop target', async () => {
  const result = await runNode(['scripts/validate-extension.mjs', 'bundled-extensions/test-loop'])
  assert.equal(
    result.code,
    0,
    `validate-extension failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  assert.match(result.stdout, /\[OK\] bundled-extensions\/test-loop|\[OK\] test-loop/)
  assert.match(result.stdout, /Summary: 1 passed, 0 failed/)
})
