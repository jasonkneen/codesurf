import {
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build, type Plugin } from 'esbuild'
import { MAX_EXTENSION_TEXT_RESOURCE_BYTES } from '../src/main/extensions/resource-path.ts'

const projectRoot = resolve(process.cwd())
const projectRequire = createRequire(join(projectRoot, 'package.json'))
// The monorepo's shared daemon package, two levels up from apps/desktop.
const localDaemonRoot = realpathSync(join(projectRoot, '..', '..', 'packages', 'codesurf-daemon'))
const resolvedDaemonManifest = realpathSync(
  projectRequire.resolve('@codesurf/daemon/package.json'),
)

assert.equal(
  resolvedDaemonManifest,
  join(localDaemonRoot, 'package.json'),
  '@codesurf/daemon must resolve from this checkout, not another worktree',
)

const hermeticDependencies: Plugin = {
  name: 'hermetic-dependencies',
  setup(builder) {
    builder.onResolve({ filter: /^@codesurf\/daemon(?:\/|$)/ }, args => {
      const resolvedPath = realpathSync(projectRequire.resolve(args.path))
      assert.ok(
        resolvedPath === localDaemonRoot || resolvedPath.startsWith(`${localDaemonRoot}${sep}`),
        `${args.path} resolved outside this checkout: ${resolvedPath}`,
      )
      return { path: resolvedPath }
    })
    builder.onResolve({ filter: /^(better-sqlite3|node-pty)$/ }, args => ({
      // Native packages cannot be safely rewritten into an ESM fixture. Keep
      // the current checkout's installed native entry external and absolute.
      path: realpathSync(projectRequire.resolve(args.path)),
      external: true,
    }))
  },
}

const nativeDependencyStub: Plugin = {
  name: 'native-dependency-stub',
  setup(builder) {
    builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
      path: 'better-sqlite3',
      namespace: 'native-dependency-stub',
    }))
    builder.onLoad({ filter: /.*/, namespace: 'native-dependency-stub' }, () => ({
      // The extension-loading surface never opens provider session databases.
      // Stub the eager session-source import so these focused tests do not
      // bundle a native CommonJS addon into an ESM fixture.
      contents: 'export default class BetterSqlite3TestStub {}',
      loader: 'js',
    }))
  },
}

async function loadRegistryModule(codesurfHome: string) {
  const bundleDir = await mkdtemp(join(tmpdir(), 'codesurf-registry-test-'))
  const outfile = join(bundleDir, 'registry.mjs')
  const electronStub: Plugin = {
    name: 'electron-stub',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({
        path: 'electron',
        namespace: 'electron-stub',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents: [
          'export const app = {}',
          'export const BrowserWindow = {}',
          'export const dialog = {}',
          'export const ipcMain = {}',
          'export const net = {}',
          'export const protocol = {}',
          'export const safeStorage = {}',
          'export const session = {}',
          'export const utilityProcess = {}',
        ].join('\n'),
        loader: 'js',
      }))
    },
  }

  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['src/main/extensions/registry.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    plugins: [nativeDependencyStub, hermeticDependencies, electronStub],
    logLevel: 'silent',
  })

  const previousHome = process.env.CODESURF_HOME
  process.env.CODESURF_HOME = codesurfHome
  try {
    return await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`)
  } finally {
    if (previousHome === undefined) delete process.env.CODESURF_HOME
    else process.env.CODESURF_HOME = previousHome
  }
}

async function loadExtensionIpcModule(
  codesurfHome: string,
  handlers: Map<string, (...args: unknown[]) => unknown>,
) {
  const bundleDir = await mkdtemp(join(tmpdir(), 'codesurf-extension-ipc-test-'))
  const outfile = join(bundleDir, 'extensions-ipc.cjs')
  Object.assign(globalThis, { __codesurfExtensionLoadingHandlers: handlers })
  const electronStub: Plugin = {
    name: 'electron-stub',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({
        path: 'electron',
        namespace: 'electron-stub',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents: [
          'const handlers = globalThis.__codesurfExtensionLoadingHandlers',
          'export const ipcMain = { handle(channel, handler) { handlers.set(channel, handler) }, removeHandler() {} }',
          'export const BrowserWindow = { fromWebContents() { return null }, getFocusedWindow() { return null } }',
          'export const dialog = {}',
          'export const app = {}',
          'export const net = {}',
          'export const protocol = {}',
          'export const safeStorage = {',
          '  isEncryptionAvailable() { return false },',
          '  encryptString(value) { return Buffer.from(value) },',
          '  decryptString(value) { return Buffer.from(value).toString("utf8") },',
          '}',
          'export const session = {}',
          'export const utilityProcess = {}',
        ].join('\n'),
        loader: 'js',
      }))
    },
  }

  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['src/main/ipc/extensions.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    plugins: [nativeDependencyStub, hermeticDependencies, electronStub],
    logLevel: 'silent',
  })

  const previousHome = process.env.CODESURF_HOME
  process.env.CODESURF_HOME = codesurfHome
  try {
    return await import(`${pathToFileURL(outfile).href}?test=${Date.now()}-${Math.random()}`)
  } finally {
    if (previousHome === undefined) delete process.env.CODESURF_HOME
    else process.env.CODESURF_HOME = previousHome
  }
}

async function writeWorkspaceExtension(
  workspace: string,
  directory: string,
  id: string,
  tileType: string,
  extraTiles: Array<{ type: string; label: string; entry: string }> = [],
): Promise<string> {
  const extDir = join(workspace, '.codesurf', 'extensions', directory)
  await mkdir(extDir, { recursive: true })
  await writeFile(join(extDir, 'index.html'), '<html></html>')
  await writeFile(join(extDir, 'extension.json'), JSON.stringify({
    id,
    name: id,
    version: '1.0.0',
    tier: 'safe',
    contributes: {
      tiles: [{ type: tileType, label: id, entry: 'index.html' }, ...extraTiles],
    },
  }))
  return extDir
}

test('broker host replaces owned extension IPC handlers before re-registering', () => {
  const source = readFileSync(`${process.cwd()}/src/main/extensions/broker/host.ts`, 'utf8')

  assert.match(source, /const expectedPrefix = `ext:\$\{extId\}:`/)
  assert.match(source, /if \(this\.ipcChannels\.includes\(fullChannel\)\) \{\s*ipcMain\.removeHandler\(fullChannel\)/s)
  assert.match(source, /this\.ipcChannels = this\.ipcChannels\.filter\(channel => channel !== fullChannel\)/)
  assert.match(source, /this\.ipcChannels\.push\(fullChannel\)/)
})

test('extension IPC loading coalesces in-flight scans for the same workspace', () => {
  const source = readFileSync(`${process.cwd()}/src/main/ipc/extensions.ts`, 'utf8')

  assert.match(source, /let inFlightLoad: \{ workspacePath: string \| null; promise: Promise<void> \} \| null = null/)
  assert.match(source, /inFlightLoad && inFlightLoad\.workspacePath === targetWorkspacePath/)
  assert.match(source, /await inFlightLoad\.promise/)
  assert.match(source, /inFlightLoad = \{ workspacePath: targetWorkspacePath, promise: loadPromise \}/)
})

test('lightweight discovery establishes the executable workspace and replaces it on switch', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-workspace-transition-'))
  const codesurfHome = join(temp, 'home')
  const workspaceA = join(temp, 'workspace-a')
  const workspaceB = join(temp, 'workspace-b')
  const invalidDir = await writeWorkspaceExtension(
    workspaceA,
    'invalid',
    '../mcp-server',
    'escape',
  )
  const alphaDir = await writeWorkspaceExtension(
    workspaceA,
    'alpha',
    'workspace-alpha',
    'alpha',
    [{ type: 'escape', label: 'Escape', entry: 'escape.html' }],
  )
  const externalSurface = join(temp, 'outside-surface.html')
  await writeFile(externalSurface, '<html>outside</html>')
  await symlink(externalSurface, join(alphaDir, 'escape.html'))
  await writeWorkspaceExtension(workspaceB, 'beta', 'workspace-beta', 'beta')

  const { ExtensionRegistry } = await loadRegistryModule(codesurfHome)
  const registry = new ExtensionRegistry()
  await assert.rejects(
    registry.loadFromManifest({
      id: '../adapted',
      name: 'Invalid adapted extension',
      version: '1.0.0',
      tier: 'safe',
      contributes: {},
      _path: invalidDir,
    }),
    new RegExp(`Invalid extension id.*${invalidDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  )

  const lightweightA = await registry.scanLightweight(workspaceA)
  assert.deepEqual(lightweightA.map((manifest: { id: string }) => manifest.id), ['workspace-alpha'])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceA))

  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    await registry.rescan(registry.getActiveWorkspacePath())
  } finally {
    console.error = originalError
  }
  assert.equal(registry.get('../mcp-server'), undefined)
  assert.ok(errors.some(message => message.includes(invalidDir) && message.includes('Invalid extension id')))
  assert.match(
    registry.getTileEntry('workspace-alpha', 'ext:alpha') ?? '',
    /^codesurf-ext:\/\/workspace-alpha\/index\.html/,
  )
  assert.equal(
    await registry.getSurfaceHtml('workspace-alpha', 'tile', 'ext:alpha'),
    '<html></html>',
  )
  assert.equal(
    await registry.getSurfaceHtml('workspace-alpha', 'tile', 'ext:escape'),
    null,
  )

  const lightweightB = await registry.scanLightweight(workspaceB)
  assert.deepEqual(lightweightB.map((manifest: { id: string }) => manifest.id), ['workspace-beta'])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))
  await registry.rescan(registry.getActiveWorkspacePath())
  assert.equal(registry.getTileEntry('workspace-alpha', 'ext:alpha'), null)
  assert.match(
    registry.getTileEntry('workspace-beta', 'ext:beta') ?? '',
    /^codesurf-ext:\/\/workspace-beta\/index\.html/,
  )

  const lightweightWithoutWorkspace = await registry.scanLightweight(null)
  assert.deepEqual(lightweightWithoutWorkspace, [])
  assert.equal(registry.getActiveWorkspacePath(), null)
  assert.deepEqual(await registry.scanLightweight(), [])
  await registry.rescan(registry.getActiveWorkspacePath())
  assert.equal(registry.getTileEntry('workspace-beta', 'ext:beta'), null)

  await Promise.all([
    registry.scanLightweight(workspaceA),
    registry.scanLightweight(workspaceB),
  ])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))
})

test('registered IPC keeps sidebar and executable collision precedence aligned', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-collision-'))
  const codesurfHome = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const globalDir = join(codesurfHome, 'extensions', 'global-copy')
  const workspaceDir = join(workspace, '.codesurf', 'extensions', 'workspace-copy')
  await mkdir(globalDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })

  await writeFile(join(globalDir, 'global.html'), '<html>global</html>')
  await writeFile(join(globalDir, 'extension.json'), JSON.stringify({
    id: 'collision-extension',
    name: 'Trusted global metadata',
    version: '1.0.0',
    tier: 'safe',
    contributes: {
      actions: [{ name: 'global-action', description: 'Global action' }],
      tiles: [{
        type: 'shared',
        label: 'Global tile',
        entry: 'global.html',
      }],
    },
  }))
  await writeFile(join(workspaceDir, 'workspace.html'), '<html>workspace</html>')
  await writeFile(join(workspaceDir, 'extension.json'), JSON.stringify({
    id: 'collision-extension',
    name: 'Workspace metadata',
    version: '2.0.0',
    tier: 'safe',
    contributes: {
      actions: [{ name: 'workspace-action', description: 'Workspace action' }],
      tiles: [{
        type: 'shared',
        label: 'Workspace tile',
        entry: 'workspace.html',
      }],
    },
  }))

  const { ExtensionRegistry } = await loadRegistryModule(codesurfHome)
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const { registerExtensionIPC } = await loadExtensionIpcModule(codesurfHome, handlers)
  const registry = new ExtensionRegistry()
  registerExtensionIPC(registry)

  const listSidebar = handlers.get('ext:list-sidebar')!
  const listTiles = handlers.get('ext:list-tiles')!
  const tileEntry = handlers.get('ext:tile-entry')!

  const workspaceSidebar = await listSidebar({}, workspace) as {
    entries: Array<{ name: string }>
    tiles: Array<{
      label: string
      entry: string
      actions?: Array<{ name: string }>
    }>
  }
  assert.equal(workspaceSidebar.entries[0]?.name, 'Workspace metadata')
  assert.equal(workspaceSidebar.tiles[0]?.label, 'Workspace tile')
  assert.equal(workspaceSidebar.tiles[0]?.entry, 'workspace.html')
  assert.deepEqual(workspaceSidebar.tiles[0]?.actions, [{
    name: 'workspace-action',
    description: 'Workspace action',
  }])

  const workspaceTiles = await listTiles({}) as Array<{ label: string }>
  assert.deepEqual(workspaceTiles.map(tile => tile.label), ['Workspace tile'])
  assert.match(
    String(await tileEntry({}, 'collision-extension', 'ext:shared')),
    /^codesurf-ext:\/\/collision-extension\/workspace\.html/,
  )
  assert.equal(registry.get('collision-extension')?.manifest._path, realpathSync(workspaceDir))

  const globalSidebar = await listSidebar({}, null) as {
    entries: Array<{ name: string }>
    tiles: Array<{ label: string; entry: string }>
  }
  assert.equal(globalSidebar.entries[0]?.name, 'Trusted global metadata')
  assert.equal(globalSidebar.tiles[0]?.label, 'Global tile')
  assert.equal(globalSidebar.tiles[0]?.entry, 'global.html')
  assert.equal(registry.getActiveWorkspacePath(), null)

  const globalTiles = await listTiles({}) as Array<{ label: string }>
  assert.deepEqual(globalTiles.map(tile => tile.label), ['Global tile'])
  assert.match(
    String(await tileEntry({}, 'collision-extension', 'ext:shared')),
    /^codesurf-ext:\/\/collision-extension\/global\.html/,
  )
  assert.equal(registry.get('collision-extension')?.manifest._path, realpathSync(globalDir))
})

test('registry transition queue preserves request order and recovers after rejection', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-workspace-queue-'))
  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry()
  const workspaceA = join(temp, 'workspace-a')
  const workspaceB = join(temp, 'workspace-b')

  let releaseFirst!: () => void
  let markStarted!: () => void
  const firstBlocked = new Promise<void>(resolveBlocked => { releaseFirst = resolveBlocked })
  const firstStarted = new Promise<void>(resolveStarted => { markStarted = resolveStarted })
  let scanCalls = 0
  registry.scan = async () => {
    scanCalls += 1
    if (scanCalls === 1) {
      markStarted()
      await firstBlocked
    }
  }

  const first = registry.rescan(workspaceA)
  await firstStarted
  const second = registry.rescan(workspaceB)
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceA))
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))

  registry.scan = async () => { throw new Error('expected transition failure') }
  await assert.rejects(registry.rescan(workspaceA), /expected transition failure/)
  registry.scan = async () => {}
  await registry.rescan(workspaceB)
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))
})

test('rescan clears tools and recovers after a disposer throws', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-disposer-failure-'))
  const bundledDir = join(temp, 'bundled')
  const extensionDir = join(bundledDir, 'bad-disposer')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'bad-disposer',
    name: 'Bad Disposer',
    version: '1.0.0',
    tier: 'safe',
  }))
  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry({ bundledDirs: [bundledDir] })
  await registry.rescan()
  registry.get('bad-disposer')!.deactivate = () => {
    throw new Error('simulated disposer failure')
  }
  registry.registerMCPTool('bad-disposer', {
    name: 'leaked-tool',
    description: 'must be cleared',
  })

  await assert.rejects(
    registry.rescan(),
    /failed to deactivate/,
  )
  assert.equal(registry.get('bad-disposer'), undefined)
  assert.deepEqual(
    registry.getMCPTools().filter(
      (tool: { extId: string }) => tool.extId === 'bad-disposer',
    ),
    [],
  )
  await registry.rescan()
  assert.equal(registry.get('bad-disposer')?.manifest._enabled, true)
})

test('enable superseded by disable disposes partial activation and leaves no tools', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-enable-disable-race-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const extensionDir = join(workspace, '.codesurf', 'extensions', 'racy-power')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'racy-power',
    name: 'Racy Power',
    version: '1.0.0',
    tier: 'power',
    main: 'main.cjs',
    capabilities: [{ name: 'chat' }],
  }))
  await writeFile(join(extensionDir, 'main.cjs'), 'module.exports.activate = () => () => {}')

  let markActivationStarted: (() => void) | undefined
  let releaseActivation: (() => void) | undefined
  const activationStarted = new Promise<void>(resolveStarted => {
    markActivationStarted = resolveStarted
  })
  const activationBlocked = new Promise<void>(resolveBlocked => {
    releaseActivation = resolveBlocked
  })
  let activations = 0
  let disposals = 0
  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({
    activatePower: async (
      manifest: { id: string },
      _context: unknown,
      _scope: unknown,
      activeRegistry: {
        registerMCPTool: (id: string, tool: { name: string; description: string }) => void
      },
    ) => {
      activations += 1
      activeRegistry.registerMCPTool(manifest.id, {
        name: 'racy-tool',
        description: 'must not leak',
      })
      markActivationStarted?.()
      await activationBlocked
      return () => {
        disposals += 1
      }
    },
  })
  await registry.rescan(workspace)

  const enable = registry.enable('racy-power')
  await activationStarted
  const disable = registry.disable('racy-power')
  releaseActivation?.()

  assert.deepEqual(await Promise.all([enable, disable]), [true, true])
  assert.equal(activations, 1)
  assert.equal(disposals, 1)
  assert.equal(registry.get('racy-power')?.manifest._enabled, false)
  assert.deepEqual(
    registry.getMCPTools().filter((tool: { extId: string }) => tool.extId === 'racy-power'),
    [],
  )
  const persisted = JSON.parse(
    await fsPromises.readFile(join(home, 'extension-security-state.json'), 'utf8'),
  ) as {
    disabledExtensionIds: string[]
    enabledCatalogExtensionIds: string[]
    grants: Record<string, string[]>
  }
  assert.equal(persisted.disabledExtensionIds.includes('racy-power'), true)
  assert.equal(persisted.enabledCatalogExtensionIds.includes('racy-power'), false)
  assert.equal(Object.hasOwn(persisted.grants, 'racy-power'), false)
})

test('double enable serializes activation and disposes the superseded instance', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-double-enable-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const extensionDir = join(workspace, '.codesurf', 'extensions', 'double-power')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'double-power',
    name: 'Double Power',
    version: '1.0.0',
    tier: 'power',
    main: 'main.cjs',
    capabilities: [{ name: 'chat' }],
  }))
  await writeFile(join(extensionDir, 'main.cjs'), 'module.exports.activate = () => () => {}')

  let markFirstStarted: (() => void) | undefined
  let releaseFirst: (() => void) | undefined
  const firstStarted = new Promise<void>(resolveStarted => {
    markFirstStarted = resolveStarted
  })
  const firstBlocked = new Promise<void>(resolveBlocked => {
    releaseFirst = resolveBlocked
  })
  let activations = 0
  let disposals = 0
  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({
    activatePower: async (
      manifest: { id: string },
      _context: unknown,
      _scope: unknown,
      activeRegistry: {
        registerMCPTool: (id: string, tool: { name: string; description: string }) => void
      },
    ) => {
      activations += 1
      const activation = activations
      activeRegistry.registerMCPTool(manifest.id, {
        name: `tool-${activation}`,
        description: 'one live instance only',
      })
      if (activation === 1) {
        markFirstStarted?.()
        await firstBlocked
      }
      return () => {
        disposals += 1
      }
    },
  })
  await registry.rescan(workspace)

  const first = registry.enable('double-power')
  await firstStarted
  const second = registry.enable('double-power')
  releaseFirst?.()

  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(activations, 2)
  assert.equal(disposals, 1)
  assert.equal(registry.get('double-power')?.manifest._enabled, true)
  assert.equal(
    registry.getMCPTools().filter(
      (tool: { extId: string }) => tool.extId === 'double-power',
    ).length,
    1,
  )
})

test('rescan removal supersedes in-flight enable and reinstall stays disabled', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-enable-rescan-race-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const extensionDir = join(workspace, '.codesurf', 'extensions', 'removed-power')
  const writeExtension = async (): Promise<void> => {
    await mkdir(extensionDir, { recursive: true })
    await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
      id: 'removed-power',
      name: 'Removed Power',
      version: '1.0.0',
      tier: 'power',
      main: 'main.cjs',
      capabilities: [{ name: 'chat' }],
    }))
    await writeFile(join(extensionDir, 'main.cjs'), 'module.exports.activate = () => () => {}')
  }
  await writeExtension()

  let markActivationStarted: (() => void) | undefined
  let releaseActivation: (() => void) | undefined
  const activationStarted = new Promise<void>(resolveStarted => {
    markActivationStarted = resolveStarted
  })
  const activationBlocked = new Promise<void>(resolveBlocked => {
    releaseActivation = resolveBlocked
  })
  let activations = 0
  let disposals = 0
  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({
    activatePower: async () => {
      activations += 1
      if (activations === 1) {
        markActivationStarted?.()
        await activationBlocked
      }
      return () => {
        disposals += 1
      }
    },
  })
  await registry.rescan(workspace)

  const enable = registry.enable('removed-power')
  await activationStarted
  await rm(extensionDir, { recursive: true })
  const rescan = registry.rescan(workspace)
  releaseActivation?.()
  assert.equal(await enable, true)
  await rescan
  assert.equal(disposals, 1)
  assert.equal(registry.get('removed-power'), undefined)

  await writeExtension()
  await registry.rescan(workspace)
  assert.equal(registry.get('removed-power')?.manifest._enabled, false)
  assert.equal(await registry.enable('removed-power'), true)
  assert.equal(registry.get('removed-power')?.manifest._enabled, true)
  assert.equal(activations, 2)
})

test('a same-id replacement during rescan cannot execute before durable revocation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-rescan-swap-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const extensionDir = join(workspace, '.codesurf', 'extensions', 'swapped-power')
  const writeExtension = (version: string): void => {
    mkdirSync(extensionDir, { recursive: true })
    writeFileSync(join(extensionDir, 'extension.json'), JSON.stringify({
      id: 'swapped-power',
      name: 'Swapped Power',
      version,
      tier: 'power',
      main: 'main.cjs',
      capabilities: [{ name: 'shell' }],
    }))
    writeFileSync(join(extensionDir, 'main.cjs'), 'module.exports.activate = () => () => {}')
  }
  writeExtension('1.0.0')

  let activations = 0
  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({
    activatePower: async () => {
      activations += 1
      return () => undefined
    },
  })
  await registry.rescan(workspace)
  assert.equal(await registry.enable('swapped-power'), true)
  assert.equal(activations, 1)

  const deactivateAll = registry.deactivateAll.bind(registry)
  registry.deactivateAll = () => {
    deactivateAll()
    rmSync(extensionDir, { recursive: true })
    writeExtension('2.0.0')
  }

  await registry.rescan(workspace)
  assert.equal(activations, 1)
  assert.equal(registry.get('swapped-power')?.manifest.version, '2.0.0')
  assert.equal(registry.get('swapped-power')?.manifest._enabled, false)
  const persisted = JSON.parse(
    await fsPromises.readFile(join(home, 'extension-security-state.json'), 'utf8'),
  ) as {
    disabledExtensionIds: string[]
    enabledCatalogExtensionIds: string[]
    grants: Record<string, string[]>
  }
  assert.equal(persisted.disabledExtensionIds.includes('swapped-power'), true)
  assert.equal(persisted.enabledCatalogExtensionIds.includes('swapped-power'), false)
  assert.equal(Object.hasOwn(persisted.grants, 'swapped-power'), false)
})

test('a failed enable for a missing id does not poison a later installation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-late-install-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const extensionDir = join(workspace, '.codesurf', 'extensions', 'late-power')
  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({
    activatePower: async () => () => undefined,
  })
  await registry.rescan(workspace)
  assert.equal(await registry.enable('late-power'), false)

  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'late-power',
    name: 'Late Power',
    version: '1.0.0',
    tier: 'power',
    main: 'main.cjs',
  }))
  await writeFile(join(extensionDir, 'main.cjs'), 'module.exports.activate = () => () => {}')
  await registry.rescan(workspace)
  assert.equal(registry.get('late-power')?.manifest._enabled, false)
  assert.equal(await registry.enable('late-power'), true)
  assert.equal(registry.get('late-power')?.manifest._enabled, true)
})

test('capability gates distinguish absent and empty grants and drop stale declarations', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-capability-state-'))
  const home = join(temp, 'home')
  const bundledDir = join(temp, 'bundled')
  const writeBundled = async (
    id: string,
    capabilities: string[],
  ): Promise<void> => {
    const extensionDir = join(bundledDir, id)
    await mkdir(extensionDir, { recursive: true })
    await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      tier: 'safe',
      capabilities: capabilities.map(name => ({ name })),
    }))
  }
  await Promise.all([
    writeBundled('absent-grants', ['chat', 'relay']),
    writeBundled('empty-grants', ['chat']),
    writeBundled('stale-grants', ['chat']),
  ])
  await mkdir(home)
  await writeFile(join(home, 'extension-security-state.json'), JSON.stringify({
    version: 1,
    disabledExtensionIds: [],
    enabledCatalogExtensionIds: [],
    grants: {
      'empty-grants': [],
      'stale-grants': ['chat', 'relay'],
    },
  }))

  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({ bundledDirs: [bundledDir] })
  await registry.rescan()
  assert.deepEqual(registry.getCapabilityGate('absent-grants'), {
    enforced: true,
    granted: ['chat', 'relay'],
  })
  assert.deepEqual(registry.getCapabilityGate('empty-grants'), {
    enforced: true,
    granted: [],
  })
  assert.deepEqual(registry.getCapabilityGate('stale-grants'), {
    enforced: true,
    granted: ['chat'],
  })
})

test('registry exposes declared media and revokes sensitive consent on disable or removal', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-sensitive-registry-'))
  const bundledDir = join(temp, 'bundled')
  const extensionDir = join(bundledDir, 'media-extension')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'media-extension',
    name: 'Media Extension',
    version: '1.0.0',
    tier: 'safe',
    capabilities: [
      { name: 'network' },
      { name: 'microphone', reason: 'Join room audio' },
      { name: 'display-capture' },
    ],
    contributes: {
      tiles: [{ type: 'media', label: 'Media', entry: 'index.html' }],
    },
  }))

  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const revoked: string[] = []
  const registry = new ExtensionRegistry({
    bundledDirs: [bundledDir],
    onSensitiveMediaRevoked: async (extensionId: string) => {
      revoked.push(extensionId)
    },
  })
  await registry.rescan()
  assert.deepEqual(registry.getExtensionMediaPermission('media-extension'), {
    id: 'media-extension',
    identity: registry.getExtensionMediaPermission('media-extension')?.identity,
    name: 'Media Extension',
    enabled: true,
    declaredMedia: ['microphone', 'display-capture'],
    declaredMediaReasons: {
      microphone: 'Join room audio',
    },
  })
  assert.match(
    registry.getExtensionMediaPermission('media-extension')?.identity ?? '',
    /^sha256:[a-f0-9]{64}$/,
  )
  assert.deepEqual(
    registry.getTileTypes()[0]?.sensitiveMedia,
    ['microphone', 'display-capture'],
  )

  assert.equal(await registry.disable('media-extension'), true)
  assert.deepEqual(revoked, ['media-extension'])
  assert.equal(await registry.enable('media-extension'), true)
  assert.deepEqual(
    revoked,
    ['media-extension', 'media-extension'],
    're-enable retries revocation before the extension becomes active',
  )

  const { ExtensionRegistry: RemovalRegistry } = await loadRegistryModule(
    join(temp, 'removal-home'),
  )
  const removalRegistry = new RemovalRegistry({
    bundledDirs: [bundledDir],
    onSensitiveMediaRevoked: async (extensionId: string) => {
      revoked.push(`removed:${extensionId}`)
    },
  })
  await removalRegistry.rescan()
  await rm(extensionDir, { recursive: true })
  await removalRegistry.rescan()
  assert.equal(
    revoked.includes('removed:media-extension'),
    true,
    'a disappeared extension must revoke persisted sensitive consent',
  )
})

test('attested media surfaces revoke changed content and stale requests cannot revoke a rescan', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-sensitive-surface-'))
  const bundledDir = join(temp, 'bundled')
  const extensionDir = join(bundledDir, 'attested-surface')
  const entryPath = join(extensionDir, 'surface.html')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'attested-surface',
    name: 'Attested Surface',
    version: '1.0.0',
    tier: 'safe',
    capabilities: [{ name: 'microphone' }],
    contributes: {
      tiles: [{ type: 'surface', label: 'Surface', entry: 'surface.html' }],
    },
  }))
  await writeFile(entryPath, 'trusted')

  const revoked: string[] = []
  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry({
    bundledDirs: [bundledDir],
    onSensitiveMediaRevoked: async (extensionId: string) => {
      revoked.push(extensionId)
    },
  })
  await registry.rescan()
  const tileType = registry.get('attested-surface')
    ?.manifest.contributes?.tiles?.[0]?.type
  assert.ok(tileType)
  const protectedSurface = await registry.getSurfaceHtml(
    'attested-surface',
    'tile',
    tileType,
  )
  assert.ok(protectedSurface)
  assert.match(
    protectedSurface,
    /^<meta http-equiv="Content-Security-Policy"/,
  )
  assert.match(protectedSurface, /script-src 'self'/)
  assert.match(protectedSurface, /worker-src 'self'/)
  assert.match(protectedSurface, /object-src 'none'/)
  assert.match(protectedSurface, /base-uri 'none'/)
  assert.match(protectedSurface, /trusted$/)
  const staleAttestation = registry.get('attested-surface')?.mediaAttestation
  assert.ok(staleAttestation)

  await writeFile(entryPath, 'changed')
  assert.equal(
    await registry.getSurfaceHtml('attested-surface', 'tile', tileType),
    null,
  )
  assert.deepEqual(revoked, ['attested-surface'])
  assert.equal(registry.getExtensionMediaPermission('attested-surface'), undefined)
  assert.equal(registry.get('attested-surface')?.mediaAttestation, null)

  await registry.rescan()
  const currentAttestation = registry.get('attested-surface')?.mediaAttestation
  assert.ok(currentAttestation)
  assert.notEqual(currentAttestation, staleAttestation)
  revoked.length = 0
  assert.equal(
    await registry.invalidateExtensionMediaAttestation(
      'attested-surface',
      staleAttestation,
    ),
    false,
  )
  assert.deepEqual(revoked, [])
  assert.equal(
    registry.getExtensionMediaPermission('attested-surface')?.identity,
    currentAttestation.identity,
  )

  await writeFile(
    entryPath,
    Buffer.alloc(MAX_EXTENSION_TEXT_RESOURCE_BYTES + 1),
  )
  await registry.rescan()
  revoked.length = 0
  const oversizedAttestation = registry.get('attested-surface')?.mediaAttestation
  assert.ok(oversizedAttestation)
  assert.equal(
    await registry.getSurfaceHtml('attested-surface', 'tile', tileType),
    null,
  )
  assert.equal(
    registry.get('attested-surface')?.mediaAttestation,
    oversizedAttestation,
  )
  assert.deepEqual(revoked, [])
})

test('media identity follows effective precedence and changes on update or reinstall', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-sensitive-identity-'))
  const bundledDir = join(temp, 'bundled')
  const bundledExtensionDir = join(bundledDir, 'media-extension')
  const workspace = join(temp, 'workspace')
  const workspaceExtensionDir = join(
    workspace,
    '.codesurf',
    'extensions',
    'media-extension',
  )
  const manifest = (version: string, label: string) => JSON.stringify({
    id: 'media-extension',
    name: label,
    version,
    tier: 'safe',
    capabilities: [{ name: 'microphone' }],
    contributes: {
      tiles: [{ type: 'media', label: 'Media', entry: 'index.html' }],
    },
  })
  await mkdir(bundledExtensionDir, { recursive: true })
  await writeFile(join(bundledExtensionDir, 'extension.json'), manifest('1.0.0', 'Bundled'))
  await writeFile(join(bundledExtensionDir, 'index.html'), 'bundled-v1')
  await mkdir(workspaceExtensionDir, { recursive: true })
  await writeFile(join(workspaceExtensionDir, 'extension.json'), manifest('2.0.0', 'Workspace'))
  await writeFile(join(workspaceExtensionDir, 'index.html'), 'workspace-v2')

  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const revoked: string[] = []
  const registry = new ExtensionRegistry({
    bundledDirs: [bundledDir],
    onSensitiveMediaRevoked: async (extensionId: string) => {
      revoked.push(extensionId)
    },
  })

  await registry.rescan()
  const bundledIdentityV1 = registry.getExtensionMediaPermission('media-extension')?.identity
  assert.match(bundledIdentityV1 ?? '', /^sha256:[a-f0-9]{64}$/)
  await registry.rescan()
  assert.deepEqual(revoked, [], 'an unchanged compatible rescan keeps grants')

  await registry.rescan(workspace)
  const workspaceIdentity = registry.getExtensionMediaPermission('media-extension')?.identity
  assert.notEqual(workspaceIdentity, bundledIdentityV1)
  assert.equal(registry.get('media-extension')?.manifest.name, 'Workspace')
  assert.deepEqual(revoked, ['media-extension'])

  await registry.rescan(workspace)
  assert.deepEqual(revoked, ['media-extension'], 'an unchanged override stays compatible')
  await registry.rescan(null)
  assert.equal(registry.getExtensionMediaPermission('media-extension')?.identity, bundledIdentityV1)
  assert.deepEqual(revoked, ['media-extension', 'media-extension'])

  await writeFile(join(bundledExtensionDir, 'extension.json'), manifest('1.1.0', 'Bundled'))
  await writeFile(join(bundledExtensionDir, 'index.html'), 'bundled-v1.1')
  await registry.rescan()
  const updatedIdentity = registry.getExtensionMediaPermission('media-extension')?.identity
  assert.notEqual(updatedIdentity, bundledIdentityV1)
  assert.deepEqual(revoked, ['media-extension', 'media-extension', 'media-extension'])

  await rm(join(bundledExtensionDir, 'extension.json'))
  await rm(join(bundledExtensionDir, 'index.html'))
  await writeFile(join(bundledExtensionDir, 'extension.json'), manifest('1.1.0', 'Bundled'))
  await writeFile(join(bundledExtensionDir, 'index.html'), 'bundled-v1.1')
  await registry.rescan()
  assert.notEqual(
    registry.getExtensionMediaPermission('media-extension')?.identity,
    updatedIdentity,
    'a same-path reinstall with identical content gets a new install identity',
  )
  assert.deepEqual(
    revoked,
    ['media-extension', 'media-extension', 'media-extension', 'media-extension'],
  )
})

test('registry rejects native and adapted root or manifest symlinks', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-root-links-'))
  const bundledDir = join(temp, 'bundled')
  const externalRoot = join(temp, 'external-extension')
  const nativeRootLink = join(bundledDir, 'native-root-link')
  const manifestLinkRoot = join(bundledDir, 'manifest-link')
  const externalManifest = join(temp, 'external-manifest.json')
  await mkdir(externalRoot, { recursive: true })
  await mkdir(manifestLinkRoot, { recursive: true })
  const mediaManifest = JSON.stringify({
    id: 'linked-media',
    name: 'Linked Media',
    version: '1.0.0',
    tier: 'safe',
    capabilities: [{ name: 'microphone' }],
  })
  await writeFile(join(externalRoot, 'extension.json'), mediaManifest)
  await writeFile(externalManifest, mediaManifest)
  await symlink(externalRoot, nativeRootLink)
  await symlink(externalManifest, join(manifestLinkRoot, 'extension.json'))

  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry({ bundledDirs: [bundledDir] })
  await registry.rescan()
  assert.equal(registry.get('linked-media'), undefined)

  const adaptedRootLink = join(temp, 'adapted-root-link')
  await symlink(externalRoot, adaptedRootLink)
  await assert.rejects(
    registry.loadFromManifest({
      id: 'adapted-linked-media',
      name: 'Adapted Linked Media',
      version: '1.0.0',
      tier: 'safe',
      capabilities: [{ name: 'microphone' }],
      _path: adaptedRootLink,
    }),
    /Extension root must be a regular directory/,
  )
})

test('workspace extension scan roots cannot escape through a symlinked ancestor', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-workspace-scan-root-'))
  const workspace = join(temp, 'workspace')
  const externalExtensions = join(temp, 'external-extensions')
  const externalExtension = join(externalExtensions, 'outside-media')
  await mkdir(join(workspace, '.codesurf'), { recursive: true })
  await mkdir(externalExtension, { recursive: true })
  await writeFile(join(externalExtension, 'extension.json'), JSON.stringify({
    id: 'outside-media',
    name: 'Outside Media',
    version: '1.0.0',
    tier: 'safe',
    capabilities: [{ name: 'microphone' }],
  }))
  await symlink(externalExtensions, join(workspace, '.codesurf', 'extensions'))

  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry()
  const canonicalExternal = await fsPromises.realpath(externalExtensions)
  const originalReaddir = fsPromises.readdir
  let enumeratedExternal = false
  fsPromises.readdir = (async (...args: Parameters<typeof fsPromises.readdir>) => {
    const path = String(args[0])
    if (path === canonicalExternal || path.startsWith(`${canonicalExternal}${sep}`)) {
      enumeratedExternal = true
    }
    return originalReaddir(...args)
  }) as typeof fsPromises.readdir
  try {
    await registry.rescan(workspace)
    const lightweight = await registry.scanLightweight(workspace)
    assert.equal(
      lightweight.some(manifest => manifest.id === 'outside-media'),
      false,
    )
  } finally {
    fsPromises.readdir = originalReaddir
  }
  assert.equal(enumeratedExternal, false)
  assert.equal(registry.get('outside-media'), undefined)
})

test('full and lightweight scans reject a workspace scan-root swap before opening external files', async () => {
  for (const mode of ['full', 'lightweight'] as const) {
    const temp = await mkdtemp(join(tmpdir(), `codesurf-workspace-scan-swap-${mode}-`))
    const workspace = join(temp, 'workspace')
    const scanRoot = join(workspace, '.codesurf', 'extensions')
    const originalScanRoot = `${scanRoot}-original`
    const externalExtensions = join(temp, 'external-extensions')
    const externalExtension = join(externalExtensions, 'outside-media')
    await mkdir(scanRoot, { recursive: true })
    await mkdir(externalExtension, { recursive: true })
    await writeFile(join(externalExtension, 'extension.json'), JSON.stringify({
      id: 'outside-media',
      name: 'Outside Media',
      version: '1.0.0',
      tier: 'safe',
      capabilities: [{ name: 'microphone' }],
    }))

    const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
    const registry = new ExtensionRegistry()
    const canonicalScanRoot = await fsPromises.realpath(scanRoot)
    const originalReaddir = fsPromises.readdir
    const originalOpen = fsPromises.open
    let releaseReaddir!: () => void
    let readdirStarted!: () => void
    let intercepted = false
    let openedExternal = false
    const started = new Promise<void>(resolveStarted => { readdirStarted = resolveStarted })
    const release = new Promise<void>(resolveRelease => { releaseReaddir = resolveRelease })
    fsPromises.readdir = (async (...args: Parameters<typeof fsPromises.readdir>) => {
      if (!intercepted && String(args[0]) === canonicalScanRoot) {
        intercepted = true
        readdirStarted()
        await release
      }
      return originalReaddir(...args)
    }) as typeof fsPromises.readdir
    fsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
      const path = String(args[0])
      const replacementCandidate = join(canonicalScanRoot, 'outside-media')
      if (path === replacementCandidate || path.startsWith(`${replacementCandidate}${sep}`)) {
        openedExternal = true
      }
      return originalOpen(...args)
    }) as typeof fsPromises.open

    try {
      const scan = mode === 'full'
        ? registry.rescan(workspace)
        : registry.scanLightweight(workspace)
      await started
      await fsPromises.rename(scanRoot, originalScanRoot)
      await fsPromises.rename(externalExtensions, scanRoot)
      releaseReaddir()
      await assert.rejects(scan, /scan root changed|Extension root changed/)
    } finally {
      fsPromises.readdir = originalReaddir
      fsPromises.open = originalOpen
      releaseReaddir?.()
    }
    assert.equal(openedExternal, false)
    assert.equal(registry.get('outside-media'), undefined)
  }
})

test('a regular scan-root replacement after the per-entry check cannot activate power code', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-scan-root-power-swap-'))
  const scanRoot = join(temp, 'bundled')
  const originalScanRoot = `${scanRoot}-original`
  const replacementRoot = join(temp, 'replacement')
  const originalExtension = join(scanRoot, 'power')
  const replacementExtension = join(replacementRoot, 'power')
  const marker = join(temp, 'replacement-activated')
  const manifest = JSON.stringify({
    id: 'swap-power',
    name: 'Swap Power',
    version: '1.0.0',
    tier: 'power',
    main: 'main.cjs',
  })
  await mkdir(originalExtension, { recursive: true })
  await mkdir(replacementExtension, { recursive: true })
  await writeFile(join(originalExtension, 'extension.json'), manifest)
  await writeFile(join(originalExtension, 'main.cjs'), 'module.exports.activate = () => {}')
  await writeFile(join(replacementExtension, 'extension.json'), manifest)
  await writeFile(
    join(replacementExtension, 'main.cjs'),
    `module.exports.activate = () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'activated')`,
  )

  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry({ bundledDirs: [scanRoot] })
  const canonicalScanRoot = await fsPromises.realpath(scanRoot)
  const candidatePath = join(canonicalScanRoot, 'power')
  const originalLstat = fsPromises.lstat
  let releaseCandidate!: () => void
  let candidateStarted!: () => void
  let intercepted = false
  const started = new Promise<void>(resolveStarted => { candidateStarted = resolveStarted })
  const release = new Promise<void>(resolveRelease => { releaseCandidate = resolveRelease })
  fsPromises.lstat = (async (...args: Parameters<typeof fsPromises.lstat>) => {
    if (!intercepted && String(args[0]) === candidatePath) {
      intercepted = true
      candidateStarted()
      await release
    }
    return originalLstat(...args)
  }) as typeof fsPromises.lstat
  const priorBrokerMode = process.env.CODESURF_POWER_BROKER
  process.env.CODESURF_POWER_BROKER = '0'
  try {
    const scan = registry.rescan()
    await started
    await fsPromises.rename(scanRoot, originalScanRoot)
    await fsPromises.rename(replacementRoot, scanRoot)
    releaseCandidate()
    await assert.rejects(scan, /scan root changed|Extension root changed/)
  } finally {
    fsPromises.lstat = originalLstat
    releaseCandidate?.()
    if (priorBrokerMode === undefined) delete process.env.CODESURF_POWER_BROKER
    else process.env.CODESURF_POWER_BROKER = priorBrokerMode
  }
  await assert.rejects(fsPromises.stat(marker), { code: 'ENOENT' })
  assert.equal(registry.get('swap-power'), undefined)
})

test('non-media and disabled extensions skip recursive identity work until required', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-identity-skip-'))
  const bundledDir = join(temp, 'bundled')
  const nonMediaDir = join(bundledDir, 'non-media')
  const workspace = join(temp, 'workspace')
  const disabledMediaDir = join(
    workspace,
    '.codesurf',
    'extensions',
    'disabled-media',
  )
  await mkdir(nonMediaDir, { recursive: true })
  await mkdir(disabledMediaDir, { recursive: true })
  await writeFile(join(nonMediaDir, 'extension.json'), JSON.stringify({
    id: 'non-media',
    name: 'Non Media',
    version: '1.0.0',
    tier: 'safe',
  }))
  await writeFile(join(disabledMediaDir, 'extension.json'), JSON.stringify({
    id: 'disabled-media',
    name: 'Disabled Media',
    version: '1.0.0',
    tier: 'power',
    main: 'main.js',
    capabilities: [{ name: 'microphone' }],
  }))
  await writeFile(join(disabledMediaDir, 'main.js'), 'export function activate() {}')
  for (const path of [
    join(nonMediaDir, 'oversized.bin'),
    join(disabledMediaDir, 'oversized.bin'),
  ]) {
    const handle = await open(path, 'w')
    await handle.truncate(17 * 1024 * 1024)
    await handle.close()
  }

  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry({ bundledDirs: [bundledDir] })
  await registry.rescan(workspace)
  assert.equal(registry.get('non-media')?.mediaIdentity, null)
  assert.equal(registry.getExtensionMediaPermission('non-media'), undefined)
  assert.equal(registry.get('disabled-media')?.manifest._enabled, false)
  assert.equal(registry.get('disabled-media')?.mediaIdentity, null)
  await assert.rejects(
    registry.enable('disabled-media'),
    /file exceeds media identity byte budget/,
  )
  assert.equal(registry.get('disabled-media')?.manifest._enabled, false)
  assert.equal(registry.get('disabled-media')?.mediaIdentity, null)
})

test('enabling a disabled extension fails closed when its install root was replaced after scan', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-stale-enable-'))
  const workspace = join(temp, 'workspace')
  const extensionDir = join(
    workspace,
    '.codesurf',
    'extensions',
    'stale-media',
  )
  const originalDir = `${extensionDir}-original`
  const marker = join(temp, 'replacement-activated')
  const manifest = JSON.stringify({
    id: 'stale-media',
    name: 'Stale Media',
    version: '1.0.0',
    tier: 'power',
    main: 'main.cjs',
    capabilities: [{ name: 'microphone' }],
  })
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), manifest)
  await writeFile(join(extensionDir, 'main.cjs'), 'module.exports.activate = () => {}')

  const revoked: string[] = []
  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry({
    onSensitiveMediaRevoked: async (extensionId: string) => {
      revoked.push(extensionId)
    },
  })
  await registry.rescan(workspace)
  assert.equal(registry.get('stale-media')?.manifest._enabled, false)
  const revocationsBeforeEnable = revoked.length

  await fsPromises.rename(extensionDir, originalDir)
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), manifest)
  await writeFile(
    join(extensionDir, 'main.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'activated')`,
  )

  await assert.rejects(
    registry.enable('stale-media'),
    /Extension root changed after scan; rescan before enabling/,
  )
  assert.equal(registry.get('stale-media')?.manifest._enabled, false)
  assert.equal(registry.get('stale-media')?.mediaIdentity, null)
  assert.equal(
    revoked.length,
    revocationsBeforeEnable,
    'stale enable must fail before consent/grant mutation',
  )
  await assert.rejects(fsPromises.stat(marker), { code: 'ENOENT' })
})

test('enable rolls back when the install changes during permission persistence', { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-enable-persist-swap-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const extensionDir = join(workspace, '.codesurf', 'extensions', 'persist-swap')
  const originalDir = `${extensionDir}-original`
  const marker = join(temp, 'replacement-activated')
  const manifest = JSON.stringify({
    id: 'persist-swap',
    name: 'Persist Swap',
    version: '1.0.0',
    tier: 'power',
    main: 'main.cjs',
    capabilities: [{ name: 'microphone' }],
  })
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), manifest)
  await writeFile(join(extensionDir, 'main.cjs'), 'module.exports.activate = () => () => {}')

  const revoked: string[] = []
  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({
    onSensitiveMediaRevoked: async (extensionId: string) => {
      revoked.push(extensionId)
    },
  })
  await registry.rescan(workspace)
  const originalRename = fsPromises.rename
  let swapped = false
  fsPromises.rename = (async (...args: Parameters<typeof fsPromises.rename>) => {
    const result = await originalRename(...args)
    if (!swapped && String(args[1]).endsWith('/extension-security-state.json')) {
      swapped = true
      await fsPromises.rename(extensionDir, originalDir)
      await fsPromises.mkdir(extensionDir, { recursive: true })
      await fsPromises.writeFile(join(extensionDir, 'extension.json'), manifest)
      await fsPromises.writeFile(
        join(extensionDir, 'main.cjs'),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'activated')`,
      )
    }
    return result
  }) as typeof fsPromises.rename
  try {
    await assert.rejects(
      registry.enable('persist-swap'),
      /Extension root changed while enabling; rescan required/,
    )
  } finally {
    fsPromises.rename = originalRename
  }

  const extension = registry.get('persist-swap')
  assert.equal(swapped, true)
  assert.equal(extension?.manifest._enabled, false)
  assert.equal(extension?.mediaIdentity, null)
  assert.equal(extension?.mediaAttestation, null)
  assert.equal(extension?.deactivate, undefined)
  assert.deepEqual(
    registry.getMCPTools().filter((tool: { extId: string }) => tool.extId === 'persist-swap'),
    [],
  )
  await assert.rejects(fsPromises.stat(marker), { code: 'ENOENT' })
  assert.equal(revoked.filter(id => id === 'persist-swap').length >= 2, true)

  const securityState = JSON.parse(
    await fsPromises.readFile(join(home, 'extension-security-state.json'), 'utf8'),
  ) as {
    disabledExtensionIds: string[]
    enabledCatalogExtensionIds: string[]
    grants: Record<string, string[]>
  }
  assert.equal(securityState.disabledExtensionIds.includes('persist-swap'), false)
  assert.equal(securityState.enabledCatalogExtensionIds.includes('persist-swap'), false)
  assert.equal(Object.hasOwn(securityState.grants, 'persist-swap'), false)
})

test('failed power activation removes partial tools and restores disabled state', { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-enable-activation-fail-'))
  const workspace = join(temp, 'workspace')
  const extensionDir = join(workspace, '.codesurf', 'extensions', 'activation-fail')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'activation-fail',
    name: 'Activation Fail',
    version: '1.0.0',
    tier: 'power',
    main: 'main.cjs',
    capabilities: [{ name: 'microphone' }],
  }))
  await writeFile(join(extensionDir, 'main.cjs'), 'module.exports.activate = () => () => {}')

  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  let observedPartialTool = false
  let registry: InstanceType<typeof ExtensionRegistry>
  registry = new ExtensionRegistry({
    activatePower: async (
      _manifest: unknown,
      ctx: {
        mcp: {
          registerTool(tool: {
            name: string
            description: string
            inputSchema: Record<string, unknown>
            handler: () => Promise<string>
          }): void
        }
      },
    ) => {
      ctx.mcp.registerTool({
        name: 'leaked',
        description: 'must be rolled back',
        inputSchema: {},
        handler: async () => 'never',
      })
      observedPartialTool = registry.getMCPTools().some(
        (tool: { extId: string }) => tool.extId === 'activation-fail',
      )
      throw new Error('activation failed after registering')
    },
  })
  await registry.rescan(workspace)
  await assert.rejects(
    registry.enable('activation-fail'),
    /activation failed after registering/,
  )
  const extension = registry.get('activation-fail')
  assert.equal(observedPartialTool, true)
  assert.equal(extension?.manifest._enabled, false)
  assert.equal(extension?.mediaIdentity, null)
  assert.equal(extension?.mediaAttestation, null)
  assert.equal(extension?.deactivate, undefined)
  assert.deepEqual(
    registry.getMCPTools().filter((tool: { extId: string }) => tool.extId === 'activation-fail'),
    [],
  )
})

test('idempotent enable persistence failure preserves existing media consent identity', { concurrency: false }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-enable-idempotent-'))
  const bundledDir = join(temp, 'bundled')
  const extensionDir = join(bundledDir, 'enabled-media')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'enabled-media',
    name: 'Enabled Media',
    version: '1.0.0',
    tier: 'safe',
    capabilities: [{ name: 'microphone' }],
  }))
  const revoked: string[] = []
  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry({
    bundledDirs: [bundledDir],
    onSensitiveMediaRevoked: async (extensionId: string) => {
      revoked.push(extensionId)
    },
  })
  await registry.rescan()
  const identity = registry.get('enabled-media')?.mediaIdentity
  const attestation = registry.get('enabled-media')?.mediaAttestation
  assert.ok(identity)
  assert.ok(attestation)

  const originalRename = fsPromises.rename
  fsPromises.rename = (async (...args: Parameters<typeof fsPromises.rename>) => {
    if (String(args[1]).endsWith('/extension-security-state.json')) {
      throw new Error('simulated persistence failure')
    }
    return originalRename(...args)
  }) as typeof fsPromises.rename
  try {
    await assert.rejects(
      registry.enable('enabled-media'),
      /rollback was not durable/,
    )
  } finally {
    fsPromises.rename = originalRename
  }
  assert.deepEqual(revoked, [])
  assert.equal(registry.get('enabled-media')?.manifest._enabled, true)
  assert.equal(registry.get('enabled-media')?.mediaIdentity, identity)
  assert.equal(registry.get('enabled-media')?.mediaAttestation, attestation)
})

test('disable reports durable-state failure while keeping runtime authority revoked', {
  concurrency: false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-disable-failure-'))
  const home = join(temp, 'home')
  const bundledDir = join(temp, 'bundled')
  const extensionDir = join(bundledDir, 'disable-failure')
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'disable-failure',
    name: 'Disable Failure',
    version: '1.0.0',
    tier: 'safe',
    capabilities: [{ name: 'microphone' }],
  }))
  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({ bundledDirs: [bundledDir] })
  await registry.rescan()
  assert.equal(registry.get('disable-failure')?.manifest._enabled, true)

  const originalRename = fsPromises.rename
  fsPromises.rename = (async (...args: Parameters<typeof fsPromises.rename>) => {
    if (String(args[1]).endsWith('/extension-security-state.json')) {
      throw new Error('simulated disable persistence failure')
    }
    return originalRename(...args)
  }) as typeof fsPromises.rename
  try {
    assert.equal(await registry.disable('disable-failure'), false)
  } finally {
    fsPromises.rename = originalRename
  }
  assert.equal(registry.get('disable-failure')?.manifest._enabled, false)
  assert.equal(registry.get('disable-failure')?.mediaIdentity, null)
  assert.equal(registry.get('disable-failure')?.mediaAttestation, null)

  assert.equal(await registry.disable('disable-failure'), true)
  const restarted = new ExtensionRegistry({ bundledDirs: [bundledDir] })
  await restarted.rescan()
  assert.equal(restarted.get('disable-failure')?.manifest._enabled, false)
})

test('malformed extension security state stops a rescan fail closed', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-state-corrupt-'))
  const home = join(temp, 'home')
  const bundledDir = join(temp, 'bundled')
  const extensionDir = join(bundledDir, 'must-not-load')
  await mkdir(extensionDir, { recursive: true })
  await mkdir(home)
  await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({
    id: 'must-not-load',
    name: 'Must Not Load',
    version: '1.0.0',
    tier: 'safe',
  }))
  await writeFile(join(home, 'extension-security-state.json'), '{"version":1')
  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({ bundledDirs: [bundledDir] })
  await assert.rejects(registry.rescan(), /JSON|Unexpected/)
  assert.equal(registry.get('must-not-load'), undefined)
})

test('a losing catalog collision is rejected before recursive identity hashing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-collision-skip-'))
  const bundledDir = join(temp, 'bundled')
  const catalogDir = join(temp, 'catalog')
  const bundledExtension = join(bundledDir, 'media')
  const catalogExtension = join(catalogDir, 'media')
  const manifestFor = (name: string) => JSON.stringify({
    id: 'collision-media',
    name,
    version: '1.0.0',
    tier: 'safe',
    capabilities: [{ name: 'microphone' }],
  })
  await mkdir(bundledExtension, { recursive: true })
  await mkdir(catalogExtension, { recursive: true })
  await writeFile(join(bundledExtension, 'extension.json'), manifestFor('Bundled Winner'))
  await writeFile(join(catalogExtension, 'extension.json'), manifestFor('Catalog Loser'))
  const huge = await open(join(catalogExtension, 'oversized.bin'), 'w')
  await huge.truncate(17 * 1024 * 1024)
  await huge.close()

  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry({
    bundledDirs: [bundledDir],
    catalogDirs: [catalogDir],
  })
  await registry.rescan()
  assert.equal(registry.get('collision-media')?.manifest.name, 'Bundled Winner')
  assert.match(
    registry.getExtensionMediaPermission('collision-media')?.identity ?? '',
    /^sha256:[a-f0-9]{64}$/,
  )
})

test('a bundled extension wins over a same-id global install', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-bundled-global-collision-'))
  const home = join(temp, 'home')
  const bundledDir = join(temp, 'bundled')
  const globalDir = join(home, 'extensions')
  const bundledExtension = join(bundledDir, 'source-control')
  const globalExtension = join(globalDir, 'source-control')
  await mkdir(bundledExtension, { recursive: true })
  await mkdir(globalExtension, { recursive: true })
  await writeFile(join(bundledExtension, 'extension.json'), JSON.stringify({
    id: 'source-control',
    name: 'Bundled Source Control',
    version: '1.0.0',
    tier: 'safe',
  }))
  await writeFile(join(globalExtension, 'extension.json'), JSON.stringify({
    id: 'source-control',
    name: 'Stale Global Source Control',
    version: '1.0.0',
    tier: 'safe',
  }))

  const { ExtensionRegistry } = await loadRegistryModule(home)
  const registry = new ExtensionRegistry({ bundledDirs: [bundledDir] })
  await registry.rescan()
  assert.equal(registry.get('source-control')?.manifest.name, 'Bundled Source Control')
  assert.ok(
    (registry.get('source-control')?.manifest._path ?? '').endsWith(`${sep}bundled${sep}source-control`),
    `expected bundled install path, got ${registry.get('source-control')?.manifest._path}`,
  )
})
