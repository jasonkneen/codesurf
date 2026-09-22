import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  assertSafePathSegment,
  assertSafeWorkspacePath,
  resolveInside,
} from '../src/main/security/pathSegments.ts'
import {
  assertBusPublishAllowed,
  assertBusPublishScope,
  assertBusSubscribeAllowed,
  assertSafeBusChannel,
  isSafeBusEventType,
} from '../src/main/security/busChannels.ts'
import { ensureWorkspaceSecretsGitignored } from '../src/main/security/workspaceSecrets.ts'

describe('assertSafePathSegment', () => {
  test('accepts simple tile ids', () => {
    assert.equal(assertSafePathSegment('tile-123', 'tileId'), 'tile-123')
  })

  test('rejects traversal segments', () => {
    assert.throws(() => assertSafePathSegment('../etc', 'tileId'), /Invalid tileId/)
    assert.throws(() => assertSafePathSegment('..', 'tileId'), /Invalid tileId/)
    assert.throws(() => assertSafePathSegment('a/b', 'tileId'), /Invalid tileId/)
  })
})

describe('resolveInside', () => {
  test('keeps resolved paths inside the root', () => {
    const root = assertSafeWorkspacePath('/tmp/workspace')
    const target = resolveInside(root, 'tile-1', 'state.json')
    assert.equal(target, join(root, 'tile-1', 'state.json'))
  })

  test('rejects path escape attempts', () => {
    const root = assertSafeWorkspacePath('/tmp/workspace')
    assert.throws(() => resolveInside(root, '..', 'secrets'), /escapes expected directory/)
  })
})

describe('bus channel authorization', () => {
  test('rejects invalid publish tokens', () => {
    assert.throws(
      () => assertBusPublishAllowed('tile:abc;drop', 'browser:abc', 'data'),
      /Invalid bus channel/,
    )
    assert.throws(
      () => assertBusPublishAllowed('tile:abc', 'browser:abc', 'bogus'),
      /Invalid bus event type/,
    )
  })

  test('allows domain bus event types used by tiles', () => {
    for (const type of [
      'tool_inventory',
      'skill_inventory',
      'browser.evidence',
      'browser.page_health',
    ] as const) {
      assert.equal(isSafeBusEventType(type), true)
      const validated = assertBusPublishAllowed(`tile:abc`, `chat:abc`, type)
      assert.equal(validated.type, type)
    }
  })

  test('allows scoped publish for matching browser tile', () => {
    const validated = assertBusPublishAllowed('browser:tile-1', 'browser:tile-1', 'activity')
    assertBusPublishScope(validated.channel, validated.source)
    assert.equal(validated.channel, 'browser:tile-1')
  })

  test('blocks cross-tile bus publish scope', () => {
    assert.throws(
      () => assertBusPublishScope('tile:other', 'browser:tile-1'),
      /outside source scope/,
    )
  })

  test('binds workspace-qualified channels to the matching source identity', () => {
    assert.doesNotThrow(() => {
      assertBusPublishScope(
        'tile:workspace-a:tile-1',
        'chat:workspace-a:tile-1',
      )
    })
    assert.throws(
      () => assertBusPublishScope(
        'tile:workspace-b:tile-1',
        'chat:workspace-a:tile-1',
      ),
      /outside source scope/,
    )
    assert.throws(
      () => assertBusPublishScope(
        'tile:workspace-a:tile-2',
        'chat:workspace-a:tile-1',
      ),
      /outside source scope/,
    )
  })

  test('allows wildcard subscribe channels', () => {
    const validated = assertBusSubscribeAllowed('tile:*', 'chat:tile-1:mcp')
    assert.equal(validated.channel, 'tile:*')
    assert.equal(validated.subscriberId, 'chat:tile-1:mcp')
  })

  test('blocks wildcard publish channels', () => {
    assert.throws(
      () => assertSafeBusChannel('tile:*'),
      /Wildcards are not allowed/,
    )
  })
})

describe('ensureWorkspaceSecretsGitignored', () => {
  test('adds MCP secret paths to workspace gitignore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codesurf-sec-'))
    await ensureWorkspaceSecretsGitignored(dir)
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8')
    assert.match(gitignore, /^\.mcp\.json$/m)
    assert.match(gitignore, /^\.codesurf\/mcp-server\.json$/m)
  })
})
