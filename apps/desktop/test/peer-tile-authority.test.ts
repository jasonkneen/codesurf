import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { authorizePeerTileTarget } from '../src/main/mcp/peer-bridge-authority.ts'

const canvas = {
  tiles: [
    { id: 'tile-a', type: 'note' },
    { id: 'tile-b', type: 'ext:api-proxy' },
    { id: 'tile-c', type: 'note' },
  ],
  // Canvas peers come from lockedConnections/sourceTileId/targetTileId
  // (packages/codesurf-daemon peer-authority-policy).
  lockedConnections: [{ sourceTileId: 'tile-a', targetTileId: 'tile-b' }],
}

const tilePrincipal = (tileId: string) => ({ kind: 'tile' as const, workspaceId: 'ws-1', tileId })

describe('M22 — cross-tile dispatch requires a wire', () => {
  it('refuses a tile the caller has no connection to', () => {
    const r = authorizePeerTileTarget({
      principal: tilePrincipal('tile-a'),
      workspaceId: 'ws-1',
      targetTileId: 'tile-c',
      canvas,
    })
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.error : '', /not a current connected peer/)
  })

  it('refuses a target in another workspace', () => {
    const r = authorizePeerTileTarget({
      principal: tilePrincipal('tile-a'),
      workspaceId: 'ws-2',
      targetTileId: 'tile-b',
      canvas,
    })
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.error : '', /outside the authenticated workspace/)
  })

  it('fails closed when canvas state cannot be read', () => {
    const r = authorizePeerTileTarget({
      principal: tilePrincipal('tile-a'),
      workspaceId: 'ws-1',
      targetTileId: 'tile-b',
      canvas: null,
    })
    assert.equal(r.ok, false, 'connectivity cannot be proven, so it must be refused')
  })
})

describe('M22 — legitimate uses still work', () => {
  it('allows a connected peer', () => {
    const r = authorizePeerTileTarget({
      principal: tilePrincipal('tile-a'),
      workspaceId: 'ws-1',
      targetTileId: 'tile-b',
      canvas,
    })
    assert.equal(r.ok, true)
  })

  it('allows a tile to address its OWN context when allowSelf is set', () => {
    // tile_context_set on your own tile is the primary intended use.
    const r = authorizePeerTileTarget({
      principal: tilePrincipal('tile-a'),
      workspaceId: 'ws-1',
      targetTileId: 'tile-a',
      canvas,
      allowSelf: true,
    })
    assert.equal(r.ok, true)
  })

  it('still bans self-targeting for peer dispatch (allowSelf off)', () => {
    const r = authorizePeerTileTarget({
      principal: tilePrincipal('tile-a'),
      workspaceId: 'ws-1',
      targetTileId: 'tile-a',
      canvas,
    })
    assert.equal(r.ok, false)
    assert.match(r.ok === false ? r.error : '', /cannot target the caller tile/)
  })

  it('a workspace-scoped principal keeps its workspace-wide reach', () => {
    const r = authorizePeerTileTarget({
      principal: { kind: 'global' } as never,
      workspaceId: 'ws-1',
      targetTileId: 'tile-c',
      canvas: null,
    })
    assert.equal(r.ok, true, 'a global token has no peer graph and is already workspace-scoped')
  })
})

describe('M22 — the handlers actually call it', () => {
  it('ext_invoke_action and tile_context_set both authorize', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/main/mcp/tools/context.ts', import.meta.url), 'utf8')
    const calls = src.match(/authorizePeerTileTarget\(\{/g) ?? []
    assert.equal(calls.length, 2, 'both handlers must authorize')

    const ext = src.slice(src.indexOf("if (name === 'ext_invoke_action')"))
    const extBody = ext.slice(0, ext.indexOf('broadcastToRenderer'))
    assert.ok(extBody.includes('authorizePeerTileTarget'), 'authority precedes the broadcast')
  })
})
