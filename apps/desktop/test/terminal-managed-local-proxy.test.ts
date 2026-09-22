import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_MANAGED_LOCAL_PROXY_PORT,
  hasManagedLocalProxyEnvironmentEvidence,
  inferManagedLocalProxyProcessState,
  isValidManagedLocalProxyPort,
  managedLocalProxyProcessState,
  MANAGED_LOCAL_PROXY_MODE_ENV,
  reconcileManagedLocalProxySession,
  resolveManagedLocalProxyPort,
  resolveManagedLocalProxySpawnEnvironment,
  resolveReportedManagedLocalProxyPort,
  shouldForwardTmuxEnvironment,
  terminalLaunchChanged,
  type ManagedLocalProxySessionState,
} from '../src/main/ipc/terminal-helpers.ts'

describe('managed local-proxy port contract', () => {
  test('accepts only integer TCP ports in the 1..65535 range', () => {
    assert.equal(isValidManagedLocalProxyPort(1), true)
    assert.equal(isValidManagedLocalProxyPort(65_535), true)
    assert.equal(resolveManagedLocalProxyPort(1337), 1337)

    for (const invalid of [
      0,
      -1,
      1.5,
      65_536,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1337',
      null,
      undefined,
    ]) {
      assert.equal(
        resolveManagedLocalProxyPort(invalid),
        null,
        `expected ${String(invalid)} to be rejected`,
      )
    }
  })

  test('never reports unresolved port zero', () => {
    assert.equal(resolveReportedManagedLocalProxyPort(1777, 1888), 1777)
    assert.equal(resolveReportedManagedLocalProxyPort(null, 1888), 1888)
    assert.equal(
      resolveReportedManagedLocalProxyPort(null, 0),
      DEFAULT_MANAGED_LOCAL_PROXY_PORT,
    )
    assert.equal(
      resolveReportedManagedLocalProxyPort(0, 0),
      DEFAULT_MANAGED_LOCAL_PROXY_PORT,
    )
  })

  test('rejects invalid configuration before invoking the runtime start path', async () => {
    let ensureCalls = 0
    await assert.rejects(resolveManagedLocalProxySpawnEnvironment(
      { localProxyEnabled: true, localProxyPort: 0 },
      {
        ensureRunning: async () => {
          ensureCalls += 1
          return { ok: true, port: 0 }
        },
        getStatus: () => ({ running: false, port: 0, token: null }),
      },
    ), /integer between 1 and 65535/)
    assert.equal(ensureCalls, 0)
  })

  test('fails closed when a supposedly running runtime has unresolved port zero', async () => {
    let ensureCalls = 0
    await assert.rejects(resolveManagedLocalProxySpawnEnvironment(
      { localProxyEnabled: true, localProxyPort: 1777 },
      {
        ensureRunning: async () => {
          ensureCalls += 1
          return { ok: true, port: 1777 }
        },
        getStatus: () => ({ running: true, port: 0, token: 'runtime-token' }),
      },
    ), /not running/)
    assert.equal(ensureCalls, 1)
  })
})

describe('managed local-proxy terminal reconciliation', () => {
  const enabled = (token: string) => managedLocalProxyProcessState('enabled', token)
  const disabled = () => managedLocalProxyProcessState('disabled')
  const session = (
    eligible: boolean,
    desired = enabled('token-a'),
    actual = enabled('token-a'),
  ): ManagedLocalProxySessionState => ({ eligible, desired, actual })

  test('reuses an eligible Claude session when mode and token are current', () => {
    const result = reconcileManagedLocalProxySession(
      session(true),
      enabled('token-a'),
    )

    assert.equal(result.action, 'reuse')
    assert.deepEqual(result.state.actual, enabled('token-a'))
    assert.deepEqual(result.state.desired, enabled('token-a'))
  })

  test('replaces on token rotation and becomes reusable after the replacement adopts desired state', () => {
    const rotated = reconcileManagedLocalProxySession(
      session(true),
      enabled('token-b'),
    )

    assert.equal(rotated.action, 'replace')
    assert.deepEqual(rotated.state.actual, enabled('token-a'))
    assert.deepEqual(rotated.state.desired, enabled('token-b'))

    const replacedState: ManagedLocalProxySessionState = {
      ...rotated.state,
      actual: rotated.state.desired,
    }
    assert.equal(
      reconcileManagedLocalProxySession(replacedState, enabled('token-b')).action,
      'reuse',
    )
  })

  test('replaces on enabled-to-disabled and disabled-to-enabled transitions', () => {
    assert.equal(
      reconcileManagedLocalProxySession(session(true), disabled()).action,
      'replace',
    )
    assert.equal(
      reconcileManagedLocalProxySession(
        session(true, disabled(), disabled()),
        enabled('token-b'),
      ).action,
      'replace',
    )
  })

  test('never replaces an unrelated non-Claude session', () => {
    const unrelatedTmuxEnvironment = {}
    const actual = inferManagedLocalProxyProcessState(unrelatedTmuxEnvironment)
    const eligible = hasManagedLocalProxyEnvironmentEvidence(unrelatedTmuxEnvironment)
    assert.equal(
      reconcileManagedLocalProxySession(
        session(eligible, disabled(), actual),
        enabled('token-b'),
      ).action,
      'reuse',
    )
    assert.equal(
      reconcileManagedLocalProxySession(
        session(false, disabled(), disabled()),
        enabled('token-b'),
      ).action,
      'reuse',
    )
  })

  test('infers legacy tmux managed mode without requiring the new marker', () => {
    const legacyEnvironment = {
      baseUrl: 'http://127.0.0.1:1337/v1',
      token: 'legacy-token',
    }
    assert.equal(hasManagedLocalProxyEnvironmentEvidence(legacyEnvironment), true)
    assert.deepEqual(
      inferManagedLocalProxyProcessState(legacyEnvironment),
      enabled('legacy-token'),
    )
    assert.equal(
      hasManagedLocalProxyEnvironmentEvidence({ mode: 'disabled' }),
      true,
    )
    assert.deepEqual(
      inferManagedLocalProxyProcessState({ mode: 'disabled' }),
      disabled(),
    )
    assert.deepEqual(
      inferManagedLocalProxyProcessState({ mode: 'enabled' }),
      managedLocalProxyProcessState('enabled'),
    )
    assert.equal(shouldForwardTmuxEnvironment(MANAGED_LOCAL_PROXY_MODE_ENV), true)
  })
})

describe('terminal provider launch identity', () => {
  test('reuses only the same explicit provider argv', () => {
    const session = { launchBin: 'claude', launchArgs: ['--resume', 'session-a'] }
    assert.equal(terminalLaunchChanged(session, 'claude', ['--resume', 'session-a']), false)
    assert.equal(terminalLaunchChanged(session, 'claude', ['--resume', 'session-b']), true)
    assert.equal(terminalLaunchChanged(session, 'codex', ['resume', 'session-a']), true)
  })

  test('treats omitted launch metadata as a legacy reconnect', () => {
    assert.equal(
      terminalLaunchChanged({ launchBin: 'claude', launchArgs: ['--resume', 'session-a'] }),
      false,
    )
  })
})
