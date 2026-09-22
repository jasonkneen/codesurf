import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('validate-extension succeeds for all bundled example extensions', async () => {
  const child = spawn(process.execPath, ['scripts/validate-extension.mjs', '--all'], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  child.stdout.on('data', chunk => {
    stdout += String(chunk)
  })

  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })

  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('close', code => resolvePromise(code ?? 1))
  })

  assert.equal(
    exitCode,
    0,
    `validate-extension failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  )
  assert.match(stdout, /Summary: \d+ passed, 0 failed/)
})
