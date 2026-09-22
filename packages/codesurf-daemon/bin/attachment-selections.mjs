import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import {
  OWNED_TEMP_ATTACHMENT_NAME_PATTERN,
  OWNED_TEMP_ATTACHMENT_TTL_MS,
  sanitizeAttachmentDisplayName,
} from './attachment-capabilities.mjs'
import {
  assertFileIdentity,
  fileIdentity,
  openNoFollowFile,
} from './secure-file-reader.mjs'

export const SELECTION_RECEIPT_PATTERN = /^csr1_[A-Za-z0-9_-]{43}$/
export const HOST_CLEANUP_TOKEN_PATTERN = /^hct1_[A-Za-z0-9_-]{43}$/
export const SELECTION_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_SELECTIONS_PER_ISSUE = 12

const STORE_VERSION = 1
const MAX_SELECTIONS = 512
const MAX_WORKSPACE_SELECTIONS = 96
const MAX_OWNED_TEMP_ATTACHMENT_BYTES = 5 * 1024 * 1024
const OWNED_NAME_CLOCK_SKEW_MS = 30 * 1000
const MAX_ACTIVATION_CLOSE_ATTEMPTS = 2

function opaqueId(prefix) {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

function normalizeId(value) {
  const id = String(value ?? '').trim()
  return id && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id) && !id.includes('..') ? id : null
}

function normalizeReceiptList(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_SELECTIONS_PER_ISSUE) {
    throw new Error(`selectionReceipts must contain 1-${MAX_SELECTIONS_PER_ISSUE} values`)
  }
  const receipts = values.map(value => String(value ?? '').trim())
  if (receipts.some(receipt => !SELECTION_RECEIPT_PATTERN.test(receipt))) {
    throw new Error('Attachment selection receipt is invalid')
  }
  if (new Set(receipts).size !== receipts.length) {
    throw new Error('Attachment selection receipts must not contain duplicates')
  }
  return receipts
}

function hasPrivatePermissions(stat) {
  return (stat.mode & 0o077) === 0
}

function hasCurrentOwner(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid()
}

function ownedNameTimestamp(name) {
  const match = OWNED_TEMP_ATTACHMENT_NAME_PATTERN.exec(name)
  if (!match) return null
  const timestamp = Number(match[1])
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

function guessMediaType(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.svg': return 'image/svg+xml'
    case '.pdf': return 'application/pdf'
    case '.json': return 'application/json'
    case '.html':
    case '.htm': return 'text/html'
    case '.md': return 'text/markdown'
    case '.txt': return 'text/plain'
    default: return 'application/octet-stream'
  }
}

function normalizeStoredRecord(value) {
  if (!value || typeof value !== 'object') return null
  const selectionReceipt = String(value.selectionReceipt ?? '').trim()
  const hostCleanupToken = String(value.hostCleanupToken ?? '').trim()
  const workspaceId = normalizeId(value.workspaceId)
  const cardId = normalizeId(value.cardId)
  const resolvedPath = String(value.resolvedPath ?? '').trim()
  const requestedPath = String(value.requestedPath ?? resolvedPath).trim()
  const displayPath = sanitizeAttachmentDisplayName(value.displayPath)
  const expiresAt = Number(value.expiresAt)
  const createdAt = Number(value.createdAt)
  const byteCount = Number(value.byteCount)
  const mtimeMs = Number(value.mtimeMs)
  const ctimeMs = Number(value.ctimeMs)
  if (
    !SELECTION_RECEIPT_PATTERN.test(selectionReceipt)
    || !HOST_CLEANUP_TOKEN_PATTERN.test(hostCleanupToken)
    || !workspaceId
    || !cardId
    || !resolvedPath
    || resolve(resolvedPath) !== resolvedPath
    || !requestedPath
    || resolve(requestedPath) !== requestedPath
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(createdAt)
    || !Number.isFinite(byteCount)
    || byteCount < 0
    || !Number.isFinite(mtimeMs)
    || !Number.isFinite(ctimeMs)
  ) return null
  return {
    selectionReceipt,
    hostCleanupToken,
    workspaceId,
    cardId,
    requestedPath,
    resolvedPath,
    displayPath,
    mediaType: guessMediaType(resolvedPath),
    device: String(value.device ?? ''),
    inode: String(value.inode ?? ''),
    byteCount,
    mtimeMs,
    ctimeMs,
    createdAt,
    expiresAt,
    ownedTemporary: value.ownedTemporary === true,
    reservationId: null,
  }
}

function storedRecord(record) {
  return {
    selectionReceipt: record.selectionReceipt,
    hostCleanupToken: record.hostCleanupToken,
    workspaceId: record.workspaceId,
    cardId: record.cardId,
    requestedPath: record.requestedPath,
    resolvedPath: record.resolvedPath,
    displayPath: record.displayPath,
    mediaType: record.mediaType,
    device: record.device,
    inode: record.inode,
    byteCount: record.byteCount,
    mtimeMs: record.mtimeMs,
    ctimeMs: record.ctimeMs,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ownedTemporary: record.ownedTemporary === true,
  }
}

async function atomicWriteStore(storePath, records) {
  const parent = dirname(storePath)
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await fs.writeFile(tempPath, `${JSON.stringify({
      version: STORE_VERSION,
      records: [...records.values()].map(storedRecord),
    }, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(tempPath, storePath)
    await fs.chmod(storePath, 0o600).catch(() => {})
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function canonicalOwnedRoot(rootValue) {
  const requestedRoot = resolve(String(rootValue ?? '').trim())
  if (basename(requestedRoot) !== 'chat-attachments') {
    throw new Error('Owned temporary attachment root is invalid')
  }
  const rootStat = await fs.lstat(requestedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Owned temporary attachment root must be a canonical directory')
  }
  if (!hasPrivatePermissions(rootStat) || !hasCurrentOwner(rootStat)) {
    throw new Error('Owned temporary attachment root must be private and owned by this user')
  }
  return {
    requestedRoot,
    canonicalRoot: await fs.realpath(requestedRoot),
  }
}

function assertOwnedIssuePath(path, root, now) {
  if (dirname(path) !== root.requestedRoot) {
    throw new Error('Owned temporary attachment path must be a direct child of the app-owned root')
  }
  const timestamp = ownedNameTimestamp(basename(path))
  if (
    timestamp == null
    || timestamp > now + OWNED_NAME_CLOCK_SKEW_MS
    || now - timestamp > OWNED_TEMP_ATTACHMENT_TTL_MS
  ) {
    throw new Error('Owned temporary attachment name is outside the issuance window')
  }
}

function assertOwnedFile(path, resolvedPath, stat, root) {
  if (basename(path) !== basename(resolvedPath) || dirname(resolvedPath) !== root.canonicalRoot) {
    throw new Error('Owned temporary attachment path must remain canonical')
  }
  if (!stat.isFile() || stat.isSymbolicLink?.()) {
    throw new Error('Owned temporary attachment must be a regular file')
  }
  if (!hasPrivatePermissions(stat) || !hasCurrentOwner(stat)) {
    throw new Error('Owned temporary attachment must be private and owned by this user')
  }
  if (stat.size > MAX_OWNED_TEMP_ATTACHMENT_BYTES) {
    throw new Error(`Owned temporary attachment exceeds ${MAX_OWNED_TEMP_ATTACHMENT_BYTES} bytes`)
  }
}

async function unlinkOwnedRecord(record) {
  if (!record?.ownedTemporary) return false
  try {
    const stat = await fs.lstat(record.resolvedPath)
    if (stat.isSymbolicLink()) return false
    assertFileIdentity(stat, record, 'Owned temporary attachment')
    await fs.unlink(record.resolvedPath)
    return true
  } catch {
    // Missing and identity-mismatched paths are intentionally left untouched.
    return false
  }
}

function assertScope(record, workspaceId, cardId) {
  if (record.workspaceId !== workspaceId || record.cardId !== cardId) {
    throw new Error('Attachment selection does not belong to this workspace and card')
  }
}

function publicAttachment(record) {
  return {
    selectionReceipt: record.selectionReceipt,
    displayPath: record.displayPath,
    mediaType: record.mediaType,
    byteCount: record.byteCount,
    ownedTemporary: record.ownedTemporary === true,
    hostCleanupToken: record.hostCleanupToken,
  }
}

export function createAttachmentSelectionRegistry({
  storePath,
  ownedTempRoot,
  now = () => Date.now(),
  receiptTtlMs = SELECTION_RECEIPT_TTL_MS,
} = {}) {
  const durableStorePath = resolve(String(storePath ?? '').trim())
  const configuredOwnedTempRoot = resolve(String(ownedTempRoot ?? '').trim())
  const boundedTtlMs = Math.max(
    10 * 60 * 1000,
    Math.min(30 * 24 * 60 * 60 * 1000, Number(receiptTtlMs) || SELECTION_RECEIPT_TTL_MS),
  )
  let loaded = false
  let disposed = false
  let disposing = false
  let disposePromise = null
  let records = new Map()
  let lockTail = Promise.resolve()
  const activeReservations = new Set()
  const deferredOwned = new Set()
  const pendingActivationClosures = new Set()

  async function withLock(action, { allowDuringDispose = false } = {}) {
    const previous = lockTail
    let release
    lockTail = new Promise(resolveLock => { release = resolveLock })
    await previous
    try {
      if (disposed || (disposing && !allowDuringDispose)) {
        throw new Error('Attachment selection registry is disposed')
      }
      return await action()
    } finally {
      release()
    }
  }

  async function ensureLoaded() {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(await fs.readFile(durableStorePath, 'utf8'))
      const loadedRecords = new Map()
      if (parsed?.version === STORE_VERSION && Array.isArray(parsed.records)) {
        for (const value of parsed.records.slice(0, MAX_SELECTIONS)) {
          const record = normalizeStoredRecord(value)
          if (record && !loadedRecords.has(record.selectionReceipt)) {
            loadedRecords.set(record.selectionReceipt, record)
          }
        }
      }
      records = loadedRecords
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      records = new Map()
    }
  }

  async function persist(nextRecords) {
    await atomicWriteStore(durableStorePath, nextRecords)
  }

  async function closeActivation(activation, { deleteOwned = false } = {}) {
    if (!activation) return true
    if (deleteOwned) await unlinkOwnedRecord(activation.record)
    const handle = activation.handle
    let closeError = null
    if (handle) {
      for (let attempt = 0; attempt < MAX_ACTIVATION_CLOSE_ATTEMPTS; attempt += 1) {
        try {
          await handle.close()
          activation.handle = null
          closeError = null
          break
        } catch (error) {
          closeError = error
        }
      }
    }
    if (closeError) pendingActivationClosures.add(activation)
    else pendingActivationClosures.delete(activation)
    if (deleteOwned) await unlinkOwnedRecord(activation.record)
    return !closeError
  }

  async function deferOwnedActivation(activation) {
    await closeActivation(activation)
    const deferred = { activation, timer: null }
    deferred.timer = setTimeout(() => {
      void withLock(async () => {
        if (!deferredOwned.delete(deferred)) return
        await closeActivation(deferred.activation, { deleteOwned: true })
      }).catch(() => {
        // Disposal owns any deferred activation that could not enter the lock.
      })
    }, OWNED_TEMP_ATTACHMENT_TTL_MS)
    deferred.timer.unref?.()
    deferredOwned.add(deferred)
  }

  async function issue({ workspaceId, cardId, paths, ownedTemporary = false } = {}) {
    return await withLock(async () => {
      await ensureLoaded()
      const scopedWorkspaceId = normalizeId(workspaceId)
      const scopedCardId = normalizeId(cardId)
      if (!scopedWorkspaceId) throw new Error('A valid workspaceId is required')
      if (!scopedCardId) throw new Error('A valid cardId is required')
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_SELECTIONS_PER_ISSUE) {
        throw new Error(`paths must contain 1-${MAX_SELECTIONS_PER_ISSUE} files`)
      }
      const liveWorkspaceCount = [...records.values()]
        .filter(record => record.workspaceId === scopedWorkspaceId).length
      if (
        records.size + paths.length > MAX_SELECTIONS
        || liveWorkspaceCount + paths.length > MAX_WORKSPACE_SELECTIONS
      ) throw new Error('Too many pending attachment selections')

      const root = ownedTemporary ? await canonicalOwnedRoot(configuredOwnedTempRoot) : null
      const opened = []
      const issued = []
      try {
        for (const pathValue of paths) {
          const rawPath = String(pathValue ?? '').trim()
          if (!rawPath) throw new Error('Attachment path is required')
          const requestedPath = resolve(rawPath)
          if (root) assertOwnedIssuePath(requestedPath, root, Number(now()))
          const file = await openNoFollowFile(requestedPath, null, 'Attachment')
          opened.push(file.handle)
          const resolvedPath = await fs.realpath(requestedPath)
          const pathStat = await fs.lstat(resolvedPath)
          if (pathStat.isSymbolicLink()) throw new Error('Attachment changed during validation')
          assertFileIdentity(pathStat, file.identity, 'Attachment')
          if (root) assertOwnedFile(requestedPath, resolvedPath, file.stat, root)
          let selectionReceipt
          do selectionReceipt = opaqueId('csr1_')
          while (records.has(selectionReceipt) || issued.some(record => record.selectionReceipt === selectionReceipt))
          let hostCleanupToken
          do hostCleanupToken = opaqueId('hct1_')
          while ([...records.values(), ...issued].some(record => record.hostCleanupToken === hostCleanupToken))
          const createdAt = Number(now())
          issued.push({
            selectionReceipt,
            hostCleanupToken,
            workspaceId: scopedWorkspaceId,
            cardId: scopedCardId,
            requestedPath,
            resolvedPath,
            displayPath: sanitizeAttachmentDisplayName(requestedPath),
            mediaType: guessMediaType(resolvedPath),
            ...fileIdentity(file.stat),
            createdAt,
            expiresAt: createdAt + boundedTtlMs,
            ownedTemporary: Boolean(root),
            reservationId: null,
          })
        }
        const nextRecords = new Map(records)
        for (const record of issued) nextRecords.set(record.selectionReceipt, record)
        await persist(nextRecords)
        records = nextRecords
        return { attachments: issued.map(publicAttachment) }
      } finally {
        await Promise.all(opened.map(handle => handle.close().catch(() => {})))
      }
    })
  }

  async function reserve({ workspaceId, cardId, selectionReceipts } = {}) {
    return await withLock(async () => {
      await ensureLoaded()
      const scopedWorkspaceId = normalizeId(workspaceId)
      const scopedCardId = normalizeId(cardId)
      if (!scopedWorkspaceId || !scopedCardId) {
        throw new Error('A valid workspaceId and cardId are required')
      }
      const receipts = normalizeReceiptList(selectionReceipts)
      const reservation = {
        id: opaqueId('asr1_'),
        status: 'reserved',
        records: new Map(),
        activations: new Map(),
      }
      const root = await canonicalOwnedRoot(configuredOwnedTempRoot).catch(() => null)
      const reservedIdentities = new Set()
      try {
        for (const receipt of receipts) {
          const record = records.get(receipt)
          if (!record) throw new Error('Attachment selection receipt is invalid, expired, or already used')
          assertScope(record, scopedWorkspaceId, scopedCardId)
          if (record.expiresAt <= Number(now())) {
            throw new Error('Attachment selection receipt has expired')
          }
          if (record.reservationId) {
            throw new Error('Attachment selection is already reserved by another expansion')
          }
          const identity = `${record.device}:${record.inode}`
          if (reservedIdentities.has(identity)) {
            throw new Error('Attachment selections must identify distinct files')
          }
          reservedIdentities.add(identity)
          record.reservationId = reservation.id
          reservation.records.set(receipt, record)
        }
        for (const record of reservation.records.values()) {
          const opened = await openNoFollowFile(record.resolvedPath, record, 'Attachment')
          const resolvedPath = await fs.realpath(record.resolvedPath)
          if (resolvedPath !== record.resolvedPath) throw new Error('Attachment changed during validation')
          const pathStat = await fs.lstat(record.resolvedPath)
          if (pathStat.isSymbolicLink()) throw new Error('Attachment changed during validation')
          assertFileIdentity(pathStat, record, 'Attachment')
          if (record.ownedTemporary) {
            if (!root) throw new Error('Owned temporary attachment root is unavailable')
            assertOwnedFile(record.resolvedPath, resolvedPath, opened.stat, root)
          }
          let activationCapability
          do activationCapability = randomBytes(32).toString('base64url')
          while (reservation.activations.has(activationCapability))
          reservation.activations.set(activationCapability, {
            activationCapability,
            record,
            handle: opened.handle,
            stat: opened.stat,
          })
        }
        activeReservations.add(reservation)
        return reservation
      } catch (error) {
        for (const record of reservation.records.values()) {
          if (record.reservationId === reservation.id) record.reservationId = null
        }
        await Promise.all([...reservation.activations.values()].map(activation => closeActivation(activation)))
        reservation.status = 'rolled-back'
        throw error
      }
    })
  }

  async function getReserved(reservation, activationCapability) {
    if (
      !reservation
      || reservation.status !== 'reserved'
      || !reservation.activations?.has(activationCapability)
    ) throw new Error('Attachment selection activation is no longer active')
    const activation = reservation.activations.get(activationCapability)
    if (
      activation.record.reservationId !== reservation.id
      || records.get(activation.record.selectionReceipt) !== activation.record
    ) throw new Error('Attachment selection activation changed before expansion')
    const handleStat = await activation.handle.stat()
    assertFileIdentity(handleStat, activation.record, 'Attachment')
    const pathStat = await fs.lstat(activation.record.resolvedPath)
    if (pathStat.isSymbolicLink()) throw new Error('Attachment changed during validation')
    assertFileIdentity(pathStat, activation.record, 'Attachment')
    return activation
  }

  async function rollback(reservation) {
    if (!reservation || reservation.status !== 'reserved') return
    await withLock(async () => {
      if (reservation.status !== 'reserved') return
      reservation.status = 'rolled-back'
      activeReservations.delete(reservation)
      for (const record of reservation.records.values()) {
        if (record.reservationId === reservation.id) record.reservationId = null
      }
      await Promise.all([...reservation.activations.values()].map(activation => closeActivation(activation)))
    }, { allowDuringDispose: true })
  }

  async function commit(reservation, { deferOwnedActivationCapabilities = [] } = {}) {
    if (!reservation || reservation.status !== 'reserved') {
      throw new Error('Attachment selection reservation is no longer active')
    }
    const deferred = new Set(deferOwnedActivationCapabilities)
    await withLock(async () => {
      if (reservation.status !== 'reserved') {
        throw new Error('Attachment selection reservation is no longer active')
      }
      for (const activationCapability of deferred) {
        const activation = reservation.activations.get(activationCapability)
        if (!activation?.record?.ownedTemporary) {
          throw new Error('Deferred owned selection activation is invalid')
        }
      }
      for (const [receipt, record] of reservation.records) {
        if (record.reservationId !== reservation.id || records.get(receipt) !== record) {
          throw new Error('Attachment selection reservation changed before commit')
        }
      }
      const nextRecords = new Map(records)
      for (const receipt of reservation.records.keys()) nextRecords.delete(receipt)
      await persist(nextRecords)
      records = nextRecords
      for (const [activationCapability, activation] of reservation.activations) {
        if (deferred.has(activationCapability)) await deferOwnedActivation(activation)
        else await closeActivation(activation, { deleteOwned: activation.record.ownedTemporary })
      }
      reservation.status = 'committed'
      activeReservations.delete(reservation)
      for (const record of reservation.records.values()) record.reservationId = null
    })
  }

  async function inspect(args = {}) {
    const reservation = await reserve(args)
    try {
      return { hasAttachments: reservation.records.size > 0 }
    } finally {
      await rollback(reservation)
    }
  }

  async function revoke({ workspaceId, cardId, selectionReceipts, hostCleanupTokens } = {}) {
    return await withLock(async () => {
      await ensureLoaded()
      const scopedWorkspaceId = normalizeId(workspaceId)
      const scopedCardId = normalizeId(cardId)
      if (!scopedWorkspaceId || !scopedCardId) {
        throw new Error('A valid workspaceId and cardId are required')
      }
      let requested
      if (Array.isArray(selectionReceipts) && selectionReceipts.length > 0) {
        requested = normalizeReceiptList(selectionReceipts).map(receipt => records.get(receipt))
      } else if (Array.isArray(hostCleanupTokens) && hostCleanupTokens.length > 0) {
        const tokens = hostCleanupTokens.map(value => String(value ?? '').trim())
        if (
          tokens.length > MAX_SELECTIONS_PER_ISSUE
          || tokens.some(token => !HOST_CLEANUP_TOKEN_PATTERN.test(token))
          || new Set(tokens).size !== tokens.length
        ) throw new Error('Host cleanup tokens are invalid')
        requested = tokens.map(token => [...records.values()].find(record => record.hostCleanupToken === token))
      } else {
        throw new Error('selectionReceipts or hostCleanupTokens are required')
      }
      if (requested.some(record => !record)) {
        throw new Error('Attachment selection receipt is invalid, expired, or already used')
      }
      for (const record of requested) {
        assertScope(record, scopedWorkspaceId, scopedCardId)
        if (record.reservationId) throw new Error('Attachment selection is currently in use')
      }
      const nextRecords = new Map(records)
      for (const record of requested) nextRecords.delete(record.selectionReceipt)
      await persist(nextRecords)
      records = nextRecords
      await Promise.all(requested.map(record => unlinkOwnedRecord(record)))
      return { ok: true, revoked: requested.length }
    })
  }

  async function sweepExpired() {
    return await withLock(async () => {
      await ensureLoaded()
      const expired = [...records.values()].filter(record => (
        record.expiresAt <= Number(now()) && !record.reservationId
      ))
      if (expired.length === 0) return { expired: 0, deletedOwned: 0 }
      const nextRecords = new Map(records)
      for (const record of expired) nextRecords.delete(record.selectionReceipt)
      await persist(nextRecords)
      records = nextRecords
      const deleted = await Promise.all(expired.map(record => unlinkOwnedRecord(record)))
      return { expired: expired.length, deletedOwned: deleted.filter(Boolean).length }
    })
  }

  async function listProtectedOwnedPaths() {
    return await withLock(async () => {
      await ensureLoaded()
      return new Set([...records.values()]
        .filter(record => record.ownedTemporary && record.expiresAt > Number(now()))
        .flatMap(record => [record.requestedPath, record.resolvedPath]))
    })
  }

  async function stats() {
    return await withLock(async () => {
      await ensureLoaded()
      return {
        total: records.size,
        reserved: [...records.values()].filter(record => record.reservationId).length,
        deferredOwned: deferredOwned.size,
      }
    })
  }

  async function dispose() {
    if (disposePromise) return await disposePromise
    disposing = true
    disposePromise = (async () => {
      try {
        for (const reservation of [...activeReservations]) await rollback(reservation)
        await withLock(async () => {
          for (const deferred of [...deferredOwned]) {
            if (deferred.timer) clearTimeout(deferred.timer)
            await closeActivation(deferred.activation, { deleteOwned: true })
          }
          deferredOwned.clear()
          for (const activation of [...pendingActivationClosures]) {
            await closeActivation(activation, {
              deleteOwned: activation.record.ownedTemporary,
            })
          }
          if (pendingActivationClosures.size > 0) {
            throw new Error('Attachment selection file handles could not be closed during disposal')
          }
          disposed = true
        }, { allowDuringDispose: true })
      } catch (error) {
        disposing = false
        disposePromise = null
        throw error
      }
    })()
    return await disposePromise
  }

  return {
    issue,
    inspect,
    reserve,
    getReserved,
    rollback,
    commit,
    revoke,
    sweepExpired,
    listProtectedOwnedPaths,
    stats,
    dispose,
  }
}
