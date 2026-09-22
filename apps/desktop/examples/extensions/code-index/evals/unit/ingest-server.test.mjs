import { describe, it, expect, afterEach } from 'vitest'
import { startIngestServer } from '../../lib/ingest-server.js'

let server
afterEach(async () => { if (server) await server.close(); server = null })

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() }
}

describe('ingest server', () => {
  it('starts on a free port and returns the port', async () => {
    server = await startIngestServer({ onEvent: () => {} })
    expect(server.port).toBeGreaterThan(0)
  })

  it('accepts well-formed Claude hook payload and dispatches to onEvent', async () => {
    const events = []
    server = await startIngestServer({ onEvent: (e) => events.push(e) })
    const r = await post(server.port, '/ingest', {
      session_id: 'abc',
      tool_name: 'Read',
      tool_input: { file_path: '/Users/x/repo/src/a.ts' },
      cwd: '/Users/x/repo',
    })
    expect(r.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      tool: 'Read',
      path: '/Users/x/repo/src/a.ts',
      cwd: '/Users/x/repo',
    })
    expect(events[0].ts).toBeGreaterThan(0)
  })

  it('extracts path from MultiEdit payload', async () => {
    const events = []
    server = await startIngestServer({ onEvent: (e) => events.push(e) })
    await post(server.port, '/ingest', {
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/x/a.ts', edits: [{ old_string: 'a' }] },
      cwd: '/x',
    })
    expect(events[0].tool).toBe('MultiEdit')
    expect(events[0].path).toBe('/x/a.ts')
  })

  it('rejects unknown tools with 200 + ignored:true (never block the hook)', async () => {
    const events = []
    server = await startIngestServer({ onEvent: (e) => events.push(e) })
    const r = await post(server.port, '/ingest', { tool_name: 'Bash', tool_input: {}, cwd: '/x' })
    expect(r.status).toBe(200)
    expect(events).toHaveLength(0)
  })

  it('returns 200 for malformed JSON without throwing', async () => {
    server = await startIngestServer({ onEvent: () => {} })
    const res = await fetch(`http://127.0.0.1:${server.port}/ingest`, { method: 'POST', body: 'not json' })
    expect(res.status).toBe(200)
  })

  it('GET /health returns ok', async () => {
    server = await startIngestServer({ onEvent: () => {} })
    const res = await fetch(`http://127.0.0.1:${server.port}/health`)
    expect(res.status).toBe(200)
  })
})
