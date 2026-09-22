import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  RELAY_IPC_LIMITS,
  isRelayChannelMessageDraft,
  isRelayDirectMessageDraft,
  isRelaySpawnRequest,
  isRelayWorkContext,
} from '../src/main/relay/ipc-validation.ts'

describe('relay IPC payload validation', () => {
  test('accepts the canonical direct-message `to` field', () => {
    assert.equal(isRelayDirectMessageDraft({
      to: 'agent-b',
      subject: 'Coordination',
      body: 'Please review the shared file.',
      kind: 'request',
      priority: 'high',
    }), true)
    assert.equal(isRelayDirectMessageDraft({
      toParticipantId: 'agent-b',
      subject: 'Legacy shape',
      body: 'This must not cross IPC.',
    }), false)
  })

  test('requires canonical spawn name and task while accepting optional id', () => {
    assert.equal(isRelaySpawnRequest({
      id: 'agent-b',
      name: 'Reviewer',
      task: 'Review the shared file',
      provider: 'codex',
      channels: ['review'],
    }), true)
    assert.equal(isRelaySpawnRequest({
      participantId: 'agent-b',
      provider: 'codex',
    }), false)
    assert.equal(isRelaySpawnRequest({
      id: 42,
      name: 'Reviewer',
      task: 'Review the shared file',
    }), false)
  })

  test('rejects malformed channel, work, and optional message fields', () => {
    assert.equal(isRelayChannelMessageDraft({
      channel: 'review',
      subject: 'Update',
      body: 'Ready',
      data: { files: ['src/main/ipc/relay.ts'] },
    }), true)
    assert.equal(isRelayChannelMessageDraft({
      channel: 'review',
      subject: 'Update',
      body: 'Ready',
      priority: 'urgent',
    }), false)
    assert.equal(isRelayWorkContext({
      summary: 'Reviewing IPC boundaries',
      files: ['src/main/ipc/relay.ts'],
      impacts: [{
        targetType: 'agent',
        targetId: 'agent-b',
        description: 'Shared IPC types',
        severity: 'medium',
      }],
    }), true)
    assert.equal(isRelayWorkContext({
      summary: 'Invalid work',
      files: [42],
    }), false)
  })

  test('enforces bounded provider prompt and collection inputs', () => {
    assert.equal(isRelaySpawnRequest({
      name: 'Reviewer',
      task: 'a'.repeat(RELAY_IPC_LIMITS.taskBytes),
      channels: Array.from(
        { length: RELAY_IPC_LIMITS.channelItems },
        (_, index) => `channel-${index}`,
      ),
    }), true)
    assert.equal(isRelaySpawnRequest({
      name: 'Reviewer',
      task: 'a'.repeat(RELAY_IPC_LIMITS.taskBytes + 1),
    }), false)
    assert.equal(isRelaySpawnRequest({
      name: 'n'.repeat(RELAY_IPC_LIMITS.nameBytes + 1),
      task: 'Review the shared file',
    }), false)
    assert.equal(isRelaySpawnRequest({
      name: 'Reviewer',
      task: 'Review the shared file',
      channels: Array.from(
        { length: RELAY_IPC_LIMITS.channelItems + 1 },
        (_, index) => `channel-${index}`,
      ),
    }), false)
  })

  test('enforces bounded message, work, and structured payload inputs', () => {
    const boundedMetadata = {
      value: 'a'.repeat(RELAY_IPC_LIMITS.structuredBytes - 12),
    }
    assert.equal(isRelaySpawnRequest({
      name: 'Reviewer',
      task: 'Review the shared file',
      metadata: boundedMetadata,
    }), true)
    assert.equal(isRelaySpawnRequest({
      name: 'Reviewer',
      task: 'Review the shared file',
      metadata: {
        value: `${boundedMetadata.value}a`,
      },
    }), false)
    assert.equal(isRelayDirectMessageDraft({
      to: 'agent-b',
      subject: 's'.repeat(RELAY_IPC_LIMITS.subjectBytes + 1),
      body: 'Body',
    }), false)
    assert.equal(isRelayDirectMessageDraft({
      to: 'agent-b',
      subject: 'Subject',
      body: 'b'.repeat(RELAY_IPC_LIMITS.bodyBytes + 1),
    }), false)
    assert.equal(isRelayWorkContext({
      summary: 'Bounded work',
      files: Array.from(
        { length: RELAY_IPC_LIMITS.listItems + 1 },
        (_, index) => `src/file-${index}.ts`,
      ),
    }), false)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.equal(isRelaySpawnRequest({
      name: 'Reviewer',
      task: 'Review the shared file',
      metadata: cyclic,
    }), false)
  })
})
