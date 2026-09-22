import assert from 'node:assert/strict'
import test from 'node:test'
import {
  safeSerializeContextValue,
  singleLine,
  toWellFormedText,
  utf8Bytes,
  utf8Prefix,
} from '../src/main/chat/peer-context-serialization.ts'

const limits = {
  containerEntries: 3,
  depth: 3,
  nodes: 8,
}

test('peer context text helpers keep byte prefixes valid and remove prompt-breaking controls', () => {
  const prefix = utf8Prefix('abé界z', 6)
  assert.equal(prefix, 'abé')
  assert.equal(utf8Bytes(prefix), 4)
  assert.equal(prefix, Buffer.from(prefix, 'utf8').toString('utf8'))
  assert.equal(toWellFormedText('\ud800'), '\uFFFD')
  assert.equal(singleLine('  hello\n\u202Eworld  '), 'hello world')
})

test('safe peer context serialization is deterministic, bounded by traversal limits, and cycle-safe', () => {
  const circular: Record<string, unknown> = { z: true, a: 1 }
  circular.self = circular
  const first = safeSerializeContextValue(circular, limits)
  const second = safeSerializeContextValue(circular, limits)
  assert.equal(first, second)
  assert.match(first, /^\{"a":1,"self":"\[Circular\]","z":true\}$/)

  const wide = safeSerializeContextValue({ d: 4, c: 3, b: 2, a: 1 }, limits)
  assert.match(wide, /"\.\.\.":"\[1 entries omitted\]"/)
  const deep = safeSerializeContextValue({ a: { b: { c: { d: true } } } }, limits)
  assert.match(deep, /\[Depth limit reached\]|\[Node limit reached\]/)
})

test('safe peer context serialization does not execute getters or toJSON', () => {
  const value = {
    safe: 'visible',
    toJSON() { throw new Error('must not execute') },
  }
  Object.defineProperty(value, 'secret', {
    enumerable: true,
    get() { throw new Error('must not execute') },
  })
  const serialized = safeSerializeContextValue(value, {
    containerEntries: 8,
    depth: 4,
    nodes: 16,
  })
  assert.match(serialized, /"safe":"visible"/)
  assert.match(serialized, /"secret":"\[Inaccessible property\]"/)
  assert.match(serialized, /"toJSON":"\[Function\]"/)
})
