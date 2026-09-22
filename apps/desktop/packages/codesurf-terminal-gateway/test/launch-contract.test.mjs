import assert from 'node:assert/strict'
import test from 'node:test'

import { TerminalLaunchContractError, validateTerminalLaunch } from '../src/launch-contract.js'

test('accepts the explicit resume grammar for every supported provider', () => {
  const launches = [
    ['claude', ['--resume', 'claude-session']],
    ['codex', ['resume', 'codex-session']],
    ['opencode', ['--session', 'opencode-session']],
    ['openclaw', ['tui', '--session', 'openclaw-session']],
    ['hermes', ['--resume', 'hermes-session']],
    ['pi', ['--resume', 'pi-session']],
    ['codex', ['resume']],
  ]

  for (const [launchBin, launchArgs] of launches) {
    assert.deepEqual(validateTerminalLaunch(launchBin, launchArgs), {
      launchBin,
      launchArgs,
    })
  }
})

test('rejects shell execution, path-like ids, and provider flag injection', () => {
  const invalid = [
    ['/bin/sh', ['-c', 'echo unsafe']],
    ['claude', ['--resume', '../escape']],
    ['codex', ['resume', 'session', '--dangerous']],
    ['openclaw', ['tui', '--session']],
  ]

  for (const [launchBin, launchArgs] of invalid) {
    assert.throws(() => validateTerminalLaunch(launchBin, launchArgs), TerminalLaunchContractError)
  }
})
