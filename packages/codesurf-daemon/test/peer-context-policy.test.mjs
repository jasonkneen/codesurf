import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  PEER_CONTEXT_LIMITS,
  buildPeerContextPrompt,
} from '@codesurf/daemon/peer-context-policy'

const fixtures = JSON.parse(readFileSync(
  new URL('./fixtures/peer-context-policy.json', import.meta.url),
  'utf8',
))

function escaped(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

function fragmentText(result) {
  return result.fragment?.text
}

for (const fixture of fixtures.cases) {
  test(`daemon peer policy matches shared fixture: ${fixture.name}`, () => {
    const result = buildPeerContextPrompt(fixture.peers)
    assert.deepEqual(result.peers.map(peer => peer.peerId), fixture.expected.peerIds)
    for (const value of fixture.expected.includes) assert.match(fragmentText(result) ?? '', escaped(value))
    for (const value of fixture.expected.excludes) assert.doesNotMatch(fragmentText(result) ?? '', escaped(value))
  })
}

test('daemon peer policy bounds aggregate UTF-8 output and all collection counts', () => {
  const peers = Array.from({ length: PEER_CONTEXT_LIMITS.peers + 4 }, (_, peerIndex) => ({
    peerId: `peer-${String(peerIndex).padStart(2, '0')}`,
    peerType: `browser-${'é'.repeat(100)}`,
    tools: Array.from({ length: PEER_CONTEXT_LIMITS.toolsPerPeer + 4 }, (_, toolIndex) => `browser_tool_${toolIndex}`),
    actions: Array.from({ length: PEER_CONTEXT_LIMITS.actionsPerPeer + 4 }, (_, actionIndex) => ({
      name: `action_${actionIndex}`,
      description: '界'.repeat(1_000),
    })),
    context: Object.fromEntries(Array.from(
      { length: PEER_CONTEXT_LIMITS.contextEntriesPerPeer + 4 },
      (_, contextIndex) => [`ctx-${contextIndex}`, 'é'.repeat(4_000)],
    )),
  }))
  const result = buildPeerContextPrompt(peers)

  const prompt = fragmentText(result)
  assert.ok(prompt)
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= PEER_CONTEXT_LIMITS.promptRenderedBytes)
  assert.equal(prompt, Buffer.from(prompt, 'utf8').toString('utf8'))
  assert.equal(result.fragment.owner, 'peer-context-policy')
  assert.equal(result.fragment.volatility, 'per-turn')
  assert.equal(result.peers.length, PEER_CONTEXT_LIMITS.peers)
  assert.ok(result.peers.every(peer => peer.tools.length <= PEER_CONTEXT_LIMITS.toolsPerPeer))
  assert.ok(result.peers.every(peer => peer.actions.length <= PEER_CONTEXT_LIMITS.actionsPerPeer))
  assert.ok(result.peers.every(peer => peer.contextEntries.length <= PEER_CONTEXT_LIMITS.contextEntriesPerPeer))
  assert.equal(result.metadata.omittedPeerCount, 4)
  assert.equal(result.metadata.promptTruncated, true)
})

test('daemon peer policy never invokes accessors or toJSON and contains cycles', () => {
  const circular = { label: 'cycle' }
  circular.self = circular
  const accessor = {}
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() { throw new Error('must not execute') },
  })
  const value = {
    safe: true,
    toJSON() { throw new Error('must not execute') },
  }
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const result = buildPeerContextPrompt([{
    peerId: 'safe',
    peerType: 'chat',
    tools: [],
    context: { accessor, circular, value },
  }])

  assert.match(fragmentText(result) ?? '', /\[Circular\]/)
  assert.match(fragmentText(result) ?? '', /\[Inaccessible property\]/)
  assert.match(fragmentText(result) ?? '', /"safe":true/)
  assert.equal(buildPeerContextPrompt([{
    peerId: 'safe',
    peerType: 'chat',
    tools: [],
    context: { accessor, circular, value },
  }]).fragment?.text, fragmentText(result))
  assert.doesNotThrow(() => buildPeerContextPrompt([revoked.proxy]))

  const throwingLength = array => new Proxy(array, {
    get(target, property, receiver) {
      if (property === 'length') throw new Error('length getter must not escape')
      return Reflect.get(target, property, receiver)
    },
  })
  assert.doesNotThrow(() => buildPeerContextPrompt(throwingLength([{
    peerId: 'proxy-root',
    peerType: 'chat',
    tools: throwingLength(['room_post']),
    actions: throwingLength([{ name: 'send', description: 'Send' }]),
  }])))
})
