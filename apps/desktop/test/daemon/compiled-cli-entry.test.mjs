import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const ROOT_DIR = resolve(import.meta.dirname, '../..')
const CLI_PATH = join(ROOT_DIR, 'bin', 'codesurf.cjs')

function runNode(args, cwd = ROOT_DIR) {
  return spawnSync(process.execPath, ['--no-experimental-strip-types', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CODESURF_SKIP_UPDATE_CHECK: '1' },
  })
}

test('no-strip-types control rejects raw TypeScript while codesurf chat help loads compiled JS', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'codesurf-raw-ts-negative-'))
  t.after(async () => { await rm(fixture, { recursive: true, force: true }) })
  await writeFile(join(fixture, 'raw.ts'), 'export const raw: string = "not production JavaScript"\n')

  const rawControl = runNode(['-e', "import('./raw.ts')"], fixture)
  assert.notEqual(rawControl.status, 0, 'negative control must reject raw TypeScript')
  assert.match(rawControl.stderr, /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension/)

  const cli = runNode([CLI_PATH, 'chat', '--help'])
  assert.equal(cli.status, 0, cli.stderr || cli.stdout)
  assert.match(cli.stdout, /CodeSurf chat/)
  assert.match(cli.stdout, /Usage:/)
})
