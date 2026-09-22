#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function verifyWebBuild(outputDir = join(root, 'dist')) {
  const manifestPath = join(outputDir, 'manifest.webmanifest')
  const serviceWorkerPath = join(outputDir, 'sw.js')
  const runtimeConfigFallbackPath = join(outputDir, 'codesurf-runtime-config.js')
  if (!existsSync(manifestPath)) throw new Error(`Missing PWA manifest: ${manifestPath}`)
  if (!existsSync(serviceWorkerPath)) throw new Error(`Missing service worker: ${serviceWorkerPath}`)
  if (!existsSync(runtimeConfigFallbackPath)) {
    throw new Error(`Missing packaged runtime-config fallback: ${runtimeConfigFallbackPath}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== 'CodeSurf' || manifest.id !== '/' || manifest.start_url !== '/') {
    throw new Error('PWA manifest is missing the reviewed CodeSurf identity and root launch URL')
  }
  if (!Array.isArray(manifest.icons) || !manifest.icons.some(icon => icon?.sizes === '512x512')) {
    throw new Error('PWA manifest must include a 512x512 install icon')
  }

  const serviceWorker = readFileSync(serviceWorkerPath, 'utf8')
  if (!serviceWorker.includes('precacheAndRoute')) {
    throw new Error('Generated service worker does not register its precache manifest')
  }
  for (const requiredAsset of ['manifest.webmanifest', 'ts.worker-', 'json.worker-']) {
    if (!serviceWorker.includes(requiredAsset)) {
      throw new Error(`Generated service worker does not precache ${requiredAsset}`)
    }
  }
  if (serviceWorker.includes('codesurf-runtime-config.js')) {
    throw new Error('Service worker must not precache the per-launch runtime configuration URL')
  }

  const workboxFiles = readdirSync(outputDir).filter(name => /^workbox-.*\.js$/.test(name))
  if (workboxFiles.length !== 1) {
    throw new Error(`Expected one generated Workbox runtime, found ${workboxFiles.length}`)
  }
  if (!serviceWorker.includes(workboxFiles[0].replace(/\.js$/, ''))) {
    throw new Error(`Service worker does not load generated Workbox runtime ${workboxFiles[0]}`)
  }

  return {
    manifestPath,
    serviceWorkerPath,
    runtimeConfigFallbackPath,
    workboxPath: join(outputDir, workboxFiles[0]),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = verifyWebBuild()
    console.log(`[verify-web-build] manifest: ${result.manifestPath}`)
    console.log(`[verify-web-build] service worker: ${result.serviceWorkerPath}`)
    console.log(`[verify-web-build] packaged runtime fallback: ${result.runtimeConfigFallbackPath}`)
    console.log(`[verify-web-build] Workbox runtime: ${result.workboxPath}`)
  } catch (error) {
    console.error(`[verify-web-build] ${error?.message || error}`)
    process.exitCode = 1
  }
}
