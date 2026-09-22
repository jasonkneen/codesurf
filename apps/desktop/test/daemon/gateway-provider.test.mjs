import assert from 'node:assert/strict'
import { daemonUrl, daemonFile, daemonSource } from '../helpers/daemon-path.mjs'
import { describe, test } from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { fetchGatewayModels,
  loadCanvasToolBridge,
  mapGatewayModels: daemonMapGatewayModels,
  resolveGatewayApiKey,
  runGatewayJob,
  selectGatewayTools: daemonSelectGatewayTools,
  tileMcpConfigPath, } = await import(daemonUrl('bin/gateway-provider.mjs'))
import {
  mapGatewayModels as runtimeMapGatewayModels,
  selectGatewayTools as runtimeSelectGatewayTools,
} from '../../src/main/chat/gateway-tools.ts'

const TOOLS = [
  { name: 'canvas_create_tile', description: 'create', inputSchema: { type: 'object' } },
  { name: 'kanban_create_card', description: 'card', inputSchema: { type: 'object' } },
]

describe('daemon gateway helpers agree with the runtime implementation (drift guard)', () => {
  const ALLOW_LISTS = [null, [], ['canvas_create_tile'], ['CanvasCreateTile', 'KANBAN-CREATE-CARD'], ['Bash']]
  for (const allowList of ALLOW_LISTS) {
    test(`selectGatewayTools agrees for ${JSON.stringify(allowList)}`, () => {
      assert.deepEqual(
        daemonSelectGatewayTools(TOOLS, allowList).map(t => t.name),
        runtimeSelectGatewayTools(TOOLS, allowList).map(t => t.name),
      )
    })
  }

  test('mapGatewayModels agrees on shape, filtering, and pricing format', () => {
    const entries = [
      { id: 'anthropic/claude-sonnet-4-6', name: 'Sonnet', description: 'fast', modelType: 'language', pricing: { input: '0.000003', output: '0.000015' } },
      { id: 'openai/embed', name: 'Embed', modelType: 'embedding' },
      { id: 'zai/glm-5', name: '' },
      { id: '', name: 'bad' },
    ]
    assert.deepEqual(daemonMapGatewayModels(entries), runtimeMapGatewayModels(entries))
  })
})

describe('resolveGatewayApiKey', () => {
  test('reads AI_GATEWAY_API_KEY, trimmed', () => {
    assert.equal(resolveGatewayApiKey({ AI_GATEWAY_API_KEY: '  vck_abc  ' }), 'vck_abc')
  })
  test('null when unset or blank', () => {
    assert.equal(resolveGatewayApiKey({}), null)
    assert.equal(resolveGatewayApiKey({ AI_GATEWAY_API_KEY: '   ' }), null)
  })
})

describe('fetchGatewayModels', () => {
  test('reports missing key without calling the network', async () => {
    const result = await fetchGatewayModels({})
    assert.deepEqual(result.models, [])
    assert.equal(result.source, 'none')
    assert.match(result.error, /AI_GATEWAY_API_KEY/)
  })
})

describe('tileMcpConfigPath', () => {
  test('builds a path under CODESURF_HOME', () => {
    const path = tileMcpConfigPath('ws1', 'tile1', { CODESURF_HOME: '/tmp/csf' })
    assert.equal(path, join('/tmp/csf', 'workspaces', 'ws1', 'tiles', 'tile1', 'mcp-server.json'))
  })
  test('refuses traversal and empty segments', () => {
    assert.equal(tileMcpConfigPath('../evil', 'tile', { CODESURF_HOME: '/tmp/csf' }), null)
    assert.equal(tileMcpConfigPath('ws', 'a/b', { CODESURF_HOME: '/tmp/csf' }), null)
    assert.equal(tileMcpConfigPath('', 'tile', { CODESURF_HOME: '/tmp/csf' }), null)
  })
})

async function writeTileConfig(config) {
  const home = await mkdtemp(join(tmpdir(), 'codesurf-gateway-bridge-'))
  const dir = join(home, 'workspaces', 'ws1', 'tiles', 'tile1')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'mcp-server.json'), JSON.stringify(config))
  return home
}

describe('loadCanvasToolBridge', () => {
  test('null when the tile config is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codesurf-gateway-none-'))
    const bridge = await loadCanvasToolBridge({ workspaceId: 'ws1', tileId: 'tile1', env: { CODESURF_HOME: home } })
    assert.equal(bridge, null)
  })

  test('null when the config lacks a token or has a non-loopback url', async () => {
    const noToken = await writeTileConfig({ url: 'http://127.0.0.1:5000' })
    assert.equal(await loadCanvasToolBridge({ workspaceId: 'ws1', tileId: 'tile1', env: { CODESURF_HOME: noToken } }), null)
    const remote = await writeTileConfig({ url: 'http://evil.example.com:5000', token: 't' })
    assert.equal(await loadCanvasToolBridge({ workspaceId: 'ws1', tileId: 'tile1', env: { CODESURF_HOME: remote } }), null)
  })

  test('lists tools with the bearer token and calls tools/call', async () => {
    const home = await writeTileConfig({ url: 'http://127.0.0.1:5000', token: 'tile-token' })
    const calls = []
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, auth: init.headers.authorization, method: body.method, params: body.params })
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'canvas_create_tile', description: 'create', inputSchema: { type: 'object' } }, { name: 'no_schema_tool', description: 'x' }] }
        : { content: [{ type: 'text', text: 'tile created' }] }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) }
    }
    const bridge = await loadCanvasToolBridge({ workspaceId: 'ws1', tileId: 'tile1', env: { CODESURF_HOME: home }, fetchImpl })
    assert.ok(bridge)
    assert.deepEqual(bridge.tools.map(t => t.name), ['canvas_create_tile'])
    const output = await bridge.call('canvas_create_tile', { type: 'note' })
    assert.equal(output, 'tile created')
    assert.equal(calls[0].url, 'http://127.0.0.1:5000/mcp')
    assert.ok(calls.every(call => call.auth === 'Bearer tile-token'))
    assert.deepEqual(calls[1].params, { name: 'canvas_create_tile', arguments: { type: 'note' } })
  })
})

describe('runGatewayJob pre-stream guards', () => {
  function makeJob() {
    const events = []
    return {
      job: { id: 'job1', cancelRequested: false, cancel: () => {} },
      events,
      hooks: {
        appendEvent: async (_jobId, event) => { events.push(event) },
        contextPrompt: '',
      },
    }
  }

  test('missing key emits a settings-pointing error and done', async (t) => {
    const original = process.env.AI_GATEWAY_API_KEY
    delete process.env.AI_GATEWAY_API_KEY
    t.after(() => { if (original != null) process.env.AI_GATEWAY_API_KEY = original })
    const { job, events, hooks } = makeJob()
    await runGatewayJob(job, { messages: [{ role: 'user', content: 'hi' }] }, null, '', hooks)
    assert.equal(events[0].type, 'error')
    assert.match(events[0].error, /Settings → Providers → AI Gateway/)
    assert.match(events[0].error, /AI_GATEWAY_API_KEY/)
    assert.equal(events[1].type, 'done')
  })

  test('no user message emits error and done', async (t) => {
    const original = process.env.AI_GATEWAY_API_KEY
    process.env.AI_GATEWAY_API_KEY = 'vck_test'
    t.after(() => {
      if (original != null) process.env.AI_GATEWAY_API_KEY = original
      else delete process.env.AI_GATEWAY_API_KEY
    })
    const { job, events, hooks } = makeJob()
    await runGatewayJob(job, { messages: [{ role: 'assistant', content: 'hello' }] }, null, '', hooks)
    assert.deepEqual(events.map(e => e.type), ['error', 'done'])
    assert.equal(events[0].error, 'No user message')
  })
})
