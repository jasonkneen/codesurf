import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import type { ChatMessage } from '../src/shared/chat-types.ts'
import { applyChatStreamEvent, isReducerEvent, type ChatStreamEvent } from '../src/renderer/src/hooks/chatStreamReducer.ts'

/**
 * Characterisation tests for the pure stream reducer extracted from
 * useChatStreamHandler. Fixtures are representative normalised event sequences
 * (the 14 event types the hook consumes). All events carry explicit ids so the
 * `Date.now()` synthetic-id fallback never fires — the reduced output is fully
 * deterministic and snapshot-stable.
 */

function freshAssistant(): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', timestamp: 0, isStreaming: true }
}

/** Fold an event sequence over a fresh streaming assistant message. */
function reduce(events: ChatStreamEvent[], start: ChatMessage = freshAssistant()): ChatMessage {
  return events.reduce(applyChatStreamEvent, start)
}

function serializableMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(JSON.stringify(message)) as ChatMessage
}

const EXPECTED_REDUCTIONS = {
  fullTurn: {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    isStreaming: false,
    thinking: {
      content: 'Let me check the file and search.',
      done: true,
      id: 'th1',
    },
    thinkingBlocks: [{
      id: 'th1',
      content: 'Let me check the file and search.',
      done: true,
    }],
    contentBlocks: [
      { type: 'thinking', thinkingId: 'th1' },
      { type: 'tool', toolId: 't1' },
      { type: 'tool', toolId: 't2' },
    ],
    toolBlocks: [
      {
        id: 't1',
        name: 'Read',
        rawName: 'Read',
        canonicalName: 'read_file',
        displayName: 'Read file',
        groupKey: 'read_file',
        category: 'read',
        input: '{"path":"a.ts"}',
        status: 'done',
        summary: 'Read a.ts',
        commandEntries: [{ label: 'a.ts', kind: 'read' }],
      },
      {
        id: 't2',
        name: 'Grep',
        rawName: 'Grep',
        canonicalName: 'search_files',
        displayName: 'Search files',
        groupKey: 'search_files',
        category: 'search',
        input: '{"pattern":"foo"}',
        status: 'done',
        summary: 'Searched for foo',
        commandEntries: [{ label: 'foo', kind: 'search' }],
      },
    ],
    cost: 0.012,
    turns: 1,
  },
  streamingToolInput: {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    isStreaming: true,
    toolBlocks: [{
      id: 't1',
      name: 'Bash',
      rawName: 'Bash',
      canonicalName: 'run_command',
      displayName: 'Run command',
      groupKey: 'run_command',
      category: 'command',
      input: 'npm run test',
      status: 'done',
    }],
    contentBlocks: [{ type: 'tool', toolId: 't1' }],
  },
  interleavedBlocks: {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    isStreaming: true,
    thinking: {
      content: 'second',
      done: true,
      id: 'th2',
    },
    thinkingBlocks: [
      { id: 'th1', content: 'first', done: false },
      { id: 'th2', content: 'second', done: true },
    ],
    contentBlocks: [
      { type: 'thinking', thinkingId: 'th1' },
      { type: 'tool', toolId: 't1' },
      { type: 'thinking', thinkingId: 'th2' },
    ],
    toolBlocks: [{
      id: 't1',
      name: 'Read',
      rawName: 'Read',
      canonicalName: 'read_file',
      displayName: 'Read file',
      groupKey: 'read_file',
      category: 'read',
      input: '',
      status: 'done',
    }],
  },
  completedTool: {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    isStreaming: false,
    toolBlocks: [{
      id: 't1',
      name: 'Read',
      rawName: 'Read',
      canonicalName: 'read_file',
      displayName: 'Read file',
      groupKey: 'read_file',
      category: 'read',
      input: '',
      status: 'done',
    }],
    contentBlocks: [{ type: 'tool', toolId: 't1' }],
    cost: 0.001,
    turns: 2,
  },
  error: {
    id: 'm1',
    role: 'assistant',
    content: 'Error: boom',
    timestamp: 0,
    isStreaming: false,
  },
} satisfies Record<string, ChatMessage>

describe('chat stream reducer', () => {
  test('isReducerEvent owns block-model events, not side-effect events', () => {
    for (const t of ['thinking_start', 'thinking', 'tool_start', 'tool_input', 'tool_use', 'tool_summary', 'tool_progress', 'block_stop', 'done', 'error']) {
      expect(isReducerEvent(t)).toBe(true)
    }
    for (const t of ['session', 'text', 'tool_permission_request', 'tool_permission_resolved', 'unknown']) {
      expect(isReducerEvent(t)).toBe(false)
    }
  })

  test('non-owned events leave the message unchanged', () => {
    const start = freshAssistant()
    expect(applyChatStreamEvent(start, { type: 'session', sessionId: 's1' })).toBe(start)
    expect(applyChatStreamEvent(start, { type: 'text', text: 'hi' })).toBe(start)
    expect(applyChatStreamEvent(start, { type: 'unknown' })).toBe(start)
  })

  test('full assistant turn: thinking, two tools, summaries, block_stop, done', () => {
    const result = reduce([
      { type: 'thinking_start', thinkingId: 'th1' },
      { type: 'thinking', thinkingId: 'th1', text: 'Let me check the file' },
      { type: 'thinking', thinkingId: 'th1', text: ' and search.' },
      { type: 'tool_start', toolId: 't1', toolName: 'Read' },
      { type: 'tool_input', toolId: 't1', text: '{"path":' },
      { type: 'tool_input', toolId: 't1', text: '"a.ts"}' },
      { type: 'tool_use', toolId: 't1', toolName: 'Read', toolInput: '{"path":"a.ts"}' },
      { type: 'tool_summary', toolId: 't1', text: 'Read a.ts', commandEntries: [{ label: 'a.ts', kind: 'read' }] },
      { type: 'tool_start', toolId: 't2', toolName: 'Grep' },
      { type: 'tool_use', toolId: 't2', toolName: 'Grep', toolInput: '{"pattern":"foo"}' },
      { type: 'tool_summary', toolId: 't2', text: 'Searched for foo', commandEntries: [{ label: 'foo', kind: 'search' }] },
      { type: 'block_stop', thinkingId: 'th1' },
      { type: 'done', cost: 0.012, turns: 1 },
    ])
    expect(serializableMessage(result)).toEqual(EXPECTED_REDUCTIONS.fullTurn)
  })

  test('streaming tool input accumulates across deltas', () => {
    const result = reduce([
      { type: 'tool_start', toolId: 't1', toolName: 'Bash' },
      { type: 'tool_input', toolId: 't1', text: 'npm ' },
      { type: 'tool_input', toolId: 't1', text: 'run ' },
      { type: 'tool_input', toolId: 't1', text: 'test' },
      { type: 'tool_use', toolId: 't1', toolName: 'Bash' },
    ])
    expect(serializableMessage(result)).toEqual(EXPECTED_REDUCTIONS.streamingToolInput)
  })

  test('interleaved thinking and tool blocks preserve contentBlocks order', () => {
    const result = reduce([
      { type: 'thinking_start', thinkingId: 'th1' },
      { type: 'thinking', thinkingId: 'th1', text: 'first' },
      { type: 'tool_start', toolId: 't1', toolName: 'Read' },
      { type: 'tool_use', toolId: 't1', toolName: 'Read' },
      { type: 'thinking_start', thinkingId: 'th2' },
      { type: 'thinking', thinkingId: 'th2', text: 'second' },
      { type: 'block_stop', thinkingId: 'th2' },
    ])
    expect(serializableMessage(result)).toEqual(EXPECTED_REDUCTIONS.interleavedBlocks)
  })

  test('duplicate thinking_start with the same id does not add a second chip', () => {
    const result = reduce([
      { type: 'thinking_start', thinkingId: 'th1' },
      { type: 'thinking_start', thinkingId: 'th1' },
      { type: 'thinking', thinkingId: 'th1', text: 'once' },
    ])
    expect(result.thinkingBlocks?.length).toBe(1)
    expect(result.contentBlocks?.filter(block => block.type === 'thinking').length).toBe(1)
    expect(result.thinkingBlocks?.[0]?.content).toBe('once')
  })

  test('done marks any still-running tool blocks as done', () => {
    const result = reduce([
      { type: 'tool_start', toolId: 't1', toolName: 'Read' },
      { type: 'done', cost: 0.001, turns: 2 },
    ])
    expect(serializableMessage(result)).toEqual(EXPECTED_REDUCTIONS.completedTool)
  })

  test('tool events preserve raw name and add canonical metadata', () => {
    const result = reduce([
      { type: 'tool_start', toolId: 't1', toolName: 'Codex: Read_file' },
      { type: 'tool_use', toolId: 't1', toolName: 'mcp__codesurf__read_file', toolInput: '{"path":"a.ts"}' },
      { type: 'tool_summary', toolId: 't1', text: 'Read a.ts' },
    ])
    const block = result.toolBlocks?.[0]
    expect(block?.name).toBe('mcp__codesurf__read_file')
    expect(block?.rawName).toBe('mcp__codesurf__read_file')
    expect(block?.displayName).toBe('Read file')
    expect(block?.groupKey).toBe('read_file')
    expect(block?.namespace).toBe('codesurf')
  })

  test('orphan tool summaries become visible activity chips', () => {
    const result = reduce([
      { type: 'tool_summary', toolId: 'bg1', toolName: 'Background job', text: 'Started detached job.' },
    ])
    const block = result.toolBlocks?.[0]
    expect(block?.displayName).toBe('Background job')
    expect(block?.summary).toBe('Started detached job.')
    expect(result.contentBlocks?.[0]).toEqual({ type: 'tool', toolId: 'bg1' })
  })

  test('orphan tool_use (no preceding tool_start) still appears in transcript', () => {
    // Out-of-order or provider-without-tool_start streams must not drop the call.
    const result = reduce([
      { type: 'tool_use', toolId: 'orphan1', toolName: 'Read', toolInput: '{"path":"a.ts"}' },
    ])
    const block = result.toolBlocks?.[0]
    expect(block?.id).toBe('orphan1')
    expect(block?.status).toBe('done')
    expect(block?.input).toBe('{"path":"a.ts"}')
    expect(block?.displayName).toBe('Read file')
    expect(result.contentBlocks?.[0]).toEqual({ type: 'tool', toolId: 'orphan1' })
  })

  test('error fills empty content and stops streaming', () => {
    const result = reduce([
      { type: 'error', error: 'boom' },
    ])
    expect(serializableMessage(result)).toEqual(EXPECTED_REDUCTIONS.error)
  })

  test('error preserves existing content', () => {
    const start: ChatMessage = { ...freshAssistant(), content: 'partial answer' }
    const result = applyChatStreamEvent(start, { type: 'error', error: 'boom' })
    expect(result.content).toBe('partial answer')
    expect(result.isStreaming).toBe(false)
  })
})
