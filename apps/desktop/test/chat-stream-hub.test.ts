import assert from 'node:assert/strict'
import { describe, test, beforeEach } from 'node:test'
import {
  getChatStreamHubListenerCount,
  getChatStreamHubTileCount,
  isChatStreamHubTransportActive,
  resetChatStreamHubForTests,
  setChatStreamHubTransportForTests,
  subscribeChatStream,
  type ChatStreamChunk,
} from '../src/renderer/src/components/chat/chatStreamHub.ts'

beforeEach(() => {
  resetChatStreamHubForTests()
})

describe('chatStreamHub demux', () => {
  test('attaches transport once for multiple tile subscribers', () => {
    let attachCount = 0
    let detachCount = 0
    let push: ((e: ChatStreamChunk) => void) | null = null

    setChatStreamHubTransportForTests((onChunk) => {
      attachCount += 1
      push = onChunk
      return () => { detachCount += 1; push = null }
    })

    const a: ChatStreamChunk[] = []
    const b: ChatStreamChunk[] = []
    const unsubA = subscribeChatStream('workspace-a', 'tile-a', e => { a.push(e) })
    const unsubB = subscribeChatStream('workspace-a', 'tile-b', e => { b.push(e) })

    assert.equal(attachCount, 1)
    assert.equal(isChatStreamHubTransportActive(), true)
    assert.equal(getChatStreamHubTileCount(), 2)
    assert.equal(getChatStreamHubListenerCount(), 2)

    push!({ workspaceId: 'workspace-a', cardId: 'tile-a', type: 'text', text: 'only-a' })
    push!({ workspaceId: 'workspace-a', cardId: 'tile-b', type: 'text', text: 'only-b' })
    push!({ workspaceId: 'workspace-a', cardId: 'tile-a', type: 'text', text: 'a2' })

    assert.deepEqual(a.map(e => e.text), ['only-a', 'a2'])
    assert.deepEqual(b.map(e => e.text), ['only-b'])

    unsubA()
    assert.equal(getChatStreamHubTileCount(), 1)
    assert.equal(detachCount, 0) // still one tile

    unsubB()
    assert.equal(getChatStreamHubTileCount(), 0)
    assert.equal(detachCount, 1)
    assert.equal(isChatStreamHubTransportActive(), false)
  })

  test('second listener on same tile does not re-attach transport', () => {
    let attachCount = 0
    setChatStreamHubTransportForTests((onChunk) => {
      attachCount += 1
      return () => {}
    })

    const u1 = subscribeChatStream('workspace-a', 'tile-a', () => {})
    const u2 = subscribeChatStream('workspace-a', 'tile-a', () => {})
    assert.equal(attachCount, 1)
    assert.equal(getChatStreamHubListenerCount(), 2)
    assert.equal(getChatStreamHubTileCount(), 1)
    u1()
    assert.equal(isChatStreamHubTransportActive(), true)
    u2()
    assert.equal(isChatStreamHubTransportActive(), false)
  })

  test('isolates identical card IDs by workspace', () => {
    let push: ((e: ChatStreamChunk) => void) | null = null
    setChatStreamHubTransportForTests((onChunk) => {
      push = onChunk
      return () => {}
    })
    const a: ChatStreamChunk[] = []
    const b: ChatStreamChunk[] = []
    const unsubA = subscribeChatStream('workspace-a', 'same-card', event => a.push(event))
    const unsubB = subscribeChatStream('workspace-b', 'same-card', event => b.push(event))

    push!({
      workspaceId: 'workspace-a',
      cardId: 'same-card',
      type: 'text',
      text: 'only-a',
    })
    push!({
      workspaceId: 'workspace-b',
      cardId: 'same-card',
      type: 'text',
      text: 'only-b',
    })

    assert.deepEqual(a.map(event => event.text), ['only-a'])
    assert.deepEqual(b.map(event => event.text), ['only-b'])
    unsubA()
    unsubB()
  })

  test('drops events with missing workspace or card identity', () => {
    let push: ((e: ChatStreamChunk) => void) | null = null
    setChatStreamHubTransportForTests((onChunk) => {
      push = onChunk
      return () => {}
    })
    const seen: ChatStreamChunk[] = []
    const unsub = subscribeChatStream('workspace-a', 'tile-a', e => { seen.push(e) })
    push!({ workspaceId: 'workspace-a', cardId: '', type: 'text', text: 'nope' } as ChatStreamChunk)
    push!({ workspaceId: '', cardId: 'tile-a', type: 'text', text: 'nope2' } as ChatStreamChunk)
    push!({ cardId: 'tile-a', type: 'text', text: 'nope3' } as ChatStreamChunk)
    push!({ workspaceId: 'workspace-a', cardId: 'tile-a', type: 'text', text: 'ok' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.text, 'ok')
    unsub()
  })
})
