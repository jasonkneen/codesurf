import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2] ?? 'normal'
const selfPath = fileURLToPath(import.meta.url)

if (mode === 'normal') {
  process.stdout.write('normal-output')
  process.stderr.write('normal-diagnostic')
} else if (mode === 'nonzero') {
  process.stdout.write('partial-output')
  process.stderr.write('expected-failure')
  process.exitCode = 7
} else if (mode === 'overflow') {
  const chunk = Buffer.alloc(64 * 1024, 0x61)
  const writeForever = () => {
    while (process.stdout.write(chunk)) {
      // Fill the pipe until backpressure, then continue on drain.
    }
    process.stdout.once('drain', writeForever)
  }
  writeForever()
  setInterval(() => {}, 1_000)
} else if (mode === 'stderr-overflow') {
  const chunk = Buffer.alloc(64 * 1024, 0x62)
  const writeForever = () => {
    while (process.stderr.write(chunk)) {
      // Fill the pipe until backpressure, then continue on drain.
    }
    process.stderr.once('drain', writeForever)
  }
  writeForever()
  setInterval(() => {}, 1_000)
} else if (mode === 'linger') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
} else if (mode === 'grandchild') {
  const child = spawn(process.execPath, [selfPath, 'linger'], {
    stdio: 'ignore',
  })
  process.stdout.write(`grandchild:${child.pid}\n`, () => {
    const readyPath = process.argv[3]
    if (readyPath) {
      writeFileSync(readyPath, `${child.pid}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    }
  })
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
} else if (mode === 'grandchild-parent-exits') {
  const child = spawn(process.execPath, [selfPath, 'linger'], {
    stdio: 'ignore',
  })
  process.stdout.write(`grandchild:${child.pid}\n`)
  // No SIGTERM handler: the direct child exits during the grace period while
  // its grandchild remains alive in the process group until group escalation.
  setInterval(() => {}, 1_000)
} else {
  process.stderr.write(`unknown mode: ${mode}`)
  process.exitCode = 2
}
