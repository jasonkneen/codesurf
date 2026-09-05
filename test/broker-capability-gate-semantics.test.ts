import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateCapabilityCall } from '../src/main/extensions/broker/policy.ts'

const BASELINE = ['bus', 'mcp', 'ipc', 'settings', 'store', 'log']
const GATED = ['relayHost', 'chat', 'canvas', 'fs', 'shell', 'network', 'secrets', 'chrome', 'daemon']

const capabilityLess = { enforced: false, granted: [] as string[] }
const declaredNotGranted = { enforced: true, granted: [] as string[] }

describe('capability gate is fail-closed for capability-less extensions', () => {
  it('denies EVERY gated namespace when the manifest declares no capabilities', () => {
    // The registry comment used to claim this case was "ungated (full SDK
    // surface)". It is not, and must never become that — an extension that
    // declares nothing must not reach fs/shell/network/secrets.
    for (const ns of GATED) {
      const r = validateCapabilityCall(capabilityLess, 'legacy-ext', ns, 'call')
      assert.equal(r.ok, false, `${ns} must be denied for a capability-less extension`)
      assert.equal(r.ok === false && r.code, 'capability-denied')
    }
  })

  it('still allows the baseline namespaces', () => {
    for (const ns of BASELINE) {
      assert.equal(validateCapabilityCall(capabilityLess, 'legacy-ext', ns, 'call').ok, true, `${ns} is baseline`)
    }
  })

  it('rejects an unknown namespace distinctly from a denied one', () => {
    const r = validateCapabilityCall(capabilityLess, 'x', 'not-a-namespace', 'call')
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.code, 'capability-unknown')
  })
})

describe('enforced distinguishes the two denial causes', () => {
  it('tells a capability-less author to declare the capability', () => {
    const r = validateCapabilityCall(capabilityLess, 'legacy-ext', 'fs', 'readFile')
    assert.equal(r.ok, false)
    const msg = r.ok === false ? r.message : ''
    assert.match(msg, /declares no/, 'must name the real cause: nothing declared')
    assert.match(msg, /"capabilities"/)
    assert.match(msg, /"name": "fs"/, 'must show the exact manifest entry to add')
  })

  it('tells a declared-but-ungranted author it is a grant problem', () => {
    const r = validateCapabilityCall(declaredNotGranted, 'scoped-ext', 'fs', 'readFile')
    assert.equal(r.ok, false)
    const msg = r.ok === false ? r.message : ''
    assert.match(msg, /is not granted capability "fs"/)
    assert.equal(/declares no/.test(msg), false, 'must not blame a missing declaration')
  })

  it('enforced=false never widens access relative to enforced=true', () => {
    for (const ns of GATED) {
      const lenient = validateCapabilityCall(capabilityLess, 'a', ns, 'm').ok
      const strict = validateCapabilityCall(declaredNotGranted, 'a', ns, 'm').ok
      assert.equal(lenient, strict, `${ns}: enforced=false must not grant more than enforced=true`)
    }
  })
})

describe('a granted capability still works', () => {
  it('allows the namespace whose grant is present', () => {
    const gate = { enforced: true, granted: ['relay'] }
    assert.equal(validateCapabilityCall(gate, 'codesurf-relay-suite', 'relayHost', 'install').ok, true)
  })

  it('does not let one grant unlock a different namespace', () => {
    const gate = { enforced: true, granted: ['relay'] }
    assert.equal(validateCapabilityCall(gate, 'codesurf-relay-suite', 'fs', 'readFile').ok, false)
  })
})
