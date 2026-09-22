import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { assertSafeCardId } from '../src/main/ipc/fs.ts'

describe('assertSafeCardId', () => {
  test('accepts alphanumeric IDs with hyphens', () => {
    assert.doesNotThrow(() => assertSafeCardId('card-abc-123'))
    assert.doesNotThrow(() => assertSafeCardId('card-kanban-1717654321000'))
    assert.doesNotThrow(() => assertSafeCardId('ABC-xyz-9'))
  })

  test('rejects empty and whitespace-only IDs', () => {
    assert.throws(() => assertSafeCardId(''), /Unsafe card ID/)
    assert.throws(() => assertSafeCardId('   '), /Unsafe card ID/)
  })

  test('rejects path traversal and separator characters', () => {
    assert.throws(() => assertSafeCardId('..'), /Unsafe card ID/)
    assert.throws(() => assertSafeCardId('../etc/passwd'), /Unsafe card ID/)
    assert.throws(() => assertSafeCardId('card/../secret'), /Unsafe card ID/)
    assert.throws(() => assertSafeCardId('card/id'), /Unsafe card ID/)
    assert.throws(() => assertSafeCardId('card\\id'), /Unsafe card ID/)
  })

  test('rejects other special characters', () => {
    assert.throws(() => assertSafeCardId('card.id'), /Unsafe card ID/)
    assert.throws(() => assertSafeCardId('card@home'), /Unsafe card ID/)
    assert.throws(() => assertSafeCardId('card id'), /Unsafe card ID/)
    assert.throws(() => assertSafeCardId('card%20'), /Unsafe card ID/)
  })
})