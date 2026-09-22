import assert from 'node:assert/strict'
import { register } from 'node:module'
import { describe, test } from 'node:test'
import type { McpToolContext } from '../src/main/mcp/types.ts'

const loader = `
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\\\.(ts|js|json|node)$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {}
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)

const {
  handleBusTool,
  scopeBusChannel,
} = await import('../src/main/mcp/tools/bus.ts')
const { handleCanvasTool } = await import('../src/main/mcp/tools/canvas.ts')

function context(
  rendered: Array<[string, unknown]>,
  principal: McpToolContext['principal'] = {
    kind: 'tile',
    workspaceId: 'workspace-a',
    tileId: 'caller-a',
  },
): McpToolContext {
  return {
    principal,
    sendToRenderer: (event, data) => rendered.push([event, data]),
    pushSSE: () => {},
    getExtensionRegistry: () => null,
  }
}

describe('workspace-scoped canvas and bus tools', () => {
  test('canvas mutations stamp tile-token workspace and reject a forged one', async () => {
    const rendered: Array<[string, unknown]> = []
    const ctx = context(rendered)
    assert.match(
      await handleCanvasTool('canvas_create_tile', {
        workspace_id: 'workspace-b',
        type: 'note',
      }, ctx) ?? '',
      /Forbidden/,
    )
    assert.deepEqual(rendered, [])

    assert.equal(
      await handleCanvasTool('canvas_create_tile', { type: 'note' }, ctx),
      'Block created: note',
    )
    assert.deepEqual(rendered, [[
      'canvas_create_tile',
      {
        workspaceId: 'workspace-a',
        type: 'note',
        title: undefined,
        filePath: undefined,
        x: undefined,
        y: undefined,
      },
    ]])
  })

  test('global canvas callers must name a workspace', async () => {
    const rendered: Array<[string, unknown]> = []
    const ctx = context(rendered, { kind: 'global' })
    assert.equal(
      await handleCanvasTool('canvas_list_tiles', {}, ctx),
      'Missing workspace_id',
    )
    assert.equal(
      await handleCanvasTool('canvas_list_tiles', {
        workspace_id: 'workspace-a',
      }, ctx),
      'Block list requested — canvas will emit canvas_tiles_response event',
    )
    assert.deepEqual(rendered, [[
      'canvas_list_tiles',
      { workspaceId: 'workspace-a' },
    ]])
  })

  test('bus channels are canonicalized and cannot cross workspaces', async () => {
    assert.equal(
      scopeBusChannel('workspace-a', 'tile:target-a'),
      'tile:workspace-a:target-a',
    )
    assert.equal(
      scopeBusChannel('workspace-a', 'tile:workspace-b:target-a'),
      null,
    )
    assert.equal(
      scopeBusChannel('workspace-a', 'task:build'),
      'workspace:workspace-a:task:build',
    )

    const rendered: Array<[string, unknown]> = []
    const ctx = context(rendered)
    assert.match(
      await handleBusTool('notify', {
        channel: 'tile:workspace-b:target-a',
        message: 'forged',
      }, ctx) ?? '',
      /Forbidden/,
    )
    assert.equal(rendered.length, 0)

    assert.equal(
      await handleBusTool('notify', {
        channel: 'tile:target-a',
        message: 'scoped',
      }, ctx),
      'Notification sent on tile:workspace-a:target-a: scoped',
    )
    const event = rendered[0]?.[1] as {
      channel?: string
      payload?: { workspaceId?: string }
    }
    assert.equal(event.channel, 'tile:workspace-a:target-a')
    assert.equal(event.payload?.workspaceId, 'workspace-a')
  })
})
