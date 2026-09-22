import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { join } from 'node:path'
import { resolvePetBundleDir } from '../src/main/ipc/pets-path.ts'
import { assertSafePathSegment, resolveInside } from '../src/main/security/pathSegments.ts'

const ROOT = '/tmp/codesurf-pets-test-root'

describe('resolvePetBundleDir', () => {
  test('resolves a plain slug under the pets root', () => {
    const result = resolvePetBundleDir(ROOT, 'my-pet')
    assert.equal(result, resolveInside(ROOT, 'my-pet'))
    assert.ok(result.startsWith(ROOT))
  })

  test('rejects path traversal with ../', () => {
    assert.throws(() => resolvePetBundleDir(ROOT, '../../.ssh'), /Invalid pet slug/)
  })

  test('rejects a bare .. slug', () => {
    assert.throws(() => resolvePetBundleDir(ROOT, '..'), /Invalid pet slug/)
  })

  test('rejects a slug with a path separator', () => {
    assert.throws(() => resolvePetBundleDir(ROOT, 'a/b'), /Invalid pet slug/)
  })

  test('rejects empty slug', () => {
    assert.throws(() => resolvePetBundleDir(ROOT, ''), /Invalid pet slug/)
  })

  test('rejects absolute-looking segments with backslash', () => {
    assert.throws(() => resolvePetBundleDir(ROOT, 'foo\\bar'), /Invalid pet slug/)
  })
})

describe('assertSafePathSegment (pets callers)', () => {
  test('accepts typical petdex slugs', () => {
    assert.equal(assertSafePathSegment('orange-cat', 'pet slug'), 'orange-cat')
    assert.equal(assertSafePathSegment('pet_01', 'pet slug'), 'pet_01')
  })
})

describe('resolveInside escape prevention', () => {
  test('joined path never escapes root for safe segments', () => {
    const target = resolveInside(ROOT, 'safe-pet')
    assert.equal(target, join(ROOT, 'safe-pet'))
  })
})
