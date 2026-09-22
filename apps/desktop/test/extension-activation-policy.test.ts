import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  isUntrustedPowerExtension,
  resolveExtensionDefaultEnabled,
  resolveExtensionEnabled,
} from '../src/main/extensions/activation-policy.ts'

describe('extension activation policy (risk-01)', () => {
  test('flags workspace-scoped power extensions as untrusted', () => {
    assert.equal(isUntrustedPowerExtension({ untrustedScope: true, tier: 'power' }), true)
    assert.equal(isUntrustedPowerExtension({ untrustedScope: true, tier: 'safe' }), false)
    assert.equal(isUntrustedPowerExtension({ untrustedScope: false, tier: 'power' }), false)
  })

  test('defaults bundled safe extensions on', () => {
    assert.equal(resolveExtensionDefaultEnabled({
      untrustedScope: false,
      defaultEnabledOption: true,
      tier: 'safe',
    }), true)
  })

  test('defaults workspace power extensions off until explicitly enabled', () => {
    assert.equal(resolveExtensionDefaultEnabled({
      untrustedScope: true,
      tier: 'power',
    }), false)

    const enabledCatalogIds = new Set<string>()
    assert.equal(resolveExtensionEnabled({
      untrustedScope: true,
      tier: 'power',
      disabled: false,
      enabledCatalogIds,
      extensionId: 'malicious-loop',
    }), false)

    enabledCatalogIds.add('malicious-loop')
    assert.equal(resolveExtensionEnabled({
      untrustedScope: true,
      tier: 'power',
      disabled: false,
      enabledCatalogIds,
      extensionId: 'malicious-loop',
    }), true)
  })

  test('catalog entries stay off until the user enables them', () => {
    const enabledCatalogIds = new Set<string>()
    assert.equal(resolveExtensionEnabled({
      defaultEnabledOption: false,
      tier: 'safe',
      disabled: false,
      enabledCatalogIds,
      extensionId: 'gallery-widget',
    }), false)

    enabledCatalogIds.add('gallery-widget')
    assert.equal(resolveExtensionEnabled({
      defaultEnabledOption: false,
      tier: 'safe',
      disabled: false,
      enabledCatalogIds,
      extensionId: 'gallery-widget',
    }), true)
  })

  test('disabled ids always win', () => {
    assert.equal(resolveExtensionEnabled({
      untrustedScope: false,
      tier: 'safe',
      disabled: true,
      enabledCatalogIds: new Set(['safe-ext']),
      extensionId: 'safe-ext',
    }), false)
  })
})