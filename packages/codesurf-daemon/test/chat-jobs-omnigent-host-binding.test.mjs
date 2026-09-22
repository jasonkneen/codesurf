import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createChatJobManager } from '../bin/chat-jobs.mjs'

async function waitForCompletedJob(manager, jobId, timeoutMs = 5_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = await manager.getJobState(jobId)
    if (state && state.status !== 'running' && state.status !== 'queued') return state
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for Omnigent job ${jobId}`)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

test('Omnigent job resolves a runner host before creating its session', async t => {
  const calls = []
  let sessionBody = null
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    calls.push(`${req.method} ${url.pathname}`)
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'GET' && url.pathname === '/v1/agents') {
      res.end(JSON.stringify({ agents: [{ id: 'agent-x' }] }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/hosts') {
      res.end(JSON.stringify({ hosts: [
        { host_id: 'runner-offline', status: 'offline' },
        { host_id: 'runner-online', status: 'ONLINE' },
      ] }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      sessionBody = await readJsonBody(req)
      res.end(JSON.stringify({ id: 'session-1' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/sessions/session-1/stream') {
      res.setHeader('Content-Type', 'text/event-stream')
      res.end('data: {"type":"response.completed"}\n\n')
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions/session-1/events') {
      await readJsonBody(req)
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const homeDir = await mkdtemp(join(process.cwd(), '.tmp-omnigent-host-binding-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(() => rm(homeDir, { recursive: true, force: true }))

  const manager = createChatJobManager({ homeDir })
  const job = await manager.startJob({
    cardId: 'omnigent-host-binding',
    workspaceId: 'ws-omnigent',
    workspaceDir,
    provider: 'omnigent',
    model: 'omnigent:default',
    omnigent: { enabled: true, baseUrl, autoStart: false },
    messages: [{ role: 'user', content: 'hello runner' }],
  })
  const completed = await waitForCompletedJob(manager, job.id)

  assert.equal(completed.status, 'completed')
  assert.equal(completed.error, null)
  assert.deepEqual(sessionBody, {
    agent_id: 'agent-x',
    host_id: 'runner-online',
    title: 'hello runner',
    workspace: workspaceDir,
  })
  assert.ok(calls.indexOf('GET /v1/hosts') < calls.indexOf('POST /v1/sessions'))
})

test('Omnigent job fails clearly when no runner host is registered', async t => {
  let sessionCreateCount = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && url.pathname === '/v1/agents') {
      res.end(JSON.stringify({ agents: [{ id: 'agent-x' }] }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/hosts') {
      res.end(JSON.stringify({ hosts: [] }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      sessionCreateCount += 1
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))

  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const homeDir = await mkdtemp(join(process.cwd(), '.tmp-omnigent-no-host-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(() => rm(homeDir, { recursive: true, force: true }))

  const manager = createChatJobManager({ homeDir })
  const job = await manager.startJob({
    cardId: 'omnigent-no-host',
    workspaceId: 'ws-omnigent',
    workspaceDir,
    provider: 'omnigent',
    model: 'omnigent:default',
    omnigent: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}`,
      autoStart: false,
    },
    messages: [{ role: 'user', content: 'hello runner' }],
  })
  const completed = await waitForCompletedJob(manager, job.id)

  assert.equal(completed.status, 'failed')
  assert.match(completed.error, /no runner hosts/i)
  assert.equal(sessionCreateCount, 0)
})
