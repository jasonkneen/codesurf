import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatImageAttachment } from '../../src/main/chat/types.ts'

export const MAX_ELECTROBUN_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_ELECTROBUN_IMAGE_REQUEST_BYTES = 20 * 1024 * 1024
const ELECTROBUN_IMAGE_OWNER_FILE = '.owner.json'
const MAX_ELECTROBUN_IMAGE_DIRECTORY_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_ELECTROBUN_IMAGE_OWNER_BYTES = 4 * 1024

export interface VerifiedElectrobunImage extends ChatImageAttachment {
  bytes: Buffer
}

export async function readVerifiedElectrobunImages(
  attachments: ChatImageAttachment[] | undefined,
): Promise<VerifiedElectrobunImage[]> {
  const candidates = attachments ?? []
  let totalBytes = 0
  const verified: VerifiedElectrobunImage[] = []

  for (const attachment of candidates) {
    if (
      !Number.isSafeInteger(attachment.byteCount)
      || attachment.byteCount <= 0
      || attachment.byteCount > MAX_ELECTROBUN_IMAGE_BYTES
    ) {
      throw new Error(`Image attachment exceeds the ${MAX_ELECTROBUN_IMAGE_BYTES}-byte per-file limit: ${attachment.displayPath}`)
    }
    totalBytes += attachment.byteCount
    if (totalBytes > MAX_ELECTROBUN_IMAGE_REQUEST_BYTES) {
      throw new Error(`Image attachments exceed the ${MAX_ELECTROBUN_IMAGE_REQUEST_BYTES}-byte request limit`)
    }
    if (
      !attachment.device
      || !attachment.inode
      || !Number.isFinite(attachment.mtimeMs)
      || !Number.isFinite(attachment.ctimeMs)
    ) {
      throw new Error(`Image attachment lacks verified file identity: ${attachment.displayPath}`)
    }

    const handle = await open(
      attachment.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const before = await handle.stat()
      if (
        !before.isFile()
        || String(before.dev) !== attachment.device
        || String(before.ino) !== attachment.inode
        || before.size !== attachment.byteCount
        || before.mtimeMs !== attachment.mtimeMs
        || before.ctimeMs !== attachment.ctimeMs
      ) {
        throw new Error(`Image attachment changed before delivery: ${attachment.displayPath}`)
      }
      const bytes = Buffer.allocUnsafe(attachment.byteCount)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (result.bytesRead === 0) break
        offset += result.bytesRead
      }
      const after = await handle.stat()
      if (
        offset !== bytes.length
        || String(after.dev) !== attachment.device
        || String(after.ino) !== attachment.inode
        || after.size !== attachment.byteCount
        || after.mtimeMs !== attachment.mtimeMs
        || after.ctimeMs !== attachment.ctimeMs
      ) {
        throw new Error(`Image attachment changed during delivery: ${attachment.displayPath}`)
      }
      verified.push({ ...attachment, bytes })
    } finally {
      await handle.close().catch(() => {})
    }
  }

  return verified
}

export function buildClaudeStreamInput(
  text: string,
  images: VerifiedElectrobunImage[],
): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map(image => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: image.bytes.toString('base64'),
          },
        })),
      ],
    },
    parent_tool_use_id: null,
  })}\n`
}

function imageExtension(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/gif') return 'gif'
  if (mediaType === 'image/webp') return 'webp'
  return 'png'
}

type ElectrobunImageDirectoryOwner = {
  pid: number
  createdAt: number
}

async function readImageDirectoryOwner(directory: string): Promise<ElectrobunImageDirectoryOwner | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(
      join(directory, ELECTROBUN_IMAGE_OWNER_FILE),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    const state = await handle.stat()
    if (!state.isFile() || state.size <= 0 || state.size > MAX_ELECTROBUN_IMAGE_OWNER_BYTES) return null
    const bytes = Buffer.allocUnsafe(state.size)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== bytes.length) return null
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<ElectrobunImageDirectoryOwner>
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0) return null
    if (!Number.isFinite(parsed.createdAt) || Number(parsed.createdAt) <= 0) return null
    return { pid: Number(parsed.pid), createdAt: Number(parsed.createdAt) }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function sweepStaleElectrobunImageDirectories(
  temporaryRoot: string,
  options: { now?: number, maxAgeMs?: number } = {},
): Promise<{ removed: number, retained: number }> {
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? MAX_ELECTROBUN_IMAGE_DIRECTORY_AGE_MS
  let entries: Dirent[]
  try {
    entries = await readdir(temporaryRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, retained: 0 }
    throw error
  }

  let removed = 0
  let retained = 0
  for (const entry of entries) {
    if (!entry.name.startsWith('request-')) continue
    const directory = join(temporaryRoot, entry.name)
    const owner = await readImageDirectoryOwner(directory)
    const live = owner
      && now >= owner.createdAt
      && now - owner.createdAt <= maxAgeMs
      && isProcessAlive(owner.pid)
    if (live) {
      retained += 1
      continue
    }
    const state = await lstat(directory).catch(() => null)
    await rm(directory, { recursive: state?.isDirectory() === true, force: true })
    removed += 1
  }
  return { removed, retained }
}

export async function materializeVerifiedElectrobunImages(
  images: VerifiedElectrobunImage[],
  temporaryRoot: string,
): Promise<{ paths: string[], cleanup: () => Promise<void> }> {
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  await chmod(temporaryRoot, 0o700)
  const directory = await mkdtemp(join(temporaryRoot, 'request-'))
  const paths: string[] = []
  try {
    await chmod(directory, 0o700)
    await writeFile(
      join(directory, ELECTROBUN_IMAGE_OWNER_FILE),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      { flag: 'wx', mode: 0o600 },
    )
    for (const [index, image] of images.entries()) {
      const path = join(directory, `image-${index}.${imageExtension(image.mediaType)}`)
      await writeFile(path, image.bytes, { flag: 'wx', mode: 0o600 })
      paths.push(path)
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let cleaned = false
  return {
    paths,
    cleanup: async () => {
      if (cleaned) return
      cleaned = true
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export function insertCodexImageArgs(args: string[], paths: string[]): string[] {
  if (paths.length === 0) return args
  const next = [...args]
  const optionIndex = next.indexOf('resume')
  next.splice(
    optionIndex >= 0 ? optionIndex : next.length - 1,
    0,
    ...paths.flatMap(path => ['--image', path]),
  )
  return next
}
