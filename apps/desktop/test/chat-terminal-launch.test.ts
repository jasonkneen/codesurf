import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveChatTerminalLaunch } from '../src/renderer/src/components/chat/chatTerminalLaunch.ts'

describe('chat terminal provider handoff', () => {
  for (const [provider, launchBin, launchArgs, sessionId] of [
    ['claude', 'claude', ['--resume', 'claude-session'], 'claude-session'],
    ['codex', 'codex', ['resume', 'codex-session'], 'codex-session'],
    ['opencode', 'opencode', ['--session', 'opencode-session'], 'opencode-session'],
    ['openclaw', 'openclaw', ['tui', '--session', 'openclaw-session'], 'openclaw-session'],
    ['hermes', 'hermes', ['--resume', 'hermes-session'], 'hermes-session'],
    ['csagent', 'pi', ['--resume', 'pi-session'], 'pi-session'],
  ] as const) {
    test(`${provider} resumes with its own CLI grammar`, () => {
      assert.deepEqual(resolveChatTerminalLaunch(provider, sessionId), {
        launchBin,
        launchArgs,
        supported: true,
      })
    })
  }

  test('Codex opens its own picker before a session id exists', () => {
    assert.deepEqual(resolveChatTerminalLaunch('codex', null), {
      launchBin: 'codex',
      launchArgs: ['resume'],
      supported: true,
    })
  })

  test('unknown providers fail closed instead of presenting a shell as a resumed chat', () => {
    assert.deepEqual(resolveChatTerminalLaunch('extension-provider', 'foreign-session'), {
      launchBin: undefined,
      launchArgs: [],
      supported: false,
    })
  })

  test('whitespace-only session ids are not forwarded', () => {
    assert.deepEqual(resolveChatTerminalLaunch('claude', '   ').launchArgs, [])
  })
})
