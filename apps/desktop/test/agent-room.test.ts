import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'codesurf-agent-room-compat-'))
process.env.CODESURF_HOME = testHome
const { CODESURF_HOME } = await import('../src/main/paths.ts')
assert.equal(CODESURF_HOME, testHome)

const {
  disposeAgentRooms,
  resetAgentRoomsForTests,
  updateLinks,
  post,
  consume,
  readMessages,
  acknowledgeThrough,
  digest,
  prepareTurnContext,
  publishTurnSummary,
  getRoomForTile,
  leaveRoom,
} = await import('../src/main/agent-room/store.ts')
const {
  CHAT_CONTEXT_LIMITS,
  composeChatContext,
} = await import('../src/main/chat/context-composer.ts')
const workspaceId = 'workspace-compat'

beforeEach(async () => {
  await resetAgentRoomsForTests()
})

after(async () => {
  await disposeAgentRooms()
  await rm(testHome, { recursive: true, force: true })
})

describe('agent-room', () => {
  it('creates a room when two tiles are wired', () => {
    const a = 'tile-a-test'
    const b = 'tile-b-test'
    leaveRoom(workspaceId, a)
    leaveRoom(workspaceId, b)

    const room = updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'chat' })
    assert.ok(room)
    assert.equal(room!.members.length, 2)
    assert.equal(getRoomForTile(workspaceId, a)?.id, room!.id)
    assert.equal(getRoomForTile(workspaceId, b)?.id, room!.id)

    const d = digest(workspaceId, a)
    assert.equal(d.roomId, room!.id)
    assert.match(d.standingText, /Agent Room/)
  })

  it('delivers posts via consume once (cursor-gated)', () => {
    const a = 'tile-a-consume'
    const b = 'tile-b-consume'
    leaveRoom(workspaceId, a)
    leaveRoom(workspaceId, b)
    updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'terminal' })

    const event = post(workspaceId, { fromTileId: a, text: 'hello peer', kind: 'task' })
    assert.ok(event)

    const first = consume(workspaceId, b)
    assert.equal(first.events.length, 1)
    assert.match(first.text, /hello peer/)
    assert.match(first.text, /Shared agent room traffic/)

    const second = consume(workspaceId, b)
    assert.equal(second.events.length, 0)
    assert.equal(second.text, '')
  })

  it('prepareTurnContext injects pending room traffic', () => {
    const a = 'tile-a-turn'
    const b = 'tile-b-turn'
    leaveRoom(workspaceId, a)
    leaveRoom(workspaceId, b)
    updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'chat' })
    post(workspaceId, { fromTileId: a, text: 'please review the PR', kind: 'handoff' })

    const prepared = prepareTurnContext(workspaceId, b, 'chat')
    assert.ok(prepared.roomId)
    assert.match(prepared.systemExtra, /please review the PR/)
    assert.match(prepared.systemExtra, /Agent Room|Shared agent room/)
    assert.equal(digest(workspaceId, b).unconsumed, 1)
    assert.ok(prepared.acknowledgeThrough)
    assert.equal(
      acknowledgeThrough(workspaceId, b, prepared.acknowledgeThrough!),
      true,
    )
    assert.equal(digest(workspaceId, b).unconsumed, 0)
  })

  it('projects only whole canonical events that fit the final composed room fragment', () => {
    const a = 'tile-a-room-fragment-budget'
    const b = 'tile-b-room-fragment-budget'
    updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'chat' })
    for (let index = 0; index < 10; index += 1) {
      post(workspaceId, {
        fromTileId: a,
        text: `event-${index}-${'界'.repeat(400)}`,
        kind: 'message',
      })
    }

    const first = prepareTurnContext(workspaceId, b, 'chat')
    assert.ok(first.consumed.events.length > 0)
    assert.ok(first.consumed.events.length < 10)
    assert.ok(first.acknowledgeThrough)
    for (const event of first.consumed.events) {
      assert.match(first.systemExtra, new RegExp(`event-${event.sequence - 1}-`))
    }
    const composed = composeChatContext({ room: first.systemExtra })
    const roomFragment = composed.fragments.find(fragment => fragment.kind === 'room')
    assert.ok(roomFragment)
    assert.equal(roomFragment.truncated, false)
    assert.ok(roomFragment.includedBytes <= CHAT_CONTEXT_LIMITS.roomBytes)

    const deliveredCount = first.consumed.events.length
    assert.equal(acknowledgeThrough(workspaceId, b, first.acknowledgeThrough!), true)
    const second = prepareTurnContext(workspaceId, b, 'chat')
    assert.match(second.systemExtra, new RegExp(`event-${deliveredCount}-`))
    assert.equal(second.consumed.events[0]?.sequence, deliveredCount + 1)
  })

  it('delivers budgeted traffic in ordered batches without gaps', () => {
    const a = 'tile-a-batches'
    const b = 'tile-b-batches'
    updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'chat' })
    for (let index = 0; index < 12; index += 1) {
      post(workspaceId, {
        fromTileId: a,
        text: `${index}:${'x'.repeat(2_000)}`,
      })
    }

    const sequences: number[] = []
    for (let batch = 0; batch < 20; batch += 1) {
      const result = consume(workspaceId, b)
      if (result.events.length === 0) break
      sequences.push(...result.events.map(event => event.sequence))
    }
    assert.deepEqual(sequences, Array.from({ length: 12 }, (_, index) => index + 1))
    assert.equal(digest(workspaceId, b).unconsumed, 0)
  })

  it('keeps compatibility message reads cursor-safe across response batches', () => {
    const a = 'tile-a-message-batches'
    const b = 'tile-b-message-batches'
    updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'chat' })
    for (let index = 0; index < 12; index += 1) {
      post(workspaceId, {
        fromTileId: a,
        text: `${index}:${'y'.repeat(2_000)}`,
      })
    }

    const delivered: number[] = []
    for (let batch = 0; batch < 20; batch += 1) {
      const result = readMessages(workspaceId, b)
      if (result.messages.length === 0) break
      delivered.push(...result.messages.map(message =>
        Number.parseInt(message.text.split(':', 1)[0]!, 10)))
    }
    assert.deepEqual(delivered, Array.from({ length: 12 }, (_, index) => index))
    assert.equal(digest(workspaceId, b).unconsumed, 0)
  })

  it('publishTurnSummary shares assistant output', () => {
    const a = 'tile-a-sum'
    const b = 'tile-b-sum'
    leaveRoom(workspaceId, a)
    leaveRoom(workspaceId, b)
    updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'chat' })
    publishTurnSummary(workspaceId, a, 'I finished the refactor.', 'chat')
    const forB = consume(workspaceId, b)
    assert.ok(forB.events.some(e => e.kind === 'summary'))
    assert.match(forB.text, /finished the refactor/)
  })
})
