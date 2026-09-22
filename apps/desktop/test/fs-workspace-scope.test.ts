import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'
import {
  assertPathAllowedForFs,
  cleanupCreatedCopyIfUnchanged,
  copyFileNoFollow,
  isPathUnderRoot,
  registerFsIPC,
  validateCanonicalFsPath,
  validateCanonicalFsPathDetails,
  validateFsPath,
  writeUtf8FileNoFollow,
  type FsIpcRegistrationDependencies,
  type FsPathScopeOptions,
} from '../src/main/ipc/fs.ts'
import { CODESURF_HOME } from '../src/main/paths.ts'

// `validateFsPath`'s `resolveHome()` falls back to `process.env.HOME` /
// `os.homedir()` outside of Electron, which is the case here.
const HOME = process.env.HOME || process.env.USERPROFILE || homedir()
const execFileAsync = promisify(execFile)

async function createFsFixture(): Promise<{
  root: string
  workspace: string
  outside: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-fs-scope-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await Promise.all([
    mkdir(workspace),
    mkdir(outside),
  ])
  return { root, workspace, outside }
}

const scopedTo = (workspace: string) => ({
  restrictToWorkspaceRoots: true,
  allowedRoots: [workspace],
})

type CapturedIpcHandler = (event: unknown, ...args: unknown[]) => unknown

function captureFsHandlers(
  scope: FsPathScopeOptions,
  overrides?: Omit<FsIpcRegistrationDependencies, 'ipcMain'>,
): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  invokeWithEvent: (
    channel: string,
    event: unknown,
    ...args: unknown[]
  ) => Promise<unknown>
} {
  const handlers = new Map<string, CapturedIpcHandler>()
  const ipcMain: NonNullable<FsIpcRegistrationDependencies['ipcMain']> = {
    handle(channel, listener) {
      handlers.set(channel, listener as unknown as CapturedIpcHandler)
    },
  }
  const shell: NonNullable<FsIpcRegistrationDependencies['shell']> = {
    showItemInFolder() {},
  }

  registerFsIPC({
    ...overrides,
    ipcMain,
    shell: overrides?.shell ?? shell,
    validatePath: overrides?.validatePath ?? (
      (filePath, intent, _workspaceId, operationOptions) => (
        validateCanonicalFsPathDetails(filePath, intent, {
          ...scope,
          ...operationOptions,
        })
      )
    ),
  })

  async function invokeWithEvent(
    channel: string,
    event: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = handlers.get(channel)
    assert.ok(handler, `Expected ${channel} to be registered`)
    return await handler(event, ...args)
  }

  return {
    async invoke(channel, ...args) {
      return invokeWithEvent(channel, {}, ...args)
    },
    invokeWithEvent,
  }
}

describe('isPathUnderRoot', () => {
  test('matches exact root path', () => {
    assert.equal(isPathUnderRoot('/tmp/workspace', '/tmp/workspace'), true)
  })

  test('matches nested file under root', () => {
    assert.equal(isPathUnderRoot('/tmp/workspace/src/app.ts', '/tmp/workspace'), true)
  })

  test('rejects sibling paths that share a prefix', () => {
    assert.equal(isPathUnderRoot('/tmp/workspace-other/file.ts', '/tmp/workspace'), false)
  })

  test('rejects paths outside root', () => {
    assert.equal(isPathUnderRoot('/etc/passwd', '/tmp/workspace'), false)
  })
})

describe('validateCanonicalFsPath operation-aware authorization', () => {
  test('allows read, write, and create below a real workspace root', async () => {
    const fixture = await createFsFixture()
    try {
      const filePath = join(fixture.workspace, 'allowed.txt')
      await writeFile(filePath, 'before', 'utf8')

      const readPath = await validateCanonicalFsPath(filePath, 'read', scopedTo(fixture.workspace))
      assert.equal(await readFile(readPath, 'utf8'), 'before')

      const writePath = await validateCanonicalFsPath(filePath, 'write', scopedTo(fixture.workspace))
      await writeFile(writePath, 'after', 'utf8')
      assert.equal(await readFile(filePath, 'utf8'), 'after')

      const newFilePath = join(fixture.workspace, 'created.txt')
      const createPath = await validateCanonicalFsPath(
        newFilePath,
        'create',
        scopedTo(fixture.workspace),
      )
      await writeFile(createPath, 'created', 'utf8')
      assert.equal(await readFile(newFilePath, 'utf8'), 'created')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('ignores an unavailable unrelated root but fails closed beneath it', async () => {
    const fixture = await createFsFixture()
    try {
      const validFile = join(fixture.workspace, 'valid.txt')
      const brokenRoot = join(fixture.root, 'broken-root')
      await writeFile(validFile, 'valid', 'utf8')
      await symlink(join(fixture.root, 'missing-root-target'), brokenRoot)

      const canonical = await validateCanonicalFsPath(validFile, 'read', {
        restrictToWorkspaceRoots: true,
        allowedRoots: [brokenRoot, fixture.workspace],
      })
      assert.equal(await readFile(canonical, 'utf8'), 'valid')

      await assert.rejects(
        validateCanonicalFsPath(join(brokenRoot, 'unavailable.txt'), 'read', {
          restrictToWorkspaceRoots: true,
          allowedRoots: [brokenRoot, fixture.workspace],
        }),
        /broken symbolic link|outside allowed workspace roots/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('a broken CODESURF_HOME does not disable another workspace or OpenCode reads', async () => {
    const fixture = await createFsFixture()
    try {
      const fakeHome = join(fixture.root, 'home')
      const validWorkspace = join(fixture.root, 'valid-workspace')
      const validFile = join(validWorkspace, 'valid.txt')
      const skillPath = join(fakeHome, '.config', 'opencode', 'skills', 'skill.md')
      const brokenCodesurfHome = join(fixture.root, 'broken-codesurf-home')
      await mkdir(dirname(skillPath), { recursive: true })
      await mkdir(validWorkspace)
      await writeFile(validFile, 'workspace', 'utf8')
      await writeFile(skillPath, 'skill', 'utf8')
      await symlink(join(fixture.root, 'missing-codesurf-home'), brokenCodesurfHome)

      const moduleUrl = new URL('../src/main/ipc/fs.ts', import.meta.url).href
      const script = `
        import { readFile } from 'node:fs/promises'
        import { validateCanonicalFsPath } from ${JSON.stringify(moduleUrl)}
        const workspacePath = await validateCanonicalFsPath(
          ${JSON.stringify(validFile)},
          'read',
          {
            restrictToWorkspaceRoots: true,
            allowedRoots: [${JSON.stringify(validWorkspace)}],
          },
        )
        const skillPath = await validateCanonicalFsPath(
          ${JSON.stringify(skillPath)},
          'read',
          {
            restrictToWorkspaceRoots: true,
            allowedRoots: [${JSON.stringify(brokenCodesurfHome)}],
            allowReadOnlyOpenCodeConfig: true,
          },
        )
        process.stdout.write(JSON.stringify([
          await readFile(workspacePath, 'utf8'),
          await readFile(skillPath, 'utf8'),
        ]))
      `
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '--eval', script],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            CODESURF_HOME: brokenCodesurfHome,
          },
        },
      )
      assert.deepEqual(JSON.parse(stdout), ['workspace', 'skill'])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects an external-file symlink for read and write intents', async () => {
    const fixture = await createFsFixture()
    try {
      const externalFile = join(fixture.outside, 'secret.txt')
      const linkedFile = join(fixture.workspace, 'linked-secret.txt')
      await writeFile(externalFile, 'secret', 'utf8')
      await symlink(externalFile, linkedFile)

      for (const intent of ['read', 'write'] as const) {
        await assert.rejects(
          validateCanonicalFsPath(linkedFile, intent, scopedTo(fixture.workspace)),
          /outside allowed workspace roots|symbolic link/,
        )
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('follows a final in-workspace file symlink for reads but rejects writes', async () => {
    const fixture = await createFsFixture()
    try {
      const targetFile = join(fixture.workspace, 'target.txt')
      const linkedFile = join(fixture.workspace, 'linked.txt')
      await writeFile(targetFile, 'inside', 'utf8')
      await symlink(targetFile, linkedFile)

      assert.equal(
        await validateCanonicalFsPath(linkedFile, 'read', scopedTo(fixture.workspace)),
        await realpath(targetFile),
      )
      await assert.rejects(
        validateCanonicalFsPath(linkedFile, 'write', scopedTo(fixture.workspace)),
        /symbolic link/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects an external-directory symlink for list, create, delete, and copy destination intents', async () => {
    const fixture = await createFsFixture()
    try {
      const linkedDirectory = join(fixture.workspace, 'linked-directory')
      await symlink(fixture.outside, linkedDirectory)

      for (const intent of ['read-directory', 'directory'] as const) {
        await assert.rejects(
          validateCanonicalFsPath(linkedDirectory, intent, scopedTo(fixture.workspace)),
          /outside allowed workspace roots|symbolic link/,
        )
      }
      await assert.rejects(
        validateCanonicalFsPath(
          join(linkedDirectory, 'created.txt'),
          'create',
          scopedTo(fixture.workspace),
        ),
        /outside allowed workspace roots/,
      )
      await assert.rejects(
        validateCanonicalFsPath(linkedDirectory, 'write', scopedTo(fixture.workspace)),
        /outside allowed workspace roots|symbolic link/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('follows a final in-workspace directory symlink for reads but rejects writes', async () => {
    const fixture = await createFsFixture()
    try {
      const targetDirectory = join(fixture.workspace, 'target-directory')
      const linkedDirectory = join(fixture.workspace, 'linked-directory')
      await mkdir(targetDirectory)
      await symlink(targetDirectory, linkedDirectory)

      assert.equal(
        await validateCanonicalFsPath(linkedDirectory, 'read-directory', scopedTo(fixture.workspace)),
        await realpath(targetDirectory),
      )
      for (const intent of ['directory', 'write'] as const) {
        await assert.rejects(
          validateCanonicalFsPath(linkedDirectory, intent, scopedTo(fixture.workspace)),
          /symbolic link/,
        )
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects a symlink to a sensitive home path with workspace scoping disabled', {
    concurrency: false,
  }, async () => {
    const fixture = await createFsFixture()
    const originalHome = process.env.HOME
    try {
      const fakeHome = join(fixture.root, 'home')
      const sshDir = join(fakeHome, '.ssh')
      await mkdir(sshDir, { recursive: true })
      const secretPath = join(sshDir, 'id_test')
      await writeFile(secretPath, 'secret', 'utf8')
      const linkedSecret = join(fixture.workspace, 'linked-sensitive')
      await symlink(secretPath, linkedSecret)
      process.env.HOME = fakeHome

      await assert.rejects(
        validateCanonicalFsPath(linkedSecret, 'read'),
        /sensitive directory/,
      )
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects a missing target below a symlinked parent', async () => {
    const fixture = await createFsFixture()
    try {
      const linkedDirectory = join(fixture.workspace, 'linked-parent')
      await symlink(fixture.outside, linkedDirectory)

      await assert.rejects(
        validateCanonicalFsPath(
          join(linkedDirectory, 'new.txt'),
          'create',
          scopedTo(fixture.workspace),
        ),
        /outside allowed workspace roots/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('canonicalizes a configured workspace root that is itself a symlink', async () => {
    const fixture = await createFsFixture()
    try {
      const configuredRoot = join(fixture.root, 'configured-root')
      const filePath = join(configuredRoot, 'inside.txt')
      await writeFile(join(fixture.workspace, 'inside.txt'), 'inside', 'utf8')
      await symlink(fixture.workspace, configuredRoot)

      const canonical = await validateCanonicalFsPath(filePath, 'read', scopedTo(configuredRoot))
      assert.equal(canonical, await realpath(join(fixture.workspace, 'inside.txt')))

      const validatedRoot = await validateCanonicalFsPathDetails(
        configuredRoot,
        'directory',
        scopedTo(configuredRoot),
      )
      assert.equal(validatedRoot.operationPath, await realpath(fixture.workspace))
      assert.equal(validatedRoot.displayPath, configuredRoot)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('validates rename and copy endpoints independently', async () => {
    const fixture = await createFsFixture()
    try {
      const externalFile = join(fixture.outside, 'source.txt')
      const escapedSource = join(fixture.workspace, 'escaped-source.txt')
      const escapedDestination = join(fixture.workspace, 'escaped-destination')
      await writeFile(externalFile, 'outside', 'utf8')
      await symlink(externalFile, escapedSource)
      await symlink(fixture.outside, escapedDestination)

      await assert.rejects(
        validateCanonicalFsPath(escapedSource, 'read', scopedTo(fixture.workspace)),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        validateCanonicalFsPath(
          join(escapedDestination, 'copied.txt'),
          'create',
          scopedTo(fixture.workspace),
        ),
        /outside allowed workspace roots/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('keeps the OpenCode carve-out read-only', {
    concurrency: false,
  }, async () => {
    const fixture = await createFsFixture()
    const originalHome = process.env.HOME
    try {
      const fakeHome = join(fixture.root, 'home')
      const skillPath = join(fakeHome, '.config', 'opencode', 'skills', 'skill.md')
      await mkdir(dirname(skillPath), { recursive: true })
      await writeFile(skillPath, 'skill', 'utf8')
      process.env.HOME = fakeHome

      const readPath = await validateCanonicalFsPath(skillPath, 'read', {
        restrictToWorkspaceRoots: true,
        allowedRoots: [],
        allowReadOnlyOpenCodeConfig: true,
      })
      assert.equal(await readFile(readPath, 'utf8'), 'skill')

      await assert.rejects(
        validateCanonicalFsPath(skillPath, 'write', {
          restrictToWorkspaceRoots: true,
          allowedRoots: [],
          allowReadOnlyOpenCodeConfig: true,
        }),
        /sensitive directory/,
      )
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('keeps CODESURF_HOME available with no workspace roots', async () => {
    const statePath = join(
      CODESURF_HOME,
      `plan-013-${process.pid}`,
      'state.json',
    )
    const canonical = await validateCanonicalFsPath(statePath, 'create', {
      restrictToWorkspaceRoots: true,
      allowedRoots: [],
    })

    const canonicalCodesurfHome = await realpath(CODESURF_HOME).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return join(await realpath(dirname(CODESURF_HOME)), basename(CODESURF_HOME))
    })
    assert.equal(
      canonical,
      join(canonicalCodesurfHome, `plan-013-${process.pid}`, 'state.json'),
    )
  })
})

describe('ancestor-swap resistance', () => {
  test('detects a parent swap before content write and cleans its created inode', async () => {
    const fixture = await createFsFixture()
    try {
      const authorizedParent = join(fixture.workspace, 'authorized-parent')
      const movedParent = join(fixture.workspace, 'moved-parent')
      const targetPath = join(authorizedParent, 'created.txt')
      const escapedTarget = join(fixture.outside, 'created.txt')
      await mkdir(authorizedParent)

      const validated = await validateCanonicalFsPathDetails(
        targetPath,
        'create',
        scopedTo(fixture.workspace),
      )
      await assert.rejects(
        writeUtf8FileNoFollow(validated.operationPath, 'must-not-escape', {
          authorization: validated.authorization,
          async beforeOpen() {
            await rename(authorizedParent, movedParent)
            await symlink(fixture.outside, authorizedParent)
          },
        }),
        /changed during access/,
      )

      // O_EXCL can briefly create an empty file after the ancestor swap because
      // Node has no openat(2), but authorization runs before content mutation
      // and removes only the inode opened by this call.
      await assert.rejects(lstat(escapedTarget), { code: 'ENOENT' })
      await assert.rejects(lstat(join(movedParent, 'created.txt')), { code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('does not truncate an existing external file after a parent swap', async () => {
    const fixture = await createFsFixture()
    try {
      const authorizedParent = join(fixture.workspace, 'authorized-parent')
      const movedParent = join(fixture.workspace, 'moved-parent')
      const targetPath = join(authorizedParent, 'existing.txt')
      const escapedTarget = join(fixture.outside, 'existing.txt')
      await mkdir(authorizedParent)
      await writeFile(targetPath, 'inside', 'utf8')
      await writeFile(escapedTarget, 'outside-secret', 'utf8')

      const validated = await validateCanonicalFsPathDetails(
        targetPath,
        'write',
        scopedTo(fixture.workspace),
      )
      await assert.rejects(
        writeUtf8FileNoFollow(validated.operationPath, 'must-not-overwrite', {
          authorization: validated.authorization,
          async beforeOpen() {
            await rename(authorizedParent, movedParent)
            await symlink(fixture.outside, authorizedParent)
          },
        }),
        /changed during access/,
      )

      assert.equal(await readFile(escapedTarget, 'utf8'), 'outside-secret')
      assert.equal(await readFile(join(movedParent, 'existing.txt'), 'utf8'), 'inside')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('registered filesystem handlers', () => {
  test('use canonical paths for I/O while preserving a symlink workspace identity', async () => {
    const fixture = await createFsFixture()
    try {
      const configuredRoot = join(fixture.root, 'configured-workspace')
      const sourceRoot = join(fixture.root, 'import-source')
      const canonicalFile = join(fixture.workspace, 'notes.txt')
      const lexicalFile = join(configuredRoot, 'notes.txt')
      const importSource = join(sourceRoot, 'import.txt')
      await mkdir(sourceRoot)
      await writeFile(canonicalFile, 'before', 'utf8')
      await writeFile(importSource, 'imported', 'utf8')
      await symlink(fixture.workspace, configuredRoot)

      const { invoke } = captureFsHandlers({
        restrictToWorkspaceRoots: true,
        allowedRoots: [configuredRoot, sourceRoot],
      })

      await invoke('fs:writeFile', lexicalFile, 'after')
      assert.equal(await readFile(canonicalFile, 'utf8'), 'after')
      assert.equal(await invoke('fs:readFile', lexicalFile), 'after')

      const entries = await invoke('fs:readDir', configuredRoot) as Array<{
        name: string
        path: string
        isDir: boolean
        ext: string
      }>
      const notesEntry = entries.find(entry => entry.name === 'notes.txt')
      assert.ok(notesEntry)
      // FileExplorer stores and passes this path back into later handlers. It
      // must retain the configured root identity rather than switching to the
      // real target halfway through navigation.
      assert.equal(notesEntry.path, lexicalFile)
      assert.equal(await invoke('fs:readFile', notesEntry.path), 'after')

      const copyResult = await invoke(
        'fs:copyIntoDir',
        importSource,
        configuredRoot,
      ) as { path: string }
      assert.deepEqual(copyResult, {
        path: join(configuredRoot, 'import.txt'),
      })
      assert.equal(
        await readFile(join(fixture.workspace, 'import.txt'), 'utf8'),
        'imported',
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('covers create, rename, reveal, probe, stat, text detection, and delete', async () => {
    const fixture = await createFsFixture()
    try {
      const revealedPaths: string[] = []
      const { invoke } = captureFsHandlers(scopedTo(fixture.workspace), {
        shell: {
          showItemInFolder(fullPath) {
            revealedPaths.push(fullPath)
          },
        },
      })
      const createdDir = join(fixture.workspace, 'created-dir')
      const createdFile = join(createdDir, 'created.txt')
      const renamedFile = join(createdDir, 'renamed.txt')

      await invoke('fs:createDir', createdDir)
      await invoke('fs:createFile', createdFile)
      assert.equal(await readFile(createdFile, 'utf8'), '')
      await invoke('fs:writeFile', createdFile, 'plain text')

      assert.deepEqual(await invoke('fs:probeDir', createdDir), { ok: true })
      const stats = await invoke('fs:stat', createdFile) as {
        size: number
        mtimeMs: number
        isFile: boolean
        isDir: boolean
      }
      assert.equal(stats.size, Buffer.byteLength('plain text'))
      assert.equal(stats.isFile, true)
      assert.equal(stats.isDir, false)
      assert.equal(await invoke('fs:isProbablyTextFile', createdFile), true)

      await invoke('fs:renameFile', createdFile, renamedFile)
      assert.equal(await readFile(renamedFile, 'utf8'), 'plain text')
      await invoke('fs:revealInFinder', renamedFile)
      assert.deepEqual(revealedPaths, [await realpath(renamedFile)])

      await invoke('fs:deleteFile', renamedFile)
      await assert.rejects(lstat(renamedFile), { code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('deletes an in-workspace symlink entry without touching its external target', async () => {
    const fixture = await createFsFixture()
    try {
      const externalTarget = join(fixture.outside, 'keep.txt')
      const workspaceLink = join(fixture.workspace, 'safe-link.txt')
      await writeFile(externalTarget, 'keep-me', 'utf8')
      await symlink(externalTarget, workspaceLink)

      const { invoke } = captureFsHandlers(scopedTo(fixture.workspace))
      await invoke('fs:deleteFile', workspaceLink)

      await assert.rejects(lstat(workspaceLink), { code: 'ENOENT' })
      assert.equal(await readFile(externalTarget, 'utf8'), 'keep-me')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('writes briefs through the real handler without leaking test state', async () => {
    const fixture = await createFsFixture()
    try {
      const appStateRoot = join(fixture.workspace, 'app-state')
      await mkdir(appStateRoot)
      const scope = scopedTo(fixture.workspace)
      const validatePath: NonNullable<
        FsIpcRegistrationDependencies['validatePath']
      > = async (filePath, intent, _workspaceId, operationOptions) => {
        const lexicalPath = resolve(filePath)
        if (isPathUnderRoot(lexicalPath, CODESURF_HOME)) {
          const mappedPath = join(
            appStateRoot,
            relative(CODESURF_HOME, lexicalPath),
          )
          const validated = await validateCanonicalFsPathDetails(
            mappedPath,
            intent,
            {
              ...scope,
              ...operationOptions,
            },
          )
          return {
            ...validated,
            displayPath: lexicalPath,
          }
        }
        return validateCanonicalFsPathDetails(filePath, intent, {
          ...scope,
          ...operationOptions,
        })
      }
      const { invoke } = captureFsHandlers(scope, { validatePath })

      const returnedPath = await invoke(
        'fs:writeBrief',
        'card-123',
        '# Brief',
      )
      assert.equal(returnedPath, join(CODESURF_HOME, 'briefs', 'card-123.md'))
      assert.equal(
        await readFile(join(appStateRoot, 'briefs', 'card-123.md'), 'utf8'),
        '# Brief',
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('stops the original watcher after a symlink workspace root is retargeted', async () => {
    const fixture = await createFsFixture()
    try {
      const configuredRoot = join(fixture.root, 'configured-workspace')
      await symlink(fixture.workspace, configuredRoot)
      const scope: FsPathScopeOptions = {
        restrictToWorkspaceRoots: true,
        allowedRoots: [configuredRoot, fixture.workspace, fixture.outside],
      }
      let validationCount = 0
      let closeCount = 0
      const watchedPaths: string[] = []
      const validatePath: NonNullable<
        FsIpcRegistrationDependencies['validatePath']
      > = async (filePath, intent, _workspaceId, operationOptions) => {
        validationCount += 1
        return validateCanonicalFsPathDetails(filePath, intent, {
          ...scope,
          ...operationOptions,
        })
      }
      const watchDirectory = ((
        watchedPath: string,
      ) => {
        watchedPaths.push(watchedPath)
        return {
          close() {
            closeCount += 1
          },
        }
      }) as unknown as NonNullable<
        FsIpcRegistrationDependencies['watchDirectory']
      >
      const { invokeWithEvent } = captureFsHandlers(scope, {
        validatePath,
        watchDirectory,
      })
      const destroyedListeners: Array<() => void> = []
      const sender = {
        once(eventName: string, listener: () => void) {
          if (eventName === 'destroyed') destroyedListeners.push(listener)
          return this
        },
        isDestroyed() {
          return false
        },
        send() {},
      }
      const event = { sender }

      await invokeWithEvent('fs:watchStart', event, configuredRoot, 'workspace-1')
      assert.deepEqual(watchedPaths, [await realpath(fixture.workspace)])
      assert.equal(validationCount, 1)

      await rm(configuredRoot)
      await symlink(fixture.outside, configuredRoot)
      await invokeWithEvent('fs:watchStop', event, configuredRoot, 'workspace-1')

      assert.equal(validationCount, 1)
      assert.equal(closeCount, 1)
      assert.equal(destroyedListeners.length, 1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('reference-counts duplicate watches from the same renderer', async () => {
    const fixture = await createFsFixture()
    try {
      let watchCount = 0
      let closeCount = 0
      const watchDirectory = (() => {
        watchCount += 1
        return {
          close() {
            closeCount += 1
          },
        }
      }) as unknown as NonNullable<
        FsIpcRegistrationDependencies['watchDirectory']
      >
      const { invokeWithEvent } = captureFsHandlers(
        scopedTo(fixture.workspace),
        { watchDirectory },
      )
      const sender = {
        once() {
          return this
        },
        isDestroyed() {
          return false
        },
        send() {},
      }
      const event = { sender }

      await invokeWithEvent('fs:watchStart', event, fixture.workspace, 'workspace-1')
      await invokeWithEvent('fs:watchStart', event, fixture.workspace, 'workspace-1')
      assert.equal(watchCount, 1)

      await invokeWithEvent('fs:watchStop', event, fixture.workspace, 'workspace-1')
      assert.equal(closeCount, 0)
      await invokeWithEvent('fs:watchStop', event, fixture.workspace, 'workspace-1')
      assert.equal(closeCount, 1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('serializes an immediate stop behind an in-flight watch start', async () => {
    const fixture = await createFsFixture()
    try {
      let releaseValidation: (() => void) | undefined
      let markValidationStarted: (() => void) | undefined
      const validationGate = new Promise<void>(resolveGate => {
        releaseValidation = resolveGate
      })
      const validationStarted = new Promise<void>(resolveStarted => {
        markValidationStarted = resolveStarted
      })
      let watchCount = 0
      let closeCount = 0
      const validatePath: NonNullable<
        FsIpcRegistrationDependencies['validatePath']
      > = async (filePath, intent, _workspaceId, operationOptions) => {
        markValidationStarted?.()
        await validationGate
        return validateCanonicalFsPathDetails(filePath, intent, {
          ...scopedTo(fixture.workspace),
          ...operationOptions,
        })
      }
      const watchDirectory = (() => {
        watchCount += 1
        return {
          close() {
            closeCount += 1
          },
        }
      }) as unknown as NonNullable<
        FsIpcRegistrationDependencies['watchDirectory']
      >
      const { invokeWithEvent } = captureFsHandlers(
        scopedTo(fixture.workspace),
        { validatePath, watchDirectory },
      )
      const sender = {
        once() {
          return this
        },
        isDestroyed() {
          return false
        },
        send() {},
      }
      const event = { sender }

      const start = invokeWithEvent(
        'fs:watchStart',
        event,
        fixture.workspace,
        'workspace-1',
      )
      await validationStarted
      const stop = invokeWithEvent(
        'fs:watchStop',
        event,
        fixture.workspace,
        'workspace-1',
      )
      releaseValidation?.()
      await Promise.all([start, stop])

      assert.equal(watchCount, 1)
      assert.equal(closeCount, 1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('retargeted re-subscriptions retain both canonical watcher lifecycles', async () => {
    const fixture = await createFsFixture()
    try {
      const configuredRoot = join(fixture.root, 'configured-workspace')
      await symlink(fixture.workspace, configuredRoot)
      const scope: FsPathScopeOptions = {
        restrictToWorkspaceRoots: true,
        allowedRoots: [configuredRoot, fixture.workspace, fixture.outside],
      }
      const watchedPaths: string[] = []
      const closedPaths: string[] = []
      const watchDirectory = ((
        watchedPath: string,
      ) => {
        watchedPaths.push(watchedPath)
        return {
          close() {
            closedPaths.push(watchedPath)
          },
        }
      }) as unknown as NonNullable<
        FsIpcRegistrationDependencies['watchDirectory']
      >
      const { invokeWithEvent } = captureFsHandlers(scope, { watchDirectory })
      const destroyedListeners: Array<() => void> = []
      const sender = {
        once(eventName: string, listener: () => void) {
          if (eventName === 'destroyed') destroyedListeners.push(listener)
          return this
        },
        isDestroyed() {
          return false
        },
        send() {},
      }
      const event = { sender }

      await invokeWithEvent('fs:watchStart', event, configuredRoot, 'workspace-1')
      await rm(configuredRoot)
      await symlink(fixture.outside, configuredRoot)
      await invokeWithEvent('fs:watchStart', event, configuredRoot, 'workspace-1')

      const canonicalWorkspace = await realpath(fixture.workspace)
      const canonicalOutside = await realpath(fixture.outside)
      assert.deepEqual(watchedPaths, [canonicalWorkspace, canonicalOutside])

      await invokeWithEvent('fs:watchStop', event, configuredRoot, 'workspace-1')
      assert.deepEqual(closedPaths, [canonicalWorkspace])
      assert.equal(destroyedListeners.length, 1)

      destroyedListeners[0]()
      assert.deepEqual(closedPaths, [canonicalWorkspace, canonicalOutside])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('real handlers reject symlink escapes for read, write, list, and copy endpoints', async () => {
    const fixture = await createFsFixture()
    try {
      const sourceRoot = join(fixture.root, 'source')
      const deniedRoot = join(fixture.root, 'denied')
      const deniedFile = join(deniedRoot, 'secret.txt')
      const sourceFile = join(sourceRoot, 'source.txt')
      const escapedFile = join(fixture.workspace, 'escaped-file.txt')
      const escapedSource = join(sourceRoot, 'escaped-source.txt')
      const escapedDirectory = join(fixture.workspace, 'escaped-directory')
      const internalTargetDirectory = join(fixture.workspace, 'target-directory')
      const internalLinkedDirectory = join(fixture.workspace, 'linked-directory')
      await Promise.all([mkdir(sourceRoot), mkdir(deniedRoot), mkdir(internalTargetDirectory)])
      await Promise.all([
        writeFile(deniedFile, 'secret', 'utf8'),
        writeFile(sourceFile, 'source', 'utf8'),
      ])
      await Promise.all([
        symlink(deniedFile, escapedFile),
        symlink(deniedFile, escapedSource),
        symlink(deniedRoot, escapedDirectory),
        symlink(internalTargetDirectory, internalLinkedDirectory),
      ])

      const { invoke } = captureFsHandlers({
        restrictToWorkspaceRoots: true,
        allowedRoots: [fixture.workspace, sourceRoot],
      })

      await assert.rejects(
        invoke('fs:readFile', escapedFile),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:writeFile', escapedFile, 'overwrite'),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:readDir', escapedDirectory),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:copyIntoDir', escapedSource, fixture.workspace),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:copyIntoDir', join(sourceRoot, 'missing.txt'), escapedDirectory),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:copyIntoDir', sourceFile, internalLinkedDirectory),
        /symbolic link/,
      )
      await assert.rejects(readFile(join(internalTargetDirectory, 'source.txt'), 'utf8'), { code: 'ENOENT' })
      assert.equal(await readFile(deniedFile, 'utf8'), 'secret')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('copy failure cleanup', () => {
  test('removes a partial destination after a mid-copy failure', async () => {
    const fixture = await createFsFixture()
    try {
      const sourcePath = join(fixture.workspace, 'large-source.bin')
      const destinationPath = join(fixture.workspace, 'partial-copy.bin')
      await writeFile(sourcePath, Buffer.alloc(128 * 1024, 0x61))

      await assert.rejects(
        copyFileNoFollow(sourcePath, destinationPath, {
          afterChunkCopied() {
            throw new Error('injected mid-copy failure')
          },
        }),
        /injected mid-copy failure/,
      )
      await assert.rejects(lstat(destinationPath), { code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('removes the inode created by a failed copy', async () => {
    const fixture = await createFsFixture()
    try {
      const destinationPath = join(fixture.workspace, 'partial-copy.txt')
      await writeFile(destinationPath, 'partial', 'utf8')
      const createdStats = await lstat(destinationPath)

      assert.equal(
        await cleanupCreatedCopyIfUnchanged(destinationPath, {
          dev: createdStats.dev,
          ino: createdStats.ino,
        }),
        true,
      )
      await assert.rejects(lstat(destinationPath), { code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('preserves replacement files and symlinks', async () => {
    const fixture = await createFsFixture()
    try {
      const destinationPath = join(fixture.workspace, 'partial-copy.txt')
      await writeFile(destinationPath, 'partial', 'utf8')
      const createdStats = await lstat(destinationPath)
      await rm(destinationPath)
      await writeFile(destinationPath, 'replacement', 'utf8')

      assert.equal(
        await cleanupCreatedCopyIfUnchanged(destinationPath, {
          dev: createdStats.dev,
          ino: createdStats.ino,
        }),
        false,
      )
      assert.equal(await readFile(destinationPath, 'utf8'), 'replacement')

      await rm(destinationPath)
      const symlinkTarget = join(fixture.workspace, 'symlink-target.txt')
      await writeFile(symlinkTarget, 'target', 'utf8')
      await symlink(symlinkTarget, destinationPath)

      assert.equal(
        await cleanupCreatedCopyIfUnchanged(destinationPath, {
          dev: createdStats.dev,
          ino: createdStats.ino,
        }),
        false,
      )
      assert.equal((await lstat(destinationPath)).isSymbolicLink(), true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('assertPathAllowedForFs', () => {
  test('no-op when workspace scoping is disabled', () => {
    assert.doesNotThrow(() => assertPathAllowedForFs('/etc/passwd'))
    assert.doesNotThrow(() => assertPathAllowedForFs('/etc/passwd', { restrictToWorkspaceRoots: false }))
  })

  test('allows paths under configured workspace roots', () => {
    assert.doesNotThrow(() => assertPathAllowedForFs('/tmp/workspace/src/foo.ts', {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    }))
  })

  test('allows CODESURF_HOME when scoping is enabled', () => {
    assert.doesNotThrow(() => assertPathAllowedForFs(join(CODESURF_HOME, 'settings.json'), {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    }))
  })

  test('denies paths outside workspace roots when scoping is enabled', () => {
    assert.throws(
      () => assertPathAllowedForFs('/etc/passwd', {
        restrictToWorkspaceRoots: true,
        allowedRoots: ['/tmp/workspace'],
      }),
      /outside allowed workspace roots/,
    )
  })

  test('denies all non-CODESURF_HOME paths when no roots are configured', () => {
    assert.throws(
      () => assertPathAllowedForFs('/tmp/workspace/file.ts', {
        restrictToWorkspaceRoots: true,
        allowedRoots: [],
      }),
      /no workspace project folders configured/i,
    )
  })
})

describe('validateFsPath workspace scoping', () => {
  test('allows arbitrary paths when scoping is off', () => {
    const resolved = validateFsPath('/tmp/outside-home/file.txt')
    assert.equal(resolved, join('/tmp/outside-home/file.txt'))
  })

  test('allows workspace paths when scoping is on', () => {
    const resolved = validateFsPath('/tmp/workspace/readme.md', {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    })
    assert.equal(resolved, join('/tmp/workspace/readme.md'))
  })

  test('always allows CODESURF_HOME paths when scoping is on', () => {
    const resolved = validateFsPath(join(CODESURF_HOME, 'briefs/card.md'), {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    })
    assert.equal(resolved, join(CODESURF_HOME, 'briefs/card.md'))
  })

  test('rejects paths outside workspace roots when scoping is on', () => {
    assert.throws(
      () => validateFsPath('/etc/passwd', {
        restrictToWorkspaceRoots: true,
        allowedRoots: ['/tmp/workspace'],
      }),
      /outside allowed workspace roots/,
    )
  })
})

describe('validateFsPath sensitive-dir denylist (shared with file-protocol-auth)', () => {
  test('rejects ~/.git-credentials', () => {
    assert.throws(
      () => validateFsPath(join(HOME, '.git-credentials')),
      /sensitive directory/,
    )
  })

  test('rejects ~/.npmrc', () => {
    assert.throws(
      () => validateFsPath(join(HOME, '.npmrc')),
      /sensitive directory/,
    )
  })

  test('rejects ~/.kube/config', () => {
    assert.throws(
      () => validateFsPath(join(HOME, '.kube', 'config')),
      /sensitive directory/,
    )
  })

  test('allows ~/.config/opencode/skills/x.md with allowReadOnlyOpenCodeConfig', () => {
    const resolved = validateFsPath(join(HOME, '.config', 'opencode', 'skills', 'x.md'), {
      allowReadOnlyOpenCodeConfig: true,
    })
    assert.equal(resolved, join(HOME, '.config', 'opencode', 'skills', 'x.md'))
  })

  test('rejects ~/.config/other/x (as before)', () => {
    assert.throws(
      () => validateFsPath(join(HOME, '.config', 'other', 'x'), {
        allowReadOnlyOpenCodeConfig: true,
      }),
      /sensitive directory/,
    )
  })

  test('still allows a workspace-root path', () => {
    const resolved = validateFsPath('/tmp/workspace/readme.md', {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    })
    assert.equal(resolved, join('/tmp/workspace/readme.md'))
  })
})

describe('fs:readFilePrefix workspace and byte bounds', () => {
  test('passes workspace identity through validation and reads only the requested prefix', async () => {
    const fixture = await createFsFixture()
    try {
      const largeFile = join(fixture.workspace, 'large.txt')
      await writeFile(largeFile, `HEAD\n${'x'.repeat(2 * 1024 * 1024)}\nTAIL`, 'utf8')
      const validations: Array<{ path: string; workspaceId?: string }> = []
      const { invoke } = captureFsHandlers(scopedTo(fixture.workspace), {
        validatePath: async (filePath, intent, workspaceId, operationOptions) => {
          validations.push({ path: filePath, workspaceId })
          return await validateCanonicalFsPathDetails(filePath, intent, {
            ...scopedTo(fixture.workspace),
            ...operationOptions,
          })
        },
      })

      const prefix = await invoke('fs:readFilePrefix', largeFile, 1024, 'workspace-a')
      assert.equal(typeof prefix, 'string')
      assert.equal(Buffer.byteLength(prefix as string, 'utf8'), 1024)
      assert.match(prefix as string, /^HEAD\n/)
      assert.doesNotMatch(prefix as string, /TAIL/)
      assert.deepEqual(validations, [{ path: largeFile, workspaceId: 'workspace-a' }])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects invalid byte budgets before validation and rejects cross-workspace paths', async () => {
    const fixture = await createFsFixture()
    try {
      const outsideFile = join(fixture.outside, 'secret.txt')
      await writeFile(outsideFile, 'secret', 'utf8')
      let validations = 0
      const { invoke } = captureFsHandlers(scopedTo(fixture.workspace), {
        validatePath: async (filePath, intent, _workspaceId, operationOptions) => {
          validations += 1
          return await validateCanonicalFsPathDetails(filePath, intent, {
            ...scopedTo(fixture.workspace),
            ...operationOptions,
          })
        },
      })

      await assert.rejects(invoke('fs:readFilePrefix', outsideFile, 0, 'workspace-a'), /between 1 and 65536/)
      await assert.rejects(invoke('fs:readFilePrefix', outsideFile, 65_537, 'workspace-a'), /between 1 and 65536/)
      await assert.rejects(invoke('fs:readFilePrefix', outsideFile, 1.5, 'workspace-a'), /between 1 and 65536/)
      assert.equal(validations, 0)

      await assert.rejects(
        invoke('fs:readFilePrefix', outsideFile, 64, 'workspace-a'),
        /outside allowed workspace roots/,
      )
      assert.equal(validations, 1)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
