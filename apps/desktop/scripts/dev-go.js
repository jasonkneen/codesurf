#!/usr/bin/env node
/**
 * Dev launcher with TypeScript-Go running in watch mode beside Electron/Vite.
 *
 * TypeScript-Go is a fast typechecker, not the app runtime. This command keeps
 * the normal dev server alive while tsgo reports type errors continuously.
 */
const { spawn } = require('child_process')

const raw = process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB
const maxOldSpace = raw && /^\d+$/.test(raw) ? raw : '8192'
if (raw && raw !== maxOldSpace) {
  console.warn(
    `[dev:go] Ignoring non-numeric CODESURF_MAX_OLD_SPACE_SIZE_MB=${JSON.stringify(raw)}; using ${maxOldSpace}`
  )
}

const jsFlags = `--expose-gc --max-old-space-size=${maxOldSpace}`
const env = { ...process.env }

const children = []
let shuttingDown = false
let devExitCode = null

function spawnCommand(name, command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env,
    shell: true,
  })

  children.push(child)

  child.on('error', (error) => {
    console.error(`[dev:go] ${name} failed to start:`, error)
    shutdown(1)
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (name === 'electron-vite') {
      devExitCode = code ?? (signal ? 1 : 0)
      shutdown(devExitCode)
    }
  })

  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 100)
}

process.on('SIGINT', () => shutdown(devExitCode ?? 0))
process.on('SIGTERM', () => shutdown(devExitCode ?? 0))

spawnCommand('tsgo', 'tsgo', ['-p', 'tsconfig.tsgo.json', '--noEmit', '--watch', '--pretty', 'false'])
spawnCommand('electron-vite', 'electron-vite', ['dev', '--', `--js-flags=${jsFlags}`])
