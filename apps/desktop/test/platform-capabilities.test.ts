import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultCapabilitiesFor,
  normalizeCapabilities,
  PLATFORM_CAPABILITY_KEYS,
  hasCapability,
  type PlatformCapabilities,
} from '../src/renderer/src/platform/capabilities.ts'
import { detectPlatform } from '../src/renderer/src/platform/detect.ts'

const ROOT = process.cwd()
const INSTALL = readFileSync(join(ROOT, 'src/renderer/src/platform/installHostBridge.ts'), 'utf8')
const INDEX = readFileSync(join(ROOT, 'src/renderer/src/platform/index.ts'), 'utf8')
const DAEMON_BRIDGE = readFileSync(join(ROOT, 'src/renderer/src/platform/daemonBridge.ts'), 'utf8')
const KANBAN = readFileSync(join(ROOT, 'src/renderer/src/components/KanbanTile.tsx'), 'utf8')

describe('platform capability matrix', () => {
  test('electron is full-fidelity', () => {
    const caps = defaultCapabilitiesFor('electron')
    for (const key of PLATFORM_CAPABILITY_KEYS) {
      assert.equal(caps[key], true, `${key} should be true on electron`)
    }
  })

  test('web daemon-backed core without terminal by default', () => {
    const caps = defaultCapabilitiesFor('web')
    assert.equal(caps.workspace, true)
    assert.equal(caps.canvas, true)
    assert.equal(caps.chatJobs, true)
    assert.equal(caps.activity, false)
    assert.equal(caps.terminal, false)
    assert.equal(caps.extensions, false)
    assert.equal(caps.nodePty, false)
    assert.equal(caps.mcp, false)
    assert.equal(caps.nativeDialogs, false)
    assert.equal(caps.shell, false)
  })

  test('native enables shell + dialogs; terminal is opt-in', () => {
    const without = defaultCapabilitiesFor('native')
    assert.equal(without.shell, true)
    assert.equal(without.nativeDialogs, true)
    assert.equal(without.terminal, false)
    assert.equal(without.activity, false)

    const withTerm = defaultCapabilitiesFor('native', { terminalAvailable: true })
    assert.equal(withTerm.terminal, true)
    assert.equal(withTerm.extensions, false)
  })

  test('normalizeCapabilities fills missing keys from platform defaults', () => {
    const partial = normalizeCapabilities({ terminal: true }, 'web')
    assert.equal(partial.terminal, true)
    assert.equal(partial.workspace, true)
    assert.equal(partial.extensions, false)
  })

  test('hasCapability is false without installed map', () => {
    assert.equal(hasCapability('workspace', null), false)
    const fakeWin = {
      __CODESURF_CAPABILITIES__: defaultCapabilitiesFor('electron') as PlatformCapabilities,
    } as unknown as Window
    assert.equal(hasCapability('extensions', fakeWin), true)
    assert.equal(hasCapability('nodePty', fakeWin), true)
  })

  test('installHostBridge publishes capabilities via the matrix helper', () => {
    assert.match(INSTALL, /defaultCapabilitiesFor/)
    assert.match(INSTALL, /defaultCapabilitiesFor\('electron'\)/)
    assert.match(INSTALL, /terminalAvailable:\s*isTerminalTransportAvailable\(\)/)
    assert.match(INDEX, /defaultCapabilitiesFor/)
    assert.match(INDEX, /hasCapability/)
  })

  test('alternate hosts expose Activity as unavailable and callers gate before use', () => {
    assert.match(DAEMON_BRIDGE, /upsert:\s*notAvailable\('activity\.upsert'\)/)
    assert.match(DAEMON_BRIDGE, /status:\s*'unavailable'/)
    assert.match(KANBAN, /hasCapability\('activity'\)/)
    assert.match(KANBAN, /Activity persistence is unavailable on this host/)
  })

  test('Electrobun facade marker is detected as an alternate native host', () => {
    const previousWindow = globalThis.window
    Object.assign(globalThis, {
      window: {
        electron: { __codesurfHostKind: 'electrobun' },
      },
    })
    try {
      assert.equal(detectPlatform(), 'native')
    } finally {
      Object.assign(globalThis, { window: previousWindow })
    }
  })
})
