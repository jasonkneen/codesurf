import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureNodePtySpawnHelperExecutable } from '../scripts/ensure-node-pty-spawn-helper.mjs'

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-node-pty-helper-'))
  const packageRoot = join(root, 'node_modules', 'node-pty')
  const helperDirectory = join(packageRoot, 'prebuilds', 'darwin-arm64')
  const packageJsonPath = join(packageRoot, 'package.json')
  const helperPath = join(helperDirectory, 'spawn-helper')
  await mkdir(helperDirectory, { recursive: true })
  await writeFile(packageJsonPath, '{}\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, packageRoot, packageJsonPath, helperPath }
}

test('repairs only the current Darwin node-pty spawn-helper mode', async (t) => {
  const fixture = await createFixture(t)
  await writeFile(fixture.helperPath, '#!/bin/sh\n')
  await chmod(fixture.helperPath, 0o644)

  const result = await ensureNodePtySpawnHelperExecutable({
    platform: 'darwin',
    arch: 'arm64',
    packageJsonPath: fixture.packageJsonPath,
  })

  assert.equal(result.changed, true)
  assert.equal((await lstat(fixture.helperPath)).mode & 0o777, 0o755)
})

test('refuses symlinked or package-escaping node-pty helpers', async (t) => {
  const directSymlink = await createFixture(t)
  const outsideHelper = join(directSymlink.root, 'outside-helper')
  await writeFile(outsideHelper, '#!/bin/sh\n')
  await symlink(outsideHelper, directSymlink.helperPath)

  await assert.rejects(
    ensureNodePtySpawnHelperExecutable({
      platform: 'darwin',
      arch: 'arm64',
      packageJsonPath: directSymlink.packageJsonPath,
    }),
    /Refusing to chmod non-regular node-pty helper/,
  )

  const escapedDirectory = await createFixture(t)
  const outsideDirectory = join(escapedDirectory.root, 'outside-directory')
  await mkdir(outsideDirectory)
  await writeFile(join(outsideDirectory, 'spawn-helper'), '#!/bin/sh\n')
  const currentArchDirectory = join(escapedDirectory.packageRoot, 'prebuilds', 'darwin-arm64')
  await rm(currentArchDirectory, { recursive: true })
  await symlink(outsideDirectory, currentArchDirectory)

  await assert.rejects(
    ensureNodePtySpawnHelperExecutable({
      platform: 'darwin',
      arch: 'arm64',
      packageJsonPath: escapedDirectory.packageJsonPath,
    }),
    /Refusing to chmod node-pty helper outside package root/,
  )
})

test('does not resolve or modify node-pty outside Darwin', async () => {
  assert.deepEqual(
    await ensureNodePtySpawnHelperExecutable({
      platform: 'linux',
      arch: 'x64',
      packageJsonPath: '/path/that/does/not/exist/package.json',
    }),
    { changed: false, reason: 'non-darwin' },
  )
})
