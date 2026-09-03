import { register } from 'node:module'
import assert from 'node:assert/strict'
import { describe, test, before, after, mock } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import * as dns from 'node:dns'
import { IncomingMessage as RealIncomingMessage } from 'node:http'

// Redirect the app home BEFORE importing anything under src/main so no test
// can touch the live ~/.codesurf configuration.
const testCodesurfHome = mkdtempSync(join(tmpdir(), 'codesurf-stream-ipc-'))
process.env.CODESURF_HOME = testCodesurfHome
process.on('exit', () => {
  rmSync(testCodesurfHome, { recursive: true, force: true })
})

// Capture surfaces shared with the stub modules below. The electron data-URL
// module and this file communicate through globalThis because ESM data: URLs
// cannot import from the test file.
const broadcasts: Array<{ channel: string; payload?: unknown }> = []
const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
;(globalThis as Record<string, unknown>).__streamIpcProbe = { broadcasts, ipcHandlers }

// Electron is unavailable under plain node:test; register a resolver that
// substitutes a minimal stub which records broadcasts and IPC registrations.
const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(\`
        const probe = globalThis.__streamIpcProbe
        export class BrowserWindow {
          static getAllWindows() {
            return [{
              isDestroyed: () => false,
              webContents: {
                isDestroyed: () => false,
                send: (channel, payload) => { probe.broadcasts.push({ channel, payload }) },
              },
            }]
          }
          static getFocusedWindow() { return null }
        }
        export const ipcMain = {
          handle: (channel, handler) => { probe.ipcHandlers.set(channel, handler) },
        }
        export default {}
      \`),
    }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\\\.(ts|js|json|node)$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {}
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)

// stream.ts / agent-stream.ts import bare 'http' and 'https'. Core-module ESM
// named exports cannot be monkeypatched at runtime, so intercept the
// specifiers with node:test module mocks instead. The fake request objects are
// EventEmitters the tests drive directly.
class FakeClientRequest extends EventEmitter {
  written: string[] = []
  ended = false
  destroyedState = false
  write(body: string): void {
    this.written.push(body)
  }
  end(): void {
    this.ended = true
  }
  destroy(): void {
    this.destroyedState = true
    this.emit('close')
  }
}

type RequestFactory = (options: unknown, cb: (res: FakeIncomingMessage) => void) => FakeClientRequest

class FakeIncomingMessage extends EventEmitter {
  statusCode: number | undefined
  constructor(statusCode?: number) {
    super()
    this.statusCode = statusCode
  }
}

let lastRequestOptions: unknown
let pendingFactory: RequestFactory = () => {
  throw new Error('test must set pendingFactory before triggering stream:start')
}

mock.module('http', {
  exports: {
    request: ((options, cb) => pendingFactory(options, cb)) as unknown,
    IncomingMessage: RealIncomingMessage,
  },
})
mock.module('https', {
  exports: {
    request: ((options, cb) => pendingFactory(options, cb)) as unknown,
  },
})

const { registerStreamIPC } = await import('../src/main/ipc/stream.ts')

registerStreamIPC()

function handler(channel: string): (event: unknown, payload: unknown) => unknown {
  const h = ipcHandlers.get(channel)
  assert.ok(h, `expected ${channel} to be registered`)
  return h
}

function fakeSender(): EventEmitter {
  return new EventEmitter()
}

/** IPC events carry { sender }; tests hand the sender directly to handlers. */
function ipcEvent(sender: EventEmitter): { sender: EventEmitter } {
  return { sender }
}

/** Point DNS at a stable public IP so stream.ts's rebinding re-check passes. */
function stubPublicDns(t: { mock: { method: (...args: unknown[]) => unknown } }): void {
  t.mock.method(dns.promises, 'lookup', async () => ({ address: '93.184.216.34', family: 4 }))
}

function drain(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('stream:start IPC orchestration', () => {
  before(() => {})
  after(() => {})

  test('S1: upstream >=400 broadcasts an error with status + body and rejects', { timeout: 10_000 }, async (t) => {
    stubPublicDns(t)
    let res: FakeIncomingMessage | undefined
    pendingFactory = (_options, cb) => {
      res = new FakeIncomingMessage(500)
      setImmediate(() => {
        cb(res as FakeIncomingMessage)
        ;(res as FakeIncomingMessage).emit('end')
      })
      const req = new FakeClientRequest()
      return req
    }
    await assert.rejects(
      handler('stream:start')(ipcEvent(fakeSender()), {
        cardId: 'c1',
        agentId: 'generic',
        url: 'https://api.example.test/v1/stream',
      }),
      (err: Error) => {
        assert.match(err.message, /Upstream returned 500/)
        return true
      },
    )
    await drain()
    const errEvent = broadcasts.find(b => b.channel === 'agent:stream' && (b.payload as { type?: string }).type === 'error')
    assert.ok(errEvent, 'expected an error broadcast')
    assert.equal((errEvent.payload as { cardId: string }).cardId, 'c1')
  })

  test('S1b: oversized error bodies are truncated in the surfaced message', { timeout: 10_000 }, async (t) => {
    stubPublicDns(t)
    pendingFactory = (_options, cb) => {
      const res = new FakeIncomingMessage(503)
      const bigBody = 'x'.repeat(10_000)
      setImmediate(() => {
        cb(res)
        res.emit('data', Buffer.from(bigBody))
        res.emit('end')
      })
      return new FakeClientRequest()
    }
    await assert.rejects(handler('stream:start')(ipcEvent(fakeSender()), {
      cardId: 'c2',
      agentId: 'generic',
      url: 'https://api.example.test/v1/stream',
    }))
    await drain()
    const errEvent = broadcasts.filter(b => b.channel === 'agent:stream').pop() as { payload: { error: string } }
    // body is capped at 4KB then trimmed into a 500-char slice — the message
    // itself must stay small regardless of upstream size.
    assert.ok(errEvent.payload.error.length < 600, `message too long: ${errEvent.payload.error.length}`)
  })

  test('S2: 200 SSE resolves ok, feeds the parser, and emits text/done on end', { timeout: 10_000 }, async (t) => {
    stubPublicDns(t)
    let res: FakeIncomingMessage | undefined
    pendingFactory = (_options, cb) => {
      res = new FakeIncomingMessage(200)
      setImmediate(() => {
        cb(res as FakeIncomingMessage)
        ;(res as FakeIncomingMessage).emit('data', Buffer.from('hello '))
        ;(res as FakeIncomingMessage).emit('data', Buffer.from('world'))
        ;(res as FakeIncomingMessage).emit('end')
      })
      return new FakeClientRequest()
    }
    const result = (await handler('stream:start')(ipcEvent(fakeSender()), {
      cardId: 'c3',
      agentId: 'unknown-agent', // falls through to parseGenericStream
      url: 'https://api.example.test/v1/stream',
    })) as { ok: boolean }
    assert.deepEqual(result, { ok: true })
    await drain()
    const texts = broadcasts.filter(
      b => b.channel === 'agent:stream' && (b.payload as { type?: string; cardId?: string }).type === 'text' && (b.payload as { cardId?: string }).cardId === 'c3',
    )
    assert.equal(texts.length, 2)
    assert.equal((texts[0].payload as { text: string }).text, 'hello ')
    const done = broadcasts.find(
      b => b.channel === 'agent:stream' && (b.payload as { type?: string }).type === 'done',
    )
    assert.ok(done, 'expected done event after stream end')
  })

  test('S3: private URLs are rejected before any request is made', { timeout: 10_000 }, async () => {
    let factoryCalled = false
    pendingFactory = () => {
      factoryCalled = true
      return new FakeClientRequest()
    }
    await assert.rejects(
      handler('stream:start')(ipcEvent(fakeSender()), {
        cardId: 'c4',
        agentId: 'generic',
        url: 'http://127.0.0.1:9999/sse',
      }),
      (err: Error) => {
        assert.match(err.message, /not allowed|private|blocked/i)
        return true
      },
    )
    assert.equal(factoryCalled, false, 'request factory must not run for blocked URLs')
  })

  test('S4: stream:stop destroys the active request for that card only', { timeout: 10_000 }, async (t) => {
    stubPublicDns(t)
    const requests: FakeClientRequest[] = []
    pendingFactory = (_options, cb) => {
      const req = new FakeClientRequest()
      requests.push(req)
      setImmediate(() => cb(new FakeIncomingMessage(200)))
      return req
    }
    const start = handler('stream:start')
    await start(ipcEvent(fakeSender()), { cardId: 'c5', agentId: 'generic', url: 'https://api.example.test/a' })
    await start(ipcEvent(fakeSender()), { cardId: 'c6', agentId: 'generic', url: 'https://api.example.test/b' })
    assert.equal(requests.length, 2)
    await handler('stream:stop')(ipcEvent(fakeSender()), 'c5')
    assert.equal(requests[0].destroyedState, true, 'c5 request should be destroyed')
    assert.equal(requests[1].destroyedState, false, 'c6 request should survive')
  })

  test('S5: restarting the same cardId destroys the previous stream', { timeout: 10_000 }, async (t) => {
    stubPublicDns(t)
    const requests: FakeClientRequest[] = []
    pendingFactory = (_options, cb) => {
      const req = new FakeClientRequest()
      requests.push(req)
      setImmediate(() => cb(new FakeIncomingMessage(200)))
      return req
    }
    const start = handler('stream:start')
    const payload = { agentId: 'generic', url: 'https://api.example.test/v1' }
    await start(ipcEvent(fakeSender()), { cardId: 'c7', ...payload })
    await start(ipcEvent(fakeSender()), { cardId: 'c7', ...payload })
    assert.ok(requests[0].destroyedState, 'first stream should be destroyed by restart')
    assert.equal(requests[1].destroyedState, false)
  })

  test('S6: sender destruction reaps streams owned by that window', { timeout: 10_000 }, async (t) => {
    stubPublicDns(t)
    const requests: FakeClientRequest[] = []
    pendingFactory = (_options, cb) => {
      const req = new FakeClientRequest()
      requests.push(req)
      setImmediate(() => cb(new FakeIncomingMessage(200)))
      return req
    }
    const sender = fakeSender()
    await handler('stream:start')(ipcEvent(sender), { cardId: 'c8', agentId: 'generic', url: 'https://api.example.test/v1' })
    sender.emit('destroyed')
    assert.equal(requests[0].destroyedState, true, 'owned stream should be destroyed when its window dies')
  })

  test('S7: request-level socket errors broadcast an error and reject', { timeout: 10_000 }, async (t) => {
    stubPublicDns(t)
    pendingFactory = () => {
      const req = new FakeClientRequest()
      setImmediate(() => req.emit('error', new Error('ECONNRESET simulated')))
      return req
    }
    await assert.rejects(
      handler('stream:start')(ipcEvent(fakeSender()), {
        cardId: 'c9',
        agentId: 'generic',
        url: 'https://api.example.test/v1',
      }),
      /ECONNRESET simulated/,
    )
    await drain()
    const errEvent = broadcasts.filter(b => b.channel === 'agent:stream').pop() as { payload: { type: string; error: string } }
    assert.equal(errEvent.payload.type, 'error')
    assert.match(errEvent.payload.error, /ECONNRESET/)
  })

  test('S8: forwarded headers include caller headers alongside SSE defaults', { timeout: 10_000 }, async (t) => {
    stubPublicDns(t)
    let captured: Record<string, unknown> | undefined
    pendingFactory = (options, cb) => {
      captured = options as Record<string, unknown>
      setImmediate(() => cb(new FakeIncomingMessage(200)))
      return new FakeClientRequest()
    }
    await handler('stream:start')(ipcEvent(fakeSender()), {
      cardId: 'c10',
      agentId: 'generic',
      url: 'https://api.example.test/v1/chat?x=1',
      headers: { Authorization: 'Bearer test-token' },
      body: '{"prompt":"hi"}',
    })
    const headers = captured?.headers as Record<string, string>
    assert.equal(headers.Authorization, 'Bearer test-token')
    assert.equal(headers.Accept, 'text/event-stream')
    assert.equal(headers.Host, 'api.example.test')
    assert.equal((captured as { path?: string }).path, '/v1/chat?x=1')
  })
})
