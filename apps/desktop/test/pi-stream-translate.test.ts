import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  createPiTranslateState,
  remainingPiSnapshotText,
  translatePiAgentEvent,
  type PiTranslateEvent,
} from '../src/main/chat/pi-stream-translate.ts'

function drain(events: PiTranslateEvent[]) {
  const state = createPiTranslateState()
  return events.flatMap(event => translatePiAgentEvent(event, state))
}

describe('remainingPiSnapshotText', () => {
  test('emits the full snapshot when nothing has streamed', () => {
    expect(remainingPiSnapshotText('Hello', '')).toBe('Hello')
  })

  test('returns only the new tail after streamed deltas', () => {
    expect(remainingPiSnapshotText('Hello there', 'Hello')).toBe(' there')
    expect(remainingPiSnapshotText('Hello there', 'Hello there')).toBe('')
  })

  test('does not re-emit a snapshot that is not a continuation', () => {
    expect(remainingPiSnapshotText('Found 3 files.', "I'll read the file.")).toBe('')
  })
})

describe('translatePiAgentEvent', () => {
  test('surfaces Pi stopReason errors instead of an empty assistant turn', () => {
    const events = drain([
      { type: 'message_start', message: { role: 'assistant' } },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'No API key for provider: anthropic',
        },
      },
      { type: 'agent_end' },
    ])

    expect(events).toEqual([
      {
        type: 'error',
        error: 'No API key for provider: anthropic. Pick a Pi model you are logged into, or run `pi login`.',
      },
      { type: 'block_stop' },
      { type: 'done' },
    ])
  })

  test('empty thinking/text deltas do not suppress text_end content', () => {
    const events = drain([
      { type: 'message_start', message: { role: 'assistant' } },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_end',
          contentIndex: 1,
          content: "Hello! I'm here and ready.",
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: "Hello! I'm here and ready." },
          ],
        },
      },
    ])

    expect(events.filter(event => event.type === 'text')).toEqual([
      { type: 'text', text: "Hello! I'm here and ready." },
    ])
    expect(events.filter(event => event.type === 'thinking')).toEqual([])
    expect(events.some(event => event.type === 'thinking_start')).toBe(true)
  })

  test('message_end emits finalized text when the build does not stream deltas', () => {
    const events = drain([
      { type: 'message_start', message: { role: 'assistant' } },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Great—what do you want to test next?' }],
        },
      },
    ])

    expect(events).toEqual([
      { type: 'text', text: 'Great—what do you want to test next?' },
      { type: 'block_stop' },
    ])
  })

  test('does not duplicate text that already streamed as deltas', () => {
    const events = drain([
      { type: 'message_start', message: { role: 'assistant' } },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello' },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
    ])

    expect(events.filter(event => event.type === 'text')).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ])
  })

  test('accepts toolCall blocks and does not duplicate tool_execution events', () => {
    const events = drain([
      { type: 'message_start', message: { role: 'assistant' } },
      {
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: { path: 'a.ts' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read',
        args: { path: 'a.ts' },
        result: 'ok',
        isError: false,
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{
            type: 'toolCall',
            id: 't1',
            name: 'read',
            arguments: { path: 'a.ts' },
          }],
        },
      },
    ])

    expect(events.filter(event => event.type === 'tool_use')).toEqual([
      {
        type: 'tool_use',
        toolName: 'read',
        toolId: 't1',
        toolInput: JSON.stringify({ path: 'a.ts' }, null, 2),
      },
    ])
  })

  test('surfaces assistantMessageEvent error payloads', () => {
    const events = drain([
      { type: 'message_start', message: { role: 'assistant' } },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'error',
          error: { errorMessage: 'No API key for provider: anthropic' },
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'No API key for provider: anthropic',
        },
      },
    ])

    expect(events.filter(event => event.type === 'error')).toEqual([
      {
        type: 'error',
        error: 'No API key for provider: anthropic. Pick a Pi model you are logged into, or run `pi login`.',
      },
    ])
  })
})
