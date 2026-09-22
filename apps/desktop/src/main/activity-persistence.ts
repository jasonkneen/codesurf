import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import type { ActivityRecord } from '../shared/activity-types.ts'
import { capActivityRecords } from './activity-cap.ts'
import {
  EMPTY_ACTIVITY_DOCUMENT_BYTES,
  fitActivityRecordsToDocument,
  serializeCompactActivityDocument,
} from './activity-document-format.ts'
import {
  ACTIVITY_DOCUMENT_VERSION,
  ActivityValidationError,
  MAX_ACTIVITY_FILE_BYTES,
  parseActivityDocument,
  recoverActivityDocument,
  validateActivityWorkspaceId,
} from './activity-validation.ts'
import { resolveInside } from './security/pathSegments.ts'

export interface LoadedActivityRecords {
  records: ActivityRecord[]
  needsRewrite: boolean
}

export interface ActivityPersistence {
  load(workspaceId: string): Promise<LoadedActivityRecords>
  save(workspaceId: string, records: ActivityRecord[]): Promise<void>
}

export interface FileActivityPersistenceOptions {
  homeDir: string
  maxFileBytes?: number
  maxQuarantineFiles?: number
  maxQuarantineBytes?: number
  readHooks?: {
    afterAncestorInspect?: (filePath: string) => void | Promise<void>
    afterOpen?: (filePath: string) => void | Promise<void>
  }
  writeHooks?: {
    afterAncestorInspect?: (filePath: string) => void | Promise<void>
    beforeRename?: (filePath: string) => void | Promise<void>
    afterRename?: (filePath: string) => void | Promise<void>
    beforeDirectorySync?: (filePath: string) => void | Promise<void>
  }
}

export const ACTIVITY_QUARANTINE_PREFIX = 'activity.quarantine-'
export const MAX_ACTIVITY_QUARANTINE_FILES = 3
export const MAX_ACTIVITY_QUARANTINE_BYTES = 64 * 1024 * 1024

export class ActivityPersistenceError extends Error {
  readonly code: string
  readonly path: string

  constructor(code: string, message: string, path: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ActivityPersistenceError'
    this.code = code
    this.path = path
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function persistenceError(code: string, message: string, path: string, cause?: unknown): ActivityPersistenceError {
  return new ActivityPersistenceError(code, message, path, cause === undefined ? undefined : { cause })
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  )
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

interface ActivityReadBoundary {
  paths: string[]
  identities: BigIntStats[]
  canonicalRoot: string
}

interface ActivityWriteBoundary extends ActivityReadBoundary {
  directoryHandle: Awaited<ReturnType<typeof fs.open>>
}

async function captureReadBoundary(
  filePath: string,
  hooks?: FileActivityPersistenceOptions['readHooks'],
): Promise<ActivityReadBoundary | null> {
  const activityDir = dirname(filePath)
  const workspaceDir = dirname(activityDir)
  const workspacesDir = dirname(workspaceDir)
  const paths = [workspacesDir, workspaceDir, activityDir]
  const identities: BigIntStats[] = []

  for (const path of paths) {
    let info: BigIntStats
    try {
      info = await fs.lstat(path, { bigint: true })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw persistenceError('unsafe_path', 'Unable to verify the activity storage path', filePath, error)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw persistenceError('unsafe_path', 'Activity storage ancestors must be real directories', filePath)
    }
    identities.push(info)
  }

  await hooks?.afterAncestorInspect?.(filePath)
  let canonicalRoot: string
  let canonicalWorkspace: string
  let canonicalActivityDir: string
  try {
    [canonicalRoot, canonicalWorkspace, canonicalActivityDir] = await Promise.all(
      paths.map(path => fs.realpath(path)),
    )
  } catch (error) {
    throw persistenceError('path_changed', 'Activity storage path changed during inspection', filePath, error)
  }
  if (
    !isContained(canonicalRoot, canonicalWorkspace)
    || !isContained(canonicalWorkspace, canonicalActivityDir)
  ) {
    throw persistenceError('unsafe_path', 'Activity storage path escapes its workspace root', filePath)
  }
  return { paths, identities, canonicalRoot }
}

async function verifyReadBoundary(boundary: ActivityReadBoundary, filePath: string): Promise<void> {
  for (let index = 0; index < boundary.paths.length; index += 1) {
    const info = await fs.lstat(boundary.paths[index], { bigint: true }).catch(() => null)
    if (
      !info
      || info.isSymbolicLink()
      || !info.isDirectory()
      || !sameIdentity(info, boundary.identities[index])
    ) {
      throw persistenceError('path_changed', 'Activity storage path changed during access', filePath)
    }
  }
  const canonicalActivityDir = await fs.realpath(boundary.paths.at(-1)!).catch(() => null)
  if (!canonicalActivityDir || !isContained(boundary.canonicalRoot, canonicalActivityDir)) {
    throw persistenceError('path_changed', 'Activity storage path changed during access', filePath)
  }
}

async function prepareWriteBoundary(
  filePath: string,
  hooks?: FileActivityPersistenceOptions['writeHooks'],
): Promise<ActivityWriteBoundary> {
  const activityDir = dirname(filePath)
  const workspaceDir = dirname(activityDir)
  const workspacesDir = dirname(workspaceDir)
  const homeDir = dirname(workspacesDir)
  const paths = [homeDir, workspacesDir, workspaceDir, activityDir]

  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  const identities: BigIntStats[] = []
  for (const [index, path] of paths.entries()) {
    if (index > 0) {
      try {
        await fs.mkdir(path, { mode: 0o700 })
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error
      }
    }
    const info = await fs.lstat(path, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw persistenceError('unsafe_path', 'Activity storage ancestors must be real directories', filePath)
    }
    identities.push(info)
  }

  await hooks?.afterAncestorInspect?.(filePath)
  let canonicalPaths: string[]
  try {
    canonicalPaths = await Promise.all(paths.map(path => fs.realpath(path)))
  } catch (error) {
    throw persistenceError('path_changed', 'Activity storage path changed during inspection', filePath, error)
  }
  for (let index = 1; index < canonicalPaths.length; index += 1) {
    if (!isContained(canonicalPaths[index - 1], canonicalPaths[index])) {
      throw persistenceError('unsafe_path', 'Activity storage path escapes its workspace root', filePath)
    }
  }

  const directoryHandle = await fs.open(
    activityDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const directoryInfo = await directoryHandle.stat({ bigint: true })
    if (!sameIdentity(directoryInfo, identities.at(-1)!)) {
      throw persistenceError('path_changed', 'Activity storage path changed during setup', filePath)
    }
    await directoryHandle.chmod(0o700)
    const boundary = {
      paths,
      identities,
      canonicalRoot: canonicalPaths[0],
      directoryHandle,
    }
    await verifyReadBoundary(boundary, filePath)
    return boundary
  } catch (error) {
    await directoryHandle.close().catch(() => {})
    throw error
  }
}

export function activityStorePath(homeDirValue: string, workspaceIdValue: unknown): string {
  const homeDir = resolve(homeDirValue)
  const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
  const workspacesDir = resolveInside(homeDir, 'workspaces')
  return resolveInside(workspacesDir, workspaceId, '.codesurf', 'activity.json')
}

export function serializeActivityDocument(workspaceIdValue: unknown, recordsValue: ActivityRecord[]): string {
  const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
  const parsed = parseActivityDocument({
    version: ACTIVITY_DOCUMENT_VERSION,
    records: recordsValue,
  }, workspaceId)
  return serializeCompactActivityDocument(parsed.records)
}

export function activityModeNeedsRepair(
  mode: bigint,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32' && (mode & 0o777n) !== 0o600n
}

async function syncDirectoryHandle(handle: ActivityWriteBoundary['directoryHandle']): Promise<void> {
  try {
    await handle.sync()
  } catch (error) {
    if (
      !isNodeError(error)
      || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code ?? '')
    ) {
      throw error
    }
  }
}

async function durableAtomicWrite(
  filePath: string,
  content: string | Uint8Array,
  hooks?: FileActivityPersistenceOptions['writeHooks'],
): Promise<void> {
  const boundary = await prepareWriteBoundary(filePath, hooks)
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let handle
  let temporaryIdentity: BigIntStats | null = null
  let renamed = false
  try {
    await verifyReadBoundary(boundary, filePath)
    const existing = await fs.lstat(filePath, { bigint: true }).catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw error
    })
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw persistenceError('unsafe_path', 'Activity store must be a regular file', filePath)
    }

    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.chmod(0o600)
    const openedTemporaryIdentity = await handle.stat({ bigint: true })
    temporaryIdentity = openedTemporaryIdentity
    await verifyReadBoundary(boundary, filePath)
    const temporaryPathInfo = await fs.lstat(temporaryPath, { bigint: true })
    if (temporaryPathInfo.isSymbolicLink() || !sameIdentity(openedTemporaryIdentity, temporaryPathInfo)) {
      throw persistenceError('path_changed', 'Activity temporary file changed during access', filePath)
    }
    if (typeof content === 'string') await handle.writeFile(content, 'utf8')
    else await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined

    await verifyReadBoundary(boundary, filePath)
    const beforeRename = await fs.lstat(filePath, { bigint: true }).catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw error
    })
    if (
      beforeRename?.isSymbolicLink()
      || (existing === null && beforeRename !== null)
      || (existing !== null && (beforeRename === null || !sameIdentity(existing, beforeRename)))
    ) {
      throw persistenceError('path_changed', 'Activity store changed before commit', filePath)
    }
    await hooks?.beforeRename?.(filePath)
    await fs.rename(temporaryPath, filePath)
    renamed = true
    await hooks?.afterRename?.(filePath)
    await verifyReadBoundary(boundary, filePath)
    const committedInfo = await fs.lstat(filePath, { bigint: true })
    if (
      committedInfo.isSymbolicLink()
      || !committedInfo.isFile()
      || !temporaryIdentity
      || !sameIdentity(temporaryIdentity, committedInfo)
    ) {
      throw persistenceError('path_changed', 'Activity store changed during commit', filePath)
    }
    await hooks?.beforeDirectorySync?.(filePath)
    await syncDirectoryHandle(boundary.directoryHandle)
  } catch (error) {
    await handle?.close().catch(() => {})
    if (!renamed && temporaryIdentity) {
      const current = await fs.lstat(temporaryPath, { bigint: true }).catch(() => null)
      if (current && sameIdentity(current, temporaryIdentity)) {
        await fs.unlink(temporaryPath).catch(() => {})
      }
    }
    if (renamed) {
      throw persistenceError(
        'commit_uncertain',
        'Activity store commit durability could not be confirmed',
        filePath,
        error,
      )
    }
    throw error
  } finally {
    await boundary.directoryHandle.close().catch(() => {})
  }
}

interface QuarantinePolicy {
  maxFiles: number
  maxBytes: number
}

async function fileMatchesBytes(path: string, bytes: Uint8Array): Promise<boolean> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return false
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.size !== BigInt(bytes.byteLength)) return false
    const existing = await handle.readFile()
    return existing.equals(Buffer.from(bytes))
  } finally {
    await handle.close().catch(() => {})
  }
}

async function pruneActivityQuarantines(directory: string, policy: QuarantinePolicy): Promise<void> {
  const names = (await fs.readdir(directory))
    .filter(name => name.startsWith(ACTIVITY_QUARANTINE_PREFIX) && name.endsWith('.json'))
  const entries = (await Promise.all(names.map(async name => {
    const path = join(directory, name)
    const info = await fs.lstat(path, { bigint: true }).catch(() => null)
    return info?.isFile() && !info.isSymbolicLink() ? { name, path, info } : null
  })))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => (
      Number(right.info.mtimeNs - left.info.mtimeNs)
      || right.name.localeCompare(left.name)
    ))

  let keptFiles = 0
  let keptBytes = 0n
  for (const entry of entries) {
    const canKeep = (
      keptFiles < policy.maxFiles
      && keptBytes + entry.info.size <= BigInt(policy.maxBytes)
    )
    if (canKeep) {
      keptFiles += 1
      keptBytes += entry.info.size
      continue
    }
    const current = await fs.lstat(entry.path, { bigint: true }).catch(() => null)
    if (current && sameIdentity(current, entry.info)) {
      await fs.unlink(entry.path)
    }
  }
}

async function quarantineActivityBytes(
  filePath: string,
  bytes: Uint8Array,
  policy: QuarantinePolicy,
  hooks?: FileActivityPersistenceOptions['writeHooks'],
): Promise<string | null> {
  const directory = dirname(filePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  let quarantinePath = join(directory, `${ACTIVITY_QUARANTINE_PREFIX}${digest}.json`)
  if (!(await fileMatchesBytes(quarantinePath, bytes))) {
    const existing = await fs.lstat(quarantinePath, { bigint: true }).catch(() => null)
    if (existing) {
      quarantinePath = join(
        directory,
        `${ACTIVITY_QUARANTINE_PREFIX}${digest}-${randomUUID()}.json`,
      )
    }
    await durableAtomicWrite(quarantinePath, bytes, hooks)
  }
  await pruneActivityQuarantines(directory, policy)
  return await fs.lstat(quarantinePath).then(() => quarantinePath).catch(() => null)
}

async function loadActivityFile(
  filePath: string,
  workspaceId: string,
  maxFileBytes: number,
  quarantinePolicy: QuarantinePolicy,
  hooks?: FileActivityPersistenceOptions['readHooks'],
  writeHooks?: FileActivityPersistenceOptions['writeHooks'],
): Promise<LoadedActivityRecords> {
  const boundary = await captureReadBoundary(filePath, hooks)
  if (!boundary) return { records: [], needsRewrite: false }

  let pathInfo: BigIntStats
  try {
    pathInfo = await fs.lstat(filePath, { bigint: true })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { records: [], needsRewrite: false }
    throw persistenceError('read_failed', 'Unable to inspect the activity store', filePath, error)
  }
  if (pathInfo.isSymbolicLink()) {
    throw persistenceError('unsafe_path', 'Activity store cannot be a symbolic link', filePath)
  }
  if (!pathInfo.isFile()) {
    throw persistenceError('not_a_file', 'Activity store path is not a regular file', filePath)
  }

  let handle
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { records: [], needsRewrite: false }
    throw persistenceError('read_failed', 'Unable to open the activity store', filePath, error)
  }

  try {
    let openedInfo = await handle.stat({ bigint: true })
    await hooks?.afterOpen?.(filePath)
    await verifyReadBoundary(boundary, filePath)
    const verifiedPathInfo = await fs.lstat(filePath, { bigint: true }).catch(() => null)
    if (
      !openedInfo.isFile()
      || !verifiedPathInfo?.isFile()
      || verifiedPathInfo.isSymbolicLink()
      || !sameIdentity(openedInfo, pathInfo)
      || !sameIdentity(openedInfo, verifiedPathInfo)
    ) {
      throw persistenceError('path_changed', 'Activity store changed during access', filePath)
    }
    if (!openedInfo.isFile()) {
      throw persistenceError('not_a_file', 'Activity store path is not a regular file', filePath)
    }
    if (activityModeNeedsRepair(openedInfo.mode)) {
      try {
        await handle.chmod(0o600)
      } catch (error) {
        throw persistenceError(
          'permission_repair_failed',
          'Unable to secure the activity store permissions',
          filePath,
          error,
        )
      }
      openedInfo = await handle.stat({ bigint: true })
      const repairedPathInfo = await fs.lstat(filePath, { bigint: true }).catch(() => null)
      if (
        !repairedPathInfo?.isFile()
        || repairedPathInfo.isSymbolicLink()
        || !sameIdentity(openedInfo, repairedPathInfo)
        || activityModeNeedsRepair(openedInfo.mode)
      ) {
        throw persistenceError('path_changed', 'Activity store changed during permission repair', filePath)
      }
    }
    if (openedInfo.size > BigInt(maxFileBytes)) {
      throw persistenceError('file_too_large', `Activity store exceeds ${maxFileBytes} bytes`, filePath)
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxFileBytes) {
      throw persistenceError('file_too_large', `Activity store exceeds ${maxFileBytes} bytes`, filePath)
    }
    const finalInfo = await handle.stat({ bigint: true })
    const finalPathInfo = await fs.lstat(filePath, { bigint: true }).catch(() => null)
    await verifyReadBoundary(boundary, filePath)
    if (
      !finalPathInfo?.isFile()
      || finalPathInfo.isSymbolicLink()
      || !sameSnapshot(openedInfo, finalInfo)
      || !sameIdentity(openedInfo, finalPathInfo)
    ) {
      throw persistenceError('path_changed', 'Activity store changed while it was being read', filePath)
    }

    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      await quarantineActivityBytes(filePath, bytes, quarantinePolicy, writeHooks)
      return { records: [], needsRewrite: true }
    }

    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      await quarantineActivityBytes(filePath, bytes, quarantinePolicy, writeHooks)
      return { records: [], needsRewrite: true }
    }

    try {
      const recovered = recoverActivityDocument(value, workspaceId)
      if (recovered.requiresQuarantine) {
        await quarantineActivityBytes(filePath, bytes, quarantinePolicy, writeHooks)
      }
      const capped = capActivityRecords(recovered.records)
      const fitted = fitActivityRecordsToDocument(capped, maxFileBytes)
      return {
        records: fitted.records,
        needsRewrite: (
          recovered.needsRewrite
          || capped !== recovered.records
          || fitted.trimmed
        ),
      }
    } catch (error) {
      if (error instanceof ActivityValidationError && error.code === 'future_document_version') {
        throw persistenceError(
          'future_document_version',
          'Activity store was written by a newer CodeSurf version',
          filePath,
          error,
        )
      }
      throw persistenceError('invalid_document', 'Activity store schema is invalid or unsupported', filePath, error)
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

export function createFileActivityPersistence(options: FileActivityPersistenceOptions): ActivityPersistence {
  const homeDir = resolve(options.homeDir)
  const maxFileBytes = options.maxFileBytes ?? MAX_ACTIVITY_FILE_BYTES
  const maxQuarantineFiles = options.maxQuarantineFiles ?? MAX_ACTIVITY_QUARANTINE_FILES
  const maxQuarantineBytes = options.maxQuarantineBytes ?? MAX_ACTIVITY_QUARANTINE_BYTES
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new TypeError('maxFileBytes must be a positive integer')
  }
  if (maxFileBytes < EMPTY_ACTIVITY_DOCUMENT_BYTES) {
    throw new TypeError(`maxFileBytes must be at least ${EMPTY_ACTIVITY_DOCUMENT_BYTES}`)
  }
  if (!Number.isSafeInteger(maxQuarantineFiles) || maxQuarantineFiles < 0) {
    throw new TypeError('maxQuarantineFiles must be a non-negative integer')
  }
  if (!Number.isSafeInteger(maxQuarantineBytes) || maxQuarantineBytes < 0) {
    throw new TypeError('maxQuarantineBytes must be a non-negative integer')
  }

  return {
    async load(workspaceIdValue) {
      const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
      return loadActivityFile(
        activityStorePath(homeDir, workspaceId),
        workspaceId,
        maxFileBytes,
        {
          maxFiles: maxQuarantineFiles,
          maxBytes: maxQuarantineBytes,
        },
        options.readHooks,
        options.writeHooks,
      )
    },
    async save(workspaceIdValue, records) {
      const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
      const filePath = activityStorePath(homeDir, workspaceId)
      const serialized = serializeActivityDocument(workspaceId, records)
      if (Buffer.byteLength(serialized, 'utf8') > maxFileBytes) {
        throw persistenceError('file_too_large', `Activity store exceeds ${maxFileBytes} bytes`, filePath)
      }
      try {
        await durableAtomicWrite(filePath, serialized, options.writeHooks)
      } catch (error) {
        if (error instanceof ActivityPersistenceError) throw error
        throw persistenceError('write_failed', 'Unable to persist the activity store', filePath, error)
      }
    },
  }
}
