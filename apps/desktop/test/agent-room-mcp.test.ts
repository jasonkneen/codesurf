import { register } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import type { McpToolContext } from '../src/main/mcp/types.ts'

// The MCP context tool reaches Electron-bound modules and uses the app's
// extensionless TypeScript imports. Resolve both before loading production
// modules under plain node:test.
const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '../ipc/workspace.ts') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(
        'export async function getWorkspaceStorageIds(workspaceId) { return [workspaceId] }'
      ),
    }
  }
  if (specifier === 'electron') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(\`
        export class BrowserWindow {
          static getAllWindows() { return [] }
          static getFocusedWindow() { return null }
          isDestroyed() { return false }
        }
      \`),
    }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\\\.(ts|js|json|node)$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {}
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)

const testHome = await mkdtemp(join(tmpdir(), 'codesurf-agent-room-mcp-'))
process.env.CODESURF_HOME = testHome

const room = await import('../src/main/agent-room/store.ts')
const limits = await import('../src/main/agent-room/validation.ts')
const {
  handleContextTool,
  validateTileContextWrite,
  MAX_TILE_CONTEXT_KEY_BYTES,
  MAX_TILE_CONTEXT_VALUE_BYTES,
  MAX_TILE_CONTEXT_TOTAL_BYTES,
} = await import('../src/main/mcp/tools/context.ts')
const { loadWorkspaceTileState, saveWorkspaceTileState } = await import('../src/main/storage/workspaceArtifacts.ts')

function toolContext(workspaceId: string, tileId: string): McpToolContext {
  return {
    principal: { kind: 'tile', workspaceId, tileId },
    sendToRenderer: () => {},
    pushSSE: () => {},
    getExtensionRegistry: () => null,
  }
}

beforeEach(async () => {
  await room.resetAgentRoomsForTests()
  await writeFile(join(testHome, 'config.json'), JSON.stringify({
    workspaces: [
      { id: 'workspace-a', path: testHome },
      { id: 'workspace-b', path: testHome },
    ],
  }))
})

after(async () => {
  await room.disposeAgentRooms()
  await rm(testHome, { recursive: true, force: true })
})

describe('workspace-scoped agent-room MCP tools', () => {
  test('serializes concurrent context writes and isolates identical tile IDs by workspace', async () => {
    const tileId = 'shared-context-tile'
    await saveWorkspaceTileState('workspace-a', tileId, {
      currentUrl: 'https://example.test/preserved',
    })

    const responses = await Promise.all([
      handleContextTool('tile_context_set', {
        tile_id: tileId,
        key: 'ctx:first',
        value: { order: 1 },
      }, toolContext('workspace-a', tileId)),
      handleContextTool('tile_context_set', {
        tile_id: tileId,
        key: 'ctx:second',
        value: { order: 2 },
      }, toolContext('workspace-a', tileId)),
      handleContextTool('tile_context_set', {
        tile_id: tileId,
        key: 'ctx:other-workspace',
        value: { workspace: 'b' },
      }, toolContext('workspace-b', tileId)),
    ])
    for (const response of responses) {
      assert.deepEqual(JSON.parse(response ?? 'null'), { ok: true })
    }

    const [workspaceAResponse, workspaceBResponse] = await Promise.all([
      handleContextTool('tile_context_get', { tile_id: tileId }, toolContext('workspace-a', tileId)),
      handleContextTool('tile_context_get', { tile_id: tileId }, toolContext('workspace-b', tileId)),
    ])
    const workspaceAEntries = JSON.parse(workspaceAResponse ?? '[]') as Array<{ key: string; value: unknown }>
    const workspaceBEntries = JSON.parse(workspaceBResponse ?? '[]') as Array<{ key: string; value: unknown }>
    assert.deepEqual(
      workspaceAEntries.map(entry => entry.key).sort(),
      ['ctx:first', 'ctx:second'],
    )
    assert.deepEqual(
      workspaceBEntries.map(entry => entry.key),
      ['ctx:other-workspace'],
    )

    const workspaceAState = await loadWorkspaceTileState<{
      currentUrl?: string
      _context?: Record<string, unknown>
    }>('workspace-a', tileId, {})
    assert.equal(workspaceAState.currentUrl, 'https://example.test/preserved')
    assert.deepEqual(Object.keys(workspaceAState._context ?? {}).sort(), ['ctx:first', 'ctx:second'])
  })

  test('tile context writes reject oversized and non-serializable values', () => {
    const source = 'tile-a'
    assert.equal(
      validateTileContextWrite(
        {},
        'k'.repeat(MAX_TILE_CONTEXT_KEY_BYTES + 1),
        'value',
        source,
      ).ok,
      false,
    )
    assert.equal(
      validateTileContextWrite(
        {},
        'key',
        'v'.repeat(MAX_TILE_CONTEXT_VALUE_BYTES + 1),
        source,
      ).ok,
      false,
    )
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.equal(
      validateTileContextWrite({}, 'key', cyclic, source).ok,
      false,
    )

    let context = {}
    let index = 0
    while (
      Buffer.byteLength(JSON.stringify(context), 'utf8')
      < MAX_TILE_CONTEXT_TOTAL_BYTES - MAX_TILE_CONTEXT_VALUE_BYTES / 2
    ) {
      const result = validateTileContextWrite(
        context,
        `key-${index}`,
        'v'.repeat(1_000),
        source,
      )
      assert.equal(result.ok, true)
      if (!result.ok) break
      context = result.next
      index += 1
    }
    const oversized = validateTileContextWrite(
      context,
      'final',
      'v'.repeat(MAX_TILE_CONTEXT_VALUE_BYTES),
      source,
    )
    assert.equal(oversized.ok, false)
  })

  test('stamps workspace and sender identity from a tile token', async () => {
    room.updateLinks('workspace-a', 'same-tile', ['peer-a'])
    room.updateLinks('workspace-b', 'same-tile', ['peer-b'])
    const response = await handleContextTool('room_post', {
      workspace_id: 'workspace-a',
      tile_id: 'forged-sender',
      text: 'scoped message',
    }, toolContext('workspace-a', 'same-tile'))

    assert.ok(response)
    const parsed = JSON.parse(response!)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.event.fromTileId, 'same-tile')
    assert.equal(room.consume('workspace-a', 'peer-a').events.length, 1)
    assert.deepEqual(room.consume('workspace-b', 'peer-b').events, [])
  })

  test('rejects cross-workspace use even when the tile ID is identical', async () => {
    room.updateLinks('workspace-a', 'same-tile', ['peer-a'])
    room.updateLinks('workspace-b', 'same-tile', ['peer-b'])
    const response = await handleContextTool('room_status', {
      workspace_id: 'workspace-b',
      tile_id: 'same-tile',
    }, toolContext('workspace-a', 'same-tile'))
    assert.match(response ?? '', /Forbidden/)
  })

  test('global callers must provide workspace_id for room operations', async () => {
    room.updateLinks('workspace-a', 'global-a', ['global-b'])
    const ctx: McpToolContext = {
      ...toolContext('unused', 'unused'),
      principal: { kind: 'global' },
    }
    assert.equal(
      await handleContextTool('room_status', { tile_id: 'global-a' }, ctx),
      'Missing workspace_id',
    )
    const response = await handleContextTool('room_status', {
      workspace_id: 'workspace-a',
      tile_id: 'global-a',
    }, ctx)
    assert.equal(JSON.parse(response!).inRoom, true)
  })

  test('failed direct messages never echo or claim the raw request', async () => {
    room.updateLinks('workspace-a', 'sender-a', ['recipient-a'])
    const secret = 'request-secret-that-must-not-be-echoed'
    const response = await handleContextTool('peer_send_message', {
      from_tile_id: 'sender-a',
      to_tile_id: 'same-id-but-not-a-member',
      message: secret,
    }, toolContext('workspace-a', 'sender-a'))

    assert.equal(response, 'Recipient is not an active member of the sender room.')
    assert.doesNotMatch(response ?? '', new RegExp(secret))
    assert.deepEqual(room.consume('workspace-a', 'recipient-a').events, [])
  })

  test('peer state keeps the compatibility peers field as an array', async () => {
    room.updateLinks('workspace-a', 'state-a', ['state-b', 'state-c'])
    const response = await handleContextTool('peer_get_state', {
      tile_id: 'state-a',
    }, toolContext('workspace-a', 'state-a'))

    assert.ok(response)
    const parsed = JSON.parse(response!) as { peers?: unknown }
    assert.ok(Array.isArray(parsed.peers))
    assert.deepEqual(
      parsed.peers.map((peer: { tileId: string }) => peer.tileId).sort(),
      ['state-b', 'state-c'],
    )
  })

  test('every agent-room MCP result stays within aggregate byte and token budgets', async () => {
    room.updateLinks('workspace-budget', 'budget-a', ['budget-b'])
    room.setMemberState('workspace-budget', 'budget-b', {
      task: 't'.repeat(limits.MAX_MEMBER_TASK_BYTES),
      files: Array.from(
        { length: limits.MAX_MEMBER_FILES },
        (_, index) => `${index}-${'f'.repeat(limits.MAX_MEMBER_FILE_BYTES - 8)}`,
      ),
    })
    for (let index = 0; index < limits.MAX_EVENTS_PER_ROOM; index += 1) {
      room.post('workspace-budget', {
        fromTileId: 'budget-b',
        text: `${index}-${'x'.repeat(limits.MAX_EVENT_TEXT_BYTES)}`,
        meta: { detail: 'm'.repeat(limits.MAX_METADATA_STRING_BYTES) },
      })
    }

    const ctx = toolContext('workspace-budget', 'budget-a')
    const results = await Promise.all([
      handleContextTool('room_status', { tile_id: 'budget-a' }, ctx),
      handleContextTool('peer_get_state', { tile_id: 'budget-a' }, ctx),
      handleContextTool('room_consume', { tile_id: 'budget-a' }, ctx),
    ])
    for (const result of results) {
      assert.ok(result)
      assert.ok(Buffer.byteLength(result!, 'utf8') <= limits.MAX_MCP_RESULT_BYTES)
      assert.ok(
        limits.estimateTokenCount(result!)
        <= limits.MAX_MCP_RESULT_ESTIMATED_TOKENS,
      )
    }
  })
})
