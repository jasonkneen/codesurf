#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import {
  getDaemonCompiledExports,
  getDaemonRuntimeEntries,
} from '@codesurf/daemon/package-layout'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = join(ROOT, 'release', 'npm')
const PACKAGE_DIR = join(OUT_ROOT, 'package')
// Phase 0: the daemon is no longer vendored under this repo. The canonical
// @codesurf/daemon is an installed dependency (file: to the engine repo in
// dev; a registry version once published) — release embedding sources from it.
const DAEMON_DIR = dirname(require.resolve('@codesurf/daemon/package.json'))

const args = new Set(process.argv.slice(2))
const skipAppBuild = args.has('--skip-app-build')
const skipPack = args.has('--skip-pack')

function log(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    ...options,
  })
  if (result.status !== 0) {
    fail(`Command failed: ${command} ${commandArgs.join(' ')}`)
  }
}

function copyIfExists(sourceRelative, destRelative = sourceRelative) {
  const source = join(ROOT, sourceRelative)
  if (!existsSync(source)) return
  const destination = join(PACKAGE_DIR, destRelative)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, force: true })
}

function copyResources() {
  const source = join(ROOT, 'resources')
  if (!existsSync(source)) return
  const destination = join(PACKAGE_DIR, 'resources')
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: entry => !entry.endsWith('.pxd'),
  })
}

function copyDaemonPackage(destination) {
  const manifest = JSON.parse(readFileSync(join(DAEMON_DIR, 'package.json'), 'utf8'))
  mkdirSync(destination, { recursive: true })

  for (const entry of getDaemonRuntimeEntries(manifest)) {
    const entrySource = join(DAEMON_DIR, entry)
    if (!existsSync(entrySource)) fail(`Missing required daemon package entry: ${entry}`)
    cpSync(entrySource, join(destination, entry), { recursive: true, force: true })
  }

  if (existsSync(join(destination, 'src'))) {
    fail('Daemon source TypeScript must not be copied into the npm package')
  }
}

function assertStagedDaemonImports() {
  const stagedDaemon = join(PACKAGE_DIR, 'node_modules', '@codesurf', 'daemon')
  const manifest = JSON.parse(readFileSync(join(stagedDaemon, 'package.json'), 'utf8'))
  const importTargets = getDaemonCompiledExports(manifest)
    .map(target => join(stagedDaemon, target.import))
  const probe = [
    "import { pathToFileURL } from 'node:url'",
    `const targets = ${JSON.stringify(importTargets)}`,
    'await Promise.all(targets.map(target => import(pathToFileURL(target).href)))',
  ].join(';')
  run(
    process.execPath,
    ['--no-experimental-strip-types', '--input-type=module', '-e', probe],
    { cwd: PACKAGE_DIR },
  )
}

function assertExists(relativePath) {
  const fullPath = join(ROOT, relativePath)
  if (!existsSync(fullPath)) {
    fail(`Missing required build artifact: ${relativePath}`)
  }
}

function sanitizeManifest(rootManifest, daemonManifest) {
  const filteredOptionalDependencies = Object.fromEntries(
    Object.entries(rootManifest.optionalDependencies ?? {}).filter(([, value]) => {
      return typeof value === 'string' && !value.startsWith('file:')
    }),
  )

  return {
    name: rootManifest.name,
    version: rootManifest.version,
    productName: rootManifest.productName,
    description: rootManifest.description,
    license: rootManifest.license,
    author: rootManifest.author,
    main: rootManifest.main,
    bin: rootManifest.bin,
    files: rootManifest.files,
    keywords: rootManifest.keywords ?? [],
    dependencies: {
      ...(rootManifest.dependencies ?? {}),
      ...(daemonManifest.dependencies ?? {}),
      '@codesurf/daemon': daemonManifest.version,
    },
    bundleDependencies: ['@codesurf/daemon'],
    ...(Object.keys(filteredOptionalDependencies).length > 0
      ? { optionalDependencies: filteredOptionalDependencies }
      : {}),
    engines: { ...(rootManifest.engines ?? {}) },
  }
}

function main() {
  const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const daemonManifest = JSON.parse(readFileSync(join(DAEMON_DIR, 'package.json'), 'utf8'))

  if (!skipAppBuild) {
    log('Building Electron app...')
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])
  } else {
    log('Skipping app build')
    // Canonical daemon dist is built and committed in the engine repo
    // (monorepo packages/codesurf-daemon); copyDaemonPackage below fails on any missing runtime entry.
  }

  assertExists('dist-electron/main/index.js')
  assertExists('dist-electron/renderer/index.html')
  assertExists('dist-electron/preload/index.js')
  assertExists('bin/codesurf.cjs')
  assertExists('bin/codesurfd.mjs')

  rmSync(OUT_ROOT, { recursive: true, force: true })
  mkdirSync(PACKAGE_DIR, { recursive: true })

  log('Preparing npm package directory...')
  copyIfExists('bin')
  copyIfExists('dist-electron')
  copyResources()
  copyDaemonPackage(join(PACKAGE_DIR, 'packages', 'codesurf-daemon'))
  copyDaemonPackage(join(PACKAGE_DIR, 'node_modules', '@codesurf', 'daemon'))
  copyIfExists('packages/codesurf-relay/dist')
  copyIfExists('README.md')
  copyIfExists('LICENSE')
  assertStagedDaemonImports()

  const publishManifest = sanitizeManifest(rootManifest, daemonManifest)
  writeFileSync(
    join(PACKAGE_DIR, 'package.json'),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
    'utf8',
  )

  if (skipPack) {
    log(`Prepared npm package at ${PACKAGE_DIR}`)
    return
  }

  log('Packing npm tarball...')
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', OUT_ROOT], {
    cwd: PACKAGE_DIR,
  })

  const tarballs = statSync(OUT_ROOT).isDirectory()
    ? readdirSync(OUT_ROOT).filter(name => name.endsWith('.tgz'))
    : []

  if (tarballs.length === 0) {
    fail('npm pack did not produce a tarball')
  }

  log(`Created ${join(OUT_ROOT, tarballs[0])}`)
}

main()
