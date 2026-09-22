/**
 * Build-time helpers for the Native desktop shell.
 *
 * Native manifests only accept app-relative frontend paths. This stages the
 * root web build under desktop/frontend, then installs a self-contained
 * loopback-sidecar runtime into a finished macOS/Linux package. Electron is
 * deliberately not involved in this path.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  getDaemonCompiledExports,
  getDaemonPublicSpecifiers,
  getDaemonRuntimeEntries,
} from '@codesurf/daemon/package-layout'

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const desktopDir = join(rootDir, 'desktop')
export const stagedFrontendDir = join(desktopDir, 'frontend')
export const stagedSidecarDir = join(desktopDir, '.native-sidecar')
export const nativePackageFrontendDir = join(desktopDir, '.native-package-frontend')
export const nativePackageOversizedAssetsPath = join(desktopDir, '.native-package-oversized-assets.json')

// Native SDK's current asset packager buffers a file in memory and rejects an
// individual asset at 16 MiB. CodeSurf ships larger ONNX Runtime WASM variants
// for local voice detection, so package a filtered frontend tree then restore
// those static files directly into the already-created frontend asset root.
const nativeSdkAssetReadLimitBytes = 16 * 1024 * 1024

const localRuntimePackages = [
  '@codesurf/daemon',
  '@codesurf/terminal-gateway',
]

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function copy(source, destination) {
  ensureDirectory(dirname(destination))
  // npm's package-local .bin links are relative and valid inside the staged
  // dependency tree. Resolving them during copy rewrites them as absolute
  // checkout paths, which makes the finished macOS bundle fail codesign.
  cpSync(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })
}

function packagePath(root, name) {
  return join(root, 'node_modules', ...name.split('/'))
}

function localPackagePath(root, name) {
  if (!name.startsWith('@codesurf/')) return null
  return join(root, 'packages', `codesurf-${name.slice('@codesurf/'.length)}`)
}

function readPackageJson(path) {
  return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
}

function assertDaemonDistLayout(source) {
  const manifest = readPackageJson(source)
  const compiledExports = getDaemonCompiledExports(manifest)
  for (const target of compiledExports) {
    for (const relativePath of [target.types, target.import]) {
      if (!existsSync(join(source, relativePath))) {
        throw new Error(`@codesurf/daemon export ${target.subpath} is missing ${relativePath}`)
      }
    }
  }
  return { manifest, compiledExports }
}

function verifyDaemonDist(root) {
  const source = localPackagePath(root, '@codesurf/daemon')
  if (!source || !existsSync(source)) {
    throw new Error(`Local @codesurf/daemon package is missing under ${root}`)
  }
  const { compiledExports } = assertDaemonDistLayout(source)
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['--prefix', source, 'run', 'verify:dist'],
    { cwd: root, env: process.env, encoding: 'utf8' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `@codesurf/daemon dist verification failed:\n${result.stdout || ''}${result.stderr || ''}`,
    )
  }
  const importTargets = compiledExports.map(target => (
    pathToFileURL(join(source, target.import)).href
  ))
  const probe = `await Promise.all(${JSON.stringify(importTargets)}.map(target => import(target)))`
  const imported = spawnSync(
    process.execPath,
    ['--no-experimental-strip-types', '--input-type=module', '-e', probe],
    { cwd: root, env: process.env, encoding: 'utf8' },
  )
  if (imported.error) throw imported.error
  if (imported.status !== 0) {
    throw new Error(
      `@codesurf/daemon compiled exports failed to import:\n${imported.stdout || ''}${imported.stderr || ''}`,
    )
  }
}

function dependencyNames(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
    ...Object.keys(manifest.peerDependencies || {}),
  ])
}

function copyLocalPackage(source, destination, name) {
  if (name !== '@codesurf/daemon') {
    copy(source, destination)
    return
  }
  const { manifest } = assertDaemonDistLayout(source)
  rmSync(destination, { recursive: true, force: true })
  ensureDirectory(destination)
  for (const entry of getDaemonRuntimeEntries(manifest)) {
    const entrySource = join(source, entry)
    if (!existsSync(entrySource)) {
      throw new Error(`@codesurf/daemon package entry is missing: ${entry}`)
    }
    copy(entrySource, join(destination, entry))
  }
}

function linkOrCopyLocalPackage(root, appRoot, name) {
  const source = localPackagePath(root, name)
  if (!source || !existsSync(source)) return false
  const directDestination = join(appRoot, 'packages', basename(source))
  copyLocalPackage(source, directDestination, name)
  const moduleDestination = packagePath(appRoot, name)
  copyLocalPackage(source, moduleDestination, name)
  return true
}

/**
 * Copy exactly the Node package closure needed by web-host, codesurfd, and
 * the terminal gateway. The source checkout's node_modules remains the build
 * input; no package installation or network access happens during packaging.
 */
export function stageRuntimeDependencies({ root = rootDir, appRoot }) {
  const pending = [...localRuntimePackages]
  const seen = new Set()

  while (pending.length > 0) {
    const name = pending.pop()
    if (!name || seen.has(name)) continue
    seen.add(name)

    let source = localPackagePath(root, name)
    let destination
    if (source && existsSync(source)) {
      linkOrCopyLocalPackage(root, appRoot, name)
      destination = packagePath(appRoot, name)
    } else {
      source = packagePath(root, name)
      destination = packagePath(appRoot, name)
      if (!existsSync(source)) {
        // Optional dependencies can legitimately be absent. A required one is
        // caught by the packaged sidecar smoke check with its exact name.
        continue
      }
      copy(source, destination)
    }

    const manifest = readPackageJson(source)
    for (const dependency of dependencyNames(manifest)) pending.push(dependency)
  }

  return seen
}

export function stageFrontend({ root = rootDir, desktop = desktopDir } = {}) {
  const source = join(root, 'dist')
  if (!existsSync(join(source, 'index.html'))) {
    throw new Error(`Web build is missing: ${source}. Run npm run build:web first.`)
  }
  const destination = join(desktop, 'frontend')
  rmSync(destination, { recursive: true, force: true })
  copy(source, destination)
  return destination
}

function isSafeRelativeAssetPath(value) {
  if (typeof value !== 'string' || !value) return false
  return value.split(/[\\/]+/).every(segment => segment && segment !== '.' && segment !== '..')
}

function copyPackageableFrontendTree({ source, destination, relative = '', maxAssetBytes, deferred }) {
  ensureDirectory(destination)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const relativePath = relative ? join(relative, entry.name) : entry.name
    const destinationPath = join(destination, entry.name)
    const status = statSync(sourcePath)
    if (status.isDirectory()) {
      copyPackageableFrontendTree({
        source: sourcePath,
        destination: destinationPath,
        relative: relativePath,
        maxAssetBytes,
        deferred,
      })
      continue
    }
    if (!status.isFile()) continue
    if (status.size >= maxAssetBytes) {
      deferred.push({ path: relativePath, byteLength: status.size })
      continue
    }
    copy(sourcePath, destinationPath)
  }
}

/**
 * Native SDK's package tool currently has a per-file 16 MiB read limit. Build
 * a disposable input tree without those oversized assets; `packageNative`
 * copies them into Resources/frontend before the final signing pass.
 */
export function stageNativePackageFrontend({
  desktop = desktopDir,
  maxAssetBytes = nativeSdkAssetReadLimitBytes,
} = {}) {
  const source = join(desktop, 'frontend')
  const destination = join(desktop, '.native-package-frontend')
  const manifestPath = join(desktop, '.native-package-oversized-assets.json')
  if (!existsSync(join(source, 'index.html'))) {
    throw new Error(`Native frontend stage is missing: ${source}. Run stage-frontend first.`)
  }
  rmSync(destination, { recursive: true, force: true })
  rmSync(manifestPath, { force: true })
  const deferred = []
  copyPackageableFrontendTree({ source, destination, maxAssetBytes, deferred })
  writeFileSync(manifestPath, `${JSON.stringify({ maxAssetBytes, deferred }, null, 2)}\n`, { mode: 0o600 })
  return { assetsDir: destination, manifestPath, deferred }
}

function deferredFrontendAssets(desktop) {
  const manifestPath = join(desktop, '.native-package-oversized-assets.json')
  if (!existsSync(manifestPath)) return []
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(parsed?.deferred)) throw new Error(`Invalid Native oversized-assets manifest: ${manifestPath}`)
  return parsed.deferred.map(entry => {
    if (!isSafeRelativeAssetPath(entry?.path) || !Number.isSafeInteger(entry?.byteLength) || entry.byteLength <= 0) {
      throw new Error(`Invalid Native deferred asset entry in ${manifestPath}`)
    }
    return entry
  })
}

export function copyDeferredFrontendAssets({ outputPath, target, desktop = desktopDir } = {}) {
  const layout = packageLayout(resolve(outputPath), target)
  const destinationRoot = join(layout.resourcesDir, 'frontend')
  const sourceRoot = join(desktop, 'frontend')
  const deferred = deferredFrontendAssets(desktop)
  for (const entry of deferred) {
    const source = join(sourceRoot, entry.path)
    if (!existsSync(source) || statSync(source).size !== entry.byteLength) {
      throw new Error(`Native deferred frontend asset changed while packaging: ${source}`)
    }
    copy(source, join(destinationRoot, entry.path))
  }
  return deferred
}

/**
 * Own the Native SDK package invocation so oversized frontend assets can be
 * restored into the exact Resources/frontend root before sidecar installation
 * and the single final codesign pass. The target output is removed first:
 * Native's package tool creates directories but does not clean stale bundles.
 */
export function packageNative({
  outputPath,
  target,
  binaryPath,
  optimize = 'ReleaseFast',
  webEngine = 'system',
  cefDir = 'third_party/cef/macos',
  cefAutoInstall = false,
  desktop = desktopDir,
} = {}) {
  if (!outputPath || !target || !binaryPath) throw new Error('outputPath, target, and binaryPath are required')
  const packageOutput = resolve(outputPath)
  // Validates the target before deleting a package output.
  packageLayout(packageOutput, target)
  const staged = stageNativePackageFrontend({ desktop })
  try {
    rmSync(packageOutput, { recursive: true, force: true })
    const args = [
      'package',
      '--target', target,
      '--manifest', 'app.zon',
      '--assets', staged.assetsDir,
      '--signing', 'adhoc',
      '--optimize', optimize,
      '--output', outputPath,
      '--binary', binaryPath,
      '--web-engine', webEngine,
      '--cef-dir', cefDir,
    ]
    if (cefAutoInstall) args.push('--cef-auto-install')
    const result = spawnSync('native', args, { cwd: desktop, env: process.env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`native package failed with exit code ${result.status ?? 'unknown'}`)
    const deferred = copyDeferredFrontendAssets({ outputPath, target, desktop })
    return { outputPath: packageOutput, deferredAssets: deferred.length }
  } finally {
    rmSync(staged.assetsDir, { recursive: true, force: true })
    rmSync(staged.manifestPath, { force: true })
  }
}

/**
 * The Node executable is part of the app runtime, not a development shell.
 * Official/NVM macOS Node builds are self-contained enough to copy as one
 * executable; Homebrew's Node links dozens of cellar libraries by absolute
 * path and would silently produce a bundle that only works on the build host.
 */
export function assertPortableNodeRuntime(nodeRuntime) {
  if (platform() !== 'darwin') return
  const result = spawnSync('/usr/bin/otool', ['-L', nodeRuntime], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Unable to inspect Node runtime dependencies: ${nodeRuntime}`)
  }
  const linked = result.stdout
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(' ')[0])
    .filter(Boolean)
  const nonSystem = linked.filter(path => !path.startsWith('/System/') && !path.startsWith('/usr/lib/'))
  if (nonSystem.length > 0) {
    throw new Error(
      `Node runtime is not self-contained for Native packaging: ${nodeRuntime}\n`
      + `External dylibs: ${nonSystem.join(', ')}\n`
      + 'Set CODESURF_DESKTOP_NODE_RUNTIME to an official/NVM standalone Node executable (for example, `nvm which 22`).',
    )
  }

  // The Native package currently builds for the host architecture. Copying an
  // x64 Node beside an arm64 launcher (or the reverse) would pass the dylib
  // check yet fail only when the user opens the app, so fail the package here.
  const expectedArchitecture = process.arch === 'arm64'
    ? 'arm64'
    : process.arch === 'x64'
      ? 'x86_64'
      : null
  if (!expectedArchitecture) return
  const architecture = spawnSync('/usr/bin/lipo', ['-archs', nodeRuntime], { encoding: 'utf8' })
  if (architecture.status !== 0) {
    throw new Error(`Unable to inspect Node runtime architecture: ${nodeRuntime}`)
  }
  const availableArchitectures = architecture.stdout.trim().split(/\s+/).filter(Boolean)
  if (!availableArchitectures.includes(expectedArchitecture)) {
    throw new Error(
      `Node runtime architecture does not match this Native package: ${nodeRuntime}\n`
      + `Expected ${expectedArchitecture}; found ${availableArchitectures.join(', ') || 'unknown'}.\n`
      + 'Use a target-matched official/NVM Node executable for CODESURF_DESKTOP_NODE_RUNTIME.',
    )
  }
}

/**
 * Stage the packaged Node runtime plus scripts and dependency closure before
 * native package output is decorated. `CODESURF_DESKTOP_NODE_RUNTIME` lets a
 * release pipeline provide an audited, target-matching Node binary; otherwise
 * the currently-running Node is copied for the host target.
 */
export function stageSidecar({
  root = rootDir,
  desktop = desktopDir,
  nodeRuntime = process.env.CODESURF_DESKTOP_NODE_RUNTIME || process.execPath,
} = {}) {
  const sourceSupervisor = join(desktop, 'sidecar', 'supervisor.mjs')
  const sourceWebHost = join(root, 'scripts', 'web-host.mjs')
  const sourceDaemonLauncher = join(root, 'bin', 'codesurfd.mjs')
  const terminalGateway = join(root, 'packages', 'codesurf-terminal-gateway', 'bin', 'codesurf-terminal-gateway.mjs')
  if (!existsSync(sourceSupervisor)) throw new Error(`Native supervisor is missing: ${sourceSupervisor}`)
  if (!existsSync(sourceWebHost)) throw new Error(`web-host is missing: ${sourceWebHost}`)
  if (!existsSync(sourceDaemonLauncher)) {
    throw new Error(`codesurfd compatibility launcher is missing: ${sourceDaemonLauncher}`)
  }
  if (!existsSync(terminalGateway)) {
    throw new Error(`terminal gateway is missing: ${terminalGateway}. Build the workspace package before desktop:build.`)
  }
  if (!existsSync(nodeRuntime)) {
    throw new Error(`Node runtime is missing: ${nodeRuntime}`)
  }
  assertPortableNodeRuntime(nodeRuntime)
  verifyDaemonDist(root)

  const stage = join(desktop, '.native-sidecar')
  const appRoot = join(stage, 'app')
  rmSync(stage, { recursive: true, force: true })
  ensureDirectory(join(stage, 'bin'))
  ensureDirectory(join(appRoot, 'scripts'))
  copy(nodeRuntime, join(stage, 'bin', platform() === 'win32' ? 'node.exe' : 'node'))
  chmodSync(join(stage, 'bin', platform() === 'win32' ? 'node.exe' : 'node'), 0o755)
  copy(sourceSupervisor, join(stage, 'supervisor.mjs'))
  copy(sourceWebHost, join(appRoot, 'scripts', 'web-host.mjs'))
  copy(sourceDaemonLauncher, join(appRoot, 'bin', 'codesurfd.mjs'))
  stageRuntimeDependencies({ root, appRoot })

  writeFileSync(join(stage, 'runtime-manifest.json'), `${JSON.stringify({
    node: { source: nodeRuntime, version: process.version, platform: process.platform, arch: process.arch },
    packages: localRuntimePackages,
  }, null, 2)}\n`, { mode: 0o600 })
  return stage
}

function packageLayout(outputPath, target) {
  if (target === 'macos') {
    return {
      executableDir: join(outputPath, 'Contents', 'MacOS'),
      resourcesDir: join(outputPath, 'Contents', 'Resources'),
      executable: join(outputPath, 'Contents', 'MacOS', 'codesurf'),
      nativeExecutable: join(outputPath, 'Contents', 'MacOS', 'codesurf-native'),
    }
  }
  if (target === 'linux') {
    return {
      executableDir: join(outputPath, 'bin'),
      resourcesDir: join(outputPath, 'resources'),
      executable: join(outputPath, 'bin', 'codesurf'),
      nativeExecutable: join(outputPath, 'bin', 'codesurf-native'),
    }
  }
  throw new Error(`Native terminal sidecar packaging is not implemented for ${target}. Windows requires a signed .exe launcher; refusing to emit a misleading terminal-capable package.`)
}

/**
 * Install the staged runtime after `native package` has created the platform
 * bundle. The original Zig executable is renamed and launched by the compiled
 * Zig launcher, preserving a single owner for both sidecar children while
 * keeping the app bundle eligible for strict macOS codesign verification.
 */
export function installSidecarIntoPackage({
  outputPath,
  target,
  desktop = desktopDir,
  launcherPath,
} = {}) {
  if (!outputPath || !target || !launcherPath) throw new Error('outputPath, target, and launcherPath are required')
  const layout = packageLayout(resolve(outputPath), target)
  const stage = join(desktop, '.native-sidecar')
  const launcher = resolve(launcherPath)
  if (!existsSync(join(stage, 'supervisor.mjs'))) {
    throw new Error(`Native sidecar stage is missing: ${stage}`)
  }
  if (!existsSync(launcher)) {
    throw new Error(`Compiled Native sidecar launcher is missing: ${launcher}`)
  }
  if (!existsSync(layout.executable)) {
    throw new Error(`Native package executable is missing: ${layout.executable}`)
  }
  if (existsSync(layout.nativeExecutable)) {
    throw new Error(
      `Native sidecar launcher is already installed in ${layout.executable}. `
      + 'Package decoration has one owner; rebuild the package instead of installing twice.',
    )
  }

  rmSync(join(layout.resourcesDir, 'sidecar'), { recursive: true, force: true })
  copy(stage, join(layout.resourcesDir, 'sidecar'))
  renameSync(layout.executable, layout.nativeExecutable)
  copy(launcher, layout.executable)
  chmodSync(layout.executable, 0o755)
  return layout
}

export function assertPackageSidecar({ outputPath, target } = {}) {
  const layout = packageLayout(resolve(outputPath), target)
  const sidecar = join(layout.resourcesDir, 'sidecar')
  const nodeName = target === 'windows' ? 'node.exe' : 'node'
  const required = [
    layout.executable,
    layout.nativeExecutable,
    join(sidecar, 'bin', nodeName),
    join(sidecar, 'supervisor.mjs'),
    join(sidecar, 'app', 'scripts', 'web-host.mjs'),
    join(sidecar, 'app', 'bin', 'codesurfd.mjs'),
    join(sidecar, 'app', 'packages', 'codesurf-daemon', 'bin', 'codesurfd.mjs'),
    join(sidecar, 'app', 'packages', 'codesurf-daemon', 'dist', 'index.js'),
    join(sidecar, 'app', 'packages', 'codesurf-daemon', 'dist', 'chat-cli.js'),
    join(sidecar, 'app', 'packages', 'codesurf-terminal-gateway', 'bin', 'codesurf-terminal-gateway.mjs'),
  ]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length) throw new Error(`Native package is missing sidecar files:\n${missing.join('\n')}`)
  const daemonSource = join(sidecar, 'app', 'packages', 'codesurf-daemon', 'src')
  if (existsSync(daemonSource)) {
    throw new Error(`Native package must not contain daemon source TypeScript: ${daemonSource}`)
  }
  assertSidecarRuntimeLoads({ sidecar, target })
  return layout
}

/**
 * File-existence checks cannot catch a native binding built for the Electron
 * ABI instead of packaged Node, a silently skipped dependency, or a daemon
 * export that still targets non-runnable source. Load the sidecar's critical
 * modules and every compiled daemon API under packaged Node so those failures
 * stop the build instead of surfacing on first launch.
 */
function assertSidecarRuntimeLoads({ sidecar, target }) {
  // The staged Node is target-native; it only runs on a matching host, so a
  // cross-target build cannot exercise it here. Build hosts match their target
  // today (packages build host-arch only), so this normally runs.
  const hostTarget = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null
  if (target !== hostTarget) {
    console.warn(`[desktop-sidecar] skipping runtime load check: ${target} package built on ${process.platform}`)
    return
  }
  const nodeBin = join(sidecar, 'bin', target === 'windows' ? 'node.exe' : 'node')
  const appRoot = join(sidecar, 'app')
  const daemonRoot = packagePath(appRoot, '@codesurf/daemon')
  const daemonManifest = readPackageJson(daemonRoot)
  const runtimeImports = [
    'node-pty',
    'ws',
    'better-sqlite3',
    ...getDaemonPublicSpecifiers(daemonManifest),
  ]
  const probe = `Promise.all(${JSON.stringify(runtimeImports)}.map(specifier => import(specifier)))`
    + '.then(() => process.exit(0))'
    + '.catch((error) => { console.error(error && error.message || error); process.exit(1) })'
  const result = spawnSync(nodeBin, ['-e', probe], { cwd: appRoot, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Packaged sidecar failed to load its native modules or compiled daemon exports under ${nodeBin}.\n`
      + 'The likely cause is an ABI mismatch (node_modules/node-pty was built for '
      + "Electron via rebuild), or a missing runtime dependency that staging skipped.\n"
      + 'Rebuild node-pty for a plain Node ABI before desktop:build (and re-run '
      + '`npm run rebuild` afterwards to restore the Electron build for `npm run dev`).',
    )
  }
}

export function resignPackage({ outputPath, target } = {}) {
  if (target !== 'macos') return
  const packagePath = resolve(outputPath)
  // Default to an ad-hoc signature (`-`) so local builds stay Gatekeeper-testable
  // without a certificate. A release pipeline sets CODESURF_DESKTOP_SIGN_IDENTITY
  // to a Developer ID identity; that path also needs the hardened runtime, which
  // notarization requires and an ad-hoc signature cannot carry.
  const identity = process.env.CODESURF_DESKTOP_SIGN_IDENTITY?.trim() || '-'
  const signArgs = ['--force', '--deep', '--sign', identity]
  if (identity !== '-') signArgs.push('--options', 'runtime', '--timestamp')
  signArgs.push(packagePath)
  const sign = spawnSync('codesign', signArgs, { stdio: 'inherit' })
  if (sign.status !== 0) throw new Error(`codesign failed for ${packagePath}`)
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', packagePath], { stdio: 'inherit' })
  if (verify.status !== 0) throw new Error(`codesign verification failed for ${packagePath}`)
}

function command() {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'stage-frontend') {
    console.log(stageFrontend())
    return
  }
  if (action === 'stage-sidecar') {
    console.log(stageSidecar())
    return
  }
  if (action === 'package-native') {
    const [outputPath, target, optimize, webEngine, cefDir, binaryPath, ...flags] = args
    console.log(JSON.stringify(packageNative({
      outputPath,
      target,
      optimize,
      webEngine,
      cefDir,
      binaryPath,
      cefAutoInstall: flags.includes('--cef-auto-install'),
    })))
    return
  }
  if (action === 'install') {
    const [outputPath, target, launcherPath] = args
    console.log(JSON.stringify(installSidecarIntoPackage({ outputPath, target, launcherPath })))
    return
  }
  if (action === 'assert') {
    const [outputPath, target] = args
    console.log(JSON.stringify(assertPackageSidecar({ outputPath, target })))
    return
  }
  if (action === 'resign') {
    const [outputPath, target] = args
    resignPackage({ outputPath, target })
    return
  }
  throw new Error('Usage: desktop-sidecar.mjs stage-frontend|stage-sidecar|package-native <output> <target> <optimize> <web-engine> <cef-dir> <binary> [--cef-auto-install]|install <output> <target> <compiled-launcher>|assert <output> <target>|resign <output> <target>')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    command()
  } catch (error) {
    console.error('[desktop-sidecar]', error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
