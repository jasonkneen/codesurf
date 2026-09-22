import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHAT_CONTEXT_LIMITS,
  composeChatContext as composeElectronContext,
} from '../src/main/chat/context-composer.ts'
import {
  composeChatContext as composeDaemonContext,
} from '@codesurf/daemon/context-composer'
import { composeHostChatContext } from '../src/main/chat/request-context.ts'
import { appendComposedUserContextToLatestUser } from '../src/main/chat/room-context-message.ts'

const orderedInput = {
  persona: 'PERSONA',
  memory: 'MEMORY',
  skills: 'SKILLS',
  outputConvention: 'OUTPUT',
  insightConvention: 'INSIGHT',
  activityConvention: 'ACTIVITY',
  async: 'ASYNC',
  peer: 'PEER',
  room: 'ROOM',
  fileReferences: 'FILES',
  recentEdit: 'RECENT EDIT',
  blockNotes: 'BLOCK NOTES',
}

test('Electron and daemon context composers match exact stable-to-volatile ordering', () => {
  const electron = composeElectronContext(orderedInput)
  const daemon = composeDaemonContext(orderedInput)
  assert.deepEqual(electron, daemon)
  assert.deepEqual(electron.fragments.map(fragment => fragment.kind), [
    'persona',
    'memory',
    'skills',
    'output-convention',
    'insight-convention',
    'activity-convention',
    'async',
    'peer',
    'room',
    'file-reference',
    'recent-edit',
    'block-notes',
  ])
  assert.deepEqual(electron.fragments.map(fragment => fragment.precedence), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.ok(electron.fragments.every(fragment => fragment.owner === 'chat-context-composer'))
  assert.deepEqual(electron.fragments.map(fragment => fragment.volatility), [
    'stable-session',
    'stable-session',
    'stable-session',
    'stable-session',
    'stable-session',
    'stable-session',
    'per-turn',
    'per-turn',
    'per-turn',
    'per-turn',
    'per-turn',
    'per-turn',
  ])
  assert.equal(electron.systemPrompt, 'PERSONA\n\nMEMORY\n\nSKILLS\n\nOUTPUT\n\nINSIGHT\n\nACTIVITY\n\nASYNC\n\nPEER')
  assert.doesNotMatch(electron.systemPrompt ?? '', /ROOM|FILES/)
  assert.match(electron.userSuffix ?? '', /codesurf_peer_context[\s\S]*ROOM[\s\S]*codesurf_file_context[\s\S]*FILES[\s\S]*codesurf_recent_edit_context[\s\S]*RECENT EDIT[\s\S]*codesurf_block_notes_context[\s\S]*BLOCK NOTES/)
})

test('every fragment and the complete injected aggregate have hard UTF-8 ceilings', () => {
  const huge = '界'.repeat(20_000)
  const result = composeElectronContext({
    persona: huge,
    memory: huge,
    skills: huge,
    outputConvention: huge,
    insightConvention: huge,
    activityConvention: huge,
    async: huge,
    peer: huge,
    room: huge,
    fileReferences: huge,
    recentEdit: huge,
    blockNotes: huge,
  })
  assert.equal(result.fragments.length, 12)
  assert.ok(result.fragments.every(fragment => fragment.includedBytes <= fragment.maxUtf8Bytes))
  assert.ok(result.fragments.every(fragment => fragment.maxUtf8Bytes <= 1_000))
  assert.ok(result.metadata.aggregateBytes <= CHAT_CONTEXT_LIMITS.aggregateBytes)
  assert.equal(result.metadata.maxAggregateBytes, 10_000)
  assert.equal(result.metadata.truncatedFragmentCount, 12)
  assert.equal(Buffer.byteLength([result.systemPrompt, result.userSuffix].filter(Boolean).join('\n\n')), result.metadata.aggregateBytes)
  assert.deepEqual(composeDaemonContext({
    persona: huge,
    memory: huge,
    skills: huge,
    outputConvention: huge,
    insightConvention: huge,
    activityConvention: huge,
    async: huge,
    peer: huge,
    room: huge,
    fileReferences: huge,
    recentEdit: huge,
    blockNotes: huge,
  }), result)
})

test('hostile non-string inputs fail closed without invoking coercion hooks', () => {
  let coercions = 0
  const hostile = {
    toString() {
      coercions += 1
      throw new Error('must not execute')
    },
  }
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  assert.doesNotThrow(() => composeElectronContext({
    persona: hostile,
    memory: revoked.proxy,
    skills: Symbol('secret'),
  }))
  const result = composeElectronContext({ persona: hostile, memory: revoked.proxy })
  assert.equal(coercions, 0)
  assert.equal(result.systemPrompt, undefined)
  assert.deepEqual(result.fragments, [])
})

test('host request composition bounds peers and appends untrusted data only to the latest user turn', () => {
  const result = composeHostChatContext({
    agentMode: { systemPrompt: 'PERSONA' } as never,
    memoryPrompt: 'MEMORY',
    skillsPrompt: 'SKILLS',
    asyncExecution: {
      requestedRunMode: 'background',
      backend: 'daemon',
      hostType: 'local-daemon',
      hostLabel: 'Host',
      providerNativeBackground: true,
      detachedDaemonAvailable: true,
      detachedDaemonPreferred: false,
    },
    peers: [{ peerId: 'peer-a', peerType: 'browser', tools: ['browser_snapshot'] }],
    roomContext: 'ROOM',
    fileReferencePrompt: 'FILES',
    recentEditContext: 'RECENT EDIT',
    blockNotesContext: 'BLOCK NOTES',
  })
  assert.match(result.context.systemPrompt ?? '', /PERSONA[\s\S]*MEMORY[\s\S]*SKILLS[\s\S]*Async Execution/)
  assert.ok(Buffer.byteLength(result.context.systemPrompt ?? '') <= 10_000)
  const messages = appendComposedUserContextToLatestUser([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'latest' },
  ], result.context.userSuffix)
  assert.equal(messages[0]?.content, 'first')
  assert.match(messages[2]?.content ?? '', /^latest[\s\S]*trust="untrusted"[\s\S]*ROOM[\s\S]*FILES[\s\S]*RECENT EDIT[\s\S]*BLOCK NOTES/)
})
