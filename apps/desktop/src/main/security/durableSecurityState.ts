import { randomUUID } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'

export type SecurityStateCommitStatus = 'not-committed' | 'unknown'

export class SecurityStateCommitError extends Error {
  readonly commitStatus: SecurityStateCommitStatus
  readonly cause: unknown

  constructor(
    message: string,
    commitStatus: SecurityStateCommitStatus,
    cause: unknown,
  ) {
    super(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SecurityStateCommitError'
    this.commitStatus = commitStatus
    this.cause = cause
  }
}

type DirectoryBinding = {
  readonly path: string
  readonly dev: number | bigint
  readonly ino: number | bigint
}

type ReadDirectoryBoundary = {
  readonly path: string
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly handle: Awaited<ReturnType<typeof fs.open>>
}

function normalizePlatformSystemAliases(path: string): string {
  const absolute = resolve(path)
  if (process.platform !== 'darwin') return absolute
  for (const alias of ['/var', '/tmp', '/etc']) {
    if (absolute === alias || absolute.startsWith(`${alias}/`)) {
      return `/private${absolute}`
    }
  }
  return absolute
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const relative = absolute.slice(root.length)
  let current = root
  for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment)
    let info: Awaited<ReturnType<typeof fs.lstat>>
    try {
      info = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Security-state path contains a symbolic link: ${current}`)
    }
    if (!info.isDirectory()) {
      throw new Error(`Security-state ancestor is not a directory: ${current}`)
    }
  }
}

async function assertCanonicalReadAncestors(path: string): Promise<boolean> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const segment of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment)
    let info: Awaited<ReturnType<typeof fs.lstat>>
    try {
      info = await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Security-state read path has an unsafe ancestor: ${current}`)
    }
  }
  if (await fs.realpath(absolute) !== absolute) {
    throw new Error(`Security-state read directory is not canonical: ${absolute}`)
  }
  return true
}

async function captureReadBoundary(
  directory: string,
): Promise<ReadDirectoryBoundary | null> {
  if (!await assertCanonicalReadAncestors(directory)) return null
  const before = await fs.lstat(directory)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Security-state read parent is unsafe: ${directory}`)
  }
  const handle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    const opened = await handle.stat()
    if (
      !opened.isDirectory()
      || !sameIdentity(opened, before)
    ) {
      throw new Error(`Security-state read parent changed while opening: ${directory}`)
    }
    return {
      path: directory,
      dev: before.dev,
      ino: before.ino,
      handle,
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function assertReadBoundaryCurrent(
  boundary: ReadDirectoryBoundary,
): Promise<void> {
  if (!await assertCanonicalReadAncestors(boundary.path)) {
    throw new Error(`Security-state read parent disappeared: ${boundary.path}`)
  }
  const [current, opened] = await Promise.all([
    fs.lstat(boundary.path),
    boundary.handle.stat(),
  ])
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || !sameIdentity(current, boundary)
    || !opened.isDirectory()
    || !sameIdentity(opened, boundary)
  ) {
    throw new Error(`Security-state read parent changed: ${boundary.path}`)
  }
}

async function prepareDirectory(path: string): Promise<DirectoryBinding> {
  if (!isAbsolute(path)) {
    throw new Error(`Security-state path must be absolute: ${path}`)
  }
  await assertNoSymlinkAncestors(dirname(path))
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await assertNoSymlinkAncestors(dirname(path))
  const canonical = await fs.realpath(dirname(path))
  if (canonical !== resolve(dirname(path))) {
    throw new Error(`Security-state directory is not canonical: ${dirname(path)}`)
  }
  const info = await fs.lstat(dirname(path))
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Security-state parent is not a regular directory: ${dirname(path)}`)
  }
  await fs.chmod(dirname(path), 0o700)
  return { path: dirname(path), dev: info.dev, ino: info.ino }
}

async function assertDirectoryCurrent(binding: DirectoryBinding): Promise<void> {
  await assertNoSymlinkAncestors(binding.path)
  const info = await fs.lstat(binding.path)
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || !sameIdentity(binding, info)
    || await fs.realpath(binding.path) !== binding.path
  ) {
    throw new Error(`Security-state directory changed during update: ${binding.path}`)
  }
}

export function normalizeDirectorySyncError(
  platform: NodeJS.Platform,
  error: unknown,
): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (
    platform === 'win32'
    && ['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code ?? '')
  ) {
    return new Error(
      `Durable security-state directory sync is unsupported on this Windows filesystem (${code})`,
      { cause: error },
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

async function syncDirectory(binding: DirectoryBinding): Promise<void> {
  await assertDirectoryCurrent(binding)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(binding.path, fsConstants.O_RDONLY)
    const opened = await handle.stat()
    if (!opened.isDirectory() || !sameIdentity(binding, opened)) {
      throw new Error(`Security-state directory handle changed: ${binding.path}`)
    }
    await handle.sync()
    await assertDirectoryCurrent(binding)
  } catch (error) {
    throw normalizeDirectorySyncError(process.platform, error)
  } finally {
    await handle?.close()
  }
}

async function assertReplaceableTarget(filePath: string): Promise<void> {
  try {
    const info = await fs.lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Security-state target is not a regular file: ${filePath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * Reads one bounded security-state file without following a link and verifies
 * both its file identity and retained parent-directory identity throughout.
 */
export async function readSecurityStateFile(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('Security-state read limit must be a non-negative integer')
  }
  const absolutePath = normalizePlatformSystemAliases(filePath)
  const boundary = await captureReadBoundary(dirname(absolutePath))
  if (!boundary) return null
  let before: Awaited<ReturnType<typeof fs.lstat>>
  try {
    try {
      before = await fs.lstat(absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await assertReadBoundaryCurrent(boundary)
        return null
      }
      throw error
    }
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size > maxBytes
    ) {
      throw new Error(`Invalid security-state file: ${absolutePath}`)
    }
    await assertReadBoundaryCurrent(boundary)
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number'
      ? fsConstants.O_NOFOLLOW
      : 0
    const nonBlock = typeof fsConstants.O_NONBLOCK === 'number'
      ? fsConstants.O_NONBLOCK
      : 0
    const handle = await fs.open(
      absolutePath,
      fsConstants.O_RDONLY | noFollow | nonBlock,
    )
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile()
        || !sameIdentity(opened, before)
        || opened.size !== before.size
      ) {
        throw new Error(`Security-state file changed while opening: ${absolutePath}`)
      }
      const buffer = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        )
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset !== before.size) {
        throw new Error(`Security-state file changed while reading: ${absolutePath}`)
      }
      const after = await fs.lstat(absolutePath)
      if (
        !after.isFile()
        || after.isSymbolicLink()
        || !sameIdentity(after, before)
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error(`Security-state file changed while reading: ${absolutePath}`)
      }
      await assertReadBoundaryCurrent(boundary)
      return buffer.subarray(0, offset).toString('utf8')
    } finally {
      await handle.close()
    }
  } finally {
    await boundary.handle.close()
  }
}

/**
 * Durably replaces one security-state file without exposing a truncated JSON
 * document after a crash. Symlink ancestors and directory identity swaps are
 * rejected. Any failure at or after rename is reported as commit-uncertain so
 * callers can remain fail closed.
 */
export async function writeSecurityStateAtomic(
  filePath: string,
  contents: string,
): Promise<void> {
  const absolutePath = normalizePlatformSystemAliases(filePath)
  let renameAttempted = false
  let temporaryPath: string | undefined
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const directory = await prepareDirectory(absolutePath)
    temporaryPath = join(
      directory.path,
      `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number'
      ? fsConstants.O_NOFOLLOW
      : 0
    fileHandle = await fs.open(
      temporaryPath,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | noFollow,
      0o600,
    )
    const opened = await fileHandle.stat()
    if (!opened.isFile()) {
      throw new Error(`Security-state temporary is not a regular file: ${temporaryPath}`)
    }
    await fileHandle.writeFile(contents, 'utf8')
    await fileHandle.sync()
    await fileHandle.close()
    fileHandle = undefined

    await assertDirectoryCurrent(directory)
    await assertReplaceableTarget(absolutePath)
    renameAttempted = true
    await fs.rename(temporaryPath, absolutePath)
    await fs.chmod(absolutePath, 0o600)
    const finalInfo = await fs.lstat(absolutePath)
    if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) {
      throw new Error(`Security-state target changed after rename: ${absolutePath}`)
    }
    await syncDirectory(directory)
  } catch (cause) {
    throw new SecurityStateCommitError(
      `Failed to durably replace security state: ${absolutePath}`,
      renameAttempted ? 'unknown' : 'not-committed',
      cause,
    )
  } finally {
    await fileHandle?.close().catch(() => undefined)
    if (temporaryPath) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

export async function writeSecurityJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeSecurityStateAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function removeSecurityStateDurable(filePath: string): Promise<void> {
  const absolutePath = normalizePlatformSystemAliases(filePath)
  let unlinkAttempted = false
  try {
    const directory = await prepareDirectory(absolutePath)
    await assertReplaceableTarget(absolutePath)
    try {
      unlinkAttempted = true
      await fs.unlink(absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        unlinkAttempted = false
        return
      }
      throw error
    }
    await syncDirectory(directory)
  } catch (cause) {
    throw new SecurityStateCommitError(
      `Failed to durably remove security state: ${absolutePath}`,
      unlinkAttempted ? 'unknown' : 'not-committed',
      cause,
    )
  }
}
