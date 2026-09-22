import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// Phase 0: the canonical daemon is an installed dependency of this repo
// (file: to the engine repo in dev; a registry version once published). The
// fixture reproduces that shape: a real canonical daemon copied into the
// fixture's node_modules, then a manifest that the builder must merge.
const REAL_CANONICAL_DIR = dirname(require.resolve('@codesurf/daemon/package.json'))

async function writeFixtureFile(root, relativePath, contents = '') {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

test('npm package build preserves the authoritative root Node engine', async t => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'codesurf-npm-package-manifest-'))
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }) })

  const rootManifest = JSON.parse(await readFile(join(ROOT_DIR, 'package.json'), 'utf8'))
  const canonicalManifest = JSON.parse(
    await readFile(join(REAL_CANONICAL_DIR, 'package.json'), 'utf8'),
  )
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true })
  await cp(
    join(ROOT_DIR, 'scripts', 'build-npm-package.mjs'),
    join(fixtureRoot, 'scripts', 'build-npm-package.mjs'),
  )
  await writeFixtureFile(fixtureRoot, 'package.json', `${JSON.stringify(rootManifest, null, 2)}\n`)
  await writeFixtureFile(fixtureRoot, 'dist-electron/main/index.js')
  await writeFixtureFile(fixtureRoot, 'dist-electron/renderer/index.html')
  await writeFixtureFile(fixtureRoot, 'dist-electron/preload/index.js')
  await writeFixtureFile(fixtureRoot, 'bin/codesurf.cjs')
  await writeFixtureFile(fixtureRoot, 'bin/codesurfd.mjs')

  // Install the canonical daemon into the fixture like a real dependency.
  const fixtureDaemon = join(fixtureRoot, 'node_modules', '@codesurf', 'daemon')
  await cp(REAL_CANONICAL_DIR, fixtureDaemon, { recursive: true })
  // Override with the merge-under-test manifest (files + an extra runtime dep
  // the builder must fold into the publish manifest, like the real daemon's).
  const daemonExports = Object.fromEntries(
    [
      ['.', 'index'],
      ['./manager', 'manager'],
      ['./client', 'client'],
      ['./sse', 'sse'],
      ['./chat-cli', 'chat-cli'],
      ['./chat-session-store', 'chat-session-store'],
      ['./paths', 'paths'],
      ['./package-layout', 'package-layout'],
    ].map(([subpath, stem]) => [
      subpath,
      {
        types: `./dist/${stem}.d.ts`,
        import: `./dist/${stem}.js`,
        default: `./dist/${stem}.js`,
      },
    ]),
  )
  daemonExports['./package.json'] = './package.json'
  await writeFile(
    join(fixtureDaemon, 'package.json'),
    `${JSON.stringify({
      ...canonicalManifest,
      files: ['bin/', 'dist/', 'vendor/', 'README.md'],
      exports: daemonExports,
      dependencies: {
        ...canonicalManifest.dependencies,
        'daemon-only-runtime': '1.2.3',
      },
    })}\n`,
    'utf8',
  )

  const result = spawnSync(
    process.execPath,
    [join(fixtureRoot, 'scripts', 'build-npm-package.mjs'), '--skip-app-build', '--skip-pack'],
    { cwd: fixtureRoot, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const publishManifest = JSON.parse(
    await readFile(join(fixtureRoot, 'release', 'npm', 'package', 'package.json'), 'utf8'),
  )
  assert.deepEqual(publishManifest.engines, rootManifest.engines)
  assert.equal(publishManifest.engines?.node, '>=22.12.0')
  assert.equal(publishManifest.dependencies?.['@codesurf/daemon'], canonicalManifest.version)
  assert.equal(publishManifest.dependencies?.['daemon-only-runtime'], '1.2.3')
  assert.equal(publishManifest.dependencies?.['better-sqlite3'], '12.8.0')
  assert.deepEqual(publishManifest.bundleDependencies, ['@codesurf/daemon'])
  for (const daemonRoot of [
    join('packages', 'codesurf-daemon'),
    join('node_modules', '@codesurf', 'daemon'),
  ]) {
    const daemonDist = await readFile(
      join(fixtureRoot, 'release', 'npm', 'package', daemonRoot, 'dist', 'index.js'),
      'utf8',
    )
    assert.ok(daemonDist.length > 0, `${daemonRoot}/dist/index.js must contain the real compiled daemon`)
  }
})
