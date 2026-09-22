import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { join } from 'path'
import {
  buildCheckpointLabel,
  buildCheckpointSavedSummary,
  buildRuntimeSessionEntryId,
  createRuntimeCheckpoint,
  displayPathForCheckpoint,
  setRuntimeCheckpointIoForTests,
  shouldSkipRuntimeCheckpoint,
} from '../src/main/chat/runtime-checkpoints.ts'

afterEach(() => setRuntimeCheckpointIoForTests(null))

describe('runtime-checkpoints pure helpers', () => {
  test('buildRuntimeSessionEntryId is stable for a given cardId', () => {
    assert.equal(buildRuntimeSessionEntryId('chat-tile-1'), 'codesurf-runtime:chat-tile-1')
    assert.equal(buildRuntimeSessionEntryId('abc'), 'codesurf-runtime:abc')
    assert.equal(
      buildRuntimeSessionEntryId('chat-tile-1'),
      buildRuntimeSessionEntryId('chat-tile-1'),
    )
  })

  test('buildCheckpointLabel includes tool name and relative path for a single file', () => {
    const workspace = '/Users/me/project'
    const file = join(workspace, 'src', 'app.ts')
    const label = buildCheckpointLabel('Write', [file], workspace)
    assert.ok(label.startsWith('Before Write '), `label should start with tool: ${label}`)
    assert.ok(label.includes('src'), `label should include relative path: ${label}`)
    assert.ok(label.includes('app.ts'), `label should include filename: ${label}`)
    assert.ok(!label.includes(workspace), `label should not keep absolute workspace root: ${label}`)
  })

  test('buildCheckpointLabel uses multi-file form when multiple paths', () => {
    const workspace = '/Users/me/project'
    const label = buildCheckpointLabel('Edit', [
      join(workspace, 'a.ts'),
      join(workspace, 'b.ts'),
    ], workspace)
    assert.equal(label, 'Before Edit (2 files)')
  })

  test('buildCheckpointLabel with empty paths is tool-only', () => {
    assert.equal(buildCheckpointLabel('Write', []), 'Before Write')
  })

  test('displayPathForCheckpoint returns workspace-relative path', () => {
    const workspace = '/tmp/ws-checkpoint-test'
    const file = join(workspace, 'notes', 'todo.md')
    assert.equal(displayPathForCheckpoint(file, workspace), join('notes', 'todo.md'))
  })

  test('shouldSkipRuntimeCheckpoint when no paths or no workspaceId', () => {
    assert.equal(shouldSkipRuntimeCheckpoint([], 'ws-1'), true)
    assert.equal(shouldSkipRuntimeCheckpoint(['/a.ts'], null), true)
    assert.equal(shouldSkipRuntimeCheckpoint(['/a.ts'], undefined), true)
    assert.equal(shouldSkipRuntimeCheckpoint(['/a.ts'], ''), true)
    assert.equal(shouldSkipRuntimeCheckpoint(['/a.ts'], 'ws-1'), false)
  })

  test('createRuntimeCheckpoint skips empty paths without throwing', async () => {
    const result = await createRuntimeCheckpoint(
      {
        cardId: 'card-1',
        workspaceId: 'ws-1',
        workspaceDir: '/tmp/ws',
        provider: 'claude',
        model: 'm',
      },
      'Write',
      [],
    )
    assert.deepEqual(result, { ok: true, skipped: true })
  })

  test('createRuntimeCheckpoint skips missing workspaceId without throwing', async () => {
    const result = await createRuntimeCheckpoint(
      {
        cardId: 'card-1',
        workspaceId: '',
        workspaceDir: '/tmp/ws',
        provider: 'codex',
        model: 'm',
      },
      'Write',
      ['/tmp/ws/file.ts'],
    )
    assert.deepEqual(result, { ok: true, skipped: true })
  })

  test('createRuntimeCheckpoint persists metadata and emits a saved chip', async () => {
    const createCalls: unknown[][] = []
    const streamCalls: unknown[][] = []
    setRuntimeCheckpointIoForTests({
      createCheckpoint: async (...args) => {
        createCalls.push(args)
        return { ok: true, checkpoint: { id: 'checkpoint-1' } }
      },
      sendStream: (...args) => streamCalls.push(args),
      log: () => {},
    })

    const result = await createRuntimeCheckpoint(
      {
        cardId: 'card-1',
        workspaceId: 'workspace-1',
        workspaceDir: '/tmp/ws',
        provider: 'claude',
        model: 'claude-test',
      },
      'Write',
      ['/tmp/ws/src/app.ts'],
      { toolUseId: 'tool-1' },
    )

    assert.deepEqual(result, { ok: true, checkpointId: 'checkpoint-1' })
    assert.deepEqual(createCalls, [[
      'workspace-1',
      'codesurf-runtime:card-1',
      {
        label: join('Before Write src', 'app.ts'),
        reason: 'tool:Write',
        files: ['/tmp/ws/src/app.ts'],
        metadata: {
          provider: 'claude',
          model: 'claude-test',
          toolName: 'Write',
          cardId: 'card-1',
          toolUseId: 'tool-1',
        },
        source: 'main-ipc-chat',
      },
    ]])
    assert.deepEqual(streamCalls, [
      [{ workspaceId: 'workspace-1', cardId: 'card-1' }, {
        type: 'tool_start',
        toolId: 'codesurf-checkpoint-checkpoint-1',
        toolName: 'Checkpoint saved',
      }],
      [{ workspaceId: 'workspace-1', cardId: 'card-1' }, {
        type: 'tool_summary',
        toolId: 'codesurf-checkpoint-checkpoint-1',
        toolName: 'Checkpoint saved',
        text: 'Saved checkpoint before Write for src/app.ts',
      }],
    ])
  })

  test('createRuntimeCheckpoint returns daemon failures without emitting a chip', async () => {
    const streamCalls: unknown[][] = []
    setRuntimeCheckpointIoForTests({
      createCheckpoint: async () => ({ ok: false, error: 'checkpoint unavailable' }),
      sendStream: (...args) => streamCalls.push(args),
      log: () => {},
    })

    const result = await createRuntimeCheckpoint(
      {
        cardId: 'card-1',
        workspaceId: 'workspace-1',
        workspaceDir: '/tmp/ws',
        provider: 'codex',
        model: 'codex-test',
      },
      'Edit',
      ['/tmp/ws/app.ts'],
    )

    assert.deepEqual(result, { ok: false, error: 'checkpoint unavailable' })
    assert.deepEqual(streamCalls, [])
  })

  test('buildCheckpointSavedSummary mentions tool and paths', () => {
    const workspace = '/Users/me/project'
    const summary = buildCheckpointSavedSummary(
      'Write',
      [join(workspace, 'a.ts'), join(workspace, 'b.ts'), join(workspace, 'c.ts')],
      workspace,
    )
    assert.ok(summary.includes('Write'), summary)
    assert.ok(summary.includes('a.ts'), summary)
    assert.ok(summary.includes('+1 more'), summary)
  })
})
