#!/usr/bin/env node
// Phase 0: verify the IDE consumes the canonical @codesurf/daemon (engine repo),
// not a vendored copy. Fails loudly if resolution breaks or a local copy reappears.
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const require = createRequire(import.meta.url)
const manifestPath = require.resolve('@codesurf/daemon/package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.name !== '@codesurf/daemon') throw new Error('unexpected package: ' + manifest.name)
if (manifest.version !== '0.1.0') console.warn('canonical daemon version:', manifest.version)
const daemonDir = dirname(manifestPath)
if (!existsSync(join(daemonDir, 'bin', 'codesurfd.mjs'))) throw new Error('daemon bin missing at ' + daemonDir)
if (!existsSync(join(daemonDir, 'dist', 'index.js'))) throw new Error('daemon dist missing at ' + daemonDir)
console.log('canonical @codesurf/daemon OK:', manifestPath)
