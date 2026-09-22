import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const currentDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(currentDirectory, '../..')
const electronBinary = resolve(projectRoot, 'node_modules/.bin/electron')
const fixture = resolve(projectRoot, 'test/fixtures/display-permission-flow.cjs')

test('Electron 41 display capture requires the boolean preflight before source selection', async () => {
  assert.equal(existsSync(electronBinary), true, `Electron binary not found: ${electronBinary}`)
  assert.equal(existsSync(fixture), true, `fixture not found: ${fixture}`)
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'codesurf-display-permission-'))

  try {
    const { stdout } = await execFileAsync(
      electronBinary,
      [fixture, `--user-data-dir=${userDataDirectory}`],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ELECTRON_DISABLE_SANDBOX: '1',
        },
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      },
    )
    const messages = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line))

    assert.deepEqual(messages.map(message => message.kind), [
      'denied-preflight',
      'denied-result',
      'preflight',
      'display',
      'result',
    ])
    assert.deepEqual(messages[1], {
      kind: 'denied-result',
      displayCalls: 0,
      granted: false,
      error: 'NotAllowedError',
    })
    assert.deepEqual(messages[2], {
      kind: 'preflight',
      mediaTypes: [],
      securityOrigin: 'file:///',
    })
    assert.equal(messages[3].userGesture, true)
    assert.equal(messages[3].videoRequested, true)
    assert.deepEqual(messages[4], {
      kind: 'result',
      granted: true,
      tracks: ['video'],
    })
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true })
  }
})
