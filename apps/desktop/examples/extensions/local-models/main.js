const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')

const EXT_ID = 'local-models'
const APP_HOME = path.join(os.homedir(), '.codesurf')
const SETTINGS_PATH = path.join(APP_HOME, 'extension-settings', `${EXT_ID}.json`)

const DEFAULT_CONFIG = {
  command: 'ollama',
  args: ['serve'],
  basePort: 11435,
  healthPath: '/api/tags',
  modelsDir: '',
}

function parseArgs(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  }
  const source = String(value ?? '').trim()
  if (!source) return []
  const matches = source.match(/"[^"]*"|'[^']*'|\S+/g) || []
  return matches
    .map((part) => part.replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean)
}

function normalizeConfig(raw) {
  const basePort = Number(raw?.basePort)
  const normalizedHealthPath = String(raw?.healthPath ?? DEFAULT_CONFIG.healthPath).trim() || DEFAULT_CONFIG.healthPath
  return {
    command: String(raw?.command ?? DEFAULT_CONFIG.command).trim() || DEFAULT_CONFIG.command,
    args: parseArgs(raw?.args ?? DEFAULT_CONFIG.args),
    basePort: Number.isFinite(basePort) && basePort > 0 ? Math.floor(basePort) : DEFAULT_CONFIG.basePort,
    healthPath: normalizedHealthPath.startsWith('/') ? normalizedHealthPath : `/${normalizedHealthPath}`,
    modelsDir: String(raw?.modelsDir ?? '').trim(),
  }
}

async function loadConfig(homeDir = APP_HOME) {
  try {
    const raw = await fs.readFile(path.join(homeDir, 'extension-settings', `${EXT_ID}.json`), 'utf8')
    return normalizeConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

async function writeConfig(partial, homeDir = APP_HOME) {
  const current = await loadConfig(homeDir)
  const next = normalizeConfig({ ...current, ...(partial || {}) })
  await fs.mkdir(path.join(homeDir, 'extension-settings'), { recursive: true })
  await fs.writeFile(path.join(homeDir, 'extension-settings', `${EXT_ID}.json`), JSON.stringify({
    command: next.command,
    args: next.args.join(' '),
    basePort: next.basePort,
    healthPath: next.healthPath,
    modelsDir: next.modelsDir,
  }, null, 2))
  return next
}

function findAvailablePort(startPort, maxAttempts = 50) {
  return new Promise((resolve, reject) => {
    let candidate = Number(startPort)
    let attempts = 0

    const tryNext = () => {
      if (attempts >= maxAttempts) {
        reject(new Error(`Unable to find free port near ${startPort}`))
        return
      }
      attempts += 1
      const server = net.createServer()
      server.unref()
      server.once('error', () => {
        candidate += 1
        tryNext()
      })
      server.listen(candidate, '127.0.0.1', () => {
        server.close(() => resolve(candidate))
      })
    }

    tryNext()
  })
}

function isAbsoluteDir(dirPath) {
  return typeof dirPath === 'string' && dirPath.trim().length > 1 && path.isAbsolute(dirPath)
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createDaemonController(ctx) {
  let child = null
  let healthTimer = null
  let lastError = null
  let currentConfig = null
  let currentHost = null
  let currentPort = null
  let currentWorkspacePath = null
  let healthy = false
  let stopping = false
  let selectedModel = null

  function getStatus() {
    return {
      running: Boolean(child && child.exitCode === null),
      healthy,
      host: currentHost,
      port: currentPort,
      pid: child && child.exitCode === null ? child.pid : null,
      selectedModel,
      lastError,
      config: currentConfig,
      workspacePath: currentWorkspacePath,
    }
  }

  function publishStatus(type = 'status') {
    try {
      ctx.bus.publish('local-models', type, getStatus())
    } catch {}
  }

  async function probeHealth(host, healthPath) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await fetch(`${host}${healthPath}`, { signal: controller.signal })
      clearTimeout(timer)
      return response.ok
    } catch {
      clearTimeout(timer)
      return false
    }
  }

  function stopHealthPolling() {
    if (healthTimer) {
      clearInterval(healthTimer)
      healthTimer = null
    }
  }

  function startHealthPolling() {
    stopHealthPolling()
    if (!currentHost || !currentConfig) return
    healthTimer = setInterval(async () => {
      const nextHealthy = await probeHealth(currentHost, currentConfig.healthPath)
      if (healthy !== nextHealthy) {
        healthy = nextHealthy
        if (nextHealthy) lastError = null
        publishStatus('health')
      }
    }, 5000)
  }

  async function stopDaemon() {
    stopping = true
    stopHealthPolling()
    healthy = false

    if (child && child.exitCode === null) {
      const proc = child
      proc.kill('SIGTERM')
      await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        delay(1500).then(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL')
        }),
      ])
    }

    child = null
    publishStatus('stopped')
    return getStatus()
  }

  async function startDaemon(options = {}) {
    const config = await loadConfig()
    currentConfig = config
    currentWorkspacePath = isAbsoluteDir(options.workspacePath) ? options.workspacePath : null

    if (!config.command) {
      lastError = 'Set a daemon command before starting local models.'
      publishStatus('status')
      return getStatus()
    }

    if (child && child.exitCode === null) {
      return getStatus()
    }

    currentPort = await findAvailablePort(config.basePort)
    currentHost = `http://127.0.0.1:${currentPort}`
    healthy = false
    lastError = null
    stopping = false

    const env = {
      ...process.env,
    }

    if (config.command.toLowerCase().includes('ollama')) {
      env.OLLAMA_HOST = `127.0.0.1:${currentPort}`
      if (config.modelsDir) env.OLLAMA_MODELS = config.modelsDir
    }

    const spawnArgs = config.args.slice()
    const cwd = currentWorkspacePath && await pathExists(currentWorkspacePath) ? currentWorkspacePath : process.cwd()

    child = spawn(config.command, spawnArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout?.on('data', (data) => ctx.log(`[local-models] ${String(data).trim()}`))
    child.stderr?.on('data', (data) => ctx.log(`[local-models:err] ${String(data).trim()}`))
    child.on('error', (error) => {
      lastError = error.message
      healthy = false
      publishStatus('error')
    })
    child.on('exit', () => {
      const wasStopping = stopping
      child = null
      healthy = false
      if (!wasStopping) {
        lastError = lastError || 'Daemon exited unexpectedly.'
      }
      stopping = false
      publishStatus(wasStopping ? 'stopped' : 'error')
    })

    startHealthPolling()

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!child || child.exitCode !== null) break
      if (await probeHealth(currentHost, config.healthPath)) {
        healthy = true
        lastError = null
        publishStatus('started')
        return getStatus()
      }
      await delay(500)
    }

    lastError = `Daemon did not become healthy at ${currentHost}${config.healthPath}`
    publishStatus('status')
    return getStatus()
  }

  async function getConfig() {
    currentConfig = await loadConfig()
    return currentConfig
  }

  async function setConfig(partial) {
    currentConfig = await writeConfig(partial)
    publishStatus('config')
    return currentConfig
  }

  async function setSelectedModel(model) {
    selectedModel = model || null
    publishStatus('selection')
    return getStatus()
  }

  function cleanup() {
    stopHealthPolling()
    if (child && child.exitCode === null) {
      stopping = true
      child.kill('SIGTERM')
    }
  }

  return {
    getStatus,
    getConfig,
    setConfig,
    startDaemon,
    stopDaemon,
    setSelectedModel,
    cleanup,
  }
}

module.exports = {
  activate(ctx) {
    ctx.log('Local Models backend activated')
    const controller = createDaemonController(ctx)

    ctx.ipc.handle('getStatus', async () => controller.getStatus())
    ctx.ipc.handle('getConfig', async () => controller.getConfig())
    ctx.ipc.handle('setConfig', async (partial) => controller.setConfig(partial))
    ctx.ipc.handle('startDaemon', async (options) => controller.startDaemon(options || {}))
    ctx.ipc.handle('stopDaemon', async () => controller.stopDaemon())
    ctx.ipc.handle('setSelectedModel', async (model) => controller.setSelectedModel(model))

    return () => {
      controller.cleanup()
      ctx.log('Local Models backend deactivated')
    }
  },
  __testing: {
    DEFAULT_CONFIG,
    parseArgs,
    normalizeConfig,
    loadConfig,
    writeConfig,
    findAvailablePort,
  },
}
