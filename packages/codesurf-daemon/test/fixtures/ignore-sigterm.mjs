import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

process.on('SIGTERM', () => {
  process.stdout.write('sigterm-ignored\n')
})

const fixturePidPath = process.env.CODESURF_TEST_FIXTURE_PID_PATH
if (fixturePidPath) {
  await mkdir(dirname(fixturePidPath), { recursive: true })
  await writeFile(fixturePidPath, `${process.pid}\n`, 'utf8')
}

if (process.env.CODESURF_TEST_FIXTURE_PUBLISH_DAEMON_PID === '1') {
  const daemonPidPath = process.env.CODESURF_DAEMON_PID_PATH
  const daemonPidTempPath = `${daemonPidPath}.${process.pid}.tmp`
  await mkdir(dirname(daemonPidPath), { recursive: true })
  await writeFile(daemonPidTempPath, JSON.stringify({
    pid: process.pid,
    port: 1,
    token: 'fixture-token',
  }), 'utf8')
  await rename(daemonPidTempPath, daemonPidPath)
}

process.stdout.write(`ready:${process.pid}\n`)
setInterval(() => {}, 1_000)
