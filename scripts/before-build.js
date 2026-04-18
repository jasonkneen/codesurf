/**
 * electron-builder beforeBuild hook.
 * Runs before native dependencies are rebuilt for the target platform.
 * Patches node-pty and cpu-features so they compile on Windows.
 *
 * Must return `true`. From electron-builder's packager.js:
 *   this._nodeModulesHandledExternally = !performDependenciesInstallOrRebuild
 * A falsy return tells the packager "dependencies are handled externally,
 * skip npm install AND skip packing node_modules," which produces a packaged
 * app missing every runtime dependency.
 *
 * Windows-only patches are gated on `context.platform.name` so cross-
 * compiling (e.g. building a linux/mac target on a Windows host, or vice
 * versa) doesn't pull in unrelated fix-up logic.
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const { patchNodePtyWin } = require('./patch-node-pty-win')

exports.default = async function (context) {
  const targetPlatform = context.platform && context.platform.name
  console.log('[before-build] Target platform:', targetPlatform)

  if (targetPlatform === 'windows') {
    patchNodePtyWin()

    // Generate cpu-features buildcheck.gypi if missing (Windows-only build fix)
    const cpuFeaturesDir = path.join(__dirname, '..', 'node_modules', 'cpu-features')
    const buildcheckGypi = path.join(cpuFeaturesDir, 'buildcheck.gypi')
    if (fs.existsSync(cpuFeaturesDir) && !fs.existsSync(buildcheckGypi)) {
      try {
        const output = execSync('node buildcheck.js', { cwd: cpuFeaturesDir, encoding: 'utf8' })
        fs.writeFileSync(buildcheckGypi, output)
        console.log('[before-build] Generated cpu-features buildcheck.gypi')
      } catch (err) {
        // Provide a minimal fallback for Windows (cpu-features is a no-op on win32 x64)
        fs.writeFileSync(buildcheckGypi, JSON.stringify({
          conditions: [['OS!="win" and target_arch not in "ia32 x32 x64"', { defines: [], libraries: [], sources: [] }]]
        }, null, 2))
        console.log('[before-build] Created fallback buildcheck.gypi for Windows')
      }
    }
  }

  return true
}
