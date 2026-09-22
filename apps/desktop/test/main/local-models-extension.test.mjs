import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

const require = createRequire(import.meta.url)
const localModels = require('../../examples/extensions/local-models/main.js')
const { __testing } = localModels

test('loadConfig returns sensible local-model defaults when no settings file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-local-models-'))
  try {
    const config = await __testing.loadConfig(dir)
    assert.deepEqual(config, {
      command: 'ollama',
      args: ['serve'],
      basePort: 11435,
      healthPath: '/api/tags',
      modelsDir: '',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadConfig merges persisted settings and parses args safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-local-models-'))
  try {
    await mkdir(join(dir, 'extension-settings'), { recursive: true })
    await writeFile(
      join(dir, 'extension-settings', 'local-models.json'),
      JSON.stringify({
        command: '/usr/local/bin/custom-modeld',
        args: '--flag one --port 7777',
        basePort: 12345,
        healthPath: '/ready',
        modelsDir: '/tmp/models',
      }),
      'utf8',
    )
    const config = await __testing.loadConfig(dir)
    assert.deepEqual(config, {
      command: '/usr/local/bin/custom-modeld',
      args: ['--flag', 'one', '--port', '7777'],
      basePort: 12345,
      healthPath: '/ready',
      modelsDir: '/tmp/models',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('findAvailablePort skips an occupied port', async () => {
  const blocker = createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const occupiedPort = blocker.address().port
  try {
    const nextPort = await __testing.findAvailablePort(occupiedPort, 5)
    assert.notEqual(nextPort, occupiedPort)
    assert.ok(nextPort > occupiedPort)
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})
