import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyWebBuild } from '../scripts/verify-web-build.mjs'

async function webBuildFixture(t, overrides = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), 'codesurf-web-build-'))
  t.after(async () => { await rm(outputDir, { recursive: true, force: true }) })
  const manifest = overrides.manifest ?? {
    name: 'CodeSurf',
    id: '/',
    start_url: '/',
    icons: [{ src: '/icon.png', sizes: '512x512' }],
  }
  const serviceWorker = overrides.serviceWorker
    ?? 'importScripts("./workbox-proof.js");precacheAndRoute(["manifest.webmanifest","ts.worker-a.js","json.worker-b.js"])'
  await writeFile(join(outputDir, 'manifest.webmanifest'), JSON.stringify(manifest), 'utf8')
  await writeFile(join(outputDir, 'sw.js'), serviceWorker, 'utf8')
  if (overrides.runtimeConfigFallback !== false) {
    await writeFile(
      join(outputDir, 'codesurf-runtime-config.js'),
      '// credential-free packaged fallback\n',
      'utf8',
    )
  }
  await writeFile(join(outputDir, 'workbox-proof.js'), 'self.workbox = true\n', 'utf8')
  return outputDir
}

test('web build verifier accepts complete install and Monaco-worker artifacts', async t => {
  const outputDir = await webBuildFixture(t)
  const result = verifyWebBuild(outputDir)
  assert.equal(result.manifestPath, join(outputDir, 'manifest.webmanifest'))
  assert.equal(result.serviceWorkerPath, join(outputDir, 'sw.js'))
  assert.equal(result.runtimeConfigFallbackPath, join(outputDir, 'codesurf-runtime-config.js'))
  assert.equal(result.workboxPath, join(outputDir, 'workbox-proof.js'))
})

test('web build verifier rejects missing install metadata and worker precache entries', async t => {
  const badManifestDir = await webBuildFixture(t, {
    manifest: { name: 'CodeSurf', id: '/', start_url: '/', icons: [] },
  })
  assert.throws(() => verifyWebBuild(badManifestDir), /512x512 install icon/)

  const missingWorkerDir = await webBuildFixture(t, {
    serviceWorker: 'importScripts("./workbox-proof.js");precacheAndRoute(["manifest.webmanifest"])',
  })
  assert.throws(() => verifyWebBuild(missingWorkerDir), /does not precache ts\.worker-/)
})

test('web build verifier requires the packaged fallback but forbids precaching it', async t => {
  const missingFallbackDir = await webBuildFixture(t, { runtimeConfigFallback: false })
  assert.throws(() => verifyWebBuild(missingFallbackDir), /Missing packaged runtime-config fallback/)

  const cachedFallbackDir = await webBuildFixture(t, {
    serviceWorker: 'importScripts("./workbox-proof.js");precacheAndRoute(["manifest.webmanifest","ts.worker-a.js","json.worker-b.js","codesurf-runtime-config.js"])',
  })
  assert.throws(() => verifyWebBuild(cachedFallbackDir), /must not precache/)
})
