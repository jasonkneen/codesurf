import assert from 'node:assert/strict'
import { describe, test, beforeEach } from 'node:test'
import type { ChatMessage } from '../src/shared/chat-types.ts'
import { applyChatStreamEvent } from '../src/renderer/src/hooks/chatStreamReducer.ts'
import { mergeLiveTranscriptMessages } from '../src/renderer/src/hooks/useTileTranscriptMessages.ts'
import {
  appendStreamingAssistantText,
  clearAllTileMessages,
  getTileChromeSnapshot,
  getTileMessages,
  getTileMessagesSnapshot,
  isPureTextStreamUpdate,
  replaceTileMessages,
  updateTileMessages,
} from '../src/renderer/src/components/chat/chatMessagesStore.ts'

const TILE = 'chat-isolation-tile'
const WORKSPACE = 'chat-isolation-workspace'

function streamingAssistant(content = ''): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content,
    timestamp: 1,
    isStreaming: true,
    contentBlocks: content ? [{ type: 'text', text: content }] : [],
  }
}

beforeEach(() => {
  clearAllTileMessages()
})

describe('isPureTextStreamUpdate', () => {
  test('detects content growth on the last streaming assistant message', () => {
    const prev = [streamingAssistant('Hello')]
    const next = [streamingAssistant('Hello world')]
    // contentBlocks are new arrays — still pure text if tool/thinking refs match
    next[0] = {
      ...prev[0],
      content: 'Hello world',
      contentBlocks: [{ type: 'text', text: 'Hello world' }],
    }
    assert.equal(isPureTextStreamUpdate(prev, next), true)
  })

  test('rejects tool block changes as non-pure-text', () => {
    const prev = [streamingAssistant('Hi')]
    const next: ChatMessage[] = [{
      ...prev[0],
      toolBlocks: [{ id: 't1', name: 'Read', input: '', status: 'running' }],
    }]
    assert.equal(isPureTextStreamUpdate(prev, next), false)
  })
})

describe('chat messages store isolation', () => {
  test('pure text flushes update transcript content while chrome snapshot stays stable', () => {
    replaceTileMessages(WORKSPACE, TILE, [
      { id: 'u1', role: 'user', content: 'go', timestamp: 0 },
      streamingAssistant(''),
    ])

    const chromeBefore = getTileChromeSnapshot(WORKSPACE, TILE)
    const messagesBefore = getTileMessagesSnapshot(WORKSPACE, TILE)

    appendStreamingAssistantText(WORKSPACE, TILE, 'Hel')
    appendStreamingAssistantText(WORKSPACE, TILE, 'lo')
    appendStreamingAssistantText(WORKSPACE, TILE, '!')

    const chromeAfter = getTileChromeSnapshot(WORKSPACE, TILE)
    const messagesAfter = getTileMessagesSnapshot(WORKSPACE, TILE)

    // (a) transcript sees concatenated assistant text
    const last = getTileMessages(WORKSPACE, TILE).at(-1)
    assert.equal(last?.role, 'assistant')
    assert.equal(last?.content, 'Hello!')
    assert.ok(messagesAfter.revision > messagesBefore.revision)
    assert.notEqual(messagesAfter, messagesBefore)

    // (b) chrome snapshot is referentially stable across pure text chunks
    assert.equal(chromeAfter, chromeBefore)
    assert.equal(chromeAfter.revision, chromeBefore.revision)
  })

  test('tool stream events bump chrome revision (non-transcript isolation ends)', () => {
    replaceTileMessages(WORKSPACE, TILE, [streamingAssistant('working')])
    const chromeBefore = getTileChromeSnapshot(WORKSPACE, TILE)

    updateTileMessages(WORKSPACE, TILE, prev => {
      const last = prev[prev.length - 1]
      if (!last) return prev
      const withTool = applyChatStreamEvent(last, {
        type: 'tool_start',
        toolId: 't1',
        toolName: 'Read',
      })
      return [...prev.slice(0, -1), withTool]
    })

    const chromeAfter = getTileChromeSnapshot(WORKSPACE, TILE)
    assert.ok(chromeAfter.revision > chromeBefore.revision)
    assert.notEqual(chromeAfter, chromeBefore)
    assert.ok((getTileMessages(WORKSPACE, TILE).at(-1)?.toolBlocks?.length ?? 0) >= 1)
  })

  test('shipped stream-apply path: text via append + reducer tools stay consistent', () => {
    replaceTileMessages(WORKSPACE, TILE, [streamingAssistant('')])

    const chrome0 = getTileChromeSnapshot(WORKSPACE, TILE)
    appendStreamingAssistantText(WORKSPACE, TILE, 'Checking…')
    assert.equal(getTileChromeSnapshot(WORKSPACE, TILE), chrome0)

    updateTileMessages(WORKSPACE, TILE, prev => {
      let m = prev[prev.length - 1]!
      m = applyChatStreamEvent(m, { type: 'thinking_start', thinkingId: 'th1' })
      m = applyChatStreamEvent(m, { type: 'thinking', thinkingId: 'th1', text: 'plan' })
      m = applyChatStreamEvent(m, { type: 'tool_start', toolId: 't1', toolName: 'Bash' })
      return [...prev.slice(0, -1), m]
    })

    const msgs = getTileMessages(WORKSPACE, TILE)
    assert.equal(msgs.at(-1)?.content, 'Checking…')
    assert.ok((msgs.at(-1)?.thinkingBlocks?.length ?? 0) >= 1)
    assert.ok((msgs.at(-1)?.toolBlocks?.length ?? 0) >= 1)
    assert.ok(getTileChromeSnapshot(WORKSPACE, TILE).revision > chrome0.revision)
  })

  test('transcript projection refreshes live text without changing the structural window', () => {
    const structural = [
      { id: 'u1', role: 'user' as const, content: 'go', timestamp: 0 },
      streamingAssistant(''),
    ]
    const live = [structural[0], streamingAssistant('streamed text')]

    const merged = mergeLiveTranscriptMessages(structural, live)

    assert.equal(merged.length, structural.length)
    assert.equal(merged[0], structural[0])
    assert.equal(merged[1]?.content, 'streamed text')
  })
})
