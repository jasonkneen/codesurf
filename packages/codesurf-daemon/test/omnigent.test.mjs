import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveOmnigentSettings } from '../bin/omnigent-settings.mjs'
import {
  OMNIGENT_DEFAULT_BASE_URL,
  buildOmnigentSessionBody,
  chooseOmnigentHost,
  decodeOmnigentModelId,
  extractOmnigentSessionId,
  mapOmnigentStreamEvent,
  normalizeOmnigentServerRoot,
  omnigentAuthHeaders,
  omnigentEndpointUrl,
  parseOmnigentHosts,
  parseOmnigentSseChunk,
} from '../bin/omnigent-provider.mjs'

test('resolveOmnigentSettings defaults are sensible and provider works out of the box', () => {
  const s = resolveOmnigentSettings({ settings: {}, env: {} })
  assert.deepEqual(s, {
    enabled: true,
    baseUrl: OMNIGENT_DEFAULT_BASE_URL,
    apiKey: '',
    agentId: '',
    hostId: '',
    autoStart: true,
  })
})

test('resolveOmnigentSettings reads settings.omnigent and honors env overrides', () => {
  const settings = {
    omnigent: { enabled: true, baseUrl: 'http://host:9000/v1', apiKey: 'cfg', agentId: 'agent-cfg', hostId: 'host-cfg', autoStart: false },
  }
  const fromCfg = resolveOmnigentSettings({ settings, env: {} })
  assert.equal(fromCfg.baseUrl, 'http://host:9000/v1')
  assert.equal(fromCfg.apiKey, 'cfg')
  assert.equal(fromCfg.agentId, 'agent-cfg')
  assert.equal(fromCfg.hostId, 'host-cfg')
  assert.equal(fromCfg.autoStart, false)

  const overridden = resolveOmnigentSettings({
    settings,
    env: {
      CODESURF_OMNIGENT_BASE_URL: 'http://override:1234',
      CODESURF_OMNIGENT_API_KEY: 'env-key',
      CODESURF_OMNIGENT_AGENT_ID: 'env-agent',
      CODESURF_OMNIGENT_HOST_ID: 'env-host',
      CODESURF_OMNIGENT_AUTO_START: 'true',
      CODESURF_OMNIGENT_ENABLED: 'false',
    },
  })
  assert.equal(overridden.baseUrl, 'http://override:1234')
  assert.equal(overridden.apiKey, 'env-key')
  assert.equal(overridden.agentId, 'env-agent')
  assert.equal(overridden.hostId, 'env-host')
  assert.equal(overridden.autoStart, true)
  assert.equal(overridden.enabled, false)
})

test('parseOmnigentHosts normalizes array / {hosts} / {data} shapes and prefers host_id', () => {
  // host_id wins over id; rows without an id are dropped.
  assert.deepEqual(parseOmnigentHosts([{ host_id: 'h1', name: 'A', status: 'online' }, { id: 'h2' }, { name: 'no-id' }]), [
    { id: 'h1', name: 'A', status: 'online' },
    { id: 'h2', name: undefined, status: undefined },
  ])
  assert.deepEqual(parseOmnigentHosts({ hosts: [{ host_id: 'hh' }] }), [{ id: 'hh', name: undefined, status: undefined }])
  assert.deepEqual(parseOmnigentHosts({ data: [{ id: 'hd', status: 'offline' }] }), [{ id: 'hd', name: undefined, status: 'offline' }])
  assert.deepEqual(parseOmnigentHosts(null), [])
})

test('chooseOmnigentHost auto-picks the first online host, else the first host', () => {
  // Auto-pick: the online host wins even when a non-online host comes first.
  assert.equal(chooseOmnigentHost([{ id: 'a', status: 'offline' }, { id: 'b', status: 'online' }])?.id, 'b')
  // Status match is case-insensitive: an uppercase ONLINE host is picked over a
  // non-online first host (backends/CLIs report ONLINE/Online/online).
  assert.equal(chooseOmnigentHost([{ id: 'a', status: 'OFFLINE' }, { id: 'b', status: 'ONLINE' }])?.id, 'b')
  // Fall back to the first host when none report status.
  assert.equal(chooseOmnigentHost([{ id: 'a' }, { id: 'b' }])?.id, 'a')
  assert.equal(chooseOmnigentHost([]), null)
})

test('buildOmnigentSessionBody includes host_id alongside agent_id (the runner-binding fix)', () => {
  const onlineHost = chooseOmnigentHost(parseOmnigentHosts({ hosts: [{ host_id: 'runner-1', status: 'online' }] }))
  const body = buildOmnigentSessionBody({
    agentId: 'agent-x',
    hostId: onlineHost.id,
    title: 'hello',
    workspace: '/tmp/ws',
  })
  assert.deepEqual(body, { agent_id: 'agent-x', host_id: 'runner-1', title: 'hello', workspace: '/tmp/ws' })
  // host_id is the load-bearing field: it must be present so the backend binds a runner.
  assert.equal(body.host_id, 'runner-1')
  // workspace is omitted when not provided; a blank hostId drops host_id entirely.
  assert.deepEqual(buildOmnigentSessionBody({ agentId: 'a', title: 't' }), { agent_id: 'a', title: 't' })
})

test('normalizeOmnigentServerRoot strips trailing slash and /v1', () => {
  assert.equal(normalizeOmnigentServerRoot('http://x:6767/'), 'http://x:6767')
  assert.equal(normalizeOmnigentServerRoot('http://x:6767/v1'), 'http://x:6767')
  assert.equal(normalizeOmnigentServerRoot('  '), OMNIGENT_DEFAULT_BASE_URL)
  assert.equal(omnigentEndpointUrl('http://x:6767/v1/', '/v1/sessions'), 'http://x:6767/v1/sessions')
})

test('omnigentAuthHeaders only sets a bearer when a token is present', () => {
  assert.deepEqual(omnigentAuthHeaders(''), {})
  assert.deepEqual(omnigentAuthHeaders('  tok '), { Authorization: 'Bearer tok' })
})

test('decodeOmnigentModelId resolves agent id and treats the fallback row as null', () => {
  assert.equal(decodeOmnigentModelId('omnigent:default'), null)
  assert.equal(decodeOmnigentModelId('omnigent:agent_123'), 'agent_123')
  assert.equal(decodeOmnigentModelId('omnigent:a%20b'), 'a b')
  assert.equal(decodeOmnigentModelId('claude-sonnet-4-6'), null)
  // Malformed percent-encoding -> null (CLI parity), never the raw encoded string.
  assert.equal(decodeOmnigentModelId('omnigent:%E0%A4%A'), null)
})

test('extractOmnigentSessionId pulls the id from common shapes with CLI precedence', () => {
  assert.equal(extractOmnigentSessionId({ session_id: 'conv_a' }), 'conv_a')
  assert.equal(extractOmnigentSessionId({ id: 'conv_b' }), 'conv_b')
  assert.equal(extractOmnigentSessionId({ session: { id: 'conv_c' } }), 'conv_c')
  // id wins over session_id (matches the CLI provider's key order).
  assert.equal(extractOmnigentSessionId({ id: 'conv_id', session_id: 'conv_sid' }), 'conv_id')
  assert.equal(extractOmnigentSessionId({ session: { id: 'nested_id', session_id: 'nested_sid' } }), 'nested_id')
  assert.equal(extractOmnigentSessionId({}), null)
})

test('parseOmnigentSseChunk splits event name and joined data', () => {
  assert.deepEqual(parseOmnigentSseChunk('event: response.completed\ndata: {"type":"response.completed"}'), {
    eventName: 'response.completed',
    data: '{"type":"response.completed"}',
  })
  assert.deepEqual(parseOmnigentSseChunk('data: [DONE]'), { eventName: null, data: '[DONE]' })
})

test('mapOmnigentStreamEvent maps text, reasoning, and lifecycle events', () => {
  assert.deepEqual(mapOmnigentStreamEvent({ type: 'response.output_text.delta', delta: 'hi' }), {
    kind: 'text',
    text: 'hi',
  })
  assert.deepEqual(mapOmnigentStreamEvent({ type: 'response.reasoning_text.delta', delta: 'think' }), {
    kind: 'thinking',
    text: 'think',
  })
  assert.deepEqual(mapOmnigentStreamEvent({ type: 'response.reasoning.started' }), { kind: 'thinking_start' })
  assert.deepEqual(mapOmnigentStreamEvent({ type: 'response.completed', response: {} }), {
    kind: 'terminal',
    stop: 'done',
  })
  assert.deepEqual(mapOmnigentStreamEvent({ type: 'response.cancelled' }), { kind: 'terminal', stop: 'done' })
  assert.equal(mapOmnigentStreamEvent({ type: 'session.heartbeat' }), null)
  assert.equal(mapOmnigentStreamEvent({ type: 'session.status', data: { status: 'running' } }), null)
})

test('mapOmnigentStreamEvent surfaces failures with a message', () => {
  const failed = mapOmnigentStreamEvent({
    type: 'response.failed',
    response: { error: { message: 'boom' } },
  })
  assert.deepEqual(failed, { kind: 'terminal', stop: 'error', error: 'boom' })

  const statusFailed = mapOmnigentStreamEvent({ type: 'session.status', data: { status: 'failed' }, error: { message: 'nope' } })
  assert.equal(statusFailed.kind, 'terminal')
  assert.equal(statusFailed.stop, 'error')
})

test('mapOmnigentStreamEvent maps tool calls keyed on call_id', () => {
  const added = mapOmnigentStreamEvent({
    type: 'response.output_item.added',
    item: { id: 'fc_1', type: 'function_call', name: 'search.web', call_id: 'call_1' },
  })
  assert.deepEqual(added, { kind: 'tool_call', toolId: 'call_1', toolName: 'search.web', toolInput: null })

  const done = mapOmnigentStreamEvent({
    type: 'response.output_item.done',
    item: { id: 'fc_1', type: 'function_call', name: 'search.web', call_id: 'call_1', arguments: '{"q":"x"}' },
  })
  assert.deepEqual(done, { kind: 'tool_call', toolId: 'call_1', toolName: 'search.web', toolInput: '{"q":"x"}' })

  const result = mapOmnigentStreamEvent({
    type: 'response.output_item.done',
    item: { type: 'function_call_output', call_id: 'call_1', output: 'done' },
  })
  assert.deepEqual(result, { kind: 'tool_result', toolId: 'call_1', output: 'done' })
})

test('mapOmnigentStreamEvent ignores message/reasoning output items (surfaced via deltas)', () => {
  assert.equal(
    mapOmnigentStreamEvent({ type: 'response.output_item.done', item: { type: 'message', content: [] } }),
    null,
  )
})
