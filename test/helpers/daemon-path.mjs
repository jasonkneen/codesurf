// Phase 0: resolve canonical @codesurf/daemon files (engine repo grok-cli).
// Bins and non-exported dist modules are not package subpaths; tests load them
// by file URL from the installed dependency.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
export const daemonDir = dirname(require.resolve('@codesurf/daemon/package.json'))
export const daemonFile = (rel) => join(daemonDir, rel)
export const daemonUrl = (rel) => pathToFileURL(join(daemonDir, rel)).href
export const daemonSource = (rel) => readFileSync(join(daemonDir, rel), 'utf8')
export const daemonBinFile = (name) => join(daemonDir, 'bin', name)
export const daemonBinUrl = (name) => pathToFileURL(join(daemonDir, 'bin', name)).href
