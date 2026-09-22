import test from 'node:test'
import assert from 'node:assert/strict'
import {
  remainingAssistantSnapshotText,
  stripHermesReasoningChrome,
} from '../bin/chat-jobs.mjs'

test('stripHermesReasoningChrome drops TUI reasoning frames from quiet-mode stdout', () => {
  const raw = [
    '┌─ Reasoning ──────────────────────────────────────────────────────────────────┐',
    'The user just said "hello". This is a simple greeting, not a task. I should respond briefly',
    ' and warmly, letting them know I\'m ready to help.',
    'Hi! Ready to help — what would you like to work on?',
  ].join('\n')
  const cleaned = stripHermesReasoningChrome(raw)
  assert.equal(cleaned.includes('┌'), false)
  assert.equal(cleaned.includes('Reasoning ─'), false)
  assert.match(cleaned, /Hi! Ready to help/)
})

test('Hermes thinking snapshots emit only the new tail', () => {
  const first = 'The user just said "hello". This is a simple greeting, not a task. I should respond briefly'
  const full = `${first} and warmly, letting them know I'm ready to help.`
  assert.equal(remainingAssistantSnapshotText(first, '', ''), first)
  assert.equal(remainingAssistantSnapshotText(full, first, first), ' and warmly, letting them know I\'m ready to help.')
  assert.equal(remainingAssistantSnapshotText(full, full, full), '')
})
