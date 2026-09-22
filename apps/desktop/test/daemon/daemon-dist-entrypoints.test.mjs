import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { getDaemonRuntimeEntries } from '@codesurf/daemon/package-layout'

const ROOT_DIR = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)

// Phase 0: the daemon is a canonical dependency of this repo (engine repo /
// published @codesurf/daemon). Its dist is committed and contract-tested there,
// so no local build step or source embed exists here anymore.
const CANONICAL_DIR = dirname(require.resolve('@codesurf/daemon/package.json'))

test('development entrypoints require the canonical daemon and never build a local copy', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT_DIR, 'package.json'), 'utf8'))
  const scripts = manifest.scripts ?? {}
  assert.equal(scripts['build:daemon'], 'node scripts/check-daemon-canonical.mjs')
  assert.equal(scripts['verify:daemon-dist'], 'node scripts/check-daemon-canonical.mjs')
  const devBuildEntrypoints = [
    'dev',
    'dev:go',
    'web:dev',
    'web:host',
    'web:preview',
    'web:pwa',
    'desktop:dev',
    'build:web',
    'build:main',
    'build',
    'dev:electrobun',
    'build:electrobun',
  ]
  for (const name of devBuildEntrypoints) {
    assert.doesNotMatch(scripts[name] ?? '', /npm run build:daemon/, `${name} must not build a local daemon copy`)
  }
  assert.match(scripts.dogfood ?? '', /\bnpm run build\b/, 'dogfood must use the guarded root build')
  assert.match(scripts.preview ?? '', /\bnpm run verify:daemon-dist\b/, 'preview must verify the canonical daemon')
  assert.match(scripts.prepack ?? '', /\bnpm run verify:daemon-dist\b/, 'prepack must verify the canonical daemon')
})

test('shipping packagers consume the installed canonical daemon, not a source embed', async () => {
  const [manifest, daemonManifest, npmBuilder, desktopSidecar, electronHook, electrobunConfig] = await Promise.all([
    readFile(join(ROOT_DIR, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(CANONICAL_DIR, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(ROOT_DIR, 'scripts', 'build-npm-package.mjs'), 'utf8'),
    readFile(join(ROOT_DIR, 'scripts', 'desktop-sidecar.mjs'), 'utf8'),
    readFile(join(ROOT_DIR, 'scripts', 'before-build.js'), 'utf8'),
    readFile(join(ROOT_DIR, 'electrobun.config.ts'), 'utf8'),
  ])

  assert.doesNotMatch(npmBuilder, /\['--prefix', 'packages\/codesurf-daemon'\]/, 'npm builder must not run local daemon package scripts')
  assert.match(npmBuilder, /getDaemonRuntimeEntries/)
  assert.match(npmBuilder, /getDaemonCompiledExports/)
  assert.match(desktopSidecar, /verifyDaemonDist\(root\)/)
  assert.match(desktopSidecar, /getDaemonRuntimeEntries/)
  assert.match(desktopSidecar, /getDaemonCompiledExports/)
  assert.doesNotMatch(electronHook, /packages\/codesurf-daemon run verify:dist/, 'electron hook must not verify a local daemon copy')
  assert.match(electrobunConfig, /daemonRuntimeEntries\(daemonManifest\.files\)/)
  assert.doesNotMatch(electrobunConfig, /'packages\/codesurf-daemon':/)

  // Source manifests must NOT embed the daemon (it comes from the dependency).
  const sourceHasDaemon = (patterns) => (patterns ?? []).some(pattern => pattern.startsWith('packages/codesurf-daemon/'))
  assert.equal(sourceHasDaemon(manifest.files), false, 'root npm files must not embed a local daemon copy')
  assert.equal(sourceHasDaemon(manifest.build?.files), false, 'electron build files must not embed a local daemon copy')

  // Ship-time bundlers place the INSTALLED canonical under the historical app
  // layout (packages/codesurf-daemon) — their destination entries must match
  // the canonical runtime-entry contract.
  const expectedEntries = getDaemonRuntimeEntries(daemonManifest).sort()
  const electrobun = await import(
    `${pathToFileURL(join(ROOT_DIR, 'electrobun.config.ts')).href}?contract-test=${Date.now()}`
  )
  // Copy entries map SOURCE (absolute canonical path) -> DESTINATION (the
  // historical app-relative layout the packaged runtime resolves).
  const electrobunEntries = Object.values(electrobun.default.build.copy)
    .filter(path => path.startsWith('packages/codesurf-daemon/'))
    .map(path => path.slice('packages/codesurf-daemon/'.length))
    .sort()
  assert.deepEqual(electrobunEntries, expectedEntries)
})
