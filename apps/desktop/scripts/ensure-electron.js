/**
 * Ensure the Electron binary is present under node_modules/electron/dist.
 *
 * Bun (and some npm postinstall runners) can exit before electron's async
 * install.js finishes, leaving only LICENSES.chromium.html in dist/.
 * A trailing newline in path.txt also breaks electron-vite spawn (ENOENT).
 */

const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron')
const pathFile = path.join(electronDir, 'path.txt')

function getPlatformPath() {
  const platform = process.env.npm_config_platform || os.platform()
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`)
  }
}

function resolveArch(platform) {
  let arch = process.env.npm_config_arch || process.arch
  if (
    platform === 'darwin'
    && process.platform === 'darwin'
    && arch === 'x64'
    && process.env.npm_config_arch === undefined
  ) {
    try {
      const output = childProcess.execSync('sysctl -in sysctl.proc_translated')
      if (output.toString().trim() === '1') arch = 'arm64'
    } catch {
      // ignore
    }
  }
  return arch
}

function isProductionOnlyInstall(env = process.env) {
  const included = env.npm_config_include || env.NPM_CONFIG_INCLUDE || ''
  if (included.split(/[,\s]+/).includes('dev')) return false

  const omitted = env.npm_config_omit || env.NPM_CONFIG_OMIT || ''
  if (omitted.split(/[,\s]+/).includes('dev')) return true

  const only = String(env.npm_config_only || env.NPM_CONFIG_ONLY || '').toLowerCase()
  if (only === 'prod' || only === 'production') return true

  const production = String(
    env.npm_config_production || env.NPM_CONFIG_PRODUCTION || '',
  ).toLowerCase()
  return env.NODE_ENV === 'production'
    || production === 'true'
    || production === '1'
}

function readPathTxt() {
  try {
    return fs.readFileSync(pathFile, 'utf8').trim()
  } catch {
    return null
  }
}

function writePathTxt(platformPath) {
  fs.writeFileSync(pathFile, platformPath, { encoding: 'utf8', flag: 'w' })
}

function resolveBinaryPath(platformPath) {
  return process.env.ELECTRON_OVERRIDE_DIST_PATH
    || path.join(electronDir, 'dist', platformPath)
}

function isInstalled(version, platformPath) {
  try {
    const distVersion = fs.readFileSync(path.join(electronDir, 'dist', 'version'), 'utf8').replace(/^v/, '').trim()
    const recordedPath = readPathTxt()
    if (distVersion !== version || recordedPath !== platformPath) return false
  } catch {
    return false
  }
  return fs.existsSync(resolveBinaryPath(platformPath))
}

async function main() {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) return

  if (isProductionOnlyInstall()) {
    console.log('[ensure-electron] dev dependencies omitted; skipping Electron binary setup')
    return
  }

  if (!fs.existsSync(path.join(electronDir, 'package.json'))) {
    console.warn('[ensure-electron] electron package missing; skipping')
    return
  }

  const { downloadArtifact } = require('@electron/get')
  const extract = require('extract-zip')
  const { version } = require(path.join(electronDir, 'package.json'))
  const platform = process.env.npm_config_platform || process.platform
  const arch = resolveArch(platform)
  const platformPath = getPlatformPath()
  const binaryPath = resolveBinaryPath(platformPath)

  if (fs.existsSync(binaryPath)) {
    const rawPathTxt = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8') : ''
    if (rawPathTxt !== platformPath) {
      writePathTxt(platformPath)
      if (rawPathTxt.trim() !== platformPath) {
        console.log('[ensure-electron] Repaired path.txt (removed stray whitespace)')
      }
    }
    if (isInstalled(version, platformPath)) return
  }

  console.log(`[ensure-electron] Installing Electron ${version} (${platform}-${arch})...`)
  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    force: process.env.force_no_cache === 'true',
    cacheRoot: process.env.electron_config_cache,
    checksums:
      process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
        ? undefined
        : require(path.join(electronDir, 'checksums.json')),
    platform,
    arch,
  })

  const distPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist')
  await fs.promises.rm(distPath, { recursive: true, force: true })
  await fs.promises.mkdir(distPath, { recursive: true })
  if (platform === 'darwin' && process.platform === 'darwin') {
    // extract-zip can stall partway through Electron's large archive on newer
    // Node releases. ditto is a standard macOS tool and preserves the app
    // bundle's executable modes and symlinks.
    childProcess.execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, distPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    await extract(zipPath, { dir: distPath })
  }

  const srcTypeDefPath = path.join(distPath, 'electron.d.ts')
  const targetTypeDefPath = path.join(electronDir, 'electron.d.ts')
  if (fs.existsSync(srcTypeDefPath)) {
    fs.renameSync(srcTypeDefPath, targetTypeDefPath)
  }

  writePathTxt(platformPath)
  console.log('[ensure-electron] Electron binary ready')
}

// A pending Promise does not keep Node's event loop alive. Some @electron/get
// transports can have no ref'ed handles while a cached/downloaded artifact is
// being resolved, which previously let this process exit successfully before
// extraction and path.txt creation completed.
module.exports = { isProductionOnlyInstall, main }

if (require.main === module) {
  const keepAlive = setInterval(() => {}, 1_000)
  main()
    .catch((error) => {
      console.error('[ensure-electron]', error.stack || error)
      process.exitCode = 1
    })
    .finally(() => clearInterval(keepAlive))
}
