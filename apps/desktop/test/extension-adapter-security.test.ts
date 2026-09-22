import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import { build } from 'esbuild'
import { raycastAdapter } from '../src/main/extensions/adapters/raycast.ts'

async function writeRaycastPackage(
  dir: string,
  pkg: Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'Raycast test',
    version: '1.0.0',
    dependencies: { '@raycast/api': '1.0.0' },
    ...pkg,
  }))
}

async function loadAdaptersModule() {
  const bundleDir = await mkdtemp(join(tmpdir(), 'codesurf-adapters-test-'))
  const outfile = join(bundleDir, 'adapters.mjs')
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['src/main/extensions/adapters/index.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
  })
  return import(`${pathToFileURL(outfile).href}?test=${Date.now()}-${Math.random()}`)
}

describe('extension adapter side-effect boundary', () => {
  test('rejects an invalid adapted identity before wrapEntry creates output', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-adapter-identity-'))
    const extensionDir = join(temp, 'raycast-extension')
    await writeRaycastPackage(extensionDir, {
      id: '../escape',
      commands: [{ name: 'safe-command', title: 'Safe', mode: 'view' }],
    })
    const { inspectAdaptedExtension, tryAdaptExtension } = await loadAdaptersModule()

    await assert.rejects(
      inspectAdaptedExtension(extensionDir),
      /Invalid extension id/,
    )
    assert.equal(await tryAdaptExtension(extensionDir), null)
    await assert.rejects(access(join(extensionDir, 'dist')))
  })

  test('rejects a traversal-shaped Raycast command before creating a shim path', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-adapter-command-'))
    const extensionDir = join(temp, 'raycast-extension')
    await writeRaycastPackage(extensionDir, {
      id: 'safe-raycast-extension',
      commands: [{ name: '../outside', title: 'Escape', mode: 'view' }],
    })

    await assert.rejects(
      raycastAdapter.toManifest(extensionDir),
      /Invalid Raycast command name/,
    )
    await assert.rejects(
      raycastAdapter.wrapEntry!(extensionDir, {
        id: 'safe-raycast-extension',
        name: 'Safe Raycast extension',
        version: '1.0.0',
        tier: 'safe',
        contributes: {},
      }),
      /Invalid Raycast command name/,
    )
    await assert.rejects(access(join(extensionDir, 'dist')))
    await assert.rejects(access(join(temp, 'outside.html')))
  })
})
