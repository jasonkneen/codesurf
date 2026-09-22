import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  MAX_ROOM_STREAM_SUMMARY_BYTES,
  MAX_ACTIVE_ROOM_STREAMS,
  ROOM_STREAM_TTL_MS,
  RoomStreamAccumulator,
  createChatStreamScope,
  type RoomSummaryPublisher,
} from '../src/main/chat/room-stream-scope.ts'

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RoomStreamAccumulator', () => {
  test('isolates concurrent same-card callbacks by workspace through done', async () => {
    const summaries: Array<[string, string, string]> = []
    const publish: RoomSummaryPublisher = (workspaceId, cardId, summary) => {
      summaries.push([workspaceId, cardId, summary])
    }
    const accumulator = new RoomStreamAccumulator(publish)
    const aHasText = deferred()
    const bHasText = deferred()
    const scopeA = createChatStreamScope('workspace-a', 'same-card')
    const scopeB = createChatStreamScope('workspace-b', 'same-card')

    await Promise.all([
      (async () => {
        accumulator.record(scopeA, { type: 'text', text: 'a-one ' })
        aHasText.resolve()
        await bHasText.promise
        await new Promise<void>(resolve => setImmediate(() => {
          accumulator.record(scopeA, { type: 'delta', delta: 'a-two' })
          accumulator.record(scopeA, { type: 'done' })
          resolve()
        }))
      })(),
      (async () => {
        await aHasText.promise
        accumulator.record(scopeB, { type: 'assistant', text: 'b-only' })
        bHasText.resolve()
        await new Promise<void>(resolve => queueMicrotask(() => {
          accumulator.record(scopeB, { type: 'done' })
          resolve()
        }))
      })(),
    ])

    assert.deepEqual(summaries.sort(), [
      ['workspace-a', 'same-card', 'a-one a-two'],
      ['workspace-b', 'same-card', 'b-only'],
    ])
  })

  test('an error clears only its scoped buffer and cannot erase a peer workspace', async () => {
    const summaries: Array<[string, string, string]> = []
    const accumulator = new RoomStreamAccumulator((workspaceId, cardId, summary) => {
      summaries.push([workspaceId, cardId, summary])
    })
    const bothStarted = deferred()
    const scopeA = createChatStreamScope('workspace-a', 'same-card')
    const scopeB = createChatStreamScope('workspace-b', 'same-card')

    await Promise.all([
      (async () => {
        accumulator.record(scopeA, { type: 'text', text: 'discard me' })
        await bothStarted.promise
        accumulator.record(scopeA, { type: 'error', error: 'failed' })
        accumulator.record(scopeA, { type: 'done' })
      })(),
      (async () => {
        accumulator.record(scopeB, { type: 'text', text: 'keep me' })
        bothStarted.resolve()
        await Promise.resolve()
        accumulator.record(scopeB, { type: 'done' })
      })(),
    ])

    assert.deepEqual(summaries, [
      ['workspace-b', 'same-card', 'keep me'],
    ])
  })

  test('events outside an explicit workspace scope never produce room summaries', () => {
    const summaries: unknown[] = []
    const accumulator = new RoomStreamAccumulator((...args) => summaries.push(args))
    const unscoped = createChatStreamScope(undefined, 'same-card')
    accumulator.record(unscoped, { type: 'text', text: 'ambient' })
    accumulator.record(unscoped, { type: 'done' })
    assert.deepEqual(summaries, [])
  })

  test('bounds an unfinished stream accumulator before publishing its summary', () => {
    const summaries: string[] = []
    const accumulator = new RoomStreamAccumulator((_workspaceId, _cardId, summary) => {
      summaries.push(summary)
    })
    const scope = createChatStreamScope('workspace-a', 'bounded-card')

    for (let index = 0; index < 100; index += 1) {
      accumulator.record(scope, { type: 'text', text: 'x'.repeat(1_000) })
    }
    accumulator.record(scope, { type: 'done' })

    assert.equal(summaries.length, 1)
    assert.equal(
      Buffer.byteLength(summaries[0]!, 'utf8'),
      MAX_ROOM_STREAM_SUMMARY_BYTES,
    )
    assert.equal(summaries[0], 'x'.repeat(MAX_ROOM_STREAM_SUMMARY_BYTES))
  })

  test('evicts the oldest unfinished stream when the active-stream cap is reached', () => {
    const summaries: Array<[string, string]> = []
    const accumulator = new RoomStreamAccumulator((workspaceId, cardId) => {
      summaries.push([workspaceId, cardId])
    })
    for (let index = 0; index <= MAX_ACTIVE_ROOM_STREAMS; index += 1) {
      accumulator.record(
        createChatStreamScope('workspace-cap', `card-${index}`),
        { type: 'text', text: String(index) },
      )
    }
    accumulator.record(
      createChatStreamScope('workspace-cap', 'card-0'),
      { type: 'done' },
    )
    accumulator.record(
      createChatStreamScope('workspace-cap', `card-${MAX_ACTIVE_ROOM_STREAMS}`),
      { type: 'done' },
    )
    assert.deepEqual(summaries, [[
      'workspace-cap',
      `card-${MAX_ACTIVE_ROOM_STREAMS}`,
    ]])
  })

  test('expires abandoned streams and reports completion separately from summaries', () => {
    const summaries: string[] = []
    const completions: Array<[string, string, 'done' | 'error']> = []
    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      const accumulator = new RoomStreamAccumulator(
        (_workspaceId, _cardId, summary) => summaries.push(summary),
        (workspaceId, cardId, outcome) => {
          completions.push([workspaceId, cardId, outcome])
        },
      )
      const expired = createChatStreamScope('workspace-ttl', 'expired')
      accumulator.record(expired, { type: 'text', text: 'stale' })
      now += ROOM_STREAM_TTL_MS + 1
      accumulator.record(
        createChatStreamScope('workspace-ttl', 'fresh'),
        { type: 'text', text: 'fresh' },
      )
      accumulator.record(expired, { type: 'done' })
      accumulator.record(
        createChatStreamScope('workspace-ttl', 'failed'),
        { type: 'error', error: 'no provider handoff' },
      )
      accumulator.record(
        createChatStreamScope('workspace-ttl', 'empty'),
        { type: 'done' },
      )

      assert.deepEqual(summaries, [])
      assert.deepEqual(completions, [
        ['workspace-ttl', 'expired', 'done'],
        ['workspace-ttl', 'failed', 'error'],
        ['workspace-ttl', 'empty', 'done'],
      ])
    } finally {
      Date.now = originalNow
    }
  })

  test('scope objects are immutable snapshots of workspace and card identity', () => {
    const scope = createChatStreamScope(' workspace-a ', ' same-card ')
    assert.deepEqual(scope, { workspaceId: 'workspace-a', cardId: 'same-card' })
    assert.equal(Object.isFrozen(scope), true)
    assert.throws(() => {
      ;(scope as { workspaceId: string }).workspaceId = 'workspace-b'
    }, TypeError)
  })
})
