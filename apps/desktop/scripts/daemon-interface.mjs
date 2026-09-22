import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FEATURE = 'codesurf-daemon'
const BASELINE = join(
  ROOT,
  'packages',
  'codesurf-daemon',
  'contracts',
  'recursive-interface.json',
)
const FEATURES_BIN = process.env.FEATURES_BIN || 'features'
const update = process.argv.includes('--update')

function run(args, { quiet = false } = {}) {
  const result = spawnSync(FEATURES_BIN, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        `Unable to find the features binary (${FEATURES_BIN}). ` +
          'Install it or set FEATURES_BIN to its absolute path.',
      )
    }
    throw result.error
  }

  if (!quiet && result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    if (quiet && result.stdout) process.stderr.write(result.stdout)
    throw new Error(`features ${args[0]} failed with exit code ${result.status}`)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'codesurf-daemon-interface-'))
const index = join(scratch, 'index.json')

try {
  run(['scan', ROOT, '--index', index], { quiet: true })

  if (update) {
    run([
      'freeze',
      FEATURE,
      ROOT,
      '--recursive',
      '--index',
      index,
      '--out',
      BASELINE,
    ])
  } else {
    run([
      'check',
      FEATURE,
      ROOT,
      '--recursive',
      '--index',
      index,
      '--freeze-file',
      BASELINE,
    ])
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
