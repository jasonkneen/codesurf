import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { scopeChatWebviewParams } from '../src/renderer/src/components/chatWebviewScope.ts'

describe('chat webview host scope', () => {
  test('overwrites forged workspace and card identities for every bridged call', () => {
    assert.deepEqual(
      scopeChatWebviewParams({
        workspaceId: 'workspace-b',
        cardId: 'victim-card',
        message: 'hello',
      }, 'workspace-a', 'host-card'),
      {
        workspaceId: 'workspace-a',
        cardId: 'host-card',
        message: 'hello',
      },
    )
  })

  test('also scopes empty and primitive parameter payloads', () => {
    assert.deepEqual(
      scopeChatWebviewParams(null, 'workspace-a', 'host-card'),
      { workspaceId: 'workspace-a', cardId: 'host-card' },
    )
    assert.deepEqual(
      scopeChatWebviewParams('ignored', 'workspace-a', 'host-card'),
      { workspaceId: 'workspace-a', cardId: 'host-card' },
    )
  })
})
