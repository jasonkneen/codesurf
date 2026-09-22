import { constants, promises as fs } from 'node:fs'

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

export function fileIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    byteCount: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  }
}

export function assertFileIdentity(stat, expected, label = 'File') {
  if (!stat.isFile()) throw new Error(`${label} must point to a regular file`)
  if (!expected) return
  if (
    String(stat.dev) !== String(expected.device)
    || String(stat.ino) !== String(expected.inode)
    || stat.size !== Number(expected.byteCount)
    || stat.mtimeMs !== Number(expected.mtimeMs)
    || stat.ctimeMs !== Number(expected.ctimeMs)
  ) {
    throw new Error(`${label} changed during validation`)
  }
}

export async function openNoFollowFile(path, expectedIdentity, label = 'File') {
  const handle = await fs.open(path, constants.O_RDONLY | NO_FOLLOW)
  try {
    const stat = await handle.stat()
    assertFileIdentity(stat, expectedIdentity, label)
    return { handle, stat, identity: fileIdentity(stat) }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

export async function readHandlePrefix(handle, byteCount, maxBytes, includeOverflowByte = false) {
  const hardLimit = Math.max(0, Number(maxBytes) || 0)
  const allocation = Math.min(
    Math.max(0, Number(byteCount) || 0),
    hardLimit + (includeOverflowByte ? 1 : 0),
  )
  if (allocation === 0) return Buffer.alloc(0)
  const buffer = Buffer.allocUnsafe(allocation)
  let offset = 0
  while (offset < allocation) {
    const { bytesRead } = await handle.read(buffer, offset, allocation - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

/** Identity-checked, no-follow, bounded whole-file read for provider image sinks. */
export async function readVerifiedFile({
  path,
  identity,
  maxBytes,
  label = 'Attachment',
  beforeFinalStat,
}) {
  const opened = await openNoFollowFile(path, identity, label)
  try {
    if (opened.stat.size > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes} byte limit`)
    }
    const data = await readHandlePrefix(opened.handle, opened.stat.size, maxBytes)
    if (data.byteLength !== opened.stat.size) throw new Error(`${label} changed while reading`)
    await beforeFinalStat?.()
    const finalStat = await opened.handle.stat()
    assertFileIdentity(finalStat, opened.identity, label)
    return { data, stat: opened.stat, identity: opened.identity }
  } finally {
    await opened.handle.close().catch(() => {})
  }
}
