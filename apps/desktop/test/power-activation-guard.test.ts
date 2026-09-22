import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isPowerActivationPermitted, type ExtensionScope } from '../src/main/extensions/loader.ts'
import type { ExtensionManifest } from '../src/shared/types.ts'

// Only populate the fields isPowerActivationPermitted actually reads:
// manifest.name, manifest.id, manifest._enabled
function makeManifest(
  enabled: boolean,
  overrides: Partial<ExtensionManifest> = {},
): ExtensionManifest {
  return {
    id: 'test-ext',
    name: 'Test Extension',
    version: '1.0.0',
    tier: 'power',
    _enabled: enabled,
    ...overrides,
  } as ExtensionManifest
}

describe('isPowerActivationPermitted (security gate)', () => {
  test('permits enabled global extension', () => {
    assert.equal(isPowerActivationPermitted(makeManifest(true), 'global'), true)
  })

  test('permits enabled bundled extension', () => {
    assert.equal(isPowerActivationPermitted(makeManifest(true), 'bundled'), true)
  })

  test('permits enabled workspace extension', () => {
    assert.equal(isPowerActivationPermitted(makeManifest(true), 'workspace'), true)
  })

  test('blocks disabled global extension', () => {
    assert.equal(isPowerActivationPermitted(makeManifest(false), 'global'), false)
  })

  test('blocks disabled workspace extension', () => {
    assert.equal(isPowerActivationPermitted(makeManifest(false), 'workspace'), false)
  })

  test('logs _enabled-is-false error when blocked (global)', () => {
    const logged: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '))
    try {
      isPowerActivationPermitted(makeManifest(false), 'global')
    } finally {
      console.error = origError
    }
    assert.ok(
      logged.some(m => m.includes('_enabled is false')),
      `Expected "_enabled is false" in logged errors; got: ${JSON.stringify(logged)}`,
    )
  })

  test('logs workspace-specific error when disabled workspace extension is blocked', () => {
    const logged: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '))
    try {
      isPowerActivationPermitted(makeManifest(false), 'workspace')
    } finally {
      console.error = origError
    }
    assert.ok(
      logged.some(m => m.includes('workspace-local power extensions')),
      `Expected "workspace-local power extensions" in logged errors; got: ${JSON.stringify(logged)}`,
    )
  })
})
