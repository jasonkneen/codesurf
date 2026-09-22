import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHarnessEnabled } from '../bin/harness-settings.mjs'

test('disabled by default (no settings, no env)', () => {
  assert.equal(isHarnessEnabled({ settings: {}, env: '', provider: 'claude' }), false)
  assert.equal(isHarnessEnabled({ provider: 'claude' }), false)
})

test('settings.harness.enabled routes only supported providers', () => {
  const settings = { harness: { enabled: true } }
  assert.equal(isHarnessEnabled({ settings, env: '', provider: 'claude' }), true)
  assert.equal(isHarnessEnabled({ settings, env: '', provider: 'codex' }), true)
  assert.equal(isHarnessEnabled({ settings, env: '', provider: 'pi' }), false)
  assert.equal(isHarnessEnabled({ settings, env: '', provider: 'opencode' }), false)
  assert.equal(isHarnessEnabled({ settings, env: '', provider: 'hermes' }), false)
})

test('providers allow-list narrows which providers route through the harness', () => {
  const settings = { harness: { enabled: true, providers: ['claude'] } }
  assert.equal(isHarnessEnabled({ settings, env: '', provider: 'claude' }), true)
  assert.equal(isHarnessEnabled({ settings, env: '', provider: 'codex' }), false)
})

test('an explicit providers list cannot re-enable the unavailable Pi adapter', () => {
  const settings = { harness: { enabled: true, providers: ['pi'] } }
  assert.equal(isHarnessEnabled({ settings, env: '', provider: 'pi' }), false)
})

test('CODESURF_HARNESS env override enables without settings', () => {
  for (const v of ['1', 'true', 'on', 'TRUE']) {
    assert.equal(isHarnessEnabled({ settings: {}, env: v, provider: 'claude' }), true, `env=${v}`)
  }
  assert.equal(isHarnessEnabled({ settings: {}, env: '0', provider: 'claude' }), false)
  assert.equal(isHarnessEnabled({ settings: {}, env: 'off', provider: 'claude' }), false)
  // env override still respects the supported-provider set
  assert.equal(isHarnessEnabled({ settings: {}, env: '1', provider: 'opencode' }), false)
})

test('explicitly disabled settings stays off even if the key exists', () => {
  assert.equal(isHarnessEnabled({ settings: { harness: { enabled: false } }, env: '', provider: 'claude' }), false)
})

test('empty provider is never enabled', () => {
  assert.equal(isHarnessEnabled({ settings: { harness: { enabled: true } }, env: '1', provider: '' }), false)
})
