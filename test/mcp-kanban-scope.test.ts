import assert from 'node:assert/strict'
import { register } from 'node:module'
import { describe, test } from 'node:test'
import type { McpPrincipal } from '../src/main/mcp/auth.ts'
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
  handleKanbanTool,
  kanbanStateFile,
} = await import('../src/main/mcp/tools/kanban.ts')

function context(
  principal: McpPrincipal,
  pushed: Array<[string, string, string, unknown]>,
  rendered: Array<[string, unknown]>,
): McpToolContext {
  return {
    principal,
    pushSSE: (workspaceId, cardId, event, data) => {
      pushed.push([workspaceId, cardId, event, data])
    },
    sendToRenderer: (event, data) => {
      rendered.push([event, data])
    },
    getExtensionRegistry: () => null,
  }
}

describe('workspace-scoped MCP card events', () => {
  test('kanban paths reject traversal before touching the filesystem', () => {
    assert.throws(
      () => kanbanStateFile('../workspace-b', 'board-a'),
      /workspace_id/,
    )
    assert.throws(
      () => kanbanStateFile('workspace-a', '../../board-b'),
      /board_tile_id/,
    )
  })

  test('kanban board tools require and preserve the authenticated workspace', async () => {
    const pushed: Array<[string, string, string, unknown]> = []
    const rendered: Array<[string, unknown]> = []
    const tileContext = context({
      kind: 'tile',
      workspaceId: 'workspace-a',
      tileId: 'caller-a',
    }, pushed, rendered)

    assert.match(
      await handleKanbanTool('kanban_get_board', {
        workspace_id: 'workspace-b',
        board_tile_id: 'board-a',
      }, tileContext) ?? '',
      /Forbidden/,
    )
    assert.equal(
      await handleKanbanTool('kanban_get_board', {
        board_tile_id: '../board-a',
      }, tileContext),
      'Kanban tool error: Invalid board_tile_id',
    )

    const globalContext = context({ kind: 'global' }, pushed, rendered)
    assert.equal(
      await handleKanbanTool('kanban_get_board', {
        board_tile_id: 'board-a',
      }, globalContext),
      'Missing workspace_id',
    )
  })

  test('tile tokens stamp their workspace and reject a forged workspace', async () => {
    const pushed: Array<[string, string, string, unknown]> = []
    const rendered: Array<[string, unknown]> = []
    const principal: McpPrincipal = {
      kind: 'tile',
      workspaceId: 'workspace-a',
      tileId: 'same-card',
    }
    const ctx = context(principal, pushed, rendered)

    assert.match(
      await handleKanbanTool('card_update', {
        workspace_id: 'workspace-b',
        card_id: 'same-card',
        note: 'forged',
      }, ctx) ?? '',
      /Forbidden/,
    )
    assert.deepEqual(pushed, [])
    assert.deepEqual(rendered, [])

    assert.equal(
      await handleKanbanTool('card_update', {
        card_id: 'same-card',
        note: 'scoped update',
      }, ctx),
      'Card same-card updated',
    )
    const expectedPayload = {
      workspaceId: 'workspace-a',
      cardId: 'same-card',
      note: 'scoped update',
      status: undefined,
    }

    // Events now carry a `_eventId` so the renderer can drop whichever of the
    // two transports arrives second (see test/kanban-event-dedupe.test.ts).
    assert.equal(pushed.length, 1)
    const [pushedWorkspace, pushedCard, pushedEvent, pushedPayload] = pushed[0]
    assert.equal(pushedWorkspace, 'workspace-a')
    assert.equal(pushedCard, 'same-card')
    assert.equal(pushedEvent, 'card_update')
    const { _eventId: pushedId, ...pushedRest } = pushedPayload as Record<string, unknown>
    assert.deepEqual(pushedRest, expectedPayload)
    assert.equal(typeof pushedId, 'string')

    assert.equal(rendered.length, 1)
    const [renderedEvent, renderedPayload] = rendered[0]
    assert.equal(renderedEvent, 'card_update')
    const { _eventId: renderedId, ...renderedRest } = renderedPayload as Record<string, unknown>
    assert.deepEqual(renderedRest, expectedPayload)

    // The point of the id: both transports must carry the SAME one, or the
    // renderer cannot tell a duplicate from a second real event.
    assert.equal(pushedId, renderedId, 'SSE and IPC must share one event id')
  })

  test('global callers must name the workspace for card events', async () => {
    const pushed: Array<[string, string, string, unknown]> = []
    const rendered: Array<[string, unknown]> = []
    const ctx = context({ kind: 'global' }, pushed, rendered)

    assert.equal(
      await handleKanbanTool('card_complete', {
        card_id: 'card-a',
        summary: 'done',
      }, ctx),
      'Missing workspace_id',
    )
    assert.deepEqual(pushed, [])

    assert.equal(
      await handleKanbanTool('card_complete', {
        workspace_id: 'workspace-a',
        card_id: 'card-a',
        summary: 'done',
      }, ctx),
      'Card card-a marked complete: done',
    )
    assert.equal(pushed[0]?.[0], 'workspace-a')
    assert.equal(pushed[0]?.[1], 'card-a')
  })
})
