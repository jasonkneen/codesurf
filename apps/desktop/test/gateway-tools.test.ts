import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  mapGatewayModels,
  resolveGatewayApiKey,
  resolveGatewayPrincipal,
  selectGatewayTools,
} from '../src/main/chat/gateway-tools.ts'
import { assertTileScope } from '../src/main/mcp/auth.ts'

const TOOLS = [
  { name: 'canvas_create_tile', description: 'create a tile', inputSchema: { type: 'object' } },
  { name: 'canvas_list_tiles', description: 'list tiles', inputSchema: { type: 'object' } },
  { name: 'kanban_add_card', description: 'add a card', inputSchema: { type: 'object' } },
]

describe('selectGatewayTools', () => {
  test('null allow-list is unrestricted (full toolset)', () => {
    assert.deepEqual(selectGatewayTools(TOOLS, null), TOOLS)
  })

  test('empty allow-list is deny-all (no tools)', () => {
    assert.deepEqual(selectGatewayTools(TOOLS, []), [])
  })

  test('named allow-list restricts to those tools', () => {
    const selected = selectGatewayTools(TOOLS, ['canvas_create_tile'])
    assert.deepEqual(selected.map(t => t.name), ['canvas_create_tile'])
  })

  test('matching is case- and separator-insensitive (Claude-style names match)', () => {
    const selected = selectGatewayTools(TOOLS, ['CanvasCreateTile', 'KANBAN-ADD-CARD'])
    assert.deepEqual(selected.map(t => t.name), ['canvas_create_tile', 'kanban_add_card'])
  })

  test('unknown names in the allow-list grant nothing extra', () => {
    assert.deepEqual(selectGatewayTools(TOOLS, ['Bash', 'Write']), [])
  })
})

describe('resolveGatewayApiKey', () => {
  // The app and the daemon spawn path must agree, or a user with both a stored
  // key and an env var authenticates as two different accounts depending on
  // where the turn runs.
  test('stored secret wins over the environment', () => {
    assert.equal(
      resolveGatewayApiKey('stored-key', { AI_GATEWAY_API_KEY: 'env-key' }),
      'stored-key',
    )
  })

  test('environment is used when no secret is stored', () => {
    assert.equal(resolveGatewayApiKey(null, { AI_GATEWAY_API_KEY: 'env-key' }), 'env-key')
    assert.equal(resolveGatewayApiKey(undefined, { AI_GATEWAY_API_KEY: 'env-key' }), 'env-key')
    assert.equal(resolveGatewayApiKey('', { AI_GATEWAY_API_KEY: 'env-key' }), 'env-key')
  })

  test('whitespace-only values are not keys', () => {
    assert.equal(resolveGatewayApiKey('   ', { AI_GATEWAY_API_KEY: 'env-key' }), 'env-key')
    assert.equal(resolveGatewayApiKey('   ', { AI_GATEWAY_API_KEY: '   ' }), null)
  })

  test('values are trimmed (a trailing newline from a paste must not break auth)', () => {
    assert.equal(resolveGatewayApiKey('  stored-key\n', {}), 'stored-key')
    assert.equal(resolveGatewayApiKey(null, { AI_GATEWAY_API_KEY: ' env-key \n' }), 'env-key')
  })

  test('returns null when nothing is configured', () => {
    assert.equal(resolveGatewayApiKey(null, {}), null)
    assert.equal(resolveGatewayApiKey(undefined, undefined), null)
  })
})

describe('resolveGatewayPrincipal', () => {
  test('binds a complete workspace + tile pair to a tile principal', () => {
    assert.deepEqual(resolveGatewayPrincipal('ws-1', 'tile-9'), {
      kind: 'tile',
      workspaceId: 'ws-1',
      tileId: 'tile-9',
    })
  })

  test('trims surrounding whitespace', () => {
    assert.deepEqual(resolveGatewayPrincipal('  ws-1  ', '  tile-9  '), {
      kind: 'tile',
      workspaceId: 'ws-1',
      tileId: 'tile-9',
    })
  })

  // Fail closed. Returning a global principal here would be an unscoped
  // credential: assertTileScope authorizes global for every workspace/tile.
  for (const [label, workspaceId, tileId] of [
    ['missing tile', 'ws-1', undefined],
    ['missing workspace', undefined, 'tile-9'],
    ['empty tile', 'ws-1', ''],
    ['whitespace-only tile', 'ws-1', '   '],
    ['empty workspace', '', 'tile-9'],
    ['both missing', undefined, undefined],
    ['non-string ids', 42, { tileId: 'x' }],
  ] as Array<[string, unknown, unknown]>) {
    test(`returns null for ${label} (never falls back to global)`, () => {
      assert.equal(resolveGatewayPrincipal(workspaceId, tileId), null)
    })
  }

  test('a resolved principal is actually scope-checked, unlike global', () => {
    const principal = resolveGatewayPrincipal('ws-1', 'tile-9')
    assert.ok(principal)
    // Own tile: allowed.
    assert.equal(assertTileScope(principal, 'ws-1', 'tile-9'), null)
    // Another tile in the same workspace, and another workspace: refused.
    assert.match(String(assertTileScope(principal, 'ws-1', 'tile-other')), /Forbidden/)
    assert.match(String(assertTileScope(principal, 'ws-other', 'tile-9')), /Forbidden/)
    // This is what the old fallback would have produced — authorized everywhere.
    assert.equal(assertTileScope({ kind: 'global' }, 'any-ws', 'any-tile'), null)
  })
})

describe('mapGatewayModels', () => {
  test('maps id/name/description and formats pricing per 1M tokens', () => {
    const [option] = mapGatewayModels([
      {
        id: 'anthropic/claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        description: 'Fast frontier model',
        modelType: 'language',
        pricing: { input: '0.000003', output: '0.000015' },
      },
    ])
    assert.equal(option.id, 'anthropic/claude-sonnet-4-6')
    assert.equal(option.label, 'Claude Sonnet 4.6')
    assert.equal(option.description, 'Fast frontier model — $3/M in · $15/M out')
  })

  test('drops non-language models', () => {
    const options = mapGatewayModels([
      { id: 'openai/text-embedding-4', name: 'Embed', modelType: 'embedding' },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', modelType: 'language' },
      { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
    ])
    assert.deepEqual(options.map(o => o.id), ['openai/gpt-5.4', 'openai/gpt-5.5'])
  })

  test('falls back to id as label and omits description when empty', () => {
    const [option] = mapGatewayModels([{ id: 'zai/glm-5', name: '' }])
    assert.equal(option.label, 'zai/glm-5')
    assert.equal(option.description, undefined)
  })

  test('skips entries without a usable id', () => {
    assert.deepEqual(mapGatewayModels([{ id: '', name: 'Bad' }]), [])
  })
})
