import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  buildCheckpointSessionEntryId,
  getCheckpointRestoreAction,
  isCheckpointToolBlock,
} from '../src/renderer/src/components/chat/checkpointToolActions.ts'
import type { ToolBlock } from '../src/shared/chat-types.ts'

const checkpointBlock = (overrides: Partial<ToolBlock> = {}): ToolBlock => ({
  id: 'codesurf-checkpoint-checkpoint-1234-abcd',
  name: 'Checkpoint saved',
  input: '',
  status: 'done',
  summary: 'Saved checkpoint before Write for notes.txt',
  ...overrides,
})

describe('checkpoint tool actions', () => {
  test('recognizes checkpoint-saved tool blocks by encoded checkpoint id', () => {
    expect(isCheckpointToolBlock(checkpointBlock())).toBe(true)
    expect(isCheckpointToolBlock(checkpointBlock({ name: 'Write' }))).toBe(false)
    expect(isCheckpointToolBlock(checkpointBlock({ id: 'toolu_123' }))).toBe(false)
  })

  test('builds a direct restore action for a checkpoint-saved chat tool chip', () => {
    const action = getCheckpointRestoreAction(checkpointBlock(), {
      workspaceId: 'workspace-1',
      tileId: 'chat-tile-1',
    })

    expect(action).toEqual({
      checkpointId: 'checkpoint-1234-abcd',
      workspaceId: 'workspace-1',
      sessionEntryId: 'codesurf-runtime:chat-tile-1',
      label: 'Saved checkpoint before Write for notes.txt',
    })
  })

  test('does not offer restore without a workspace or runtime tile', () => {
    expect(getCheckpointRestoreAction(checkpointBlock(), { workspaceId: '', tileId: 'chat' })).toBe(null)
    expect(getCheckpointRestoreAction(checkpointBlock(), { workspaceId: 'workspace-1', tileId: '' })).toBe(null)
  })

  test('can derive checkpoint id from inspectable JSON input for future checkpoint chips', () => {
    const action = getCheckpointRestoreAction(checkpointBlock({
      id: 'checkpoint-tool-with-input',
      input: JSON.stringify({ checkpointId: 'checkpoint-from-input', sessionEntryId: 'codesurf-runtime:input-tile' }),
    }), {
      workspaceId: 'workspace-1',
      tileId: 'fallback-tile',
    })

    expect(action?.checkpointId).toBe('checkpoint-from-input')
    expect(action?.sessionEntryId).toBe('codesurf-runtime:input-tile')
  })

  test('builds stable runtime session entry ids for chat tiles', () => {
    expect(buildCheckpointSessionEntryId(' chat-tile-1 ')).toBe('codesurf-runtime:chat-tile-1')
    expect(buildCheckpointSessionEntryId('')).toBe(null)
  })
})
