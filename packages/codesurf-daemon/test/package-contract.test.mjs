import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('daemon declares the Node 22 runtime floor required by its harness dependencies', async () => {
  const daemonPackage = await readJson(resolve(DAEMON_DIR, 'package.json'))
  const daemonLock = await readJson(resolve(DAEMON_DIR, 'package-lock.json'))

  assert.equal(daemonPackage.engines?.node, '>=22.12.0')
  assert.equal(daemonLock.packages?.['']?.engines?.node, daemonPackage.engines.node)

  for (const dependency of Object.keys(daemonPackage.dependencies).filter(name => name.startsWith('@ai-sdk/harness'))) {
    assert.match(
      daemonLock.packages?.[`node_modules/${dependency}`]?.engines?.node ?? '',
      /^>=22(?:\D|$)/,
      `${dependency} must retain its Node 22 floor`,
    )
  }
})

test('daemon dependency pins retain standalone self-authority', async () => {
  const daemonPackage = await readJson(resolve(DAEMON_DIR, 'package.json'))
  const daemonLock = await readJson(resolve(DAEMON_DIR, 'package-lock.json'))

  assert.deepEqual(
    daemonLock.packages?.['']?.dependencies,
    daemonPackage.dependencies,
    'the nested lock root must exactly mirror the standalone daemon manifest',
  )

  for (const [dependency, manifestVersion] of Object.entries(daemonPackage.dependencies ?? {})) {
    assert.match(manifestVersion ?? '', /^\d+\.\d+\.\d+$/, `${dependency} must be pinned exactly`)
    assert.equal(
      daemonLock.packages?.['']?.dependencies?.[dependency],
      manifestVersion,
      `${dependency} nested lock spec must match the daemon package`,
    )
    assert.equal(
      daemonLock.packages?.[`node_modules/${dependency}`]?.version,
      manifestVersion,
      `${dependency} nested resolution must match the standalone manifest`,
    )
  }
})
