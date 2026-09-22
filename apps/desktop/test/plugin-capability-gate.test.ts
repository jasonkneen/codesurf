import test from 'node:test'
import assert from 'node:assert/strict'
import { getBridgeScript } from '../src/main/extensions/bridge.ts'

/**
 * Behavioral test for the P1 iframe capability gate. We actually EXECUTE the
 * generated bridge script in a fake window/document and inspect window.contex,
 * so this verifies the real security boundary (which namespaces a plugin can
 * reach), not just that the source compiled.
 */
function runBridge(gate?: { enforced: boolean; granted: string[] }): Record<string, unknown> {
  const script = getBridgeScript('tile-1', 'ext.demo', gate)
  const fakeWindow: Record<string, unknown> & { contex?: Record<string, unknown> } = {
    addEventListener() {},
    parent: { postMessage() {} },
  }
  const fakeDocument = {
    createElement: () => ({}),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  }
  // The script references window/document/console as free variables.
  const fn = new Function('window', 'document', 'console', script)
  fn(fakeWindow, fakeDocument, console)
  return (fakeWindow.contex ?? {}) as Record<string, unknown>
}

const BASELINE = ['tile', 'bus', 'store', 'settings', 'ext', 'workspace', 'theme', 'actions', 'context', 'surface']
const GATED = ['chat', 'relay', 'canvas']

test('ungated plugin (no capabilities declared) gets the full bridge surface', () => {
  const c = runBridge(undefined)
  for (const ns of [...BASELINE, ...GATED]) {
    assert.ok(c[ns], `expected namespace "${ns}" to be present for an ungated plugin`)
  }
  // The canonical alias must mirror window.contex.
  assert.ok(c.tileId !== undefined || c.tile, 'bridge object constructed')
})

test('enforced gate exposes ONLY granted capability namespaces', () => {
  const c = runBridge({ enforced: true, granted: ['chat'] })
  assert.ok(c.chat, 'granted "chat" namespace must remain')
  assert.equal(c.relay, undefined, 'ungranted "relay" must be pruned')
  assert.equal(c.canvas, undefined, 'ungranted "canvas" must be pruned')
  for (const ns of BASELINE) {
    assert.ok(c[ns], `baseline namespace "${ns}" must always be present`)
  }
})

test('enforced gate with empty grants prunes every gated namespace', () => {
  const c = runBridge({ enforced: true, granted: [] })
  for (const ns of GATED) {
    assert.equal(c[ns], undefined, `gated namespace "${ns}" must be pruned when nothing is granted`)
  }
  for (const ns of BASELINE) {
    assert.ok(c[ns], `baseline namespace "${ns}" must survive`)
  }
})

test('enforced:false behaves like ungated (no pruning, no regression)', () => {
  const c = runBridge({ enforced: false, granted: [] })
  for (const ns of GATED) {
    assert.ok(c[ns], `namespace "${ns}" must be present when the gate is not enforced`)
  }
})

test('granting all gated capabilities keeps all of them', () => {
  const c = runBridge({ enforced: true, granted: ['chat', 'relay', 'canvas'] })
  for (const ns of GATED) {
    assert.ok(c[ns], `fully-granted namespace "${ns}" must remain`)
  }
})
