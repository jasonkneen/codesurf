import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const repoRoot = new URL('..', import.meta.url).pathname
const helperPath = join(repoRoot, 'electrobun/helpers/pty-host.cjs')

function waitForMessage(messages, predicate, timeoutMs = 5000) {
  const existing = messages.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for PTY host message. Seen: ${JSON.stringify(messages)}`))
    }, timeoutMs)
    messages.listeners.push((message) => {
      if (!predicate(message)) return
      clearTimeout(timer)
      resolve(message)
    })
  })
}

function startHost() {
  const proc = spawn(process.execPath, [helperPath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const messages = []
  messages.listeners = []
  let buffer = ''
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      messages.push(message)
      for (const listener of messages.listeners) listener(message)
    }
  })
  return { proc, messages }
}

describe('Electrobun PTY host helper', () => {
  test('creates a real node-pty session and streams terminal data', async () => {
    const { proc, messages } = startHost()
    let stderr = ''
    proc.stderr.on('data', chunk => { stderr += chunk.toString() })
    try {
      proc.stdin.write(JSON.stringify({ type: 'create', tileId: 'tile-test', cwd: repoRoot, shell: '/bin/zsh', args: ['-lc', 'printf pty-host-ok'] }) + '\n')
      await waitForMessage(messages, message => message.type === 'created' && message.tileId === 'tile-test')
      await waitForMessage(messages, message => message.type === 'data' && message.tileId === 'tile-test' && String(message.data).includes('pty-host-ok'))
      await waitForMessage(messages, message => message.type === 'exit' && message.tileId === 'tile-test')
      assert.equal(stderr.trim(), '')
    } finally {
      proc.kill('SIGTERM')
      await Promise.race([once(proc, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))])
    }
  })
})
