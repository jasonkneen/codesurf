/**
 * Rebuild native modules for the installed Electron version.
 *
 * Fixes a recurring failure mode where a stale node-pty/build/Makefile
 * references `node_modules/node-gyp/addon.gypi` after npm has hoisted/removed
 * top-level node-gyp:
 *
 *   make: *** No rule to make target `../../node-gyp/addon.gypi' ...
 *
 * Strategy:
 * 1. Ensure node-gyp is resolvable from the package root
 * 2. Drop stale gyp output under native packages
 * 3. electron-rebuild better-sqlite3 then node-pty
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const isWindows = process.platform === 'win32'
const reviewedNodeGypVersion = '12.4.0'

function log(msg) {
  console.log(`[rebuild-natives] ${msg}`)
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: isWindows,
  })
  if (result.status !== 0) {
    const err = new Error(`${cmd} ${args.join(' ')} failed with code ${result.status ?? 'unknown'}`)
    err.code = result.status ?? 1
    throw err
  }
}

export function isProductionOnlyInstall(env = process.env) {
  const included = env.npm_config_include ?? env.NPM_CONFIG_INCLUDE ?? ''
  if (included.split(/[,\s]+/).includes('dev')) return false

  const omitted = env.npm_config_omit ?? env.NPM_CONFIG_OMIT ?? ''
  if (omitted.split(/[,\s]+/).includes('dev')) return true

  const only = String(env.npm_config_only ?? env.NPM_CONFIG_ONLY ?? '').toLowerCase()
  if (only === 'prod' || only === 'production') return true

  const production = String(
    env.npm_config_production ?? env.NPM_CONFIG_PRODUCTION ?? '',
  ).toLowerCase()
  return env.NODE_ENV === 'production'
    || production === 'true'
    || production === '1'
}

export function ensureNodeGyp(
  resolvePackage = () => require.resolve('node-gyp/package.json'),
  readPackage = path => JSON.parse(readFileSync(path, 'utf8')),
) {
  let packagePath
  try {
    packagePath = resolvePackage()
  } catch (cause) {
    throw new Error(
      `node-gyp@${reviewedNodeGypVersion} is missing from the package root. `
      + 'Restore the declared dependency with `npm ci`, then rerun `npm run rebuild`.',
      { cause },
    )
  }

  const installedVersion = readPackage(packagePath).version
  if (installedVersion !== reviewedNodeGypVersion) {
    throw new Error(
      `Expected node-gyp@${reviewedNodeGypVersion} at the package root, found `
      + `${installedVersion ?? 'an unknown version'}. Run \`npm ci\` to restore the reviewed toolchain.`,
    )
  }

  log(`node-gyp ${installedVersion} ok (${dirname(packagePath)})`)
}

function cleanStaleNativeBuilds() {
  const dirs = [
    join(root, 'node_modules/node-pty/build'),
    join(root, 'node_modules/better-sqlite3/build'),
  ]
  for (const dir of dirs) {
    if (existsSync(dir)) {
      log(`removing stale build: ${dir}`)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function electronRebuild(moduleName) {
  log(`electron-rebuild -f -o ${moduleName}`)
  const bin = join(root, 'node_modules/.bin/electron-rebuild')
  const cmd = existsSync(bin) ? bin : 'electron-rebuild'
  run(cmd, ['-f', '-o', moduleName])
}

export function main() {
  if (isProductionOnlyInstall()) {
    log('dev dependencies omitted; skipping Electron source-build compatibility and native rebuild')
    return
  }

  const braceExpansionPatch = join(root, 'scripts/patch-brace-expansion-compat.mjs')
  run(process.execPath, [braceExpansionPatch])

  const patch = join(root, 'scripts/patch-node-pty-win.js')
  if (existsSync(patch)) {
    run(process.execPath, [patch])
  }

  ensureNodeGyp()
  cleanStaleNativeBuilds()
  electronRebuild('better-sqlite3')
  electronRebuild('node-pty')
  log('done')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main()
  } catch (err) {
    console.error('[rebuild-natives] FAILED')
    console.error(err?.message || err)
    process.exit(typeof err?.code === 'number' ? err.code : 1)
  }
}
