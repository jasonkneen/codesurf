import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ElectrobunConfig } from 'electrobun'

// Phase 0: the daemon is no longer vendored here. Source it from the canonical
// engine repo (grok-cli) as a sibling of this checkout; destination inside the
// app bundle keeps the historical 'packages/codesurf-daemon' layout the
// packaged runtime expects. Swap for registry resolution once @codesurf/daemon
// is published (npm: the file: dependency below then becomes a version range).
const daemonPackagePath = resolve(
  process.cwd(),
  '..',
  '..',
  'Documents',
  'GitHub',
  'grok-cli',
  'packages',
  'codesurf-daemon',
)
const daemonManifest = JSON.parse(
  readFileSync(resolve(daemonPackagePath, 'package.json'), 'utf8'),
) as { files?: unknown }

// Electrobun bundles this config before evaluating it and cannot load workspace
// package exports there. Read the package's public files contract directly;
// daemon-dist-entrypoints.test.mjs proves this produces the same entries as
// @codesurf/daemon/package-layout.
function daemonRuntimeEntries(files: unknown): string[] {
  if (!Array.isArray(files)) throw new Error('@codesurf/daemon must declare package files')
  const forbiddenRoots = new Set(['contracts', 'node_modules', 'scripts', 'src', 'test'])
  return [...new Set([...files, 'package.json'].map(value => {
    if (typeof value !== 'string') throw new Error('daemon package files entries must be strings')
    const entry = value.replace(/^\.\//u, '').replace(/\/+$/u, '')
    if (
      !entry
      || entry.includes('\\')
      || entry.includes('\0')
      || /^[a-z]:/iu.test(entry)
      || entry.startsWith('/')
      || entry.split('/').some(segment => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error(`unsafe daemon package files entry: ${String(value)}`)
    }
    if (forbiddenRoots.has(entry.split('/')[0])) {
      throw new Error(`daemon runtime files must not publish ${entry.split('/')[0]}/`)
    }
    return entry
  }))]
}

const daemonRuntimeCopy = Object.fromEntries(
  daemonRuntimeEntries(daemonManifest.files).map(entry => [
    resolve(daemonPackagePath, entry),
    `packages/codesurf-daemon/${entry}`,
  ]),
)

export default {
  app: {
    name: 'CodeSurf',
    identifier: 'com.huggiapps.codesurf.electrobun',
    version: '0.1.0',
    description: 'Infinite canvas workspace for AI agents',
  },
  build: {
    bun: {
      entrypoint: 'electrobun/bun/index.ts',
      external: ['node-pty'],
    },
    views: {
      'codesurf-electrobun': {
        entrypoint: 'electrobun/browser/index.ts',
      },
    },
    copy: {
      'dist-electron/renderer': 'views/mainview',
      'electrobun/helpers': 'helpers',
      'bin': 'bin',
      ...daemonRuntimeCopy,
      'resources/icon.png': 'resources/icon.png',
    },
    buildFolder: 'build-electrobun',
    artifactFolder: 'artifacts-electrobun',
    mac: {
      bundleCEF: false,
      codesign: false,
      notarize: false,
      defaultRenderer: 'native',
      icons: 'resources/icon.iconset',
    },
    win: {
      bundleCEF: false,
      defaultRenderer: 'native',
      icon: 'resources/icon.ico',
    },
    linux: {
      bundleCEF: false,
      defaultRenderer: 'native',
      icon: 'resources/icon.png',
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  release: {
    generatePatch: false,
  },
} satisfies ElectrobunConfig
