/**
 * Cross-platform dev launcher.
 *
 * Reads CODESURF_MAX_OLD_SPACE_SIZE_MB from the environment (default 8192)
 * and forwards it as a V8 --max-old-space-size flag to the Electron main
 * process. The old bash syntax `${VAR:-8192}` only works on Unix; this
 * script works on Windows, macOS, and Linux.
 */

const { spawnSync } = require('child_process')
const path = require('path')

const raw = process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB
const maxOldSpace = raw && /^\d+$/.test(raw) ? raw : '8192'
if (raw && raw !== maxOldSpace) {
  console.warn(
    `[dev] Ignoring non-numeric CODESURF_MAX_OLD_SPACE_SIZE_MB=${JSON.stringify(raw)}; using ${maxOldSpace}`
  )
}
const jsFlags = `--expose-gc --max-old-space-size=${maxOldSpace}`

const ensure = spawnSync(process.execPath, [path.join(__dirname, 'ensure-electron.js')], {
  stdio: 'inherit',
})
if (ensure.status !== 0) {
  process.exit(ensure.status ?? 1)
}

const env = { ...process.env }
// electron-vite caches this without trimming; a stale value breaks spawn.
delete env.ELECTRON_EXEC_PATH

const result = spawnSync('electron-vite', ['dev', '--', `--js-flags=${jsFlags}`], {
  stdio: 'inherit',
  env,
  shell: true,
})

if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 0)