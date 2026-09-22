import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  ElectrobunRoomTurnLifecycle,
  type ElectrobunChatTurn,
} from '../electrobun/bun/chat-room-lifecycle.ts'

const turn: ElectrobunChatTurn = {
  workspaceId: 'workspace-1',
  cardId: 'chat-1',
  turnId: 'turn-1',
}
const request = { ...turn, roomAckSequence: 42 }

describe('Electrobun room turn lifecycle', () => {
  test('acknowledges on the first successful provider event', () => {
    const acknowledgements: unknown[][] = []
    const lifecycle = new ElectrobunRoomTurnLifecycle(
      (...args) => acknowledgements.push(args),
    )
    lifecycle.register(turn, request)
    lifecycle.settle(turn, 'delivered')
    lifecycle.settle(turn, 'delivered')

    assert.deepEqual(acknowledgements, [['workspace-1', 'chat-1', 42]])
  })

  test('does not acknowledge provider errors, rejected launches, or stops', () => {
    const acknowledgements: unknown[][] = []
    const lifecycle = new ElectrobunRoomTurnLifecycle(
      (...args) => acknowledgements.push(args),
    )
    for (const [turnId, outcome] of [
      ['error-turn', 'failed'],
      ['rejected-turn', 'failed'],
      ['stopped-turn', 'stopped'],
    ] as const) {
      const candidate = { ...turn, turnId }
      lifecycle.register(candidate, request)
      lifecycle.settle(candidate, outcome)
    }

    assert.deepEqual(acknowledgements, [])
  })

  test('ignores late events from a replaced turn', () => {
    const acknowledgements: unknown[][] = []
    const lifecycle = new ElectrobunRoomTurnLifecycle(
      (...args) => acknowledgements.push(args),
    )
    const replacement = { ...turn, turnId: 'turn-2' }
    lifecycle.register(turn, request)
    lifecycle.settle(turn, 'stopped')
    lifecycle.register(replacement, request)
    lifecycle.settle(turn, 'delivered')
    lifecycle.settle(replacement, 'delivered')

    assert.deepEqual(acknowledgements, [['workspace-1', 'chat-1', 42]])
  })

  test('ignores absent or invalid host cursors', () => {
    const acknowledgements: unknown[][] = []
    const lifecycle = new ElectrobunRoomTurnLifecycle(
      (...args) => acknowledgements.push(args),
    )
    for (const [index, roomAckSequence] of [undefined, -1, 1.5, Number.NaN].entries()) {
      const candidate = { ...turn, turnId: `invalid-${index}` }
      lifecycle.register(candidate, { ...request, roomAckSequence })
      lifecycle.settle(candidate, 'delivered')
    }

    assert.deepEqual(acknowledgements, [])
  })
})
