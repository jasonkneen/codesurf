import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const MAX_TEMP_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const ELECTROBUN_TEMP_ATTACHMENT_TTL_MS = 5 * 60 * 1000

export interface ElectrobunAttachmentSelection {
  selectionReceipt: string
  displayPath: string
  mediaType?: string
  byteCount?: number
  ownedTemporary?: boolean
}

export interface ElectrobunIssuedAttachment extends ElectrobunAttachmentSelection {
  hostCleanupToken: string
}

export interface ElectrobunTempAttachmentRequest {
  workspaceId?: string
  cardId?: string
  data?: string
  mime?: string
  ext?: string
  filenameHint?: string
}

export interface ElectrobunRevokeAttachmentSelectionsRequest {
  workspaceId?: string
  cardId?: string
  selectionReceipts?: string[]
}

type CapabilityIssuer = (
  workspaceId: string,
  cardId: string,
  paths: string[],
) => Promise<ElectrobunIssuedAttachment[]>

interface AttachmentFileIdentity {
  byteCount: number
  device: string
  inode: string
  mtimeMs: number
  ctimeMs: number
}

interface OwnedAttachmentRecord {
  path: string
  selectionReceipt: string | null
  identity: AttachmentFileIdentity
  timer: ReturnType<typeof setTimeout>
}

export interface ElectrobunOwnedAttachmentReceipt {
  hostCleanupToken: string
  selectionReceipt?: string
  path: string
  byteCount: number
  device: string
  inode: string
  mtimeMs: number
  ctimeMs: number
  ownedTemporary: true
}

function fileIdentity(state: {
  size: number
  dev: number | bigint
  ino: number | bigint
  mtimeMs: number
  ctimeMs: number
}): AttachmentFileIdentity {
  return {
    byteCount: state.size,
    device: String(state.dev),
    inode: String(state.ino),
    mtimeMs: state.mtimeMs,
    ctimeMs: state.ctimeMs,
  }
}

function sameFileIdentity(
  state: Parameters<typeof fileIdentity>[0],
  identity: AttachmentFileIdentity,
): boolean {
  return state.size === identity.byteCount
    && String(state.dev) === identity.device
    && String(state.ino) === identity.inode
    && state.mtimeMs === identity.mtimeMs
    && state.ctimeMs === identity.ctimeMs
}

async function unlinkIfIdentityMatches(
  path: string,
  identity: AttachmentFileIdentity,
): Promise<void> {
  try {
    const state = await lstat(path)
    if (!state.isFile() || state.isSymbolicLink() || !sameFileIdentity(state, identity)) return
    await unlink(path)
  } catch {
    // Rollback and cleanup are deliberately best-effort and identity-bound.
  }
}

function publicAttachment(
  attachment: ElectrobunIssuedAttachment,
): ElectrobunAttachmentSelection {
  const selectionReceipt = String(attachment?.selectionReceipt ?? '').trim()
  const hostCleanupToken = String(attachment?.hostCleanupToken ?? '').trim()
  const displayPath = String(attachment?.displayPath ?? '').trim()
  if (!selectionReceipt || !hostCleanupToken || !displayPath) {
    throw new Error('Attachment selection issuer returned an invalid response')
  }
  return {
    selectionReceipt,
    displayPath,
    ...(typeof attachment.mediaType === 'string' && attachment.mediaType.trim()
      ? { mediaType: attachment.mediaType.trim() }
      : {}),
    ...(Number.isSafeInteger(attachment.byteCount) && Number(attachment.byteCount) >= 0
      ? { byteCount: Number(attachment.byteCount) }
      : {}),
    ...(attachment.ownedTemporary === true ? { ownedTemporary: true } : {}),
  }
}

export class ElectrobunOwnedAttachmentRegistry {
  private readonly attachmentDirectory: string
  private readonly records = new Map<string, OwnedAttachmentRecord>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    attachmentDirectory: string,
    options: { ttlMs?: number, now?: () => number } = {},
  ) {
    this.attachmentDirectory = resolve(attachmentDirectory)
    this.ttlMs = options.ttlMs ?? ELECTROBUN_TEMP_ATTACHMENT_TTL_MS
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Owned attachment TTL must be a positive safe integer')
    }
  }

  async track(
    hostCleanupToken: string,
    path: string,
    selectionReceipt?: string,
    expectedIdentity?: AttachmentFileIdentity,
  ): Promise<void> {
    const normalizedToken = String(hostCleanupToken ?? '').trim()
    const normalizedSelectionReceipt = String(selectionReceipt ?? '').trim() || null
    const normalizedPath = resolve(path)
    if (!normalizedToken) throw new Error('Owned attachment cleanup token is required')
    if (dirname(normalizedPath) !== this.attachmentDirectory) {
      throw new Error('Owned attachment path escaped its private directory')
    }
    const state = await lstat(normalizedPath)
    if (!state.isFile() || state.isSymbolicLink()) {
      throw new Error('Owned attachment must be a regular file')
    }
    if (expectedIdentity && !sameFileIdentity(state, expectedIdentity)) {
      throw new Error('Owned attachment changed before selection enrollment')
    }
    const previous = this.records.get(normalizedToken)
    if (previous && previous.path !== normalizedPath) {
      throw new Error('Owned attachment cleanup token changed paths')
    }
    if (
      previous?.selectionReceipt
      && normalizedSelectionReceipt
      && previous.selectionReceipt !== normalizedSelectionReceipt
    ) {
      throw new Error('Owned attachment cleanup token changed selection receipts')
    }
    if (previous) clearTimeout(previous.timer)
    this.records.set(normalizedToken, {
      path: normalizedPath,
      selectionReceipt: normalizedSelectionReceipt ?? previous?.selectionReceipt ?? null,
      identity: fileIdentity(state),
      timer: this.createCleanupTimer(normalizedToken),
    })
  }

  registerCommitted(receipts: Iterable<ElectrobunOwnedAttachmentReceipt>): string[] {
    const cleanupTokens: string[] = []
    for (const receipt of receipts) {
      if (receipt?.ownedTemporary !== true) continue
      const hostCleanupToken = String(receipt.hostCleanupToken ?? '').trim()
      const selectionReceipt = String(receipt.selectionReceipt ?? '').trim() || null
      const path = resolve(String(receipt.path ?? ''))
      if (!hostCleanupToken) throw new Error('Committed owned attachment cleanup token is required')
      if (dirname(path) !== this.attachmentDirectory) {
        throw new Error('Committed owned attachment path escaped its private directory')
      }
      const identity = {
        byteCount: Number(receipt.byteCount),
        device: String(receipt.device ?? '').trim(),
        inode: String(receipt.inode ?? '').trim(),
        mtimeMs: Number(receipt.mtimeMs),
        ctimeMs: Number(receipt.ctimeMs),
      }
      if (
        !Number.isSafeInteger(identity.byteCount)
        || identity.byteCount <= 0
        || !identity.device
        || !identity.inode
        || !Number.isFinite(identity.mtimeMs)
        || !Number.isFinite(identity.ctimeMs)
      ) {
        throw new Error('Committed owned attachment lacks verified file identity')
      }
      const previous = this.records.get(hostCleanupToken)
      if (previous && previous.path !== path) {
        throw new Error('Committed owned attachment cleanup token changed paths')
      }
      if (
        previous?.selectionReceipt
        && selectionReceipt
        && previous.selectionReceipt !== selectionReceipt
      ) {
        throw new Error('Committed owned attachment cleanup token changed selection receipts')
      }
      if (previous) clearTimeout(previous.timer)
      this.records.set(hostCleanupToken, {
        path,
        selectionReceipt: selectionReceipt ?? previous?.selectionReceipt ?? null,
        identity,
        timer: this.createCleanupTimer(hostCleanupToken),
      })
      cleanupTokens.push(hostCleanupToken)
    }
    return cleanupTokens
  }

  registerExpansionResponse(response: unknown): string[] {
    if (!response || typeof response !== 'object') return []
    const candidate = response as { ownedTemporaryAttachments?: unknown }
    if (!Array.isArray(candidate.ownedTemporaryAttachments)) return []
    const receipts = candidate.ownedTemporaryAttachments.filter(
      (value): value is ElectrobunOwnedAttachmentReceipt => (
        Boolean(value)
        && typeof value === 'object'
        && (value as { ownedTemporary?: unknown }).ownedTemporary === true
      ),
    )
    return this.registerCommitted(receipts)
  }

  async cleanupCapabilities(cleanupTokens: Iterable<string>): Promise<void> {
    const records: OwnedAttachmentRecord[] = []
    for (const tokenValue of cleanupTokens) {
      const hostCleanupToken = String(tokenValue ?? '').trim()
      const record = this.records.get(hostCleanupToken)
      if (!record) continue
      this.records.delete(hostCleanupToken)
      clearTimeout(record.timer)
      records.push(record)
    }
    await Promise.all(records.map(record => unlinkIfIdentityMatches(record.path, record.identity)))
  }

  forgetSelectionReceipts(selectionReceipts: Iterable<string>): void {
    const receipts = new Set(
      [...selectionReceipts]
        .map(value => String(value ?? '').trim())
        .filter(Boolean),
    )
    if (receipts.size === 0) return
    for (const [hostCleanupToken, record] of this.records) {
      if (!record.selectionReceipt || !receipts.has(record.selectionReceipt)) continue
      this.records.delete(hostCleanupToken)
      clearTimeout(record.timer)
    }
  }

  async sweepStale(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.attachmentDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await Promise.all(names.map(async name => {
      const path = join(this.attachmentDirectory, name)
      if (relative(this.attachmentDirectory, path).startsWith('..')) return
      try {
        const metadata = await lstat(path)
        if ((!metadata.isFile() && !metadata.isSymbolicLink()) || this.now() - metadata.mtimeMs < this.ttlMs) return
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }))
  }

  async dispose(): Promise<void> {
    await this.cleanupCapabilities([...this.records.keys()])
  }

  pendingCountForTests(): number {
    return this.records.size
  }

  private createCleanupTimer(hostCleanupToken: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.cleanupCapabilities([hostCleanupToken])
    }, this.ttlMs)
    timer.unref?.()
    return timer
  }

}

function requireScopePart(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim()
  if (
    !normalized
    || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(normalized)
    || normalized.includes('..')
  ) {
    throw new Error(`A valid ${label} is required`)
  }
  return normalized
}

function requireSelectionReceipts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    throw new Error('selectionReceipts must contain 1-12 values')
  }
  const receipts = value.map(receipt => String(receipt ?? '').trim())
  if (
    receipts.some(receipt => !/^csr1_[A-Za-z0-9_-]{43}$/.test(receipt))
    || new Set(receipts).size !== receipts.length
  ) {
    throw new Error('Attachment selection receipts are invalid')
  }
  return receipts
}

function decodeBoundedBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Attachment data is required')
  if (value.length > Math.ceil(MAX_TEMP_ATTACHMENT_BYTES / 3) * 4) {
    throw new Error(`Attachment exceeds the ${MAX_TEMP_ATTACHMENT_BYTES}-byte limit`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('Attachment data must be canonical base64')
  if (bytes.length === 0 || bytes.length > MAX_TEMP_ATTACHMENT_BYTES) {
    throw new Error(`Attachment exceeds the ${MAX_TEMP_ATTACHMENT_BYTES}-byte limit`)
  }
  return bytes
}

function safeExtension(payload: ElectrobunTempAttachmentRequest): string {
  const mimeSubtype = String(payload.mime ?? '').split('/')[1] ?? ''
  const requested = String(payload.ext ?? mimeSubtype).replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  return requested.slice(0, 12) || 'bin'
}

function safeFilenameHint(value: unknown): string {
  const hint = basename(String(value ?? 'attachment'))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9._-]+$/g, '')
    .slice(0, 40)
  return hint || 'attachment'
}

export async function issueElectrobunPickedAttachments(
  workspaceIdValue: unknown,
  cardIdValue: unknown,
  paths: string[],
  issue: CapabilityIssuer,
): Promise<ElectrobunAttachmentSelection[]> {
  if (paths.length === 0) return []
  const workspaceId = requireScopePart(workspaceIdValue, 'workspaceId')
  const cardId = requireScopePart(cardIdValue, 'cardId')
  const issued = await issue(workspaceId, cardId, paths)
  if (issued.length !== paths.length) {
    throw new Error('Attachment selection issuer returned an invalid response')
  }
  return issued.map(publicAttachment)
}

export async function writeElectrobunTempAttachment(
  payload: ElectrobunTempAttachmentRequest,
  attachmentDirectory: string,
  issue: CapabilityIssuer,
  ownedAttachments?: ElectrobunOwnedAttachmentRegistry,
): Promise<
  { ok: true, attachment: ElectrobunAttachmentSelection }
  | { ok: false, error: string }
> {
  let path: string | null = null
  let createdIdentity: AttachmentFileIdentity | null = null
  try {
    const workspaceId = requireScopePart(payload?.workspaceId, 'workspaceId')
    const cardId = requireScopePart(payload?.cardId, 'cardId')
    const bytes = decodeBoundedBase64(payload?.data)
    await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 })
    await chmod(attachmentDirectory, 0o700)
    const extension = safeExtension(payload)
    path = join(
      attachmentDirectory,
      `codesurf-owned-v1-${Date.now()}-${randomUUID()}-${safeFilenameHint(payload.filenameHint)}.${extension}`,
    )
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    const state = await lstat(path)
    if (!state.isFile() || state.isSymbolicLink()) throw new Error('Temporary attachment was not a regular file')
    createdIdentity = fileIdentity(state)
    const attachments = await issue(workspaceId, cardId, [path])
    if (attachments.length !== 1) throw new Error('Attachment selection issuer returned an invalid response')
    const attachment = publicAttachment(attachments[0])
    if (attachment.ownedTemporary !== true) {
      throw new Error('Temporary attachment issuer omitted its ownership receipt')
    }
    await ownedAttachments?.track(
      attachments[0].hostCleanupToken,
      path,
      attachment.selectionReceipt,
      createdIdentity,
    )
    return { ok: true, attachment }
  } catch (error) {
    if (path && createdIdentity) await unlinkIfIdentityMatches(path, createdIdentity)
    else if (path) await unlink(path).catch(() => {})
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function revokeElectrobunAttachmentSelections(
  payload: ElectrobunRevokeAttachmentSelectionsRequest,
  revoke: (
    workspaceId: string,
    cardId: string,
    selectionReceipts: string[],
  ) => Promise<{ ok: boolean, revoked?: number, error?: string }>,
  ownedAttachments?: ElectrobunOwnedAttachmentRegistry,
): Promise<{ ok: boolean, revoked?: number, error?: string }> {
  try {
    const workspaceId = requireScopePart(payload?.workspaceId, 'workspaceId')
    const cardId = requireScopePart(payload?.cardId, 'cardId')
    const selectionReceipts = requireSelectionReceipts(payload?.selectionReceipts)
    const result = await revoke(workspaceId, cardId, selectionReceipts)
    if (result?.ok !== true) {
      return { ok: false, error: result?.error || 'Attachment selection revocation failed' }
    }
    ownedAttachments?.forgetSelectionReceipts(selectionReceipts)
    return {
      ok: true,
      ...(Number.isSafeInteger(result.revoked) && Number(result.revoked) >= 0
        ? { revoked: Number(result.revoked) }
        : {}),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
