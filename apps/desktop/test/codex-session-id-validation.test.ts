import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertValidCodexSessionId,
  buildCodexSpawnArgs,
} from '../src/main/chat/providers/agent-mode-payloads.ts'

const base = {
  agentMode: null,
  mode: 'default' as const,
  model: 'gpt-test',
  userContent: 'do it',
  workspaceDir: '/ws',
}

describe('assertValidCodexSessionId', () => {
  it('accepts real session id shapes', () => {
    for (const id of [
      '0199f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f',
      'thread-9',
      'sess_ABC.123',
    ]) {
      assert.equal(assertValidCodexSessionId(id), id)
    }
  })

  it('rejects anything clap would read as an option', () => {
    for (const hostile of [
      '--config=sandbox_mode="danger-full-access"',
      '--last',
      '-c',
      '--json',
      '-',
    ]) {
      assert.throws(() => assertValidCodexSessionId(hostile), /invalid session id/)
    }
  })

  it('rejects separators, whitespace and empty input', () => {
    for (const hostile of ['', ' ', 'a b', 'a/b', 'a\nb', 'a;b', 'a$(id)']) {
      assert.throws(() => assertValidCodexSessionId(hostile), /invalid session id/)
    }
  })

  it('rejects an over-long id', () => {
    assert.throws(() => assertValidCodexSessionId('a'.repeat(200)), /invalid session id/)
  })
})

describe('buildCodexSpawnArgs — sandbox cannot be overridden via sessionId', () => {
  it('refuses to build argv for a flag-shaped session id', () => {
    assert.throws(
      () => buildCodexSpawnArgs({ ...base, resumeThreadId: '--config=sandbox_mode="danger-full-access"' }),
      /invalid session id/,
    )
  })

  it('still resumes normally for a valid id, keeping the codex grammar', () => {
    const args = buildCodexSpawnArgs({ ...base, resumeThreadId: 'thread-9' })
    const resumeIdx = args.indexOf('resume')
    assert.equal(args[resumeIdx + 1], 'thread-9')
    assert.equal(resumeIdx, args.length - 3, 'resume, <id>, <prompt> ordering is preserved')
  })

  it('never emits a danger-full-access sandbox override for a default-mode turn', () => {
    const args = buildCodexSpawnArgs({ ...base, resumeThreadId: 'thread-9' })
    assert.equal(args.some(a => a.includes('danger-full-access')), false)
  })
})
