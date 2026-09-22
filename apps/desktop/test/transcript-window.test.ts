import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ChatMessage } from '../src/shared/chat-types.ts'
import {
  CHAT_INITIAL_RENDER_WINDOW,
  CHAT_RENDER_PAGE_SIZE,
  expandTranscriptWindow,
  resetTranscriptWindow,
  selectTranscriptWindow,
} from '../src/renderer/src/components/chat/transcriptWindow.ts'

function msg(id: string, content = id): ChatMessage {
  return { id, role: 'user', content, timestamp: 0 }
}

function makeHistory(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => msg(`m${i}`, `content-${i}`))
}

describe('selectTranscriptWindow', () => {
  test('returns all messages when under the default window', () => {
    const live = makeHistory(5)
    const result = selectTranscriptWindow(live, [], CHAT_INITIAL_RENDER_WINDOW)
    assert.equal(result.rendered.length, 5)
    assert.equal(result.hiddenCount, 0)
    assert.equal(result.combined.length, 5)
    assert.equal(result.rendered[result.rendered.length - 1]?.id, 'm4')
  })

  test('default window keeps only the latest CHAT_INITIAL_RENDER_WINDOW messages', () => {
    const n = CHAT_INITIAL_RENDER_WINDOW + 50
    const live = makeHistory(n)
    const result = selectTranscriptWindow(live, [], CHAT_INITIAL_RENDER_WINDOW)
    assert.equal(result.rendered.length, CHAT_INITIAL_RENDER_WINDOW)
    assert.equal(result.hiddenCount, 50)
    assert.equal(result.combined.length, n)
    // Latest id in the full list is the last selected id
    assert.equal(result.rendered[result.rendered.length - 1]?.id, live[live.length - 1]?.id)
    // Oldest rendered is the start of the window
    assert.equal(result.rendered[0]?.id, live[n - CHAT_INITIAL_RENDER_WINDOW]?.id)
  })

  test('raising the limit includes older messages without inventing duplicates', () => {
    const live = makeHistory(CHAT_INITIAL_RENDER_WINDOW + 30)
    const initial = selectTranscriptWindow(live, [], CHAT_INITIAL_RENDER_WINDOW)
    const expandedLimit = expandTranscriptWindow(CHAT_INITIAL_RENDER_WINDOW)
    const expanded = selectTranscriptWindow(live, [], expandedLimit)

    assert.equal(expanded.rendered.length, CHAT_INITIAL_RENDER_WINDOW + CHAT_RENDER_PAGE_SIZE)
    assert.equal(expanded.hiddenCount, 30 - CHAT_RENDER_PAGE_SIZE)
    // Last message still the latest
    assert.equal(expanded.rendered.at(-1)?.id, live.at(-1)?.id)
    // No duplicates by id
    const ids = expanded.rendered.map(m => m.id)
    assert.equal(new Set(ids).size, ids.length)
    // Expanded window is a superset of the initial window (as a suffix)
    const initialIds = initial.rendered.map(m => m.id)
    assert.deepEqual(ids.slice(-initialIds.length), initialIds)
  })

  test('historical + live dedupes by id and still windows from the end', () => {
    const historical = makeHistory(10)
    const live = [msg('m8', 'live-8'), msg('m10', 'live-10'), msg('m11', 'live-11')]
    const result = selectTranscriptWindow(live, historical, 5)
    // Combined: m0-m7 historical, then live m8,m10,m11 (m8/m9 historical dropped for m8 live)
    // historical filter removes m8 (live id) and m9 stays... wait m8 is in both, historical m8 filtered
    assert.ok(result.combined.every((m, i, arr) => arr.findIndex(x => x.id === m.id) === i))
    assert.equal(result.rendered.length, 5)
    assert.equal(result.rendered.at(-1)?.id, 'm11')
    assert.equal(result.rendered.at(-1)?.content, 'live-11')
  })

  test('resetTranscriptWindow returns the initial policy size', () => {
    assert.equal(resetTranscriptWindow(), CHAT_INITIAL_RENDER_WINDOW)
    assert.equal(expandTranscriptWindow(40, 10), 50)
  })
})
