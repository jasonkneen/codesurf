import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVerifiedFile } from '@codesurf/daemon/secure-file-reader'

export interface VerifiedImageAttachment {
  path: string
  mediaType: string
  displayPath: string
  byteCount: number
  device: string
  inode: string
  mtimeMs: number
  ctimeMs: number
  ownedTemporary?: boolean
}

const MAX_IMAGE_BYTES_PER_FILE = 5 * 1024 * 1024
const MAX_IMAGE_BYTES_PER_REQUEST = 20 * 1024 * 1024

async function unlinkOwnedAttachmentIfIdentityMatches(
  attachment: VerifiedImageAttachment,
): Promise<void> {
  if (!attachment.ownedTemporary) return
  try {
    const stat = await fs.lstat(attachment.path)
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || String(stat.dev) !== attachment.device
      || String(stat.ino) !== attachment.inode
      || stat.size !== attachment.byteCount
      || stat.mtimeMs !== attachment.mtimeMs
      || stat.ctimeMs !== attachment.ctimeMs
    ) return
    await fs.unlink(attachment.path)
  } catch {
    // Missing is already clean. Any other failure is left for the daemon's
    // bounded deferred cleanup/startup sweep; never delete a replacement.
  }
}

export async function cleanupOwnedImageAttachments(
  attachments: VerifiedImageAttachment[] | undefined,
): Promise<void> {
  await Promise.all((attachments ?? []).map(unlinkOwnedAttachmentIfIdentityMatches))
}

async function readVerifiedAttachment(
  attachment: VerifiedImageAttachment,
  remainingBytes: number,
): Promise<Buffer> {
  try {
    const { data } = await readVerifiedFile({
      path: attachment.path,
      identity: {
        device: attachment.device,
        inode: attachment.inode,
        byteCount: attachment.byteCount,
        mtimeMs: attachment.mtimeMs,
        ctimeMs: attachment.ctimeMs,
      },
      maxBytes: Math.min(MAX_IMAGE_BYTES_PER_FILE, remainingBytes),
      label: `Image attachment ${attachment.displayPath}`,
    })
    return data
  } finally {
    // Provider materialization is the final consumer of renderer-authored
    // bytes. Cleanup follows the verified read, not capability expansion.
    await unlinkOwnedAttachmentIfIdentityMatches(attachment)
  }
}

export function buildClaudePromptWithImages(
  text: string,
  imageAttachments: VerifiedImageAttachment[] | undefined,
): AsyncIterable<any> {
  async function* generator(): AsyncGenerator<any, void, unknown> {
    const contentBlocks: Array<Record<string, unknown>> = []
    const normalizedText = String(text ?? '').trim()
    if (normalizedText) contentBlocks.push({ type: 'text', text: normalizedText })

    let totalBytes = 0
    for (const attachment of imageAttachments ?? []) {
      const remainingBytes = MAX_IMAGE_BYTES_PER_REQUEST - totalBytes
      if (remainingBytes <= 0) throw new Error('Image attachments exceed the per-request byte limit')
      const data = await readVerifiedAttachment(attachment, remainingBytes)
      totalBytes += data.byteLength
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mediaType,
          data: data.toString('base64'),
        },
      })
    }

    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: normalizedText || '(empty message)' })
    }
    yield {
      type: 'user',
      message: { role: 'user', content: contentBlocks },
      parent_tool_use_id: null,
    }
  }
  return generator()
}

export interface PiImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export async function buildCsagentImages(
  attachments: VerifiedImageAttachment[] | undefined,
): Promise<PiImageContent[]> {
  if (!attachments?.length) return []
  const images: PiImageContent[] = []
  let totalBytes = 0
  for (const attachment of attachments) {
    const remaining = MAX_IMAGE_BYTES_PER_REQUEST - totalBytes
    if (remaining <= 0) throw new Error('Image attachments exceed the per-request byte limit')
    const data = await readVerifiedAttachment(attachment, remaining)
    totalBytes += data.byteLength
    images.push({ type: 'image', data: data.toString('base64'), mimeType: attachment.mediaType })
  }
  return images
}

function imageExtension(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/gif') return 'gif'
  if (mediaType === 'image/webp') return 'webp'
  return 'png'
}

export async function materializeVerifiedCodexImages(
  attachments: VerifiedImageAttachment[] | undefined,
): Promise<{ directory: string | null; paths: string[] }> {
  if (!attachments?.length) return { directory: null, paths: [] }
  const directory = await fs.mkdtemp(join(tmpdir(), 'codesurf-codex-images-'))
  const paths: string[] = []
  let totalBytes = 0
  try {
    for (const [index, attachment] of attachments.entries()) {
      const remaining = MAX_IMAGE_BYTES_PER_REQUEST - totalBytes
      if (remaining <= 0) throw new Error('Image attachments exceed the per-request byte limit')
      const data = await readVerifiedAttachment(attachment, remaining)
      totalBytes += data.byteLength
      const destination = join(directory, `image-${index}.${imageExtension(attachment.mediaType)}`)
      await fs.writeFile(destination, data, { flag: 'wx', mode: 0o600 })
      paths.push(destination)
    }
    return { directory, paths }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export function insertCodexImageArgs(args: readonly string[], paths: readonly string[]): string[] {
  const next = [...args]
  if (paths.length > 0) next.splice(2, 0, ...paths.flatMap(path => ['--image', path]))
  return next
}

export async function cleanupMaterializedCodexImages(directory: string | null): Promise<void> {
  if (!directory) return
  await fs.rm(directory, { recursive: true, force: true })
}
