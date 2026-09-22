import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createRelayProviderCancellation,
  RelayProviderCancelledError,
} from '../src/main/relay/provider-cancellation.ts'

describe('relay provider cancellation', () => {
  test('rejects before allocating provider work when already cancelled', () => {
    const parent = new AbortController()
    const reason = new Error('runtime disposed')
    parent.abort(reason)

    assert.throws(
      () => createRelayProviderCancellation('Claude', parent.signal),
      (error: unknown) => {
        assert.ok(error instanceof RelayProviderCancelledError)
        assert.equal(error.cause, reason)
        return true
      },
    )
  })

  test('aborts the provider controller and observable turn together', async () => {
    const parent = new AbortController()
    const cancellation = createRelayProviderCancellation(
      'Claude',
      parent.signal,
    )
    const reason = new Error('workspace stopped')

    parent.abort(reason)

    const error = await cancellation.cancelled.catch(caught => caught)
    assert.ok(error instanceof RelayProviderCancelledError)
    assert.equal(error.cause, reason)
    assert.equal(cancellation.abortController.signal.aborted, true)
    assert.equal(cancellation.abortController.signal.reason, error)
    cancellation.dispose()
  })
})
