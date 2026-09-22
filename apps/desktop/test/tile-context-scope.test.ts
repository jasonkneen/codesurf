import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  isTileContextChangeForScope,
  tileContextChannel,
} from '../src/shared/tileContextScope.ts'

describe('tile context workspace scope', () => {
  test('gives identical tile IDs distinct workspace channels', () => {
    assert.equal(tileContextChannel('workspace-a', 'same-tile'), 'ctx:workspace-a:same-tile')
    assert.equal(tileContextChannel('workspace-b', 'same-tile'), 'ctx:workspace-b:same-tile')
    assert.notEqual(
      tileContextChannel('workspace-a', 'same-tile'),
      tileContextChannel('workspace-b', 'same-tile'),
    )
  })

  test('accepts only payloads from the exact workspace and tile scope', () => {
    const payload = {
      action: 'context_changed',
      workspaceId: 'workspace-a',
      tileId: 'same-tile',
      key: 'ctx:test',
      value: 'a',
    }

    assert.equal(isTileContextChangeForScope(payload, 'workspace-a', 'same-tile'), true)
    assert.equal(isTileContextChangeForScope(payload, 'workspace-b', 'same-tile'), false)
    assert.equal(isTileContextChangeForScope(payload, 'workspace-a', 'other-tile'), false)
    assert.equal(isTileContextChangeForScope(null, 'workspace-a', 'same-tile'), false)
  })
})
