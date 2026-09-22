import { constants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { Readable } from 'node:stream'

export const MAX_EXTENSION_TEXT_RESOURCE_BYTES = 4 * 1024 * 1024

export type CanonicalResourceOpen =
  | {
      ok: true
      path: string
      size: number
      handle: FileHandle
      status: 200
    }
  | { ok: false; status: 403 | 404 }

export type CanonicalResourceTextRead =
  | { ok: true; path: string; text: string; status: 200 }
  | { ok: false; status: 403 | 404 | 413 }

function isContained(canonicalRoot: string, canonicalCandidate: string): boolean {
  const rel = relative(canonicalRoot, canonicalCandidate)
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export function canonicalResourceOpenFlags(
  noFollow: number | null | undefined = constants.O_NOFOLLOW,
  nonBlock: number | null | undefined = constants.O_NONBLOCK,
): number {
  return constants.O_RDONLY
    | (typeof noFollow === 'number' ? noFollow : 0)
    | (typeof nonBlock === 'number' ? nonBlock : 0)
}

/**
 * Open a regular file through one retained, no-follow handle.
 *
 * The second canonicalization and dev/inode comparison bind the authorization
 * decision to the file that was actually opened. This prevents a child
 * directory from being exchanged for an external symlink between the initial
 * realpath check and the open. Root symlinks remain supported, while child
 * symlinks may not escape the canonical root.
 */
export async function openCanonicalResource(
  extensionRoot: string,
  candidatePath: string,
): Promise<CanonicalResourceOpen> {
  let canonicalRoot: string
  let canonicalCandidate: string
  try {
    canonicalRoot = await fs.realpath(extensionRoot)
    canonicalCandidate = await fs.realpath(candidatePath)
  } catch {
    return { ok: false, status: 404 }
  }

  if (!isContained(canonicalRoot, canonicalCandidate)) {
    return { ok: false, status: 403 }
  }

  const candidateInfo = await fs.lstat(canonicalCandidate).catch(() => null)
  if (!candidateInfo?.isFile() || candidateInfo.isSymbolicLink()) {
    return { ok: false, status: 404 }
  }

  let handle: FileHandle | undefined
  let transferred = false
  try {
    handle = await fs.open(canonicalCandidate, canonicalResourceOpenFlags())
  } catch (error) {
    return {
      ok: false,
      status: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 403 : 404,
    }
  }

  try {
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile()) {
      return { ok: false, status: 404 }
    }

    let verifiedRoot: string
    let verifiedCandidate: string
    try {
      verifiedRoot = await fs.realpath(extensionRoot)
      verifiedCandidate = await fs.realpath(candidatePath)
    } catch {
      return { ok: false, status: 403 }
    }
    if (!isContained(verifiedRoot, verifiedCandidate)) {
      return { ok: false, status: 403 }
    }

    const verifiedInfo = await fs.stat(verifiedCandidate).catch(() => null)
    if (!verifiedInfo?.isFile() || !sameFile(openedInfo, verifiedInfo)) {
      return { ok: false, status: 403 }
    }

    transferred = true
    return {
      ok: true,
      path: verifiedCandidate,
      size: openedInfo.size,
      handle,
      status: 200,
    }
  } catch {
    return { ok: false, status: 404 }
  } finally {
    if (handle && !transferred) {
      await handle.close().catch(() => {})
    }
  }
}

export async function readOpenedCanonicalResourceText(
  resource: Extract<CanonicalResourceOpen, { ok: true }>,
  maxBytes = MAX_EXTENSION_TEXT_RESOURCE_BYTES,
): Promise<CanonicalResourceTextRead> {
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 0
    || maxBytes > MAX_EXTENSION_TEXT_RESOURCE_BYTES
  ) {
    await resource.handle.close().catch(() => {})
    throw new Error(`Text resource limit must be between 0 and ${MAX_EXTENSION_TEXT_RESOURCE_BYTES}`)
  }
  if (resource.size > maxBytes) {
    await resource.handle.close().catch(() => {})
    return { ok: false, status: 413 }
  }
  try {
    const chunks: Buffer[] = []
    const readLimit = maxBytes + 1
    let totalBytes = 0
    while (totalBytes < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - totalBytes))
      const { bytesRead } = await resource.handle.read(
        chunk,
        0,
        chunk.byteLength,
        totalBytes,
      )
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > maxBytes) {
        return { ok: false, status: 413 }
      }
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return {
      ok: true,
      path: resource.path,
      text: Buffer.concat(chunks, totalBytes).toString('utf8'),
      status: 200,
    }
  } catch {
    return { ok: false, status: 404 }
  } finally {
    await resource.handle.close().catch(() => {})
  }
}

export function streamOpenedCanonicalResource(
  resource: Extract<CanonicalResourceOpen, { ok: true }>,
): ReadableStream<Uint8Array> {
  const nodeStream = resource.handle.createReadStream({ autoClose: false })
  const source = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  const reader = source.getReader()
  let finalized = false

  const finalize = async (): Promise<void> => {
    if (finalized) return
    finalized = true
    nodeStream.destroy()
    await resource.handle.close().catch(() => {})
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          controller.close()
          await finalize()
          return
        }
        controller.enqueue(chunk.value)
      } catch (error) {
        controller.error(error)
        await finalize()
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
      await finalize()
    },
  })
}
