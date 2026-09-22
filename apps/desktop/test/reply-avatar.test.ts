import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { resolveReplyAvatarPersona } from '../src/renderer/src/lib/replyAvatar.ts'

const polly = { id: 'polly', name: 'Polly', color: '#b368c9' }
const gemma = { id: 'gemma', name: 'Gemma', color: '#00acd7' }

describe('resolveReplyAvatarPersona', () => {
  test('uses the stamped persona when it is still in the roster', () => {
    expect(resolveReplyAvatarPersona(
      { agentId: 'polly', provider: 'claude' },
      [polly, gemma],
      'csagent',
    )).toEqual(polly)
  })

  test('keeps a stable face when the persona was deleted', () => {
    expect(resolveReplyAvatarPersona(
      { agentId: 'retired', provider: 'claude' },
      [polly],
      'claude',
    )).toEqual({ id: 'retired', name: 'retired', color: '#8f96a0' })
  })

  test('falls back to the provider label when no persona was stamped', () => {
    expect(resolveReplyAvatarPersona(
      { provider: 'csagent' },
      [polly],
      'claude',
    )).toEqual({ id: 'provider:csagent', name: 'Pi', color: '#8f96a0' })
  })

  test('uses the live tile provider when history has neither stamp', () => {
    expect(resolveReplyAvatarPersona(
      {},
      [polly],
      'hermes',
    )).toEqual({ id: 'provider:hermes', name: 'Hermes', color: '#8f96a0' })
  })
})
