import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import type { ChatMessage } from '../src/shared/chat-types.ts'
import {
  disposeChatTileRuntimeState,
  getChatTileRuntimeState,
  isChatTileRuntimeStateDisposed,
  reviveChatTileRuntimeState,
  setChatTileRuntimeState,
} from '../src/renderer/src/components/chatTileRuntimeState.ts'
import {
  clearAllTileMessages,
  getTileMessages,
  replaceTileMessages,
  subscribeTileMessages,
  updateTileMessages,
} from '../src/renderer/src/components/chat/chatMessagesStore.ts'

const TILE_ID = 'shared-chat-tile'
const WORKSPACE_A = 'workspace-a'
const WORKSPACE_B = 'workspace-b'

function assistantMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: 1,
  }
}

beforeEach(() => {
  clearAllTileMessages()
  reviveChatTileRuntimeState(WORKSPACE_A, TILE_ID)
  reviveChatTileRuntimeState(WORKSPACE_B, TILE_ID)
})

test('restores runtime state independently for identical tile ids in different workspaces', () => {
  setChatTileRuntimeState(WORKSPACE_A, TILE_ID, { input: 'workspace A draft' })
  setChatTileRuntimeState(WORKSPACE_B, TILE_ID, { input: 'workspace B draft' })

  assert.deepEqual(
    getChatTileRuntimeState(WORKSPACE_A, TILE_ID),
    { input: 'workspace A draft' },
  )
  assert.deepEqual(
    getChatTileRuntimeState(WORKSPACE_B, TILE_ID),
    { input: 'workspace B draft' },
  )
})

test('isolates transcript updates and listeners by workspace and tile', () => {
  replaceTileMessages(WORKSPACE_A, TILE_ID, [
    assistantMessage('a1', 'workspace A'),
  ])
  replaceTileMessages(WORKSPACE_B, TILE_ID, [
    assistantMessage('b1', 'workspace B'),
  ])

  let workspaceANotifications = 0
  let workspaceBNotifications = 0
  const unsubscribeA = subscribeTileMessages(
    WORKSPACE_A,
    TILE_ID,
    () => { workspaceANotifications += 1 },
  )
  const unsubscribeB = subscribeTileMessages(
    WORKSPACE_B,
    TILE_ID,
    () => { workspaceBNotifications += 1 },
  )

  updateTileMessages(WORKSPACE_A, TILE_ID, prev => [
    ...prev,
    assistantMessage('a2', 'workspace A update'),
  ])

  assert.deepEqual(
    getTileMessages(WORKSPACE_A, TILE_ID).map(message => message.content),
    ['workspace A', 'workspace A update'],
  )
  assert.deepEqual(
    getTileMessages(WORKSPACE_B, TILE_ID).map(message => message.content),
    ['workspace B'],
  )
  assert.equal(workspaceANotifications, 1)
  assert.equal(workspaceBNotifications, 0)

  unsubscribeA()
  unsubscribeB()
})

test('disposal and tombstones only affect the matching workspace and tile', () => {
  setChatTileRuntimeState(WORKSPACE_A, TILE_ID, { input: 'workspace A draft' })
  setChatTileRuntimeState(WORKSPACE_B, TILE_ID, { input: 'workspace B draft' })
  replaceTileMessages(WORKSPACE_A, TILE_ID, [
    assistantMessage('a1', 'workspace A'),
  ])
  replaceTileMessages(WORKSPACE_B, TILE_ID, [
    assistantMessage('b1', 'workspace B'),
  ])

  disposeChatTileRuntimeState(WORKSPACE_A, TILE_ID)

  assert.equal(isChatTileRuntimeStateDisposed(WORKSPACE_A, TILE_ID), true)
  assert.equal(isChatTileRuntimeStateDisposed(WORKSPACE_B, TILE_ID), false)
  assert.equal(getChatTileRuntimeState(WORKSPACE_A, TILE_ID), null)
  assert.deepEqual(
    getChatTileRuntimeState(WORKSPACE_B, TILE_ID),
    { input: 'workspace B draft' },
  )
  assert.deepEqual(getTileMessages(WORKSPACE_A, TILE_ID), [])
  assert.deepEqual(
    getTileMessages(WORKSPACE_B, TILE_ID).map(message => message.content),
    ['workspace B'],
  )

  setChatTileRuntimeState(WORKSPACE_A, TILE_ID, { input: 'late write' })
  setChatTileRuntimeState(WORKSPACE_B, TILE_ID, { input: 'workspace B update' })

  assert.equal(getChatTileRuntimeState(WORKSPACE_A, TILE_ID), null)
  assert.deepEqual(
    getChatTileRuntimeState(WORKSPACE_B, TILE_ID),
    { input: 'workspace B update' },
  )
})
