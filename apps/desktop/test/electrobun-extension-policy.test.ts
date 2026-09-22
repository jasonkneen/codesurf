import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  resolveExtensionDefaultEnabled,
  resolveExtensionEnabled,
} from '../src/electrobun/bun/extension-policy.ts'

describe('Electrobun extension activation policy bridge', () => {
  test('re-exports the same default-off rules for workspace power extensions', () => {
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
      extensionId: 'workspace-loop',
    }), false)
  })
})