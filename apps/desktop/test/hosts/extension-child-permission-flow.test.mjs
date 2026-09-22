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
const fixture = resolve(projectRoot, 'test/fixtures/extension-child-permission-flow.cjs')

test('Electron 41 reports codesurf-ext child media and display principals exactly', async () => {
  assert.equal(existsSync(electronBinary), true, `Electron binary not found: ${electronBinary}`)
  assert.equal(existsSync(fixture), true, `fixture not found: ${fixture}`)
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'codesurf-extension-permission-'))

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
      'media-request',
      'media-result',
      'display-preflight',
      'display-request',
      'display-result',
    ])
    assert.deepEqual(messages[0], {
      kind: 'media-request',
      permission: 'media',
      isMainFrame: false,
      mediaTypes: ['audio'],
      requestingUrl: 'codesurf-ext://permission-probe/index.html',
      securityOrigin: 'codesurf-ext://permission-probe/',
    })
    assert.deepEqual(messages[1], {
      kind: 'media-result',
      granted: false,
      error: 'NotAllowedError',
    })
    assert.deepEqual(messages[2], {
      kind: 'display-preflight',
      permission: 'media',
      isMainFrame: false,
      mediaTypes: [],
      requestingUrl: 'codesurf-ext://permission-probe/index.html',
      securityOrigin: 'codesurf-ext://permission-probe/',
    })
    assert.equal(messages[3].frameUrl, 'codesurf-ext://permission-probe/index.html')
    assert.equal(messages[3].frameOrigin, 'codesurf-ext://permission-probe')
    assert.match(messages[3].parentUrl, /extension-child-permission-flow\.html$/)
    assert.equal(messages[3].topUrl, messages[3].parentUrl)
    assert.equal(messages[3].securityOrigin, 'codesurf-ext://permission-probe/')
    assert.equal(messages[3].userGesture, true)
    assert.equal(messages[3].videoRequested, true)
    assert.deepEqual(messages[4], {
      kind: 'display-result',
      granted: true,
      tracks: ['video'],
    })
  } finally {
    await rm(userDataDirectory, { recursive: true, force: true })
  }
})
