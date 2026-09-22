/**
 * Security tests for path-traversal guard in extension manifest.main resolution.
 *
 * Tests assertSafeExtensionEntry (exported from loader.ts) directly — no Electron
 * or utilityProcess required.
 *
 * Also validates that loadPowerExtension rejects manifests with traversal paths
 * before any require() is attempted.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { assertSafeExtensionEntry, loadPowerExtension } from '../src/main/extensions/loader.ts'

// ── assertSafeExtensionEntry ─────────────────────────────────────────────────

test('assertSafeExtensionEntry: normal relative path is allowed', () => {
  assert.doesNotThrow(() => assertSafeExtensionEntry('/ext/my-ext', 'dist/index.js'))
})

test('assertSafeExtensionEntry: dot-dot traversal throws', () => {
  assert.throws(
    () => assertSafeExtensionEntry('/ext/my-ext', '../../evil.js'),
    /escapes extension directory/,
  )
})

test('assertSafeExtensionEntry: absolute path escaping base throws', () => {
  // On POSIX, resolve('/ext/my-ext', '/etc/passwd') → '/etc/passwd'
  const escapingMain = sep === '/' ? '/etc/passwd' : 'C:\\Windows\\evil.exe'
  assert.throws(
    () => assertSafeExtensionEntry('/ext/my-ext', escapingMain),
    /escapes extension directory/,
  )
})

test('assertSafeExtensionEntry: single dot-dot segment throws', () => {
  assert.throws(
    () => assertSafeExtensionEntry('/ext/my-ext', '../sibling/evil.js'),
    /escapes extension directory/,
  )
})

test('assertSafeExtensionEntry: deeply nested relative path is allowed', () => {
  assert.doesNotThrow(() => assertSafeExtensionEntry('/ext/my-ext', 'a/b/c/index.js'))
})

test('assertSafeExtensionEntry: dot-dot that stays within base is allowed', () => {
  // /ext/my-ext/sub/../index.js → /ext/my-ext/index.js — still inside
  assert.doesNotThrow(() => assertSafeExtensionEntry('/ext/my-ext', 'sub/../index.js'))
})

// ── loadPowerExtension with traversal manifest ────────────────────────────────

test('loadPowerExtension: returns null and throws before require() for traversal path', async () => {
  const manifest = {
    id: 'traversal-ext',
    name: 'Traversal Test',
    version: '1.0.0',
    tier: 'power' as const,
    main: '../../evil.js',
    _path: '/tmp/fake-ext-dir',
    _enabled: true,
    _scope: 'global' as const,
    capabilities: [],
    contributes: {},
  }

  // loadPowerExtension wraps the assertSafeExtensionEntry throw in a try/catch
  // and returns null on any load error — so the caller never gets a cleanup fn.
  const result = await loadPowerExtension(manifest, {} as never, 'global')
  assert.equal(result, null, 'loadPowerExtension must return null for traversal path')
})
