import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCodexExecArgs } from '../bin/chat-jobs.mjs'

// Codex's CLI grammar is `codex exec [OPTIONS] resume <SESSION_ID> [PROMPT]`.
// Every exec-level OPTION (--json, --model, sandbox/approval flags,
// --skip-git-repo-check, -C <dir>) must precede the `resume` subcommand; only
// SESSION_ID and PROMPT follow it. The original builder pushed `resume <id>`
// immediately after `exec`, so codex rejected the trailing `-C` with
// `error: unexpected argument '-C' found`, breaking multi-turn resume.

test('buildCodexExecArgs places exec-level options before resume', () => {
  const args = buildCodexExecArgs({
    provider: 'codex',
    model: 'o3',
    mode: 'default',
    sessionId: 'session-1',
    messages: [{ role: 'user', content: 'continue' }],
  }, '/tmp/workspace')

  assert.deepEqual(args.slice(0, 13), [
    'exec',
    '--json',
    '--model',
    'o3',
    '-s',
    'workspace-write',
    '-c',
    'approval_policy=on-request',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '-C',
    '/tmp/workspace',
    'resume',
  ])
  assert.equal(args[13], 'session-1')
  assert.match(args.at(-1), /continue/)
})

test('buildCodexExecArgs never emits -C (or any flag) after resume', () => {
  const args = buildCodexExecArgs({
    provider: 'codex',
    model: 'o3',
    mode: 'default',
    sessionId: 'session-1',
    messages: [{ role: 'user', content: 'continue' }],
  }, '/tmp/workspace')

  const resumeIdx = args.indexOf('resume')
  assert.ok(resumeIdx > -1, 'resume subcommand must be present on a continuation turn')
  // `-C` and every other exec-level flag must live BEFORE `resume`.
  assert.ok(args.lastIndexOf('-C') < resumeIdx, '`-C` must never follow `resume`')
  for (const flag of ['--json', '--model', '--ignore-user-config', '--skip-git-repo-check', '-s', '-c']) {
    assert.ok(args.indexOf(flag) > -1 && args.indexOf(flag) < resumeIdx, `${flag} must precede resume`)
  }
  // Only the session id and prompt follow `resume`.
  assert.equal(resumeIdx, args.length - 3, '`resume` must be third-from-last: resume, <id>, <prompt>')
  assert.equal(args[resumeIdx + 1], 'session-1', 'the session id immediately follows `resume`')
})

test('buildCodexExecArgs keeps fresh turns on codex exec without resume', () => {
  const args = buildCodexExecArgs({
    provider: 'codex',
    model: 'o3',
    mode: 'default',
    messages: [{ role: 'user', content: 'start' }],
  }, '/tmp/workspace')

  assert.equal(args[0], 'exec')
  assert.equal(args[1], '--json', 'fresh turns keep the flag order immediately after exec')
  assert.equal(args.includes('resume'), false)
  assert.equal(args.at(-1).includes('start'), true)
})
