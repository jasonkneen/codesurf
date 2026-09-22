import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDaemonRuntimeEntries } from '@codesurf/daemon/package-layout'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
// Phase 0: the canonical daemon is an installed dependency; no local copy exists.
const CANONICAL_DIR = dirname(require.resolve('@codesurf/daemon/package.json'))
const PRODUCTION_ROOTS = ['src', 'scripts', 'electrobun']
const TOP_LEVEL_FILES = ['bin/codesurf.cjs', 'electrobun.config.ts', 'electron.vite.config.ts']
const LEGACY_ROOT_DAEMON_SHIMS = [
  'chat-jobs.mjs',
  'checkpoints.mjs',
  'context-buckets.mjs',
  'file-references.mjs',
  'instruction-context.mjs',
  'memory-loader.mjs',
  'project-context.mjs',
  'session-index.mjs',
  'skills-index.mjs',
]
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx'])
const violations = []

async function walk(current) {
  const entries = await readdir(current, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

function importSpecifiers(source) {
  return [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map(match => match[1])
}

function packagedDaemonEntries(patterns) {
  return (patterns ?? [])
    .filter(pattern => pattern.startsWith('packages/codesurf-daemon/'))
    .map(pattern => pattern
      .slice('packages/codesurf-daemon/'.length)
      .replace(/\/\*\*\/\*$/u, '')
      .replace(/\/+$/u, ''))
    .sort()
}

function sameEntries(actual, expected) {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index])
}

const files = [
  ...(await Promise.all(PRODUCTION_ROOTS.map(root => walk(join(ROOT, root))))).flat(),
  ...TOP_LEVEL_FILES.map(file => join(ROOT, file)),
]

for (const shim of LEGACY_ROOT_DAEMON_SHIMS) {
  if (existsSync(join(ROOT, 'bin', shim))) {
    violations.push(`bin/${shim}: legacy daemon re-export shims are forbidden`)
  }
}

for (const file of files) {
  const source = await readFile(file, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return ''
    throw error
  })
  for (const specifier of importSpecifiers(source)) {
    const deepBinImport = specifier.includes('packages/codesurf-daemon/bin/')
      || specifier.startsWith('@codesurf/daemon/bin/')
    const privatePackageImport = /packages\/codesurf-daemon\/(?:dist|scripts|src|test|vendor)\//.test(specifier)
    if (deepBinImport || privatePackageImport) {
      violations.push(`${relative(ROOT, file)}: imports private daemon path ${specifier}`)
    }
  }
}

const rootManifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const daemonManifest = JSON.parse(
  await readFile(join(CANONICAL_DIR, 'package.json'), 'utf8'),
)
const runtimeEntries = getDaemonRuntimeEntries(daemonManifest).sort()
for (const [label, patterns] of [
  ['root npm package', rootManifest.files],
  ['Electron package', rootManifest.build?.files],
]) {
  const actual = packagedDaemonEntries(patterns)
  if (actual.length > 0) {
    violations.push(`${label}: source manifests must not embed a local daemon copy (found ${JSON.stringify(actual)})`)
  }
}

for (const relativePath of [
  'scripts/build-npm-package.mjs',
  'scripts/desktop-sidecar.mjs',
]) {
  const source = await readFile(join(ROOT, relativePath), 'utf8')
  if (!source.includes('getDaemonRuntimeEntries')) {
    violations.push(`${relativePath}: must consume the package-owned daemon runtime layout`)
  }
}
const electrobunConfig = await readFile(join(ROOT, 'electrobun.config.ts'), 'utf8')
if (!electrobunConfig.includes('daemonRuntimeEntries(daemonManifest.files)')) {
  violations.push('electrobun.config.ts: must derive copied daemon files from the package manifest')
}

if (violations.length > 0) {
  console.error(`Daemon consumer boundary violations:\n${violations.sort().map(item => `- ${item}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Daemon consumer boundaries OK (${files.length} production files checked)`)
}
