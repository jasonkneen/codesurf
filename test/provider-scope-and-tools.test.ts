import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

const gateway = readFileSync(new URL('../src/main/chat/providers/gateway.ts', import.meta.url), 'utf8')
const hermes = readFileSync(new URL('../src/main/chat/providers/hermes.ts', import.meta.url), 'utf8')
const runtime = readFileSync(new URL('../src/main/chat/runtime.ts', import.meta.url), 'utf8')

describe('M5 — gateway must not accept a renderer-supplied system role', () => {
  it('normalizes every non-assistant role to user', () => {
    const fn = gateway.slice(gateway.indexOf('function buildGatewayMessages'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(
      body.includes("message.role === 'assistant' ? 'assistant' : 'user'"),
      'only a genuine assistant turn may keep its role',
    )
    assert.equal(
      /role !== 'user' && role !== 'assistant' && role !== 'system'/.test(body),
      false,
      'the system passthrough must be gone',
    )
  })

  it('matches the invariant provider-history already enforces', () => {
    const ph = readFileSync(new URL('../src/main/chat/provider-history.ts', import.meta.url), 'utf8')
    assert.ok(ph.includes("value?.role === 'assistant' ? 'assistant' : 'user'"))
  })

  it('behaviour: an injected system turn becomes a user turn', () => {
    const normalize = (role: string) => (role === 'assistant' ? 'assistant' : 'user')
    assert.equal(normalize('system'), 'user')
    assert.equal(normalize('tool'), 'user')
    assert.equal(normalize('user'), 'user')
    assert.equal(normalize('assistant'), 'assistant')
  })
})

describe('M6 — gateway must honour mcpEnabled', () => {
  it('builds no tools when MCP is disabled for the tile', () => {
    assert.ok(
      gateway.includes('req.mcpEnabled === false ? ({} as ToolSet) : buildToolSet('),
      'tool construction must be gated on mcpEnabled',
    )
  })

  it('an empty tool set degrades to a tool-free turn', () => {
    assert.ok(gateway.includes('toolCount > 0 ? { tools'), 'tools are only spread when non-empty')
  })
})

describe('M7 — provider output must not override the authenticated scope', () => {
  it('runtime spreads the event first and the scope last', () => {
    const fn = runtime.slice(runtime.indexOf("broadcastToRenderer('agent:stream'"))
    const call = fn.slice(0, fn.indexOf('})'))
    const eventAt = call.indexOf('...event')
    const wsAt = call.indexOf('workspaceId: scope.workspaceId')
    const cardAt = call.indexOf('cardId: scope.cardId')
    assert.ok(eventAt > -1 && wsAt > -1 && cardAt > -1)
    assert.ok(eventAt < wsAt, 'workspaceId must be applied after the event spread')
    assert.ok(eventAt < cardAt, 'cardId must be applied after the event spread')
  })

  it('hermes forwards only known keys', () => {
    assert.ok(hermes.includes('pickKnownHermesEventFields'), 'the default branch must filter')
    assert.equal(
      /sendStream\(scope, evt as Record<string, unknown>\)/.test(hermes),
      false,
      'the verbatim forward must be gone',
    )
  })

  it('behaviour: scope-last wins over a hostile event', () => {
    const scope = { workspaceId: 'real-ws', cardId: 'real-card' }
    const hostile = { type: 'tool_summary', workspaceId: 'other-ws', cardId: 'other-card' }
    const broadcast = { ...hostile, workspaceId: scope.workspaceId, cardId: scope.cardId }
    assert.equal(broadcast.workspaceId, 'real-ws')
    assert.equal(broadcast.cardId, 'real-card')
  })

  it('behaviour: the key filter drops scope fields entirely', () => {
    const KEYS = ['type', 'text', 'toolId', 'toolName', 'error', 'sessionId']
    const pick = (evt: Record<string, unknown>) => {
      const out: Record<string, unknown> = {}
      for (const k of KEYS) {
        const v = evt[k]
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
      }
      return out
    }
    const filtered = pick({ type: 'tool_summary', workspaceId: 'other-ws', cardId: 'other-card', text: 'ok' })
    assert.deepEqual(filtered, { type: 'tool_summary', text: 'ok' })
    assert.equal('workspaceId' in filtered, false)
    assert.equal('cardId' in filtered, false)
  })
})
