import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as net from 'node:net'
import test from 'node:test'
import { createGuardedLocalProxyBackendRequest } from '../src/main/chat/local-proxy-backend-request.ts'

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

async function close(server: http.Server | net.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function guardedRequest(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('guarded request did not settle')), 1_000)
    const finish = (value: string): void => {
      clearTimeout(timer)
      resolve(value)
    }
    const request = createGuardedLocalProxyBackendRequest({
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'POST',
      timeout: 500,
    }, {
      onResponse: response => {
        response.resume()
        finish('response')
      },
      onFailure: finish,
    })
    request.end('{}')
  })
}

test('backend protocol upgrade fails immediately and destroys the upgraded socket', async t => {
  let resolveUpgradedSocketClosed: (() => void) | undefined
  const upgradedSocketClosed = new Promise<void>(resolve => {
    resolveUpgradedSocketClosed = resolve
  })
  const server = net.createServer(socket => {
    socket.once('close', () => resolveUpgradedSocketClosed?.())
    socket.once('data', () => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n')
    })
  })
  const port = await listen(server)
  t.after(() => close(server))

  assert.equal(await guardedRequest(port), 'Backend returned an unsupported protocol upgrade')
  await Promise.race([
    upgradedSocketClosed,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('upgraded backend socket was not destroyed')), 500)
    }),
  ])
})

test('silent pre-response close fails without waiting for the request timeout', async t => {
  const server = net.createServer(socket => socket.destroy())
  const port = await listen(server)
  t.after(() => close(server))

  assert.match(
    await guardedRequest(port),
    /Backend (?:unreachable|request closed before a response was received)/,
  )
})

test('ordinary backend response marks the request observed before close', async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{}')
  })
  const port = await listen(server)
  t.after(() => close(server))

  assert.equal(await guardedRequest(port), 'response')
})
