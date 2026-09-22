import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { routeHostForAttachments } from '../src/main/chat/attachment-route-policy.ts'

const localDaemon = {
  id: 'local-daemon',
  type: 'local-daemon' as const,
  label: 'CodeSurf daemon',
  enabled: true,
}

describe('attachment execution routing', () => {
  test('auto and prefer-daemon modes use the capable runtime for host attachments', () => {
    for (const executionMode of ['auto', 'prefer-local-daemon'] as const) {
      assert.equal(routeHostForAttachments({
        selectedHost: localDaemon,
        executionMode,
        hasHostAttachments: true,
      }), null)
    }
  })

  test('explicit daemon pins fail closed while attachment-free turns retain the daemon', () => {
    assert.throws(() => routeHostForAttachments({
      selectedHost: localDaemon,
      executionMode: 'daemon-only',
      hasHostAttachments: true,
    }), /does not yet transport verified image bytes/i)
    assert.equal(routeHostForAttachments({
      selectedHost: localDaemon,
      executionMode: 'auto',
      hasHostAttachments: false,
    }), localDaemon)
  })
})
