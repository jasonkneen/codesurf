import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDaemonManager } from '@codesurf/daemon/manager'

async function makeManagerFixture(options = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-daemon-manager-'))
  const daemonDir = join(homeDir, 'daemon')
  const daemonScriptPath = join(homeDir, 'codesurfd.mjs')
  const pidPath = join(daemonDir, 'pid.json')
  await mkdir(daemonDir, { recursive: true })
  await writeFile(daemonScriptPath, '// manager test fixture\n', 'utf8')

  const events = []
  const alivePids = new Set()
  const identitiesByPort = new Map()
  const termSignalledPids = new Set()
  let waitForPidExitCallCount = 0
  let nextPid = 42_200
  let spawnCount = 0
  let releaseFirstSpawn
  let markFirstSpawnStarted
  const firstSpawnGate = options.delayFirstSpawn
    ? new Promise(resolve => {
        releaseFirstSpawn = resolve
      })
    : null
  const firstSpawnStarted = new Promise(resolve => {
    markFirstSpawnStarted = resolve
  })

  async function writePidInfo(info) {
    await writeFile(pidPath, `${JSON.stringify(info)}\n`, 'utf8')
    alivePids.add(info.pid)
    identitiesByPort.set(info.port, info)
  }

  if (options.existingVersion !== undefined) {
    await writePidInfo({
      pid: 42_100,
      port: 4100,
      token: 'existing-token',
      startedAt: new Date(0).toISOString(),
      protocolVersion: 1,
      appVersion: options.existingVersion,
    })
  }

  const runtime = {
    fetch: async (url, requestOptions = {}) => {
      const port = Number(new URL(String(url)).port)
      const pid = port === 4100 ? 42_100 : nextPid
      events.push(`health:${pid}`)
      assert.equal(requestOptions.headers.Authorization, port === 4100
        ? 'Bearer existing-token'
        : `Bearer token-${pid}`)
      const identity = identitiesByPort.get(port)
      const responsePid = options.healthIdentityPid ?? identity?.pid
      const responseStartedAt = options.healthIdentityStartedAt ?? identity?.startedAt
      const healthy = alivePids.has(pid)
      return new Response(JSON.stringify({
        ok: healthy,
        shuttingDown: termSignalledPids.has(pid),
        pid: responsePid,
        startedAt: responseStartedAt,
      }), {
        status: healthy ? 200 : 503,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    kill: (pid, signal = 0) => {
      if (signal === 0) {
        if (alivePids.has(pid)) return true
        const error = new Error(`No process ${pid}`)
        error.code = 'ESRCH'
        throw error
      }
      events.push(`${signal}:${pid}`)
      if (signal === 'SIGTERM') {
        termSignalledPids.add(Math.abs(pid))
      }
      if (!(signal === 'SIGTERM' && options.termLeavesAlive)) {
        alivePids.delete(Math.abs(pid))
      }
      return true
    },
    spawn: () => {
      spawnCount += 1
      nextPid += 1
      events.push(`spawn:${nextPid}`)
      if (spawnCount === 1) {
        markFirstSpawnStarted()
      }
      const child = new EventEmitter()
      child.pid = nextPid
      child.unref = () => {}
      const pidInfo = {
        pid: nextPid,
        port: nextPid,
        token: `token-${nextPid}`,
        startedAt: new Date(nextPid).toISOString(),
        protocolVersion: 1,
        appVersion: '2.0.0',
      }
      if (spawnCount === 1 && firstSpawnGate) {
        void firstSpawnGate.then(() => writePidInfo(pidInfo))
      } else {
        void writePidInfo(pidInfo)
      }
      return child
    },
    waitForChildStartupGrace: async () => {},
    ...(options.waitForPidExitResults === undefined
      ? {}
      : {
          waitForPidExit: async () => {
            const index = Math.min(
              waitForPidExitCallCount,
              options.waitForPidExitResults.length - 1,
            )
            waitForPidExitCallCount += 1
            return options.waitForPidExitResults[index]
          },
        }),
  }

  const manager = createDaemonManager({
    homeDir,
    getAppVersion: () => '2.0.0',
    resolveDaemonScriptPath: () => daemonScriptPath,
    healthTimeoutMs: 5_000,
  }, runtime)

  return {
    events,
    homeDir,
    manager,
    firstSpawnStarted,
    releaseFirstSpawn: () => releaseFirstSpawn?.(),
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  }
}

test('manager reuses a healthy same-version daemon', async t => {
  const fixture = await makeManagerFixture({ existingVersion: '2.0.0' })
  t.after(fixture.cleanup)

  const info = await fixture.manager.ensureDaemonRunning()

  assert.equal(info.pid, 42_100)
  assert.equal(fixture.events.some(event => event.startsWith('spawn:')), false)
  assert.equal(fixture.events.some(event => event.startsWith('SIGTERM:')), false)
})

test('manager retains compatibility with a healthy legacy daemon without an app version', async t => {
  const fixture = await makeManagerFixture({ existingVersion: null })
  t.after(fixture.cleanup)

  const info = await fixture.manager.ensureDaemonRunning()

  assert.equal(info.pid, 42_100)
  assert.equal(fixture.events.some(event => event.startsWith('spawn:')), false)
})

test('manager stops a healthy mismatched daemon before spawning its replacement', async t => {
  const fixture = await makeManagerFixture({ existingVersion: '1.0.0' })
  t.after(fixture.cleanup)

  const info = await fixture.manager.ensureDaemonRunning()

  assert.equal(info.appVersion, '2.0.0')
  assert.equal(fixture.events.filter(event => event.startsWith('SIGTERM:')).length, 1)
  assert.equal(fixture.events.filter(event => event.startsWith('spawn:')).length, 1)
  assert.ok(
    fixture.events.findIndex(event => event === 'SIGTERM:42100')
      < fixture.events.findIndex(event => event.startsWith('spawn:')),
  )
})

test('concurrent version-drift checks share one replacement startup', async t => {
  const fixture = await makeManagerFixture({ existingVersion: '1.0.0' })
  t.after(fixture.cleanup)

  const [first, second] = await Promise.all([
    fixture.manager.ensureDaemonRunning(),
    fixture.manager.ensureDaemonRunning(),
  ])

  assert.equal(first.pid, second.pid)
  assert.equal(fixture.events.filter(event => event.startsWith('SIGTERM:')).length, 1)
  assert.equal(fixture.events.filter(event => event.startsWith('spawn:')).length, 1)
})

test('manager refuses to signal a PID whose authenticated daemon identity does not match pid.json', async t => {
  const fixture = await makeManagerFixture({
    existingVersion: '2.0.0',
    healthIdentityPid: 99_999,
  })
  t.after(fixture.cleanup)

  await assert.rejects(
    fixture.manager.stopDaemon(),
    /refusing to send SIGTERM.*identity could not be authenticated/i,
  )

  assert.equal(fixture.events.some(event => event.startsWith('SIGTERM:')), false)
  assert.equal(fixture.events.some(event => event.startsWith('SIGKILL:')), false)
})

test('manager re-authenticates and safely escalates after the SIGTERM timeout', async t => {
  const fixture = await makeManagerFixture({
    existingVersion: '2.0.0',
    termLeavesAlive: true,
    waitForPidExitResults: [false, true],
  })
  t.after(fixture.cleanup)

  await fixture.manager.stopDaemon()

  assert.equal(fixture.events.filter(event => event === 'SIGTERM:42100').length, 1)
  assert.equal(fixture.events.filter(event => event === 'SIGKILL:-42100').length, 1)
  const termIndex = fixture.events.findIndex(event => event === 'SIGTERM:42100')
  const killIndex = fixture.events.findIndex(event => event === 'SIGKILL:-42100')
  assert.ok(
    fixture.events
      .slice(termIndex + 1, killIndex)
      .some(event => event === 'health:42100'),
  )
})

test('force restart requested during normal startup is queued and honored', async t => {
  const fixture = await makeManagerFixture({ delayFirstSpawn: true })
  t.after(fixture.cleanup)

  const normalStartup = fixture.manager.ensureDaemonRunning()
  await fixture.firstSpawnStarted
  const forcedRestart = fixture.manager.ensureDaemonRunning({ forceRestart: true })
  const duplicateForcedRestart = fixture.manager.ensureDaemonRunning({ forceRestart: true })
  const normalEnsureAfterQueue = fixture.manager.ensureDaemonRunning()

  fixture.releaseFirstSpawn()
  const [normalInfo, restartedInfo, duplicateRestartedInfo, laterNormalInfo] = await Promise.all([
    normalStartup,
    forcedRestart,
    duplicateForcedRestart,
    normalEnsureAfterQueue,
  ])

  assert.notEqual(normalInfo.pid, restartedInfo.pid)
  assert.equal(restartedInfo.pid, duplicateRestartedInfo.pid)
  assert.equal(restartedInfo.pid, laterNormalInfo.pid)
  assert.equal(fixture.events.filter(event => event.startsWith('spawn:')).length, 2)
  assert.equal(fixture.events.filter(event => event === `SIGTERM:${normalInfo.pid}`).length, 1)
})
