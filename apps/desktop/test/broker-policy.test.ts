/**
 * Unit tests for the broker capability policy (src/main/extensions/broker/policy.ts).
 *
 * Plain node:test — no Electron required.
 * Covers the capability-DENY assertion that the integration test also exercises
 * end-to-end; these run fast and without a display server.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCapabilityCall, capabilityForNamespace } from '../src/main/extensions/broker/policy.ts'

// ── capabilityForNamespace ───────────────────────────────────────────────────

test('capabilityForNamespace: relayHost maps to relay', () => {
  assert.equal(capabilityForNamespace('relayHost'), 'relay')
})

test('capabilityForNamespace: bus maps to bus (identity)', () => {
  assert.equal(capabilityForNamespace('bus'), 'bus')
})

test('capabilityForNamespace: fs maps to fs (identity)', () => {
  assert.equal(capabilityForNamespace('fs'), 'fs')
})

// ── baseline namespaces always allowed ──────────────────────────────────────

test('baseline: bus.publish always allowed (no grant)', () => {
  const gate = { enforced: false, granted: [] }
  const result = validateCapabilityCall(gate, 'test-ext', 'bus', 'publish')
  assert.equal(result.ok, true)
})

test('baseline: mcp.registerTool always allowed', () => {
  const gate = { enforced: true, granted: ['chat'] }
  const result = validateCapabilityCall(gate, 'test-ext', 'mcp', 'registerTool')
  assert.equal(result.ok, true)
})

test('baseline: settings.get always allowed', () => {
  const gate = { enforced: true, granted: [] }
  const result = validateCapabilityCall(gate, 'test-ext', 'settings', 'get')
  assert.equal(result.ok, true)
})

test('baseline: store.set always allowed', () => {
  const gate = { enforced: false, granted: [] }
  const result = validateCapabilityCall(gate, 'test-ext', 'store', 'set')
  assert.equal(result.ok, true)
})

test('baseline: log always allowed', () => {
  const gate = { enforced: false, granted: [] }
  const result = validateCapabilityCall(gate, 'test-ext', 'log', 'anything')
  assert.equal(result.ok, true)
})

// ── capability-DENY assertions ───────────────────────────────────────────────

test('deny: chat-only extension cannot call fs.readFile', () => {
  // Extension only granted 'chat'
  const gate = { enforced: true, granted: ['chat'] }
  const result = validateCapabilityCall(gate, 'chat-ext', 'fs', 'readFile')
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.code, 'capability-denied')
    assert.match(result.message, /capability-denied|not granted|fs/i)
  }
})

test('deny: chat-only extension cannot call shell.exec', () => {
  const gate = { enforced: true, granted: ['chat'] }
  const result = validateCapabilityCall(gate, 'chat-ext', 'shell', 'exec')
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.code, 'capability-denied')
  }
})

test('deny: ungated manifest (no capabilities declared) still cannot call fs', () => {
  // enforced:false means no capabilities declared — baseline only
  const gate = { enforced: false, granted: [] }
  const result = validateCapabilityCall(gate, 'legacy-ext', 'fs', 'readFile')
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.code, 'capability-denied')
  }
})

test('deny: ungated manifest cannot call shell', () => {
  const gate = { enforced: false, granted: [] }
  const result = validateCapabilityCall(gate, 'legacy-ext', 'shell', 'exec')
  assert.equal(result.ok, false)
})

test('deny: ungated manifest cannot call relayHost', () => {
  const gate = { enforced: false, granted: [] }
  const result = validateCapabilityCall(gate, 'legacy-ext', 'relayHost', 'install')
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.code, 'capability-denied')
  }
})

// ── capability-ALLOW assertions ──────────────────────────────────────────────

test('allow: fs granted extension can call fs.readFile', () => {
  const gate = { enforced: true, granted: ['fs'] }
  const result = validateCapabilityCall(gate, 'fs-ext', 'fs', 'readFile')
  assert.equal(result.ok, true)
})

test('allow: relay-granted extension can call relayHost.install', () => {
  const gate = { enforced: true, granted: ['relay'] }
  const result = validateCapabilityCall(gate, 'relay-ext', 'relayHost', 'install')
  assert.equal(result.ok, true)
})

test('allow: codesurf-relay-suite with relay grant can call relayHost', () => {
  const gate = { enforced: true, granted: ['relay'] }
  const result = validateCapabilityCall(gate, 'codesurf-relay-suite', 'relayHost', 'install')
  assert.equal(result.ok, true)
})

// ── capability-unknown assertions ────────────────────────────────────────────

test('unknown: calling a completely unregistered namespace returns capability-unknown', () => {
  const gate = { enforced: false, granted: [] }
  const result = validateCapabilityCall(gate, 'any-ext', 'nativeDisplay', 'createWindow')
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.code, 'capability-unknown')
  }
})
