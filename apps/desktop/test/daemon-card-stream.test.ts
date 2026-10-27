import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { DaemonCardStream } from '../src/main/chat/daemon-card-stream.ts'

const encoder = new TextEncoder()
const endpoint = { baseUrl: 'http://daemon.test', token: 'secret' }
const event = (jobId: string, sequence: number, type = 'text', extra = {}) => ({
  jobId, sequence, timestamp: sequence, type, text: `${jobId}-${sequence}`, ...extra,
})
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check(), 'condition did not become true')
}

function mockTransport(t: TestContext, status?: number) {
  const original = globalThis.fetch
  const requests: Array<{
    url: URL; signal: AbortSignal; headers: Headers; cancelled: boolean
    push: (payload: unknown) => void; end: () => void; raw: (text: string) => void
  }> = []
  globalThis.fetch = async (input, init) => {
    const signal = init!.signal as AbortSignal
    let sink!: ReadableStreamDefaultController<Uint8Array>
    const request = {
      url: new URL(String(input)), signal, headers: new Headers(init?.headers), cancelled: false,
      push: (payload: unknown) => sink.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
      end: () => sink.close(), raw: (text: string) => sink.enqueue(encoder.encode(text)),
    }
    requests.push(request)
    if (status && request.url.pathname === '/chat/card/events') return new Response('', { status })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sink = controller
        signal.addEventListener('abort', () => {
          request.cancelled = true
          try { controller.error(new DOMException('Aborted', 'AbortError')) } catch {}
        }, { once: true })
      },
      cancel() { request.cancelled = true },
    })
    return new Response(body)
  }
  t.after(() => { globalThis.fetch = original })
  return requests
}

test('reuses authenticated card SSE across turns, filters stale jobs, dedupes, and keeps errors nonterminal', async t => {
  const requests = mockTransport(t)
  const stream = new DaemonCardStream(endpoint, 'card & one')
  t.after(() => stream.close())
  assert.equal(await stream.prepare(), true)
  assert.equal(requests[0].url.searchParams.get('cardId'), 'card & one')
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer secret')
  requests[0].push(event('old', 1))
  requests[0].push(event('a', 1, 'text', { fileChangesTrusted: true, unexpected: 'drop' }))
  await tick()
  const received: Record<string, unknown>[] = []
  const first = stream.consumeJob('a', 0, new AbortController().signal, e => received.push(e))
  await tick()
  requests[0].push(event('a', 1))
  requests[0].push(event('old', 2))
  requests[0].push(event('a', 2, 'error'))
  requests[0].push(event('a', 3, 'done'))
  await first
  assert.deepEqual(received.map(e => e.sequence), [1, 2, 3])
  assert.equal(received[0].unexpected, undefined)
  assert.equal(received[0].fileChangesTrusted, undefined)
  assert.equal(requests[0].cancelled, false)
  await stream.prepare()
  requests[0].push(event('b', 1, 'done'))
  await tick()
  await stream.consumeJob('b', 0, new AbortController().signal, e => received.push(e))
  assert.equal(requests.length, 1)
  stream.close()
  assert.equal(requests[0].signal.aborted, true)
})

test('bounded startup overflow discards partial buffer and replays the attached job from its cursor', async t => {
  const requests = mockTransport(t)
  const stream = new DaemonCardStream(endpoint, 'card')
  t.after(() => stream.close())
  await stream.prepare()
  for (let i = 1; i <= 257; i++) requests[0].push(event('a', i))
  await tick()
  const received: number[] = []
  const done = stream.consumeJob('a', 0, new AbortController().signal, e => received.push(e.sequence))
  await until(() => requests.length === 2)
  assert.equal(requests[1].url.searchParams.get('jobId'), 'a')
  assert.equal(requests[1].url.searchParams.get('since'), '0')
  assert.deepEqual(received, [])
  requests[1].push(event('a', 1))
  requests[1].push(event('a', 2, 'done'))
  await done
  assert.deepEqual(received, [1, 2])
})

test('byte overflow also requests replay without forwarding a truncated startup buffer', async t => {
  const requests = mockTransport(t)
  const stream = new DaemonCardStream(endpoint, 'card')
  t.after(() => stream.close())
  await stream.prepare()
  for (let i = 1; i <= 4; i++) requests[0].push(event('a', i, 'text', { text: 'x'.repeat(300_000) }))
  await tick()
  const done = stream.consumeJob('a', 0, new AbortController().signal, () => {})
  await until(() => requests.length === 2)
  assert.equal(requests[1].url.searchParams.get('since'), '0')
  requests[1].push(event('a', 1, 'done'))
  await done
})

test('reconnect uses active job sequence and does not deliver replay duplicates', async t => {
  const requests = mockTransport(t)
  const stream = new DaemonCardStream(endpoint, 'card')
  t.after(() => stream.close())
  await stream.prepare()
  const received: number[] = []
  const done = stream.consumeJob('a', 0, new AbortController().signal, e => received.push(e.sequence))
  await tick()
  requests[0].push(event('a', 1))
  await until(() => received.length === 1)
  requests[0].end()
  await until(() => requests.length === 2)
  assert.equal(requests[1].url.searchParams.get('jobId'), 'a')
  assert.equal(requests[1].url.searchParams.get('since'), '1')
  requests[1].push(event('a', 1))
  requests[1].push(event('a', 2, 'done'))
  await done
  assert.deepEqual(received, [1, 2])
})

for (const status of [404, 405]) test(`${status} falls back to bounded per-job SSE and releases it on done`, async t => {
  const requests = mockTransport(t, status)
  const stream = new DaemonCardStream(endpoint, 'card')
  t.after(() => stream.close())
  assert.equal(await stream.prepare(), false)
  const received: number[] = []
  const done = stream.consumeJob('a', 4, new AbortController().signal, e => received.push(e.sequence))
  await until(() => requests.length === 2)
  assert.equal(requests[1].url.pathname, '/chat/job/events')
  assert.equal(requests[1].url.searchParams.get('since'), '4')
  requests[1].push(event('a', 5, 'done'))
  await done
  assert.deepEqual(received, [5])
  assert.equal(requests[1].signal.aborted, true)
  assert.equal(await stream.prepare(), false)
  assert.equal(requests.length, 2)
})

test('resume forces replay, job abort leaves connection alive, close prevents reconnect', async t => {
  const requests = mockTransport(t)
  const stream = new DaemonCardStream(endpoint, 'card')
  t.after(() => stream.close())
  await stream.prepare()
  stream.finishPreparation()
  const abort = new AbortController()
  const done = stream.consumeJob('a', 7, abort.signal, () => assert.fail('stale event delivered'))
  await until(() => requests.length === 2)
  assert.equal(requests[1].url.searchParams.get('since'), '7')
  requests[1].push(event('old', 8))
  abort.abort()
  await done
  assert.equal(requests[1].signal.aborted, false)
  stream.close()
  await tick()
  assert.equal(requests[1].signal.aborted, true)
  assert.equal(requests.length, 2)
})

test('sequence gaps fail the active job rather than forwarding incomplete data', async t => {
  const requests = mockTransport(t)
  const stream = new DaemonCardStream(endpoint, 'card')
  t.after(() => stream.close())
  await stream.prepare()
  const done = stream.consumeJob('a', 0, new AbortController().signal, () => assert.fail('gap delivered'))
  await tick()
  requests[0].push(event('a', 2))
  await assert.rejects(done, /sequence gap/)
  assert.equal(requests[0].cancelled, false)
})

test('Electron wiring prepares before POST, preserves untrusted files, and closes on lifecycle teardown', () => {
  const source = readFileSync(new URL('../src/main/ipc/chat.ts', import.meta.url), 'utf8')
  const send = source.slice(source.indexOf('async function sendChatToDaemon'), source.indexOf('async function resumeChatDaemonJob'))
  assert.ok(send.indexOf('await cardStream.prepare()') < send.indexOf("'/chat/job/start'"))
  assert.ok(source.includes('sendStream(scope, { ...payload, fileChangesTrusted: false })'))
  assert.ok(source.includes('for (const entry of daemonCardStreams.values()) entry.stream.close()'))
  assert.ok(source.slice(source.indexOf("ipcMain.handle('chat:disposeCard'")).includes('closeDaemonCardStream(scope)'))
  assert.ok(source.slice(source.indexOf("ipcMain.handle('chat:clearSession'")).includes('closeDaemonCardStream(scope)'))
})
