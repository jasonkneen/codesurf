import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OpenCodeClientCache, type OpenCodeClientOptions } from '../src/main/chat/providers/opencode-client.ts'

interface FakeOpenCodeClient {
  id: number
  provider: {
    list(): Promise<string>
  }
  session: {
    create(): Promise<string>
  }
}

describe('OpenCode SDK client authentication', () => {
  test('authenticates cached clients used by provider and session calls', async () => {
    const constructedWith: OpenCodeClientOptions[] = []
    const cache = new OpenCodeClientCache<FakeOpenCodeClient>()
    const createClient = (options: OpenCodeClientOptions): FakeOpenCodeClient => {
      constructedWith.push(options)
      const id = constructedWith.length
      return {
        id,
        provider: {
          list: async () => `providers-${id}`,
        },
        session: {
          create: async () => `session-${id}`,
        },
      }
    }
    const firstHeaders = {
      Authorization: 'Basic b3BlbmNvZGU6Zmlyc3Q=',
    }

    const first = cache.getOrCreate('http://127.0.0.1:31001', createClient, firstHeaders)
    assert.equal(await first.provider.list(), 'providers-1')
    assert.equal(await first.session.create(), 'session-1')
    assert.deepEqual(constructedWith, [{
      baseUrl: 'http://127.0.0.1:31001',
      headers: firstHeaders,
    }])

    const reused = cache.getOrCreate(
      'http://127.0.0.1:31001',
      createClient,
      { Authorization: 'Basic ignored-for-stable-server' },
    )
    assert.strictEqual(reused, first)
    assert.equal(constructedWith.length, 1)

    const replacementHeaders = {
      Authorization: 'Basic b3BlbmNvZGU6cmVwbGFjZW1lbnQ=',
    }
    const replacement = cache.getOrCreate(
      'http://127.0.0.1:31002',
      createClient,
      replacementHeaders,
    )
    assert.notStrictEqual(replacement, first)
    assert.deepEqual(constructedWith[1], {
      baseUrl: 'http://127.0.0.1:31002',
      headers: replacementHeaders,
    })
  })
})
