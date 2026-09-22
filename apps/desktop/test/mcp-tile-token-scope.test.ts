import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  resolvePrincipal,
  assertTileScope,
  type TileTokenRecord,
} from '../src/main/mcp/auth.ts'

const GLOBAL_TOKEN = 'global-secret-token'

function tileTokens(
  entries: Array<[string, string, string]>,
): Map<string, TileTokenRecord> {
  return new Map(entries.map(([workspaceId, tileId, token]) => [
    `${workspaceId}\0${tileId}`,
    { workspaceId, tileId, token },
  ]))
}

describe('resolvePrincipal', () => {
  test('global token resolves to a global principal', () => {
    const tokens = tileTokens([['workspace-a', 'tile-a', 'token-a']])
    assert.deepEqual(resolvePrincipal(GLOBAL_TOKEN, GLOBAL_TOKEN, tokens), { kind: 'global' })
  })

  test('a registered tile token (value match) resolves to that tile', () => {
    const tokens = tileTokens([
      ['workspace-a', 'tile-a', 'token-a'],
      ['workspace-b', 'tile-b', 'token-b'],
    ])
    assert.deepEqual(resolvePrincipal('token-a', GLOBAL_TOKEN, tokens), {
      kind: 'tile',
      workspaceId: 'workspace-a',
      tileId: 'tile-a',
    })
    assert.deepEqual(resolvePrincipal('token-b', GLOBAL_TOKEN, tokens), {
      kind: 'tile',
      workspaceId: 'workspace-b',
      tileId: 'tile-b',
    })
  })

  test('presenting a tileId (map KEY) as the token must never authenticate', () => {
    const tokens = tileTokens([['workspace-a', 'tile-a', 'token-a']])
    assert.equal(resolvePrincipal('tile-a', GLOBAL_TOKEN, tokens), null)
  })

  test('an unknown token resolves to null', () => {
    const tokens = tileTokens([['workspace-a', 'tile-a', 'token-a']])
    assert.equal(resolvePrincipal('not-a-real-token', GLOBAL_TOKEN, tokens), null)
  })

  test('a null token resolves to null', () => {
    const tokens = tileTokens([['workspace-a', 'tile-a', 'token-a']])
    assert.equal(resolvePrincipal(null, GLOBAL_TOKEN, tokens), null)
  })

  test('legacy tile-only token records fail closed without workspace scope', () => {
    const legacy = new Map<string, string>([['tile-a', 'token-a']])
    assert.equal(resolvePrincipal('token-a', GLOBAL_TOKEN, legacy), null)
  })
})

describe('assertTileScope', () => {
  test('a global principal passes any target', () => {
    assert.equal(assertTileScope({ kind: 'global' }, 'workspace-a', 'tile-a'), null)
    assert.equal(assertTileScope({ kind: 'global' }, 'workspace-b', 'tile-b'), null)
    assert.equal(assertTileScope({ kind: 'global' }, undefined, undefined), null)
  })

  test('a tile principal passes its own target', () => {
    assert.equal(assertTileScope({
      kind: 'tile',
      workspaceId: 'workspace-a',
      tileId: 'tile-a',
    }, 'workspace-a', 'tile-a'), null)
  })

  test('a tile principal is rejected for another tile\'s target', () => {
    const error = assertTileScope({
      kind: 'tile',
      workspaceId: 'workspace-a',
      tileId: 'tile-a',
    }, 'workspace-a', 'tile-b')
    assert.notEqual(error, null)
  })

  test('a tile principal is rejected for the same tile ID in another workspace', () => {
    const error = assertTileScope({
      kind: 'tile',
      workspaceId: 'workspace-a',
      tileId: 'tile-a',
    }, 'workspace-b', 'tile-a')
    assert.notEqual(error, null)
  })

  test('a tile principal is rejected for an undefined target', () => {
    const error = assertTileScope({
      kind: 'tile',
      workspaceId: 'workspace-a',
      tileId: 'tile-a',
    }, undefined, undefined)
    assert.notEqual(error, null)
  })
})
