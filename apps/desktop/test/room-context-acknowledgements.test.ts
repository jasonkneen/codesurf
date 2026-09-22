import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RoomContextAcknowledgements } from '../src/main/chat/room-context-acknowledgements.ts'
import {
  isProviderAcceptanceEvent,
  pollProviderCompletion,
} from '../src/main/chat/provider-acceptance.ts'

describe('room context acknowledgement reservations', () => {
  test('an immediate synthetic stop discards the current turn without consuming the next one', () => {
    const acknowledgements = new RoomContextAcknowledgements()
    const scope = { workspaceId: 'workspace-a', cardId: 'card-a' }

    acknowledgements.register(scope, 11)
    assert.equal(acknowledgements.settle(scope, 'stopped'), undefined)

    // The synthetic done emitted by stop is not provider delivery and has
    // nothing left to acknowledge.
    assert.equal(acknowledgements.settle(scope, 'delivered'), undefined)

    acknowledgements.register(scope, 12)
    assert.deepEqual(acknowledgements.settle(scope, 'delivered'), {
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      sequence: 12,
    })
  })

  test('provider errors discard pending context instead of acknowledging it', () => {
    const acknowledgements = new RoomContextAcknowledgements()
    const scope = { workspaceId: 'workspace-a', cardId: 'card-a' }

    acknowledgements.register(scope, 21)

    assert.equal(acknowledgements.settle(scope, 'failed'), undefined)
    assert.equal(acknowledgements.settle(scope, 'delivered'), undefined)
  })

  test('setup, lifecycle, error, and silent completion events are not prompt acceptance', () => {
    for (const type of ['session', 'setup', 'done', 'error', 'turn.failed']) {
      assert.equal(isProviderAcceptanceEvent({ type }), false, type)
    }
    for (const type of ['text', 'thinking', 'reasoning', 'tool_start', 'tool_summary']) {
      assert.equal(isProviderAcceptanceEvent({ type }), true, type)
    }
  })

  test('detached polling is bounded when the host remains unreachable', async () => {
    let reads = 0
    let waits = 0
    const outcome = await pollProviderCompletion({
      readState: async () => {
        reads += 1
        return null
      },
      isActive: () => true,
      wait: async milliseconds => {
        assert.equal(milliseconds, 750)
        waits += 1
      },
      maxAttempts: 4,
    })

    assert.equal(outcome, 'timeout')
    assert.equal(reads, 4)
    assert.equal(waits, 4)
  })

  test('detached polling exits when its scope is superseded', async () => {
    let active = true
    let reads = 0
    const outcome = await pollProviderCompletion({
      readState: async () => {
        reads += 1
        return { status: 'running' }
      },
      isActive: () => active,
      wait: async () => { active = false },
    })

    assert.equal(outcome, 'superseded')
    assert.equal(reads, 0)
  })

  test('detached polling accepts only an explicit successful completion', async () => {
    const states = [
      { status: 'queued' },
      { status: 'running' },
      { status: 'completed', error: null },
    ]
    const outcome = await pollProviderCompletion({
      readState: async () => states.shift() ?? null,
      isActive: () => true,
      wait: async () => {},
    })

    assert.equal(outcome, 'accepted')
  })
})
