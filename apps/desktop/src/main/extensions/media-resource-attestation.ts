import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CanonicalResourceOpen } from './resource-path.ts'
import {
  MAX_EXTENSION_IDENTITY_DEPTH,
  MAX_EXTENSION_IDENTITY_FILE_BYTES,
  captureExtensionMediaRoot,
  type ExtensionMediaResourceAttestation,
  type ExtensionMediaRootBinding,
} from './media-identity.ts'

const READ_CHUNK_BYTES = 64 * 1024

export const MAX_EXTENSION_MEDIA_INFLIGHT_READS = 8
export const MAX_EXTENSION_MEDIA_INFLIGHT_BYTES = 32 * 1024 * 1024
export const MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_READS = 4
export const MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_BYTES = 16 * 1024 * 1024

export type AttestedResourceRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false
      readonly reason: 'changed' | 'extension-busy' | 'global-busy'
    }

type MediaReadLease =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: 'extension-busy' | 'global-busy' }

interface ExtensionReadUsage {
  reads: number
  bytes: number
}

export class ExtensionMediaReadBudget {
  private reads = 0
  private bytes = 0
  private readonly extensions = new Map<string, ExtensionReadUsage>()

  acquire(extensionKey: string, bytes: number): MediaReadLease {
    const extension = this.extensions.get(extensionKey) ?? { reads: 0, bytes: 0 }
    if (
      extension.reads + 1 > MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_READS
      || extension.bytes + bytes > MAX_SINGLE_EXTENSION_MEDIA_INFLIGHT_BYTES
    ) {
      return { ok: false, reason: 'extension-busy' }
    }
    if (
      this.reads + 1 > MAX_EXTENSION_MEDIA_INFLIGHT_READS
      || this.bytes + bytes > MAX_EXTENSION_MEDIA_INFLIGHT_BYTES
    ) {
      return { ok: false, reason: 'global-busy' }
    }

    this.reads += 1
    this.bytes += bytes
    extension.reads += 1
    extension.bytes += bytes
    this.extensions.set(extensionKey, extension)

    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        this.reads -= 1
        this.bytes -= bytes
        extension.reads -= 1
        extension.bytes -= bytes
        if (extension.reads === 0) this.extensions.delete(extensionKey)
      },
    }
  }

  snapshot(): {
    readonly reads: number
    readonly bytes: number
    readonly extensions: number
  } {
    return {
      reads: this.reads,
      bytes: this.bytes,
      extensions: this.extensions.size,
    }
  }
}

const extensionMediaReadBudget = new ExtensionMediaReadBudget()

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

function sameResource(
  info: Awaited<ReturnType<typeof fs.lstat>>,
  expected: ExtensionMediaResourceAttestation,
): boolean {
  return info.isFile()
    && !info.isSymbolicLink()
    && info.dev === expected.dev
    && info.ino === expected.ino
    && info.mode === expected.mode
    && info.size === expected.size
    && info.mtimeMs === expected.mtimeMs
    && info.ctimeMs === expected.ctimeMs
    && info.birthtimeMs === expected.birthtimeMs
}

export function extensionMediaResourceKey(
  root: ExtensionMediaRootBinding,
  candidatePath: string,
): string | undefined {
  const lexicalRoot = resolve(root.lexicalRoot)
  const candidate = resolve(candidatePath)
  const rel = relative(lexicalRoot, candidate)
  if (
    !rel
    || rel === '..'
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) return undefined
  return rel.split(sep).join('/')
}

/**
 * Distinguishes a genuinely missing typo from a newly-created unattested path
 * without following child symlinks. Work is capped to the identity depth
 * budget, and traversal stops at the first missing or non-directory component.
 */
export async function extensionMediaResourcePathExists(
  root: ExtensionMediaRootBinding,
  candidatePath: string,
): Promise<boolean> {
  const currentRoot = await captureExtensionMediaRoot(root.lexicalRoot).catch(() => null)
  if (!currentRoot || !sameRootBinding(currentRoot, root)) return true
  const key = extensionMediaResourceKey(root, candidatePath)
  if (!key) return false
  const segments = key.split('/').filter(Boolean)
  let current = root.lexicalRoot
  for (
    let index = 0;
    index < segments.length && index <= MAX_EXTENSION_IDENTITY_DEPTH;
    index += 1
  ) {
    current = join(current, segments[index])
    const info = await fs.lstat(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!info) return false
    if (info.isSymbolicLink()) return true
    if (index < segments.length - 1 && !info.isDirectory()) return true
  }
  return true
}

/**
 * Reads the exact retained file handle into a bounded immutable response body.
 *
 * Both the handle and the lexical path are checked against the scan-time
 * attestation before and after the read. Callers must never rewind and stream
 * the live file after this succeeds; only `bytes` are authorized to leave the
 * process.
 */
export async function readAttestedExtensionResource(
  resource: Extract<CanonicalResourceOpen, { ok: true }>,
  root: ExtensionMediaRootBinding,
  resourceKey: string,
  expected: ExtensionMediaResourceAttestation,
  budget = extensionMediaReadBudget,
): Promise<AttestedResourceRead> {
  let releaseBudget: (() => void) | undefined
  try {
    if (
      expected.size > MAX_EXTENSION_IDENTITY_FILE_BYTES
      || resource.size !== expected.size
    ) return { ok: false, reason: 'changed' }

    const expectedPath = join(
      root.canonicalRoot,
      ...resourceKey.split('/').filter(Boolean),
    )
    if (resource.path !== expectedPath) {
      return { ok: false, reason: 'changed' }
    }

    const currentRoot = await captureExtensionMediaRoot(root.lexicalRoot)
    if (!sameRootBinding(currentRoot, root)) {
      return { ok: false, reason: 'changed' }
    }

    const opened = await resource.handle.stat()
    if (!sameResource(opened, expected)) {
      return { ok: false, reason: 'changed' }
    }

    const lease = budget.acquire(
      root.canonicalRoot,
      expected.size,
    )
    if (!lease.ok) return lease
    releaseBudget = lease.release

    const bytes = Buffer.allocUnsafe(expected.size)
    const digest = createHash('sha256')
    let offset = 0
    while (offset < bytes.byteLength) {
      const length = Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset)
      const { bytesRead } = await resource.handle.read(
        bytes,
        offset,
        length,
        offset,
      )
      if (bytesRead <= 0) return { ok: false, reason: 'changed' }
      digest.update(bytes.subarray(offset, offset + bytesRead))
      offset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await resource.handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      return { ok: false, reason: 'changed' }
    }

    const after = await resource.handle.stat()
    if (!sameResource(after, expected)) {
      return { ok: false, reason: 'changed' }
    }
    const pathInfo = await fs.lstat(expectedPath).catch(() => null)
    const canonicalPath = await fs.realpath(expectedPath).catch(() => null)
    if (
      !pathInfo
      || canonicalPath !== expectedPath
      || !sameResource(pathInfo, expected)
      || !sameRootBinding(await captureExtensionMediaRoot(root.lexicalRoot), root)
      || `sha256:${digest.digest('hex')}` !== expected.digest
    ) {
      return { ok: false, reason: 'changed' }
    }
    return { ok: true, bytes }
  } catch {
    return { ok: false, reason: 'changed' }
  } finally {
    releaseBudget?.()
    await resource.handle.close().catch(() => undefined)
  }
}
