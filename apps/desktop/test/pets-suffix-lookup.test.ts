import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseSuffixedPetId } from '../src/main/ipc/pets-id.ts'

describe('parseSuffixedPetId', () => {
  test('returns null for a plain id (no __ separator)', () => {
    assert.equal(parseSuffixedPetId('my-pet'), null)
  })

  test('returns the dir segment for a simple suffixed id', () => {
    assert.equal(parseSuffixedPetId('my-pet__dir'), 'dir')
  })

  test('returns the FULL remainder after the FIRST __, even with more __ inside', () => {
    assert.equal(
      parseSuffixedPetId('my-pet__dir__with__underscores'),
      'dir__with__underscores',
    )
  })

  test('rejects traversal via ../', () => {
    assert.equal(parseSuffixedPetId('my-pet__../x'), null)
  })

  test('rejects a bare .. suffix', () => {
    assert.equal(parseSuffixedPetId('my-pet__..'), null)
  })

  test('rejects a suffix containing a path separator', () => {
    assert.equal(parseSuffixedPetId('my-pet__a/b'), null)
  })

  test('returns null for an empty suffix', () => {
    assert.equal(parseSuffixedPetId('my-pet__'), null)
  })
})
