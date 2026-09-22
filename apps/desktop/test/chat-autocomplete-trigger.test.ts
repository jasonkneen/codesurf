import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { detectAutocompleteTrigger } from '../src/renderer/src/hooks/useChatAutocomplete.ts'

describe('detectAutocompleteTrigger', () => {
  test('detects slash commands after whitespace', () => {
    assert.deepEqual(detectAutocompleteTrigger('please /hel'), {
      type: 'slash',
      query: 'hel',
    })
  })

  test('detects mention queries', () => {
    assert.deepEqual(detectAutocompleteTrigger('see @src/rend'), {
      type: 'mention',
      query: 'src/rend',
    })
  })

  test('returns null when no trigger is active', () => {
    assert.equal(detectAutocompleteTrigger('plain text'), null)
  })
})