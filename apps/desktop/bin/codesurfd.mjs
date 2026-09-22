#!/usr/bin/env node
// Launcher shim. Canonical implementation lives in @codesurf/daemon (the
// codesurf engine repo, grok-cli); this repo consumes it as a dependency.
// package.json "bin", electron-builder packaging, and external scripts keep
// targeting this file; it resolves the canonical daemon binary and forwards.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const manifestPath = require.resolve('@codesurf/daemon/package.json')
const daemonBin = join(dirname(manifestPath), 'bin', 'codesurfd.mjs')
await import(pathToFileURL(daemonBin).href)
