import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createDaemonManager } from '@codesurf/daemon/manager'
import { runIsolatedElectronCleanup, withCleanupTimeout } from './cleanup-steps'
import { resolveElectronExecutable } from './electron-path'

const REPO_ROOT = join(__dirname, '../..')
const MAIN_ENTRY = join(REPO_ROOT, 'dist-electron/main/index.js')
const DAEMON_ENTRY = join(REPO_ROOT, 'bin/codesurfd.mjs')
const APP_CLOSE_TIMEOUT_MS = 30_000
const APP_PROCESS_EXIT_TIMEOUT_MS = 5_000
const DAEMON_STOP_TIMEOUT_MS = 10_000
const HOME_REMOVE_MAX_RETRIES = 10
const HOME_REMOVE_RETRY_DELAY_MS = 100
const E2E_AGENT_IDS = [
  'claude',
  'codex',
  'opencode',
  'openclaw',
  'hermes',
  'cursor-agent',
  'gemini',
  'cline',
  'amp',
  'kilo',
] as const
type E2EAgentId = typeof E2E_AGENT_IDS[number]

export interface LaunchedElectronApp {
  app: ElectronApplication
  page: Page
  homeDir: string
  process: ReturnType<ElectronApplication['process']>
}

export type LaunchCodeSurfOptions = {
  seedSettings?: Record<string, unknown>
  agentScripts?: Partial<Record<E2EAgentId, string>>
}

async function waitForProcessExit(
  process: ReturnType<ElectronApplication['process']>,
  timeoutMs: number,
): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return true
  return await new Promise<boolean>(resolve => {
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      process.off('exit', onExit)
      resolve(process.exitCode !== null || process.signalCode !== null)
    }, timeoutMs)
    process.once('exit', onExit)
  })
}

async function terminateElectronProcess(
  process: ReturnType<ElectronApplication['process']>,
): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return
  process.kill('SIGTERM')
  if (await waitForProcessExit(process, APP_PROCESS_EXIT_TIMEOUT_MS)) return
  process.kill('SIGKILL')
  if (!(await waitForProcessExit(process, APP_PROCESS_EXIT_TIMEOUT_MS))) {
    throw new Error(`Electron E2E process ${process.pid ?? 'unknown'} did not exit`)
  }
}

async function closeElectronApplication(app: ElectronApplication): Promise<void> {
  const process = app.process()
  try {
    await withCleanupTimeout(app.close(), APP_CLOSE_TIMEOUT_MS, 'Electron E2E app close')
  } catch (error) {
    await terminateElectronProcess(process)
    throw error
  }
}

async function stopIsolatedDaemon(homeDir: string): Promise<void> {
  const manager = createDaemonManager({
    homeDir: join(homeDir, '.codesurf'),
    getAppVersion: () => 'e2e-cleanup',
    resolveDaemonScriptPath: () => DAEMON_ENTRY,
  })
  await withCleanupTimeout(manager.stopDaemon(), DAEMON_STOP_TIMEOUT_MS, 'Electron E2E daemon stop')
  const status = await manager.getDaemonStatus()
  if (status.running) {
    throw new Error(`Electron E2E daemon ${status.info?.pid ?? 'unknown'} is still running`)
  }
}

async function cleanupLaunch(
  app: ElectronApplication | null,
  process: ReturnType<ElectronApplication['process']> | null,
  homeDir: string,
): Promise<void> {
  let processForCleanup = process
  if (!processForCleanup && app) {
    try {
      processForCleanup = app.process()
    } catch {
      // Launch failed before Playwright exposed the process handle.
    }
  }
  await runIsolatedElectronCleanup({
    homeDir,
    // Routine cleanup is intentionally forceful. The dedicated quit helper
    // below is the one place that exercises graceful persistence shutdown.
    closeApp: processForCleanup
      ? () => terminateElectronProcess(processForCleanup)
      : undefined,
    stopDaemon: () => stopIsolatedDaemon(homeDir),
    // Chromium helpers can finish flushing the isolated profile just after the
    // Electron parent exits. Keep cleanup bounded, but tolerate that brief
    // ENOTEMPTY/EBUSY window instead of making otherwise-green E2E runs flaky.
    removeHome: () => rm(homeDir, {
      recursive: true,
      force: true,
      maxRetries: HOME_REMOVE_MAX_RETRIES,
      retryDelay: HOME_REMOVE_RETRY_DELAY_MS,
    }),
  })
}

export async function launchCodeSurfElectron(options?: LaunchCodeSurfOptions): Promise<LaunchedElectronApp> {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-e2e-home-'))
  let app: ElectronApplication | null = null
  let appProcess: ReturnType<ElectronApplication['process']> | null = null
  try {
    const codesurfHome = join(homeDir, '.codesurf')
    const userDataDir = join(homeDir, 'electron-user-data')
    await mkdir(codesurfHome, { recursive: true })
    await mkdir(userDataDir, { recursive: true })
    const canonicalUserDataDir = await realpath(userDataDir)
    const now = new Date().toISOString()
    const seededAgentPaths = new Map<E2EAgentId, string>()
    const agentScripts = options?.agentScripts ?? {}
    if (Object.keys(agentScripts).length > 0) {
      const agentBinDir = join(homeDir, 'e2e-agents')
      await mkdir(agentBinDir, { recursive: true })
      for (const id of E2E_AGENT_IDS) {
        const script = agentScripts[id]
        if (typeof script !== 'string') continue
        const scriptPath = join(agentBinDir, id)
        await writeFile(scriptPath, script, { mode: 0o755 })
        seededAgentPaths.set(id, scriptPath)
      }
    }

    await writeFile(
      join(codesurfHome, 'agent-paths.json'),
      JSON.stringify({
        shellPath: process.env.PATH ?? null,
        updatedAt: now,
        ...Object.fromEntries(E2E_AGENT_IDS.map(id => [
          id,
          {
            path: seededAgentPaths.get(id) ?? null,
            version: seededAgentPaths.has(id) ? 'e2e-fixture' : null,
            detectedAt: now,
            confirmed: true,
          },
        ])),
      }, null, 2),
    )

    await writeFile(
      join(codesurfHome, 'settings.json'),
      JSON.stringify({
        version: 1,
        settings: {
          onboardingComplete: true,
          ...options?.seedSettings,
        },
      }, null, 2),
    )

    app = await electron.launch({
      executablePath: resolveElectronExecutable(REPO_ROOT),
      cwd: REPO_ROOT,
      args: [`--user-data-dir=${canonicalUserDataDir}`, MAIN_ENTRY],
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODESURF_E2E: '1',
      },
      timeout: 60_000,
    })
    appProcess = app.process()

    const activeUserDataDir = await app.evaluate(({ app: electronApp }) => (
      electronApp.getPath('userData')
    ))
    if (
      resolve(await realpath(activeUserDataDir))
      !== resolve(canonicalUserDataDir)
    ) {
      throw new Error(
        `Electron E2E userData escaped isolation: ${activeUserDataDir}`,
      )
    }

    const page = await app.firstWindow({ timeout: 45_000 })
    await page.waitForLoadState('domcontentloaded')

    return { app, page, homeDir, process: appProcess }
  } catch (error) {
    try {
      await cleanupLaunch(app, appProcess, homeDir)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Electron E2E launch and cleanup failed')
    }
    throw error
  }
}

export async function closeCodeSurfElectron(launch: LaunchedElectronApp): Promise<void> {
  await cleanupLaunch(launch.app, launch.process, launch.homeDir)
}

export async function quitCodeSurfElectron(launch: LaunchedElectronApp): Promise<void> {
  await closeElectronApplication(launch.app)
}
