import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExtensionManifest } from '../../shared/types.ts'

export const MAX_EXTENSION_IDENTITY_DEPTH = 32
export const MAX_EXTENSION_IDENTITY_ENTRIES = 4096
export const MAX_EXTENSION_IDENTITY_FILES = 2048
export const MAX_EXTENSION_IDENTITY_FILE_BYTES = 16 * 1024 * 1024
export const MAX_EXTENSION_IDENTITY_TOTAL_BYTES = 64 * 1024 * 1024
export const MAX_EXTENSION_IDENTITY_MANIFEST_BYTES = 1024 * 1024
export const MAX_EXTENSION_IDENTITY_SYMLINK_BYTES = 8 * 1024

const READ_CHUNK_BYTES = 64 * 1024
const MAX_MANIFEST_DEPTH = 32
const MAX_MANIFEST_NODES = 8192
// O_NOFOLLOW is POSIX-only. On platforms where Node exposes no numeric flag,
// the retained-handle inode check plus post-open lstat/realpath containment
// remains the equivalent fail-closed guard before any bytes are read.
export function extensionIdentityOpenFlags(
  noFollow: number | null | undefined = constants.O_NOFOLLOW,
): number {
  return constants.O_RDONLY | (typeof noFollow === 'number' ? noFollow : 0)
}

type FileInfo = Awaited<ReturnType<typeof fs.lstat>>

interface IdentityBudget {
  entries: number
  files: number
  totalBytes: number
}

interface ManifestBudget {
  nodes: number
}

export interface ExtensionMediaRootBinding {
  readonly lexicalRoot: string
  readonly canonicalRoot: string
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly mode: number | bigint
  readonly size: number | bigint
  readonly mtimeMs: number | bigint
  readonly ctimeMs: number | bigint
  readonly birthtimeMs: number | bigint
}

export interface ExtensionMediaResourceAttestation {
  readonly digest: string
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly mode: number | bigint
  readonly size: number
  readonly mtimeMs: number | bigint
  readonly ctimeMs: number | bigint
  readonly birthtimeMs: number | bigint
}

export interface ExtensionMediaResourceAttestations extends Iterable<
  readonly [string, ExtensionMediaResourceAttestation]
> {
  readonly size: number
  get(path: string): ExtensionMediaResourceAttestation | undefined
  has(path: string): boolean
}

export interface ExtensionMediaAttestation {
  readonly identity: string
  readonly resources: ExtensionMediaResourceAttestations
}

class ImmutableResourceAttestations implements ExtensionMediaResourceAttestations {
  readonly #resources: ReadonlyMap<string, ExtensionMediaResourceAttestation>

  constructor(resources: ReadonlyMap<string, ExtensionMediaResourceAttestation>) {
    this.#resources = new Map(resources)
    Object.freeze(this)
  }

  get size(): number {
    return this.#resources.size
  }

  get(path: string): ExtensionMediaResourceAttestation | undefined {
    return this.#resources.get(path)
  }

  has(path: string): boolean {
    return this.#resources.has(path)
  }

  [Symbol.iterator](): IterableIterator<
    readonly [string, ExtensionMediaResourceAttestation]
  > {
    return this.#resources[Symbol.iterator]()
  }
}

export class ExtensionMediaIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtensionMediaIdentityError'
  }
}

function fail(message: string): never {
  throw new ExtensionMediaIdentityError(message)
}

function updateRecord(
  hash: ReturnType<typeof createHash>,
  record: readonly unknown[],
): void {
  hash.update(JSON.stringify(record))
  hash.update('\n')
}

function stableManifestValue(
  value: unknown,
  depth = 0,
  budget: ManifestBudget = { nodes: 0 },
): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_MANIFEST_NODES || depth > MAX_MANIFEST_DEPTH) {
    fail('Extension manifest exceeds media identity complexity budget')
  }
  if (Array.isArray(value)) {
    return value.map(item => stableManifestValue(item, depth + 1, budget))
  }
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .filter(key => key !== '_path' && key !== '_enabled')
      .sort()
      .map(key => [key, stableManifestValue(object[key], depth + 1, budget)]),
  )
}

function isContained(canonicalRoot: string, canonicalCandidate: string): boolean {
  const rel = relative(canonicalRoot, canonicalCandidate)
  return rel === '' || Boolean(
    rel
    && rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel),
  )
}

function sameObject(left: FileInfo, right: FileInfo): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
}

function rootBindingFromStat(
  lexicalRoot: string,
  canonicalRoot: string,
  info: FileInfo,
): ExtensionMediaRootBinding {
  return Object.freeze({
    lexicalRoot,
    canonicalRoot,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  })
}

function statMatchesRootBinding(
  info: FileInfo,
  binding: ExtensionMediaRootBinding,
): boolean {
  return info.dev === binding.dev
    && info.ino === binding.ino
    && info.mode === binding.mode
    && info.size === binding.size
    && info.mtimeMs === binding.mtimeMs
    && info.ctimeMs === binding.ctimeMs
    && info.birthtimeMs === binding.birthtimeMs
}

function sameRootBinding(
  left: ExtensionMediaRootBinding,
  right: ExtensionMediaRootBinding,
): boolean {
  return left.lexicalRoot === right.lexicalRoot
    && left.canonicalRoot === right.canonicalRoot
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
}

export async function captureExtensionMediaRoot(
  extensionRoot: string,
): Promise<ExtensionMediaRootBinding> {
  const lexicalRoot = resolve(extensionRoot)
  const lexicalStat = await fs.lstat(lexicalRoot)
  if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) {
    fail(`Extension root must be a regular directory: ${lexicalRoot}`)
  }
  const canonicalRoot = await fs.realpath(lexicalRoot)
  const canonicalStat = await fs.lstat(canonicalRoot)
  if (
    !canonicalStat.isDirectory()
    || canonicalStat.isSymbolicLink()
    || !sameObject(lexicalStat, canonicalStat)
  ) {
    fail(`Extension root changed while binding media identity: ${lexicalRoot}`)
  }
  return rootBindingFromStat(lexicalRoot, canonicalRoot, lexicalStat)
}

async function assertRootBindingCurrent(
  binding: ExtensionMediaRootBinding,
): Promise<void> {
  const current = await captureExtensionMediaRoot(binding.lexicalRoot)
  if (!sameRootBinding(current, binding)) {
    fail(`Extension root changed while computing media identity: ${binding.lexicalRoot}`)
  }
}

function safeFileSize(info: FileInfo, relativePath: string): number {
  const size = Number(info.size)
  if (!Number.isSafeInteger(size) || size < 0) {
    fail(`Extension file has invalid size for media identity: ${relativePath}`)
  }
  return size
}

async function assertContainedPath(
  canonicalRoot: string,
  absolutePath: string,
): Promise<string> {
  const canonicalPath = await fs.realpath(absolutePath).catch(() => {
    fail(`Extension path changed while computing media identity: ${absolutePath}`)
  })
  if (!isContained(canonicalRoot, canonicalPath)) {
    fail(`Extension path escapes media identity root: ${absolutePath}`)
  }
  return canonicalPath
}

async function assertStablePath(
  canonicalRoot: string,
  absolutePath: string,
  expected: FileInfo,
): Promise<void> {
  await assertContainedPath(canonicalRoot, absolutePath)
  const current = await fs.lstat(absolutePath).catch(() => {
    fail(`Extension path changed while computing media identity: ${absolutePath}`)
  })
  if (!sameObject(expected, current)) {
    fail(`Extension path changed while computing media identity: ${absolutePath}`)
  }
}

async function readDirectoryNames(
  canonicalRoot: string,
  directory: string,
  before: FileInfo,
  budget: IdentityBudget,
): Promise<string[]> {
  await assertStablePath(canonicalRoot, directory, before)
  const names: string[] = []
  const handle = await fs.opendir(directory)
  try {
    for await (const entry of handle) {
      budget.entries += 1
      if (budget.entries > MAX_EXTENSION_IDENTITY_ENTRIES) {
        fail(`Extension exceeds media identity entry budget (${MAX_EXTENSION_IDENTITY_ENTRIES})`)
      }
      names.push(entry.name)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  await assertStablePath(canonicalRoot, directory, before)
  names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return names
}

async function hashDirectory(
  hash: ReturnType<typeof createHash>,
  canonicalRoot: string,
  directory: string,
  relativeDirectory: string,
  depth: number,
  budget: IdentityBudget,
  resources: Map<string, ExtensionMediaResourceAttestation>,
): Promise<void> {
  if (depth > MAX_EXTENSION_IDENTITY_DEPTH) {
    fail(`Extension exceeds media identity depth budget (${MAX_EXTENSION_IDENTITY_DEPTH})`)
  }
  const before = await fs.lstat(directory)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    fail(`Extension directory changed while computing media identity: ${directory}`)
  }
  await assertContainedPath(canonicalRoot, directory)
  const names = await readDirectoryNames(canonicalRoot, directory, before, budget)

  for (const name of names) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
    const absolutePath = join(directory, name)
    const entryBefore = await fs.lstat(absolutePath)

    if (entryBefore.isSymbolicLink()) {
      const linkTarget = await fs.readlink(absolutePath)
      if (Buffer.byteLength(linkTarget, 'utf8') > MAX_EXTENSION_IDENTITY_SYMLINK_BYTES) {
        fail(`Extension symlink exceeds media identity budget: ${relativePath}`)
      }
      const linkAfter = await fs.lstat(absolutePath)
      if (!linkAfter.isSymbolicLink() || !sameObject(entryBefore, linkAfter)) {
        fail(`Extension symlink changed while computing media identity: ${absolutePath}`)
      }
      // Never realpath, stat, traverse, or read the target. Internal target
      // content is independently hashed at its actual path inside the root.
      updateRecord(hash, [
        'symlink',
        relativePath,
        linkTarget,
        entryBefore.mode,
        entryBefore.dev,
        entryBefore.ino,
        entryBefore.birthtimeMs,
      ])
      continue
    }

    await assertContainedPath(canonicalRoot, absolutePath)
    if (entryBefore.isDirectory()) {
      updateRecord(hash, [
        'directory',
        relativePath,
        entryBefore.mode,
        entryBefore.dev,
        entryBefore.ino,
        entryBefore.birthtimeMs,
      ])
      await hashDirectory(
        hash,
        canonicalRoot,
        absolutePath,
        relativePath,
        depth + 1,
        budget,
        resources,
      )
      continue
    }
    if (entryBefore.isFile()) {
      await hashFile(
        hash,
        canonicalRoot,
        absolutePath,
        relativePath,
        entryBefore,
        budget,
        resources,
      )
      continue
    }

    updateRecord(hash, [
      'other',
      relativePath,
      entryBefore.mode,
      entryBefore.size,
      entryBefore.dev,
      entryBefore.ino,
      entryBefore.birthtimeMs,
    ])
  }
  await assertStablePath(canonicalRoot, directory, before)
}

async function hashFile(
  hash: ReturnType<typeof createHash>,
  canonicalRoot: string,
  absolutePath: string,
  relativePath: string,
  before: FileInfo,
  budget: IdentityBudget,
  resources: Map<string, ExtensionMediaResourceAttestation>,
): Promise<void> {
  const fileSize = safeFileSize(before, relativePath)
  budget.files += 1
  if (budget.files > MAX_EXTENSION_IDENTITY_FILES) {
    fail(`Extension exceeds media identity file budget (${MAX_EXTENSION_IDENTITY_FILES})`)
  }
  if (fileSize > MAX_EXTENSION_IDENTITY_FILE_BYTES) {
    fail(`Extension file exceeds media identity byte budget: ${relativePath}`)
  }
  if (budget.totalBytes + fileSize > MAX_EXTENSION_IDENTITY_TOTAL_BYTES) {
    fail(`Extension exceeds aggregate media identity byte budget (${MAX_EXTENSION_IDENTITY_TOTAL_BYTES})`)
  }
  budget.totalBytes += fileSize

  await assertStablePath(canonicalRoot, absolutePath, before)
  const handle = await fs.open(
    absolutePath,
    extensionIdentityOpenFlags(),
  ).catch(() => {
    fail(`Unable to safely open extension file for media identity: ${absolutePath}`)
  })

  try {
    const opened = await handle.stat()
    const openedSize = safeFileSize(opened, relativePath)
    if (!opened.isFile() || openedSize !== fileSize || !sameObject(before, opened)) {
      fail(`Extension file changed before media identity read: ${absolutePath}`)
    }
    // Bind containment to the exact inode opened before reading any bytes.
    await assertStablePath(canonicalRoot, absolutePath, opened)
    updateRecord(hash, [
      'file',
      relativePath,
      opened.mode,
      openedSize,
      opened.dev,
      opened.ino,
      opened.birthtimeMs,
    ])

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    const resourceHash = createHash('sha256')
    let offset = 0
    while (offset < openedSize) {
      const length = Math.min(buffer.byteLength, openedSize - offset)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead <= 0) {
        fail(`Extension file changed during media identity read: ${absolutePath}`)
      }
      hash.update(buffer.subarray(0, bytesRead))
      resourceHash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }

    const after = await handle.stat()
    if (!sameObject(opened, after)) {
      fail(`Extension file changed during media identity read: ${absolutePath}`)
    }
    await assertStablePath(canonicalRoot, absolutePath, opened)
    resources.set(relativePath, Object.freeze({
      digest: `sha256:${resourceHash.digest('hex')}`,
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode,
      size: openedSize,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      birthtimeMs: opened.birthtimeMs,
    }))
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Binds sensitive-media consent to the effective extension installation.
 *
 * The canonical root and filesystem installation tuple detect replacement.
 * Recursive content is bounded and regular files are read only through stable,
 * no-follow handles. Symlinks contribute their link text and metadata but their
 * targets are never traversed or read.
 */
export async function computeExtensionMediaAttestation(
  extensionRoot: string,
  manifest: ExtensionManifest,
  expectedRoot?: ExtensionMediaRootBinding,
): Promise<ExtensionMediaAttestation> {
  const rootBinding = await captureExtensionMediaRoot(extensionRoot)
  if (expectedRoot && !sameRootBinding(rootBinding, expectedRoot)) {
    fail(`Extension root changed before computing media identity: ${rootBinding.lexicalRoot}`)
  }
  const { canonicalRoot } = rootBinding
  const rootStat = await fs.lstat(canonicalRoot)
  if (
    !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || !statMatchesRootBinding(rootStat, rootBinding)
  ) {
    fail(`Extension root changed before computing media identity: ${rootBinding.lexicalRoot}`)
  }

  const stableManifest = stableManifestValue(manifest)
  const serializedManifest = JSON.stringify(stableManifest)
  if (
    Buffer.byteLength(serializedManifest, 'utf8')
    > MAX_EXTENSION_IDENTITY_MANIFEST_BYTES
  ) {
    fail(`Extension manifest exceeds media identity byte budget (${MAX_EXTENSION_IDENTITY_MANIFEST_BYTES})`)
  }

  const hash = createHash('sha256')
  const resources = new Map<string, ExtensionMediaResourceAttestation>()
  updateRecord(hash, [
    'codesurf-extension-media-identity-v2',
    canonicalRoot,
    rootStat.dev,
    rootStat.ino,
    rootStat.birthtimeMs,
  ])
  updateRecord(hash, ['manifest', stableManifest])
  await hashDirectory(
    hash,
    canonicalRoot,
    canonicalRoot,
    '',
    0,
    { entries: 0, files: 0, totalBytes: 0 },
    resources,
  )
  await assertStablePath(canonicalRoot, canonicalRoot, rootStat)
  await assertRootBindingCurrent(rootBinding)
  return Object.freeze({
    identity: `sha256:${hash.digest('hex')}`,
    resources: new ImmutableResourceAttestations(resources),
  })
}

export async function computeExtensionMediaIdentity(
  extensionRoot: string,
  manifest: ExtensionManifest,
  expectedRoot?: ExtensionMediaRootBinding,
): Promise<string> {
  return (
    await computeExtensionMediaAttestation(extensionRoot, manifest, expectedRoot)
  ).identity
}
