#!/usr/bin/env node

import { chmod, lstat, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !pathFromRoot.startsWith('/')
    && !pathFromRoot.startsWith('\\')
}

export async function ensureNodePtySpawnHelperExecutable({
  platform = process.platform,
  arch = process.arch,
  packageJsonPath,
} = {}) {
  if (platform !== 'darwin') {
    return { changed: false, reason: 'non-darwin' }
  }

  const resolvedPackageJson = packageJsonPath ?? require.resolve('node-pty/package.json')
  const packageRoot = await realpath(dirname(resolvedPackageJson))
  const helperPath = join(packageRoot, 'prebuilds', `darwin-${arch}`, 'spawn-helper')
  const helperEntry = await lstat(helperPath)

  if (helperEntry.isSymbolicLink() || !helperEntry.isFile()) {
    throw new Error(`[terminal-gateway] Refusing to chmod non-regular node-pty helper: ${helperPath}`)
  }

  const canonicalHelper = await realpath(helperPath)
  if (!isInside(packageRoot, canonicalHelper)) {
    throw new Error(`[terminal-gateway] Refusing to chmod node-pty helper outside package root: ${canonicalHelper}`)
  }

  await chmod(canonicalHelper, 0o755)
  const executableMode = (await stat(canonicalHelper)).mode & 0o777
  if (executableMode !== 0o755) {
    throw new Error(
      `[terminal-gateway] Failed to set node-pty helper mode to 0755: ${canonicalHelper} (${executableMode.toString(8)})`,
    )
  }

  return { changed: true, helperPath: canonicalHelper }
}

const modulePath = await realpath(fileURLToPath(import.meta.url))
const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null
if (invokedPath === modulePath) {
  const result = await ensureNodePtySpawnHelperExecutable()
  if (result.changed) {
    console.log(`[terminal-gateway] node-pty spawn-helper is executable: ${result.helperPath}`)
  }
}
