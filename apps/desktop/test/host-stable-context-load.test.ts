import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect } from './node-expect.ts'
import { hostShouldPrefetchStableContext } from '../src/main/chat/hostStableContextLoad.ts'
const require = createRequire(import.meta.url)
const daemonDir = dirname(require.resolve('@codesurf/daemon/package.json'))
const { createStableContextLoadCache } = await import(
  pathToFileURL(join(daemonDir, 'bin', 'stable-context-load-cache.mjs')).href,
)

describe('hostShouldPrefetchStableContext', () => {
  test('skips host /memory/load and /skills/list when a daemon will rebuild them', () => {
    expect(hostShouldPrefetchStableContext(null)).toBe(true)
    expect(hostShouldPrefetchStableContext(undefined)).toBe(true)
    expect(hostShouldPrefetchStableContext({ type: 'local-daemon' })).toBe(false)
    expect(hostShouldPrefetchStableContext({ type: 'remote-daemon' })).toBe(false)
  })

  test('chat send uses the prefetch gate before loading stable context', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/ipc/chat.ts'), 'utf8')
    expect(source).toContain('hostShouldPrefetchStableContext(daemonHost)')
    expect(source).toContain('readRuntimeStableLoad')
  })
})

describe('createStableContextLoadCache', () => {
  test('returns a hit on the second read without replacing the value', () => {
    const cache = createStableContextLoadCache()
    const request = { workspaceId: 'ws', cardId: 'card', executionTarget: 'local' }
    const key = cache.key('memory', request)
    const payload = { prompt: '## Workspace Instructions\nOnce' }
    expect(cache.get(key).hit).toBe(false)
    cache.set(key, payload)
    const first = cache.get(key)
    expect(first.hit).toBe(true)
    expect(first.value).toBe(payload)
    expect(cache.get(key).value).toBe(payload)
  })
})
