import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadElectrobunTrustedChatContext } from '../electrobun/bun/trusted-context-runtime.ts'
import type { ChatRequest } from '../src/main/chat/types.ts'

function request(content: string): ChatRequest {
  return {
    workspaceId: 'workspace-trusted-context-order',
    workspaceDir: '/tmp/workspace-trusted-context-order',
    cardId: 'chat-1',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content }],
  }
}

test('fatal memory failure occurs before one-shot attachment expansion', async () => {
  let expansionCalls = 0
  await assert.rejects(loadElectrobunTrustedChatContext(
    request('Attached file capabilities:\nopaque-capability\timage.png'),
    {
      request: async path => {
        if (path.startsWith('/memory/load')) throw new Error('memory failed')
        if (path.startsWith('/skills/list')) return {} as never
        if (path === '/file-references/expand') {
          expansionCalls += 1
          return { changed: true, bodyText: 'image.png', references: [] } as never
        }
        throw new Error(`Unexpected request: ${path}`)
      },
      status: async () => ({ running: true }),
    },
  ), /memory failed/)
  assert.equal(expansionCalls, 0)
})

test('successful prerequisites allow capability expansion and report consumed ownership', async () => {
  let memoryLoaded = false
  const context = await loadElectrobunTrustedChatContext(
    request('Attached file capabilities:\nopaque-capability\tnotes.txt'),
    {
      request: async path => {
        if (path.startsWith('/memory/load')) {
          memoryLoaded = true
          return { prompt: 'memory' } as never
        }
        if (path.startsWith('/skills/list')) return {} as never
        if (path === '/file-references/expand') {
          assert.equal(memoryLoaded, true)
          return {
            changed: true,
            bodyText: 'notes.txt',
            references: [{
              capability: 'opaque-capability',
              binary: false,
              displayPath: 'notes.txt',
              byteCount: 4,
            }],
          } as never
        }
        throw new Error(`Unexpected request: ${path}`)
      },
      status: async () => ({ running: true }),
    },
  )

  assert.equal(context.memoryPrompt, 'memory')
  assert.deepEqual(context.consumedAttachmentCapabilities, ['opaque-capability'])
})

test('a superseded turn stops before destructive capability expansion', async () => {
  let expansionCalls = 0
  const context = await loadElectrobunTrustedChatContext(
    request('Attached file capabilities:\nopaque-capability\tnotes.txt'),
    {
      request: async path => {
        if (path.startsWith('/memory/load') || path.startsWith('/skills/list')) return {} as never
        if (path === '/file-references/expand') {
          expansionCalls += 1
          return { changed: true, bodyText: 'notes.txt', references: [] } as never
        }
        throw new Error(`Unexpected request: ${path}`)
      },
      status: async () => ({ running: true }),
    },
    { isTurnCurrent: () => false },
  )

  assert.equal(expansionCalls, 0)
  assert.equal(context.consumedAttachmentCapabilities, undefined)
})
