import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolvePrincipal } from '../src/main/mcp/auth.ts'
import type { TileTokenRecord } from '../src/main/mcp/auth.ts'
import { randomUUID } from 'node:crypto'

/**
 * Characterization for the SEC-05 wiring: tile-scoped tokens must be
 * distinct from the global token and stable per tileId. Mirrors the
 * logic in `buildContexHttpMcpServerEntry(url, tileId)` without importing
 * the Electron-bound mcp-server module.
 */
describe('tile MCP token principal model (SEC-05)', () => {
  const GLOBAL = randomUUID()
  const tileTokens = new Map<string, TileTokenRecord>()

  function tokenFor(workspaceId: string, tileId: string): string {
    const key = `${workspaceId}\0${tileId}`
    let record = tileTokens.get(key)
    if (!record) {
      record = { workspaceId, tileId, token: randomUUID() }
      tileTokens.set(key, record)
    }
    return record.token
  }

  function entry(
    scope?: { workspaceId: string, tileId: string },
  ): { type: string, url: string, headers: { Authorization: string } } {
    const token = scope ? tokenFor(scope.workspaceId, scope.tileId) : GLOBAL
    return {
      type: 'http',
      url: 'http://127.0.0.1:1234/mcp',
      headers: { Authorization: `Bearer ${token}` },
    }
  }

  test('without tileId embeds the global bearer', () => {
    const e = entry()
    assert.match(e.headers.Authorization, /^Bearer /)
    const principal = resolvePrincipal(
      e.headers.Authorization.slice('Bearer '.length),
      GLOBAL,
      tileTokens,
    )
    assert.deepEqual(principal, { kind: 'global' })
  })

  test('with tileId uses a distinct token that resolves to that tile', () => {
    const globalEntry = entry()
    const tileEntry = entry({ workspaceId: 'workspace-a', tileId: 'tile-alpha' })
    assert.notEqual(globalEntry.headers.Authorization, tileEntry.headers.Authorization)
    const principal = resolvePrincipal(
      tileEntry.headers.Authorization.slice('Bearer '.length),
      GLOBAL,
      tileTokens,
    )
    assert.deepEqual(principal, {
      kind: 'tile',
      workspaceId: 'workspace-a',
      tileId: 'tile-alpha',
    })
  })

  test('same tileId yields a stable token', () => {
    const scope = { workspaceId: 'workspace-a', tileId: 'tile-stable' }
    assert.equal(entry(scope).headers.Authorization, entry(scope).headers.Authorization)
  })

  test('different tileIds yield different tokens', () => {
    assert.notEqual(
      entry({ workspaceId: 'workspace-a', tileId: 'tile-a' }).headers.Authorization,
      entry({ workspaceId: 'workspace-a', tileId: 'tile-b' }).headers.Authorization,
    )
  })

  test('the same tile ID in different workspaces gets distinct tokens', () => {
    assert.notEqual(
      entry({ workspaceId: 'workspace-a', tileId: 'tile-a' }).headers.Authorization,
      entry({ workspaceId: 'workspace-b', tileId: 'tile-a' }).headers.Authorization,
    )
  })
})
