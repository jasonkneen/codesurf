/**
 * Package CodeSurf as a Native SDK desktop app (thin shell over web dist + host).
 *
 * Electron packaging (`npm run dist:mac` etc.) is unchanged.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireNativeSdkPath } from './resolve-native-sdk.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = path.join(root, 'desktop')
const isWindows = process.platform === 'win32'
const zigCommand = process.env.ZIG_BINARY?.trim() || (existsSync('/opt/homebrew/bin/zig') ? '/opt/homebrew/bin/zig' : 'zig')

function packageTarget() {
  const flag = process.argv.find(arg => arg.startsWith('--target='))
  if (flag) return flag.slice('--target='.length)
  const idx = process.argv.indexOf('--target')
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

function run(cmd, args, { cwd = root, env = {} } = {}) {
  const label = `${cmd} ${args.join(' ')}`
  console.log(`\n[desktop:build] ${label}`)
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  })
  if (result.status !== 0) {
    console.error(`[desktop:build] step failed: ${label}`)
    process.exit(result.status ?? 1)
  }
}

const target = packageTarget()
if (target === 'windows') {
  console.error('[desktop:build] Native terminal sidecar packaging is not implemented for Windows yet.')
  console.error('[desktop:build] A Windows .exe supervisor is required; refusing to produce a package that advertises a non-working terminal.')
  process.exit(2)
}
const nativeSdk = requireNativeSdkPath()
const packageSuffix = target === 'macos' ? '.app' : ''
const packageOutput = path.join(desktopDir, 'zig-out', 'package', `codesurf-0.1.0-${target}-ReleaseFast${packageSuffix}`)
console.log(`[desktop:build] package target=${target}`)
console.log(`[desktop:build] NATIVE_SDK_PATH=${nativeSdk}`)

// `zig build package` is the single owner of the release sequence: it builds
// and stages the frontend, validates app.zon, stages the sidecar, installs the
// compiled launcher once, asserts the layout, then signs/verifies the bundle.
run(zigCommand, [
  'build',
  'package',
  `-Dpackage-target=${target}`,
  `-Dnative-sdk-path=${nativeSdk}`,
  '-Doptimize=ReleaseFast',
], { cwd: desktopDir, env: { NATIVE_SDK_PATH: nativeSdk } })

console.log(`\n[desktop:build] done — output at ${packageOutput}`)
