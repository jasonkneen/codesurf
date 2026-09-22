import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  disposeChatTileRuntimeState,
  getChatTileRuntimeState,
  reviveChatTileRuntimeState,
  setChatTileRuntimeState,
} from '../src/renderer/src/components/chatTileRuntimeState.ts'
import {
  getTileMessages,
  replaceTileMessages,
} from '../src/renderer/src/components/chat/chatMessagesStore.ts'

test('disposing a chat tile releases both runtime state and transcript messages', () => {
  const workspaceId = 'chat-dispose-workspace'
  const tileId = 'chat-dispose-test'
  reviveChatTileRuntimeState(workspaceId, tileId)
  setChatTileRuntimeState(workspaceId, tileId, { input: 'draft' })
  replaceTileMessages(workspaceId, tileId, [
    { id: 'm1', role: 'assistant', content: 'retained transcript', timestamp: 1 },
  ])

  disposeChatTileRuntimeState(workspaceId, tileId)

  assert.equal(getChatTileRuntimeState(workspaceId, tileId), null)
  assert.deepEqual(getTileMessages(workspaceId, tileId), [])
})
