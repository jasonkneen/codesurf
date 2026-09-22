import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import type { ToolPermissionGrant } from '../src/shared/types.ts'

const permissions = readFileSync(new URL('../src/main/permissions.ts', import.meta.url), 'utf8')
const peerBridge = readFileSync(new URL('../src/main/mcp/tools/peer-bridge.ts', import.meta.url), 'utf8')
const mcpServer = readFileSync(new URL('../src/main/mcp-server.ts', import.meta.url), 'utf8')
const registry = readFileSync(new URL('../src/main/mcp/tools/peer-bridge.ts', import.meta.url), 'utf8')

// Mirror of grantAppliesToRequest's resource rule (permissions.ts imports electron).
function resourceAllows(grantResource: string | null, requestResource: string | null): boolean {
  if (requestResource !== null && grantResource !== requestResource) return false
  if (grantResource !== null && grantResource !== requestResource) return false
  return true
}

describe('M23 — a tile-scoped grant must not become workspace-wide', () => {
  it('the grant type records the resource', () => {
    const types = readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
    assert.ok(types.includes('resourceId?: string | null'))
  })

  it('both comparators check it', () => {
    assert.ok(permissions.includes("if ((grant.resourceId ?? null) !== (request.resourceId ?? null)) return false"),
      'sameGrantTarget must compare the resource')
    assert.ok(permissions.includes('const requestResource = request.resourceId ?? null'),
      'grantAppliesToRequest must compare the resource')
  })

  it('buildGrant persists it', () => {
    assert.ok(permissions.includes('resourceId: request.resourceId ?? null'))
  })

  it('both terminal_send_input ingresses set it', () => {
    assert.ok(peerBridge.includes('resourceId: tileId'), 'the peer-bridge path')
    assert.ok(mcpServer.includes('resourceId: card_id'), 'the raw /inject route')
  })

  it('behaviour: approving terminal A does not authorise terminal B', () => {
    assert.equal(resourceAllows('terminal-A', 'terminal-A'), true, 'the approved terminal still works')
    assert.equal(resourceAllows('terminal-A', 'terminal-B'), false,
      'a different terminal must prompt again — this was the shell-injection path')
  })

  it('behaviour: a legacy workspace-wide grant cannot satisfy a tile-scoped request', () => {
    assert.equal(resourceAllows(null, 'terminal-B'), false,
      'an old grant must not silently cover a newly-scoped request')
  })

  it('behaviour: non-tile-scoped tools are unaffected', () => {
    assert.equal(resourceAllows(null, null), true, 'workspace-wide tools keep working')
  })

  it('the grant shape still typechecks with the field absent', () => {
    const legacy: ToolPermissionGrant = {
      id: 'g1', provider: 'mcp', toolName: 'x', action: 'allow', scope: 'forever',
      workspaceDir: '/ws', createdAt: new Date(0).toISOString(),
    }
    assert.equal(legacy.resourceId ?? null, null, 'resourceId is optional for stored grants')
  })
})

describe('M21 — the advertised kanban schema must reach its handler', () => {
  it('peer-bridge falls through for kanban_* without tile_id', () => {
    assert.ok(registry.includes("if (name.startsWith('kanban_')) return null"),
      'a non-null return here shadowed the board-level handler')
  })

  it('a peer-targeted kanban call still routes to the bridge', () => {
    const fn = registry.slice(registry.indexOf('const tileId = asString(args.tile_id)'))
    const body = fn.slice(0, fn.indexOf('const workspaceScope'))
    assert.ok(body.includes("return 'Missing tile_id'"), 'non-kanban peer tools still require it')
  })
})

describe('M35 — dragging must not re-render on every mousemove', () => {
  const layout = readFileSync(new URL('../src/renderer/src/components/PanelLayout.tsx', import.meta.url), 'utf8')

  it('dragTarget is committed only when it actually changes', () => {
    // Two handlers are named onMove; anchor on the drag one via setDragTarget.
    const start = layout.indexOf('const panelId = panelAtPoint(rootEl')
    const body = layout.slice(start, layout.indexOf('const onUp', start))
    assert.ok(body.includes('prev.panelId === panelId && prev.zone === nextZone'),
      'an unchanged target must reuse the previous object')
    assert.ok(body.includes('? prev'), 'returning prev is what skips the render')
    assert.equal(/setDragTarget\(\{\n\s*panelId,/.test(body), false,
      'the unconditional fresh-object commit must be gone')
  })

  it('a null target is also only committed once', () => {
    // Two handlers are named onMove; anchor on the drag one via setDragTarget.
    const start = layout.indexOf('const panelId = panelAtPoint(rootEl')
    const body = layout.slice(start, layout.indexOf('const onUp', start))
    assert.ok(body.includes('prev === null ? prev : null'), 'leaving all panels must not re-commit null')
  })

  it('behaviour: repeated moves over one zone commit once', () => {
    type T = { panelId: string; zone: string } | null
    let state: T = null
    let commits = 0
    const setDragTarget = (fn: (prev: T) => T) => {
      const next = fn(state)
      if (next !== state) { state = next; commits += 1 }
    }
    const move = (panelId: string | null, zone: string | null) => {
      if (!panelId) setDragTarget(prev => (prev === null ? prev : null))
      else setDragTarget(prev => (prev && prev.panelId === panelId && prev.zone === zone ? prev : { panelId, zone: zone! }))
    }
    for (let i = 0; i < 60; i += 1) move('panel-1', 'center')   // one second of dragging
    assert.equal(commits, 1, '60 mousemoves over one zone must commit once, not 60 times')

    move('panel-1', 'left')
    assert.equal(commits, 2, 'a real zone change still commits')
    move(null, null)
    assert.equal(commits, 3, 'leaving the panels still commits')
    for (let i = 0; i < 10; i += 1) move(null, null)
    assert.equal(commits, 3, 'and does not re-commit null')
  })
})
