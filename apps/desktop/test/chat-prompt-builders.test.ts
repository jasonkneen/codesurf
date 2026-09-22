import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildAsyncExecutionPrompt,
  buildPeerAwareTurnPrompt,
  buildPeerSystemPrompt,
} from '../src/main/chat/prompt-builders.ts'
import {
  PEER_CONTEXT_LIMITS,
  buildPeerContextPrompt as buildElectronPeerContextPrompt,
} from '../src/main/chat/peer-context-policy.ts'
import {
  buildPeerContextPrompt as buildDaemonPeerContextPrompt,
} from '@codesurf/daemon/peer-context-policy'

interface PeerPolicyFixture {
  name: string
  peers: unknown[]
  expected: {
    peerIds: string[]
    includes: string[]
    excludes: string[]
  }
}

const peerPolicyFixtures = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/peer-context-policy.json', import.meta.url)),
  'utf8',
)) as { cases: PeerPolicyFixture[] }

function fragmentText(result: ReturnType<typeof buildElectronPeerContextPrompt>): string | undefined {
  return result.fragment?.text
}

describe('buildAsyncExecutionPrompt', () => {
  test('returns undefined when there is no async execution context', () => {
    assert.equal(buildAsyncExecutionPrompt(undefined), undefined)
  })

  test('always includes the heading and active backend line', () => {
    const out = buildAsyncExecutionPrompt({
      requestedRunMode: 'foreground',
      backend: 'daemon',
      hostType: 'local-daemon',
      hostLabel: 'My Mac',
      providerNativeBackground: false,
      detachedDaemonAvailable: false,
      detachedDaemonPreferred: false,
    })
    assert.match(out ?? '', /^## Async Execution/)
    assert.match(out ?? '', /Active execution backend: daemon \(My Mac\)\./)
    // No optional lines when every flag is false and run mode is foreground.
    assert.equal(out?.split('\n').length, 2)
  })

  test('adds provider-native, detached, and background lines when flagged', () => {
    const out = buildAsyncExecutionPrompt({
      requestedRunMode: 'background',
      backend: 'runtime',
      hostType: 'runtime',
      hostLabel: 'Runtime',
      providerNativeBackground: true,
      detachedDaemonAvailable: true,
      detachedDaemonPreferred: true,
    }) ?? ''
    assert.match(out, /Provider-native background agents/)
    assert.match(out, /daemon-backed detached jobs/)
    assert.match(out, /detached background orchestration job/)
  })

  test('foreground with detached available suggests detached orchestration instead of the background line', () => {
    const out = buildAsyncExecutionPrompt({
      requestedRunMode: 'foreground',
      backend: 'daemon',
      hostType: 'remote-daemon',
      hostLabel: 'Remote',
      providerNativeBackground: false,
      detachedDaemonAvailable: true,
      detachedDaemonPreferred: false,
    }) ?? ''
    assert.match(out, /prefer detached daemon orchestration/)
    assert.doesNotMatch(out, /detached background orchestration job/)
  })
})

describe('buildPeerSystemPrompt', () => {
  test('returns undefined for no peers', () => {
    assert.equal(buildPeerSystemPrompt(undefined), undefined)
    assert.equal(buildPeerSystemPrompt([]), undefined)
  })

  test('lists peer blocks, their tools, and the collaboration section', () => {
    const out = buildPeerSystemPrompt([
      { peerId: 'term-1', peerType: 'terminal', tools: ['terminal_send_input'] },
    ]) ?? ''
    assert.match(out, /Block "term-1" \(terminal\):/)
    assert.match(out, /Tools: terminal_send_input/)
    assert.match(out, /## Agent room/)
    assert.match(out, /Room tools:.*peer_get_state/)
  })

  test('emits the Browser Control guide only when a peer exposes a browser_ tool', () => {
    const withBrowser = buildPeerSystemPrompt([
      { peerId: 'b', peerType: 'browser', tools: ['browser_navigate'] },
    ]) ?? ''
    assert.match(withBrowser, /## Browser Control/)
    const withoutBrowser = buildPeerSystemPrompt([
      { peerId: 't', peerType: 'terminal', tools: ['terminal_send_input'] },
    ]) ?? ''
    assert.doesNotMatch(withoutBrowser, /## Browser Control/)
  })

  test('emits the Extension Actions guide and action lines when actions exist', () => {
    const out = buildPeerSystemPrompt([
      {
        peerId: 'ext-1',
        peerType: 'extension',
        tools: [],
        actions: [{ name: 'generate', description: 'Generate content' }],
      },
    ]) ?? ''
    assert.match(out, /## Extension Actions/)
    assert.match(out, /- generate: Generate content/)
  })

  test('renders peer context with null and object value handling', () => {
    const out = buildPeerSystemPrompt([
      {
        peerId: 'c',
        peerType: 'chat',
        tools: [],
        context: { url: null, nav: { page: 2 } },
      },
    ]) ?? ''
    assert.match(out, /Current context:/)
    assert.match(out, /url: null/)
    assert.match(out, /nav: \{"page":2\}/)
  })

  test('falls back to "(no specific tools)" for an empty peer', () => {
    const out = buildPeerSystemPrompt([
      { peerId: 'empty', peerType: 'unknown', tools: [] },
    ]) ?? ''
    assert.match(out, /\(no specific tools\)/)
  })

  for (const fixture of peerPolicyFixtures.cases) {
    test(`matches the shared peer policy fixture: ${fixture.name}`, () => {
      const electron = buildElectronPeerContextPrompt(fixture.peers)
      const daemon = buildDaemonPeerContextPrompt(fixture.peers)
      assert.deepEqual(electron, daemon)
      assert.deepEqual(electron.peers.map(peer => peer.peerId), fixture.expected.peerIds)
      for (const value of fixture.expected.includes) assert.match(fragmentText(electron) ?? '', new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      for (const value of fixture.expected.excludes) assert.doesNotMatch(fragmentText(electron) ?? '', new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })
  }

  test('bounds peer, tool, action, context, per-peer, and aggregate output by UTF-8 bytes', () => {
    const peers = Array.from({ length: PEER_CONTEXT_LIMITS.peers + 8 }, (_, peerIndex) => ({
      peerId: `peer-${String(peerIndex).padStart(2, '0')}`,
      peerType: `browser-${'é'.repeat(100)}`,
      tools: Array.from({ length: PEER_CONTEXT_LIMITS.toolsPerPeer + 8 }, (_, toolIndex) => `browser_tool_${String(toolIndex).padStart(2, '0')}`),
      actions: Array.from({ length: PEER_CONTEXT_LIMITS.actionsPerPeer + 8 }, (_, actionIndex) => ({
        name: `action_${String(actionIndex).padStart(2, '0')}`,
        description: `description-${'界'.repeat(800)}`,
      })),
      context: Object.fromEntries(Array.from(
        { length: PEER_CONTEXT_LIMITS.contextEntriesPerPeer + 8 },
        (_, contextIndex) => [`ctx-${String(contextIndex).padStart(2, '0')}`, { text: 'é'.repeat(4_000) }],
      )),
    }))

    const electron = buildElectronPeerContextPrompt(peers)
    const daemon = buildDaemonPeerContextPrompt(peers)
    assert.deepEqual(electron, daemon)
    const prompt = fragmentText(electron)
    assert.ok(prompt)
    assert.ok(Buffer.byteLength(prompt, 'utf8') <= PEER_CONTEXT_LIMITS.promptRenderedBytes)
    assert.equal(electron.metadata.renderedBytes, Buffer.byteLength(prompt, 'utf8'))
    assert.equal(prompt, Buffer.from(prompt, 'utf8').toString('utf8'))
    assert.deepEqual(electron.fragment, {
      owner: 'peer-context-policy',
      volatility: 'per-turn',
      maxUtf8Bytes: PEER_CONTEXT_LIMITS.promptRenderedBytes,
      text: prompt,
    })
    assert.equal(electron.peers.length, PEER_CONTEXT_LIMITS.peers)
    assert.ok(electron.peers.every(peer => peer.tools.length <= PEER_CONTEXT_LIMITS.toolsPerPeer))
    assert.ok(electron.peers.every(peer => peer.actions.length <= PEER_CONTEXT_LIMITS.actionsPerPeer))
    assert.ok(electron.peers.every(peer => peer.contextEntries.length <= PEER_CONTEXT_LIMITS.contextEntriesPerPeer))
    assert.equal(electron.metadata.omittedPeerCount, 8)
    assert.equal(electron.metadata.promptTruncated, true)
    assert.ok(electron.metadata.truncatedFieldCount > 0)
    assert.ok(electron.metadata.omittedFieldCount > 0)
    assert.match(prompt, /Peer prompt truncated:/)
    assert.match(prompt, /only discover the canvas/)
  })

  test('canonically ranks peers and nested collections before applying count caps', () => {
    const peers = Array.from({ length: PEER_CONTEXT_LIMITS.peers + 2 }, (_, peerIndex) => ({
      peerId: `peer-${String(peerIndex).padStart(2, '0')}`,
      peerType: 'chat',
      tools: Array.from(
        { length: PEER_CONTEXT_LIMITS.toolsPerPeer + 2 },
        (_, toolIndex) => `tool-${String(toolIndex).padStart(2, '0')}`,
      ),
      actions: Array.from(
        { length: PEER_CONTEXT_LIMITS.actionsPerPeer + 2 },
        (_, actionIndex) => ({
          name: `action-${String(actionIndex).padStart(2, '0')}`,
          description: `Description ${actionIndex}`,
        }),
      ),
    }))
    const reversed = peers.toReversed().map(peer => ({
      ...peer,
      tools: peer.tools.toReversed(),
      actions: peer.actions.toReversed(),
    }))

    const forward = buildElectronPeerContextPrompt(peers)
    const backward = buildElectronPeerContextPrompt(reversed)
    assert.deepEqual(backward, forward)
    assert.deepEqual(buildDaemonPeerContextPrompt(peers), forward)
    assert.deepEqual(buildDaemonPeerContextPrompt(reversed), forward)
  })

  test('handles cycles, throwing accessors, proxies, and hostile toJSON methods without throwing', () => {
    const circular: Record<string, unknown> = { label: 'cycle' }
    circular.self = circular
    const throwingAccessor = Object.create(null) as Record<string, unknown>
    Object.defineProperty(throwingAccessor, 'secret', {
      enumerable: true,
      get() { throw new Error('must not execute') },
    })
    const throwingToJson = {
      safe: 'visible',
      toJSON() { throw new Error('must not execute') },
    }
    const hostileProxy = new Proxy({}, {
      ownKeys() { throw new Error('must not escape') },
    })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const peers = [{
      peerId: 'safe',
      peerType: 'chat',
      tools: [],
      context: {
        circular,
        hostileProxy,
        throwingAccessor,
        throwingToJson,
        malformedUnicode: '\ud800',
        revokedProxy: revoked.proxy,
      },
    }]

    const electron = buildElectronPeerContextPrompt(peers)
    const daemon = buildDaemonPeerContextPrompt(peers)
    assert.deepEqual(electron, daemon)
    assert.match(fragmentText(electron) ?? '', /\[Circular\]/)
    assert.match(fragmentText(electron) ?? '', /\[Unserializable object\]/)
    assert.match(fragmentText(electron) ?? '', /maximum rendered bytes for one peer/)
    assert.equal(fragmentText(electron), Buffer.from(fragmentText(electron) ?? '', 'utf8').toString('utf8'))
    assert.equal(
      fragmentText(buildElectronPeerContextPrompt(peers)),
      fragmentText(electron),
      'normalization and ordering must be deterministic',
    )
    assert.doesNotThrow(() => buildElectronPeerContextPrompt([revoked.proxy]))
  })

  test('fails closed for malformed root structures and oversized identifiers', () => {
    assert.equal(fragmentText(buildElectronPeerContextPrompt({ peers: [] })), undefined)
    const result = buildElectronPeerContextPrompt([{
      peerId: 'x'.repeat(PEER_CONTEXT_LIMITS.peerIdBytes + 1),
      peerType: 'chat',
      tools: [],
    }])
    assert.equal(fragmentText(result), undefined)
    assert.equal(result.metadata.malformedPeerCount, 1)
    assert.equal(result.metadata.omittedPeerCount, 1)

    const throwingLength = <T>(array: T[]): T[] => new Proxy(array, {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('length getter must not escape')
        return Reflect.get(target, property, receiver)
      },
    })
    assert.doesNotThrow(() => buildElectronPeerContextPrompt(throwingLength([{
      peerId: 'proxy-root',
      peerType: 'chat',
      tools: throwingLength(['room_post']),
      actions: throwingLength([{ name: 'send', description: 'Send' }]),
    }])))
    const inaccessibleLength = new Proxy([], {
      getOwnPropertyDescriptor() { throw new Error('length descriptor must not escape') },
    })
    assert.equal(fragmentText(buildElectronPeerContextPrompt(inaccessibleLength)), undefined)
  })
})

test('buildPeerAwareTurnPrompt keeps stable context ahead of volatile peers on every turn', () => {
  const first = buildPeerAwareTurnPrompt('USER', 'PEERS', 'STABLE')
  assert.equal(first, 'STABLE\n\nPEERS\n\n---\n\nUSER')
  const resumed = buildPeerAwareTurnPrompt('USER', 'PEERS')
  assert.equal(resumed, 'PEERS\n\n---\n\nUSER')
  assert.equal(buildPeerAwareTurnPrompt('USER', undefined), 'USER')
})
