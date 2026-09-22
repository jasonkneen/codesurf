import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const HARNESS_PREFIX = '@ai-sdk/harness'
const BLOCKED_PI_HARNESS = '@ai-sdk/harness-pi'
const CLAUDE_SDK = '@anthropic-ai/claude-agent-sdk'
const SECURITY_LOCK_RESOLUTIONS = {
  'node_modules/ws': '8.21.1',
}
const ROOT_INSTALL_LOCKFILES = new Set([
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

// Phase 0: the daemon is an EXTERNAL canonical dependency (engine repo /
// published @codesurf/daemon), never a vendored copy under this repo.
const CANONICAL_DIR = dirname(require.resolve('@codesurf/daemon/package.json'))

test('the IDE and the canonical daemon retain one Node and dependency authority', async () => {
  const [rootPackage, rootLock, daemonPackage, daemonLock] = await Promise.all([
    readJson(resolve(ROOT_DIR, 'package.json')),
    readJson(resolve(ROOT_DIR, 'package-lock.json')),
    readJson(resolve(CANONICAL_DIR, 'package.json')),
    readJson(resolve(CANONICAL_DIR, 'package-lock.json')),
  ])

  assert.equal(rootPackage.engines?.node, '>=22.12.0')
  assert.deepEqual(rootLock.packages?.['']?.engines, rootPackage.engines)
  assert.equal(daemonPackage.engines?.node, '>=22.12.0')
  assert.deepEqual(daemonLock.packages?.['']?.engines, daemonPackage.engines)

  // Canonical standalone lock must exactly mirror the canonical manifest.
  assert.deepEqual(
    daemonLock.packages?.['']?.dependencies,
    daemonPackage.dependencies,
    'the canonical daemon lock root must exactly mirror its manifest dependencies',
  )

  // No vendored copy may exist under this repo (the anti-drift guard).
  const embeddedDaemon = rootLock.packages?.['packages/codesurf-daemon']
  assert.ok(
    !embeddedDaemon || embeddedDaemon.extraneous === true,
    'no local daemon package may be embedded in the root lock (non-extraneous)',
  )
  const daemonSpec = rootPackage.dependencies?.['@codesurf/daemon']
  assert.ok(daemonSpec, 'the root manifest must declare @codesurf/daemon')
  const linkedDaemon = rootLock.packages?.['node_modules/@codesurf/daemon']
  assert.ok(linkedDaemon, 'the root lock must link the canonical daemon dependency')
  if (daemonSpec.startsWith('file:')) {
    assert.equal(linkedDaemon.link, true, 'the file: dependency must record as a link')
    assert.equal(linkedDaemon.resolved, daemonSpec.slice('file:'.length), 'linked resolution must match the manifest spec')
  } else {
    assert.equal(linkedDaemon.version, daemonPackage.version, 'registry dependency must match canonical version')
  }

  // Shared Claude SDK authority: exact pin, equal on both sides.
  assert.equal(rootPackage.dependencies?.[CLAUDE_SDK], daemonPackage.dependencies?.[CLAUDE_SDK])
  assert.match(
    daemonPackage.dependencies?.[CLAUDE_SDK] ?? '',
    /^\d+\.\d+\.\d+$/,
    'the shared Claude SDK authority must be an exact version',
  )

  for (const [dependency, version] of Object.entries(daemonPackage.dependencies ?? {})) {
    if (!dependency.startsWith(HARNESS_PREFIX)) continue
    assert.match(version, /^\d+\.\d+\.\d+$/, `${dependency} must use an exact stable version`)
    assert.equal(
      daemonLock.packages?.[`node_modules/${dependency}`]?.version,
      version,
      `${dependency} lock resolution must match its exact manifest version`,
    )
  }

  assert.equal(daemonPackage.dependencies?.[BLOCKED_PI_HARNESS], undefined)
  assert.equal(daemonLock.packages?.[`node_modules/${BLOCKED_PI_HARNESS}`], undefined)
  assert.equal(rootLock.packages?.[`node_modules/${BLOCKED_PI_HARNESS}`], undefined)

  // The daemon's fixed security resolutions live in the canonical package's
  // own lock (the IDE no longer installs the daemon's dependency tree).
  for (const [path, expectedVersion] of Object.entries(SECURITY_LOCK_RESOLUTIONS)) {
    assert.equal(daemonLock.packages?.[path]?.version, expectedVersion, `${path} must retain its fixed daemon resolution`)
  }
})

test('the repository uses npm as its only root install authority', async () => {
  const [rootPackage, rootEntries, npmPackageBuilder, setupScript, tasksDocument] = await Promise.all([
    readJson(resolve(ROOT_DIR, 'package.json')),
    readdir(ROOT_DIR),
    readFile(resolve(ROOT_DIR, 'scripts/build-npm-package.mjs'), 'utf8'),
    readFile(resolve(ROOT_DIR, 'setup.sh'), 'utf8'),
    readFile(resolve(ROOT_DIR, 'TASKS.md'), 'utf8'),
  ])
  const presentLockfiles = rootEntries.filter(name => ROOT_INSTALL_LOCKFILES.has(name)).sort()

  assert.deepEqual(presentLockfiles, ['package-lock.json'])
  assert.match(rootPackage.scripts?.['build:npm'] ?? '', /^node\s/)
  assert.doesNotMatch(npmPackageBuilder, /\bbun(?:\.exe)?\b/)
  assert.match(setupScript, /^[ \t]*npm ci[ \t]*$/m)
  assert.doesNotMatch(setupScript, /^[ \t]*(?:exec[ \t]+)?npm install(?:[ \t]|$)/m)
  assert.match(setupScript, /\bnpm run dev\b/)
  assert.doesNotMatch(setupScript, /\bbun(?:\.exe)?\b/)
  assert.doesNotMatch(tasksDocument, /\bbun install\b/i)
})
