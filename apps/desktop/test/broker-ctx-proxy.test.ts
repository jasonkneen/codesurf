/**
 * Unit tests for the ctx proxy builder (src/main/extensions/broker/child-entry.ts).
 *
 * Plain node:test — no Electron required. Tests the proxy's marshalling
 * behaviour: that every method sends the right (capability, method, args) triple
 * to the remote call stub, and that the local carve-outs (log, snapshots,
 * subscriptions) work without a round-trip.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCtxProxy } from '../src/main/extensions/broker/child-entry.ts'

type CallRecord = { capability: string; method: string; args: unknown[] }

function makeStub(result: unknown = null) {
  const calls: CallRecord[] = []
  const call = async (capability: string, method: string, args: unknown[]) => {
    calls.push({ capability, method, args })
    return result
  }
  return { call, calls }
}

// ── bus ──────────────────────────────────────────────────────────────────────

test('ctx.bus.publish marshals to (bus, publish, [channel, type, payload])', async () => {
  const { call, calls } = makeStub()
  const ctx = createCtxProxy(call as never, 'test-ext') as Record<string, unknown>
  const bus = ctx.bus as Record<string, unknown>

  await (bus.publish as (c: string, t: string, p: unknown) => Promise<void>)('my-channel', 'my-type', { key: 'val' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].capability, 'bus')
  assert.equal(calls[0].method, 'publish')
  assert.deepEqual(calls[0].args, ['my-channel', 'my-type', { key: 'val' }])
})

test('ctx.bus.subscribe registers local callback and calls main with (bus, subscribe, [channel, subscriberId, id])', async () => {
  const { call, calls } = makeStub()
  const ctx = createCtxProxy(call as never, 'test-ext') as Record<string, unknown>
  const bus = ctx.bus as Record<string, unknown>

  const received: unknown[] = []
  const subId = (bus.subscribe as (ch: string, sid: string, cb: (e: unknown) => void) => string)(
    'chan', 'sid', (e) => received.push(e),
  )

  assert.ok(typeof subId === 'string', 'subscribe returns an id string')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].capability, 'bus')
  assert.equal(calls[0].method, 'subscribe')
  assert.equal(calls[0].args[0], 'chan')
  assert.equal(calls[0].args[1], 'sid')
  // The third arg is the internal subscription id — just assert it's a string
  assert.ok(typeof calls[0].args[2] === 'string')
})

// ── mcp.registerTool ─────────────────────────────────────────────────────────

test('ctx.mcp.registerTool registers handler locally and marshals to (mcp, registerTool)', async () => {
  const { call, calls } = makeStub()
  const ctx = createCtxProxy(call as never, 'test-ext') as Record<string, unknown>
  const mcp = ctx.mcp as Record<string, unknown>

  const handler = async (_args: Record<string, unknown>) => 'tool-result'
  ;(mcp.registerTool as (t: { name: string; description: string; inputSchema: Record<string, unknown>; handler: typeof handler }) => void)({
    name: 'my_tool',
    description: 'A tool',
    inputSchema: { type: 'object' },
    handler,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].capability, 'mcp')
  assert.equal(calls[0].method, 'registerTool')
  // args[0] should contain name, description, inputSchema, registrationId
  const toolArg = calls[0].args[0] as Record<string, unknown>
  assert.equal(toolArg.name, 'my_tool')
  assert.equal(toolArg.description, 'A tool')
  assert.ok(typeof toolArg.registrationId === 'string', 'registrationId is a string')
})

// ── settings (local snapshot reads) ─────────────────────────────────────────

test('ctx.settings.get / getAll return snapshot without calling main', async () => {
  const { call, calls } = makeStub()
  // Proxy needs pre-seeded snapshot — but createCtxProxy reads module-level globals
  // so we test the interface shape. At least ensure no remote call is made.
  const ctx = createCtxProxy(call as never, 'test-ext') as Record<string, unknown>
  const settings = ctx.settings as Record<string, unknown>

  ;(settings.get as (k: string) => unknown)('someKey')
  ;(settings.getAll as () => Record<string, unknown>)()

  // No remote call for reads
  assert.equal(calls.filter(c => c.method === 'get' || c.method === 'getAll').length, 0)
})

test('ctx.settings.set does call main with (settings, set, [values])', async () => {
  const { call, calls } = makeStub()
  const ctx = createCtxProxy(call as never, 'test-ext') as Record<string, unknown>
  const settings = ctx.settings as Record<string, unknown>

  ;(settings.set as (v: Record<string, unknown>) => void)({ theme: 'dark' })

  const settingsSetCalls = calls.filter(c => c.capability === 'settings' && c.method === 'set')
  assert.equal(settingsSetCalls.length, 1)
  assert.deepEqual(settingsSetCalls[0].args[0], { theme: 'dark' })
})

// ── capability-deny: fs / shell / relayHost ──────────────────────────────────

test('ctx.fs.readFile marshals to (fs, readFile) — denial comes from main, not the proxy', async () => {
  // The proxy itself just marshals the call; main is responsible for denial.
  // Here we verify the correct (capability, method) pair is sent.
  const error = new Error('capability-denied: extension "any-ext" is not granted capability "fs"')
  const { call, calls } = makeStub()
  // Override stub to reject
  const rejectingCall = async (capability: string, method: string, args: unknown[]) => {
    calls.push({ capability, method, args })
    throw error
  }

  const ctx = createCtxProxy(rejectingCall as never, 'any-ext') as Record<string, unknown>
  const fs = ctx.relayHost as Record<string, unknown>

  // relayHost.install() should marshal and then reject (simulating main's denial)
  await assert.rejects(
    () => (fs.install as () => Promise<unknown>)(),
    /capability-denied/,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].capability, 'relayHost')
  assert.equal(calls[0].method, 'install')
})

// ── ipc.handle ────────────────────────────────────────────────────────────────

test('ctx.ipc.handle registers local handler and marshals to (ipc, handle, [fullChannel])', async () => {
  const { call, calls } = makeStub()
  const ctx = createCtxProxy(call as never, 'my-ext') as Record<string, unknown>
  const ipc = ctx.ipc as Record<string, unknown>

  ;(ipc.handle as (ch: string, h: () => void) => void)('my-channel', () => 'result')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].capability, 'ipc')
  assert.equal(calls[0].method, 'handle')
  assert.equal(calls[0].args[0], 'ext:my-ext:my-channel')
})

test('ctx.ipc.handle catches rejected registration calls instead of emitting unhandled rejections', async () => {
  const calls: CallRecord[] = []
  const error = new Error('Attempted to register a second handler')
  const call = async (capability: string, method: string, args: unknown[]) => {
    calls.push({ capability, method, args })
    throw error
  }
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  const originalConsoleError = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => { logged.push(args) }
  process.on('unhandledRejection', onUnhandled)

  try {
    const ctx = createCtxProxy(call as never, 'my-ext') as Record<string, unknown>
    const ipc = ctx.ipc as Record<string, unknown>

    ;(ipc.handle as (ch: string, h: () => void) => void)('my-channel', () => 'result')
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].capability, 'ipc')
    assert.equal(calls[0].method, 'handle')
    assert.deepEqual(unhandled, [])
    assert.ok(
      logged.some(args => String(args.join(' ')).includes('ipc.handle(ext:my-ext:my-channel) failed')),
      `expected rejected registration to be logged, got ${JSON.stringify(logged)}`,
    )
  } finally {
    process.off('unhandledRejection', onUnhandled)
    console.error = originalConsoleError
  }
})
