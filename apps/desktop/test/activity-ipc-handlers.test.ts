import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  ActivityHealthSnapshot,
  ActivityQuery,
  ActivityRecord,
  ActivityUpsertInput,
} from '../src/shared/activity-types.ts'
import {
  createActivityIPCHandlers,
  type ActivityIPCService,
} from '../src/main/activity-ipc-handlers.ts'
import {
  ActivityValidationError,
  MAX_ACTIVITY_QUERY_LIMIT,
} from '../src/main/activity-validation.ts'

function record(workspaceId: string, data: ActivityUpsertInput): ActivityRecord {
  return {
    id: data.id ?? 'generated',
    tileId: data.tileId,
    workspaceId,
    type: data.type,
    status: data.status ?? 'pending',
    title: data.title,
    ...(data.detail === undefined ? {} : { detail: data.detail }),
    ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
    ...(data.agent === undefined ? {} : { agent: data.agent }),
    createdAt: 100,
    updatedAt: 100,
  }
}

function serviceFixture() {
  const calls: Array<{ method: string, args: unknown[] }> = []
  const service: ActivityIPCService = {
    async upsert(workspaceId, data) {
      calls.push({ method: 'upsert', args: [workspaceId, data] })
      return record(workspaceId, data)
    },
    async query(query: ActivityQuery) {
      calls.push({ method: 'query', args: [query] })
      return []
    },
    async byTile(workspaceId, tileId) {
      calls.push({ method: 'byTile', args: [workspaceId, tileId] })
      return []
    },
    async delete(workspaceId, tileId, id) {
      calls.push({ method: 'delete', args: [workspaceId, tileId, id] })
      return true
    },
    async clearTile(workspaceId, tileId) {
      calls.push({ method: 'clearTile', args: [workspaceId, tileId] })
      return 0
    },
    async byAgent(workspaceId) {
      calls.push({ method: 'byAgent', args: [workspaceId] })
      return {}
    },
    async health(workspaceId): Promise<ActivityHealthSnapshot> {
      calls.push({ method: 'health', args: [workspaceId] })
      return { available: true, status: 'healthy' }
    },
  }
  return { handlers: createActivityIPCHandlers(service), calls }
}

describe('activity IPC handlers', () => {
  test('exposes the complete bounded activity contract', () => {
    const { handlers } = serviceFixture()
    assert.deepEqual(Object.keys(handlers).sort(), [
      'activity:byAgent',
      'activity:byTile',
      'activity:clearTile',
      'activity:delete',
      'activity:health',
      'activity:query',
      'activity:upsert',
    ])
  })

  test('keeps delete explicitly tile-scoped and rejects the legacy ambiguous shape', async () => {
    const { handlers, calls } = serviceFixture()
    assert.equal(
      await handlers['activity:delete'](null, 'workspace-1', 'tile-a', 'shared'),
      true,
    )
    assert.deepEqual(calls, [{
      method: 'delete',
      args: ['workspace-1', 'tile-a', 'shared'],
    }])

    await assert.rejects(
      async () => handlers['activity:delete'](null, 'workspace-1', 'shared', undefined),
      ActivityValidationError,
    )
    assert.equal(calls.length, 1)
  })

  test('rejects traversal, invalid enums, unknown fields, and oversized limits before dispatch', async () => {
    const { handlers, calls } = serviceFixture()
    await assert.rejects(
      async () => handlers['activity:byAgent'](null, '../escape'),
      ActivityValidationError,
    )
    await assert.rejects(
      async () => handlers['activity:upsert'](null, 'workspace-1', {
        tileId: 'tile-a',
        type: 'arbitrary',
        title: 'Task',
      }),
      ActivityValidationError,
    )
    await assert.rejects(
      async () => handlers['activity:upsert'](null, 'workspace-1', {
        tileId: 'tile-a',
        type: 'task',
        title: 'Task',
        unexpected: true,
      }),
      ActivityValidationError,
    )
    await assert.rejects(
      async () => handlers['activity:query'](null, {
        workspaceId: 'workspace-1',
        limit: MAX_ACTIVITY_QUERY_LIMIT + 1,
      }),
      ActivityValidationError,
    )
    assert.equal(calls.length, 0)
  })

  test('accepts every current renderer drawer upsert payload shape', async () => {
    const { handlers, calls } = serviceFixture()
    const rendererPayloads: ActivityUpsertInput[] = [
      {
        id: 'task-1',
        tileId: 'chat-1',
        type: 'task',
        status: 'running',
        title: 'Implement',
        detail: 'Stage one',
        metadata: { task_id: 'task-1', status: 'in-progress' },
      },
      {
        id: 'tool-1',
        tileId: 'chat-1',
        type: 'tool',
        status: 'done',
        title: 'Read',
        detail: '[object Object]',
        metadata: { tool_id: 'tool-1', input_path: 'README.md' },
      },
      {
        id: 'file-1',
        tileId: 'chat-1',
        type: 'skill',
        status: 'done',
        title: 'src/main/index.ts',
        detail: 'updated',
        metadata: { file_id: 'file-1', action: 'updated' },
      },
      {
        id: 'note-1',
        tileId: 'chat-1',
        type: 'context',
        status: 'done',
        title: 'Checkpoint saved',
        detail: 'progress',
        metadata: { message: 'Checkpoint saved', source: 'progress' },
      },
    ]

    for (const payload of rendererPayloads) {
      const result = await handlers['activity:upsert'](null, 'workspace-1', payload)
      assert.equal(result.id, payload.id)
    }
    assert.equal(calls.length, rendererPayloads.length)
    assert.ok(calls.every(call => call.method === 'upsert'))
  })

  test('normalizes all lookup arguments before dispatch', async () => {
    const { handlers, calls } = serviceFixture()
    await handlers['activity:query'](null, {
      workspaceId: 'workspace-1',
      tileId: 'tile-a',
      type: 'task',
      status: 'done',
      agent: 'agent-a',
      limit: 10,
    })
    await handlers['activity:byTile'](null, 'workspace-1', 'tile-a')
    await handlers['activity:clearTile'](null, 'workspace-1', 'tile-a')
    await handlers['activity:byAgent'](null, 'workspace-1')
    await handlers['activity:health'](null, 'workspace-1')

    assert.deepEqual(calls.map(call => call.method), [
      'query',
      'byTile',
      'clearTile',
      'byAgent',
      'health',
    ])
  })
})
