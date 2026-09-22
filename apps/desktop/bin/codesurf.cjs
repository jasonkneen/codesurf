#!/usr/bin/env node

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')

const APP_NAME = 'codesurf'
const APP_DIR = path.join(__dirname, '..')
const CACHE_DIR = process.env.CODESURF_HOME?.trim() || path.join(os.homedir(), '.codesurf')
const LEGACY_CACHE_DIR = path.join(os.homedir(), '.contex')
const ELECTRON_CACHE = path.join(CACHE_DIR, 'electron')
const UPDATE_CHECK_FILE = path.join(CACHE_DIR, 'last-update-check')
const PID_FILE = path.join(CACHE_DIR, 'codesurf.pid')
const PERMISSIONS_FILE = path.join(CACHE_DIR, 'permissions.json')
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000
const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 8192
const PERMISSIONS_VERSION = 1

function getMaxOldSpaceSizeMb() {
  const raw = process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OLD_SPACE_SIZE_MB
}

// ---------------------------------------------------------------------------
// Permission store
// ---------------------------------------------------------------------------

function normalizeWorkspaceDir(workspaceDir) {
  const trimmed = String(workspaceDir ?? '').trim()
  if (!trimmed) return null
  try {
    return path.resolve(trimmed)
  } catch {
    return trimmed
  }
}

function normalizeScope(scope, action) {
  const normalized = String(scope ?? '').trim().toLowerCase()
  const aliases = {
    always: 'forever',
    alltime: 'forever',
    'all-time': 'forever',
    day: 'today',
    allday: 'today',
    'all-day': 'today',
    no: 'never',
    deny: 'never',
  }
  const value = aliases[normalized] || normalized || (action === 'deny' ? 'never' : 'forever')
  if (action === 'deny') {
    if (value !== 'never') {
      throw new Error('Deny grants can only use --scope never')
    }
    return 'never'
  }
  if (value === 'session') {
    throw new Error('Session grants are process-local and cannot be set from the CLI. Use --scope today or --scope forever.')
  }
  if (value !== 'today' && value !== 'forever') {
    throw new Error('Allow grants from the CLI must use --scope today or --scope forever')
  }
  return value
}

function normalizePermissionGrant(grant) {
  if (!grant || typeof grant !== 'object') return null
  if (typeof grant.id !== 'string' || !grant.id) return null
  if (typeof grant.provider !== 'string' || !grant.provider) return null
  if (typeof grant.toolName !== 'string' || !grant.toolName) return null
  if (grant.action !== 'allow' && grant.action !== 'deny') return null
  if (!['session', 'today', 'forever', 'never'].includes(grant.scope)) return null
  if (typeof grant.createdAt !== 'string') return null
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt)
    if (Number.isFinite(expiry) && expiry <= Date.now()) return null
  }
  return {
    id: grant.id,
    provider: grant.provider,
    toolName: grant.toolName,
    action: grant.action,
    scope: grant.scope,
    workspaceDir: normalizeWorkspaceDir(grant.workspaceDir),
    title: typeof grant.title === 'string' ? grant.title : null,
    description: typeof grant.description === 'string' ? grant.description : null,
    blockedPath: typeof grant.blockedPath === 'string' ? grant.blockedPath : null,
    createdAt: grant.createdAt,
    expiresAt: typeof grant.expiresAt === 'string' ? grant.expiresAt : null,
  }
}

function readPermissionStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf8'))
    const grants = Array.isArray(raw?.grants)
      ? raw.grants.map(normalizePermissionGrant).filter(Boolean)
      : []
    return { version: PERMISSIONS_VERSION, grants }
  } catch {
    return { version: PERMISSIONS_VERSION, grants: [] }
  }
}

function writePermissionStore(store) {
  ensureCacheDir()
  const tempPath = `${PERMISSIONS_FILE}.${process.pid}.${Date.now()}.tmp`
  let replaced = false
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify({ version: PERMISSIONS_VERSION, grants: store.grants }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    fs.renameSync(tempPath, PERMISSIONS_FILE)
    replaced = true
    fs.chmodSync(PERMISSIONS_FILE, 0o600)
  } finally {
    if (!replaced && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
}

function makePermissionId() {
  return `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function endOfTodayIso() {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}

function permissionMatches(grant, provider, toolName, workspaceDir) {
  return grant.provider === provider
    && grant.toolName === toolName
    && (grant.workspaceDir ?? null) === (workspaceDir ?? null)
}

function parsePermissionOptions(argv) {
  const options = {
    json: false,
    action: null,
    scope: null,
    workspaceDir: process.cwd(),
    title: null,
    description: null,
    blockedPath: null,
  }
  const positional = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const nextValue = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[index]
    }

    switch (arg) {
      case '--all':
        options.all = true
        break
      case '--json':
        options.json = true
        break
      case '--action':
        options.action = nextValue()
        break
      case '--scope':
        options.scope = nextValue()
        break
      case '--workspace':
      case '--cwd':
        options.workspaceDir = nextValue()
        break
      case '--global':
        options.workspaceDir = null
        break
      case '--title':
        options.title = nextValue()
        break
      case '--description':
        options.description = nextValue()
        break
      case '--blocked-path':
      case '--path':
        options.blockedPath = nextValue()
        break
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
        positional.push(arg)
        break
    }
  }

  return { positional, options }
}

function printPermissionHelp() {
  console.log(`
CodeSurf permissions

Usage:
  codesurf permissions list [--json]
  codesurf permissions path
  codesurf permissions allow <provider> <tool> [--scope today|forever] [--workspace <path>|--global]
  codesurf permissions deny <provider> <tool> [--workspace <path>|--global]
  codesurf permissions set <provider> <tool> --action allow|deny [--scope today|forever|never] [--workspace <path>|--global]
  codesurf permissions clear <grant-id>
  codesurf permissions clear --all

Defaults:
  --workspace defaults to the current directory.
  allow defaults to --scope forever.
  deny always writes a persistent "never" grant.

Store: ${PERMISSIONS_FILE}
`)
}

function formatPermissionGrant(grant) {
  const action = grant.action === 'deny' ? 'deny' : 'allow'
  const scope = grant.scope === 'forever' ? 'all time' : grant.scope
  const workspace = grant.workspaceDir ?? '(global)'
  const expiry = grant.expiresAt ? ` expires ${grant.expiresAt}` : ''
  return `${grant.id}  ${action.padEnd(5)}  ${scope.padEnd(8)}  ${grant.provider}/${grant.toolName}  ${workspace}${expiry}`
}

function outputPermissionResult(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
  }
}

function setPermissionGrant({ provider, toolName, action, scope, workspaceDir, title, description, blockedPath }) {
  const normalizedAction = action === 'deny' ? 'deny' : 'allow'
  const normalizedScope = normalizeScope(scope, normalizedAction)
  const normalizedWorkspace = normalizeWorkspaceDir(workspaceDir)
  const grant = {
    id: makePermissionId(),
    provider,
    toolName,
    action: normalizedAction,
    scope: normalizedScope,
    workspaceDir: normalizedWorkspace,
    title: title || null,
    description: description || null,
    blockedPath: blockedPath || null,
    createdAt: new Date().toISOString(),
    expiresAt: normalizedScope === 'today' ? endOfTodayIso() : null,
  }
  const store = readPermissionStore()
  const grants = store.grants.filter(existing => !permissionMatches(existing, provider, toolName, normalizedWorkspace))
  const next = { version: PERMISSIONS_VERSION, grants: [grant, ...grants] }
  writePermissionStore(next)
  return grant
}

function handlePermissionsCommand(argv) {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printPermissionHelp()
    return
  }

  if (command === 'path') {
    console.log(PERMISSIONS_FILE)
    return
  }

  if (command === 'list') {
    const { options } = parsePermissionOptions(argv.slice(1))
    const result = { path: PERMISSIONS_FILE, grants: readPermissionStore().grants }
    if (options.json) {
      outputPermissionResult(result, true)
      return
    }
    console.log(`Store: ${PERMISSIONS_FILE}`)
    if (result.grants.length === 0) {
      console.log('No permission grants.')
      return
    }
    for (const grant of result.grants) console.log(formatPermissionGrant(grant))
    return
  }

  if (command === 'clear') {
    const { positional, options } = parsePermissionOptions(argv.slice(1))
    const clearAll = argv.includes('--all')
    if (clearAll) {
      const next = { version: PERMISSIONS_VERSION, grants: [] }
      writePermissionStore(next)
      outputPermissionResult({ path: PERMISSIONS_FILE, grants: [] }, options.json)
      if (!options.json) console.log('Cleared all permission grants.')
      return
    }
    const id = positional[0]
    if (!id) throw new Error('clear requires a grant id or --all')
    const store = readPermissionStore()
    const next = { version: PERMISSIONS_VERSION, grants: store.grants.filter(grant => grant.id !== id) }
    writePermissionStore(next)
    outputPermissionResult({ path: PERMISSIONS_FILE, grants: next.grants }, options.json)
    if (!options.json) console.log(next.grants.length === store.grants.length ? `No grant found for ${id}` : `Cleared ${id}.`)
    return
  }

  if (command === 'allow' || command === 'deny' || command === 'set') {
    const { positional, options } = parsePermissionOptions(argv.slice(1))
    const provider = positional[0]?.trim()
    const toolName = positional[1]?.trim()
    if (!provider || !toolName) throw new Error(`${command} requires <provider> and <tool>`)
    const action = command === 'set'
      ? String(options.action ?? '').trim().toLowerCase()
      : command
    if (action !== 'allow' && action !== 'deny') throw new Error('set requires --action allow or --action deny')
    const grant = setPermissionGrant({
      provider,
      toolName,
      action,
      scope: options.scope,
      workspaceDir: options.workspaceDir,
      title: options.title,
      description: options.description,
      blockedPath: options.blockedPath,
    })
    outputPermissionResult({ path: PERMISSIONS_FILE, grant, grants: readPermissionStore().grants }, options.json)
    if (!options.json) {
      console.log(`Saved ${grant.action} grant: ${formatPermissionGrant(grant)}`)
    }
    return
  }

  throw new Error(`Unknown permissions command: ${command}`)
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

function migrateLegacyData() {
  if (!fs.existsSync(LEGACY_CACHE_DIR)) return

  const filesToMigrate = ['workspaces']
  filesToMigrate.forEach(file => {
    const legacyPath = path.join(LEGACY_CACHE_DIR, file)
    const newPath = path.join(CACHE_DIR, file)
    if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
      // Copy directories recursively
      if (fs.statSync(legacyPath).isDirectory()) {
        fs.cpSync(legacyPath, newPath, { recursive: true })
      } else {
        fs.copyFileSync(legacyPath, newPath)
      }
      console.log(`Migrated ${file} from ~/.contex to ~/.codesurf`)
    }
  })
}

// ---------------------------------------------------------------------------
// Cache directory
// ---------------------------------------------------------------------------

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
  }
  fs.chmodSync(CACHE_DIR, 0o700)
  migrateLegacyData()
  if (!fs.existsSync(ELECTRON_CACHE)) {
    fs.mkdirSync(ELECTRON_CACHE, { recursive: true })
  }
}

// ---------------------------------------------------------------------------
// Electron binary management
// ---------------------------------------------------------------------------

function getElectronPath() {
  const platform = os.platform()
  const electronBin = platform === 'win32' ? 'electron.cmd' : 'electron'
  return path.join(ELECTRON_CACHE, 'node_modules', '.bin', electronBin)
}

function getNpmCommand() {
  return os.platform() === 'win32' ? 'npm.cmd' : 'npm'
}

async function ensureElectron() {
  ensureCacheDir()

  const electronPath = getElectronPath()

  // Check if electron is already cached
  if (fs.existsSync(electronPath)) {
    return electronPath
  }

  console.log('Installing Electron (first run only)...')
  console.log(`  Cache location: ${ELECTRON_CACHE}`)

  try {
    // Create a minimal package.json for electron installation
    const pkgPath = path.join(ELECTRON_CACHE, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'codesurf-electron-cache',
      version: '1.0.0',
      private: true
    }))

    // Install electron to cache directory
    const npm = getNpmCommand()
    execFileSync(npm, ['install', 'electron@latest', '--no-save', '--no-audit', '--no-fund'], {
      cwd: ELECTRON_CACHE,
      stdio: 'inherit'
    })

    console.log('Electron installed successfully!\n')
    return electronPath
  } catch (error) {
    console.error('Failed to install Electron:', error.message)
    console.error('\nTry installing manually:')
    console.error(`  cd ${ELECTRON_CACHE} && npm install electron`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Native module rebuilding
// ---------------------------------------------------------------------------

async function ensureNativeModules(electronPath) {
  const rebuildMarker = path.join(CACHE_DIR, '.natives-rebuilt')
  const appNodeModules = path.join(APP_DIR, 'node_modules')

  // Skip if already rebuilt or no node_modules
  if (fs.existsSync(rebuildMarker) || !fs.existsSync(appNodeModules)) return

  console.log('Rebuilding native modules for Electron (first run only)...')

  try {
    const npm = getNpmCommand()
    execFileSync(npm, ['rebuild', 'node-pty', 'better-sqlite3'], {
      cwd: APP_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_runtime: 'electron',
        npm_config_target: getElectronVersion(),
        npm_config_disturl: 'https://electronjs.org/headers'
      }
    })
    fs.writeFileSync(rebuildMarker, Date.now().toString())
  } catch (err) {
    console.error('Native module rebuild warning:', err.message)
    // Non-fatal — app may still work without pty/sqlite
  }
}

function getElectronVersion() {
  try {
    const electronPkg = path.join(ELECTRON_CACHE, 'node_modules', 'electron', 'package.json')
    if (fs.existsSync(electronPkg)) {
      return JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version
    }
  } catch {}
  return 'latest'
}

// ---------------------------------------------------------------------------
// Version management
// ---------------------------------------------------------------------------

function getCurrentVersion() {
  try {
    const pkgPath = path.join(APP_DIR, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return pkg.version
  } catch {
    return null
  }
}

function getDaemonPackageVersion() {
  try {
    const pkg = require('@codesurf/daemon/package.json')
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.1.0'
  } catch {
    return '0.1.0'
  }
}

async function handleChatCommand(argv) {
  const { runCodesurfChatCli } = await import('@codesurf/daemon/chat-cli')
  return await runCodesurfChatCli(argv, {
    appDir: APP_DIR,
    homeDir: CACHE_DIR,
    getAppVersion: () => process.env.CODESURF_DAEMON_VERSION_PIN?.trim() || getDaemonPackageVersion(),
  })
}

function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(`https://registry.npmjs.org/${APP_NAME}/latest`, {
      headers: { 'Accept': 'application/json' },
      timeout: 5000
    }, (res) => {
      if (res.statusCode !== 200) {
        resolve(null)
        return
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const pkg = JSON.parse(data)
          resolve(pkg.version)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function shouldCheckForUpdates() {
  try {
    if (!fs.existsSync(UPDATE_CHECK_FILE)) return true
    const lastCheck = parseInt(fs.readFileSync(UPDATE_CHECK_FILE, 'utf8'), 10)
    return Date.now() - lastCheck > UPDATE_CHECK_INTERVAL
  } catch {
    return true
  }
}

function recordUpdateCheck() {
  try {
    ensureCacheDir()
    fs.writeFileSync(UPDATE_CHECK_FILE, Date.now().toString())
  } catch {}
}

function compareVersions(current, latest) {
  if (!current || !latest) return 0
  const c = current.split('.').map(Number)
  const l = latest.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return 1
    if ((l[i] || 0) < (c[i] || 0)) return -1
  }
  return 0
}

async function checkForUpdates() {
  if (!shouldCheckForUpdates()) return

  const current = getCurrentVersion()
  const latest = await fetchLatestVersion()
  recordUpdateCheck()

  if (compareVersions(current, latest) > 0) {
    console.log(`\nUpdate available: v${current} -> v${latest}`)
    console.log(`   Run: npx codesurf@latest`)
    console.log(`   Or:  npm install -g codesurf@latest\n`)
  }
}

async function performUpdate() {
  const current = getCurrentVersion()
  const latest = await fetchLatestVersion()

  if (!latest) {
    console.log('Could not check for updates (network error)')
    return false
  }

  if (compareVersions(current, latest) <= 0) {
    console.log(`Already on latest version (v${current})`)
    return false
  }

  console.log(`\nUpdating codesurf: v${current} -> v${latest}...\n`)

  try {
    const npm = getNpmCommand()
    execFileSync(npm, ['install', '-g', `codesurf@${latest}`], { stdio: 'inherit' })
    console.log(`\nUpdated to v${latest}`)
    console.log('  Run codesurf again to use the new version.\n')
    return true
  } catch (error) {
    console.error('Update failed:', error.message)
    console.error(`  Try manually: npm install -g codesurf@latest`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Build check
// ---------------------------------------------------------------------------

function checkBuilt() {
  const indexHtml = path.join(APP_DIR, 'dist-electron', 'renderer', 'index.html')
  const mainJs = path.join(APP_DIR, 'dist-electron', 'main', 'index.js')

  if (!fs.existsSync(indexHtml) || !fs.existsSync(mainJs)) {
    console.error('App not built. dist-electron/ not found.')
    console.error('\nIf you cloned from source, run:')
    console.error('  npm install && npm run build')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// PID management (single instance)
// ---------------------------------------------------------------------------

function writePidFile(pid) {
  try {
    ensureCacheDir()
    fs.writeFileSync(PID_FILE, pid.toString())
  } catch {}
}

function readPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10)
    }
  } catch {}
  return null
}

function clearPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE)
    }
  } catch {}
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function stopRunningInstance() {
  const pid = readPidFile()
  if (pid && isProcessRunning(pid)) {
    console.log(`Stopping existing instance (PID: ${pid})...`)
    try {
      process.kill(pid, 'SIGTERM')
      clearPidFile()
      return true
    } catch {}
  }
  clearPidFile()
  return false
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

async function launch() {
  try {
    console.log(`\nStarting CodeSurf...\n`)

    checkForUpdates()
    checkBuilt()
    const electronPath = await ensureElectron()
    const jsFlags = `--expose-gc --max-old-space-size=${getMaxOldSpaceSizeMb()}`

    // Launch Electron with the app
    const child = spawn(electronPath, [`--js-flags=${jsFlags}`, APP_DIR], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    })

    writePidFile(child.pid)

    child.on('exit', (code) => {
      clearPidFile()
      process.exit(code || 0)
    })

    child.on('error', (err) => {
      console.error('Failed to start Electron:', err.message)
      clearPidFile()
      process.exit(1)
    })

    // Handle signals
    process.on('SIGINT', () => {
      child.kill('SIGINT')
      clearPidFile()
    })
    process.on('SIGTERM', () => {
      child.kill('SIGTERM')
      clearPidFile()
    })

  } catch (error) {
    console.error('Failed to launch CodeSurf:', error.message)
    clearPidFile()
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

if (args[0] === 'permissions' || args[0] === 'permission') {
  try {
    handlePermissionsCommand(args.slice(1))
    process.exit(0)
  } catch (error) {
    console.error(`codesurf permissions: ${error.message}`)
    console.error('Run `codesurf permissions --help` for usage.')
    process.exit(1)
  }
}

if (args[0] === 'chat') {
  handleChatCommand(args.slice(1))
    .then(code => process.exit(code))
    .catch(error => {
      console.error(`codesurf chat: ${error.message}`)
      console.error('Run `codesurf chat --help` for usage.')
      process.exit(1)
    })
} else if (args.includes('--help') || args.includes('-h')) {
  const version = getCurrentVersion() || 'unknown'
  console.log(`
CodeSurf v${version} - Infinite canvas workspace for AI agents

Usage:
  npx codesurf            Launch the app
  npx codesurf chat       Chat with the local CodeSurf daemon
  npx codesurf permissions Manage remembered tool permissions
  npx codesurf --update   Check for and install updates
  npx codesurf --version  Show current version
  npx codesurf --clean    Clear cached Electron installation
  npx codesurf --help     Show this help message

Cache location: ${CACHE_DIR}
`)
  process.exit(0)
} else if (args.includes('--version') || args.includes('-v')) {
  const version = getCurrentVersion() || 'unknown'
  console.log(`codesurf v${version}`)
  process.exit(0)
} else if (args.includes('--update') || args.includes('-u')) {
  performUpdate().then(updated => {
    process.exit(updated ? 0 : 1)
  })
} else if (args.includes('--clean')) {
  console.log('Cleaning Electron cache...')
  if (fs.existsSync(ELECTRON_CACHE)) {
    fs.rmSync(ELECTRON_CACHE, { recursive: true })
    console.log('Cache cleared')
  } else {
    console.log('Cache already empty')
  }
  process.exit(0)
} else {
  launch()
}
