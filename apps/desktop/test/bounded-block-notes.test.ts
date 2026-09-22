import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BLOCK_NOTES_CONTEXT_BUDGET,
  buildBlockNotesContext,
} from '../src/renderer/src/components/chat/boundedBlockNotes.ts'

test('huge block notes are constructed incrementally within the exact budget', () => {
  const hugeNote = `${'guidance '.repeat(2 * 1024 * 1024)}FORBIDDEN_TAIL`
  const messages = [{
    role: 'user',
    content: `${'preview '.repeat(1024)}PREVIEW_TAIL`,
    note: { text: hugeNote },
  }]

  const context = buildBlockNotesContext(messages)
  assert.ok(context)
  assert.equal(context.length, BLOCK_NOTES_CONTEXT_BUDGET)
  assert.match(context, /User annotations on earlier turns/)
  assert.doesNotMatch(context, /FORBIDDEN_TAIL|PREVIEW_TAIL/)
  assert.match(context, /…$/)
})

test('block-note construction stops scanning once the output budget is exhausted', () => {
  const messages: Array<{ role: string; content: string; note: { text: string } }> = [{
    role: 'assistant',
    content: 'first',
    note: { text: 'x'.repeat(BLOCK_NOTES_CONTEXT_BUDGET * 2) },
  }]
  Object.defineProperty(messages, 1, {
    configurable: true,
    get() {
      throw new Error('must not inspect notes after exhaustion')
    },
  })
  messages.length = 2

  const context = buildBlockNotesContext(messages)
  assert.ok(context)
  assert.ok(context.length <= BLOCK_NOTES_CONTEXT_BUDGET)
})

test('block-note construction omits an empty envelope', () => {
  assert.equal(buildBlockNotesContext([{ role: 'user', content: 'no note' }]), null)
})
