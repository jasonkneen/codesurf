#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function typescriptCli() {
  const require = createRequire(import.meta.url)
  return require.resolve('typescript/bin/tsc')
}

export function buildDist({
  outDir = join(packageDir, 'dist'),
  clean = true,
  stdio = 'inherit',
} = {}) {
  if (clean) rmSync(outDir, { recursive: true, force: true })
  const result = spawnSync(
    process.execPath,
    [
      typescriptCli(),
      '--project',
      join(packageDir, 'tsconfig.json'),
      '--outDir',
      outDir,
    ],
    {
      cwd: packageDir,
      encoding: stdio === 'pipe' ? 'utf8' : undefined,
      stdio,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = stdio === 'pipe'
      ? `\n${result.stdout || ''}${result.stderr || ''}`.trimEnd()
      : ''
    throw new Error(`daemon TypeScript build failed with exit code ${result.status}${details}`)
  }
  return outDir
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    buildDist()
  } catch (error) {
    console.error(error?.stack || error)
    process.exitCode = 1
  }
}
