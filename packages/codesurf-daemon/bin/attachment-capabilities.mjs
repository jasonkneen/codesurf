import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, posix, resolve, win32 } from 'node:path'
import {
  assertFileIdentity,
  fileIdentity,
  openNoFollowFile,
  readHandlePrefix,
} from './secure-file-reader.mjs'

export const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const OWNED_TEMP_ATTACHMENT_TTL_MS = 5 * 60 * 1000
export const OWNED_TEMP_ATTACHMENT_NAME_PATTERN = /^codesurf-owned-v1-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9](?:[A-Za-z0-9._-]{0,39})\.[a-z0-9]{1,12}$/
const CAPABILITY_TTL_MS = OWNED_TEMP_ATTACHMENT_TTL_MS
const MAX_OWNED_TEMP_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_STARTUP_SWEEP_ENTRIES = 2_048
const OWNED_NAME_CLOCK_SKEW_MS = 30 * 1000
const MAX_CAPABILITIES = 128
const MAX_WORKSPACE_CAPABILITIES = 24
export const MAX_PER_ISSUE = 12
const records = new Map()
const deferredOwnedRecords = new Set()

function normalizeId(value) {
  const id = String(value ?? '').trim()
  return id && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id) && !id.includes('..') ? id : null
}

export function sanitizeAttachmentDisplayName(value) {
  const name = basename(String(value ?? '').replace(/[\r\n\t\0]/g, ' ')).trim()
  return (name || 'attachment').slice(0, 160)
}

function isPathWithinBoundary(canonicalBoundaryPath, canonicalPath, platform) {
  const pathApi = platform === 'win32' ? win32 : posix
  if (!pathApi.isAbsolute(canonicalBoundaryPath) || !pathApi.isAbsolute(canonicalPath)) return false
  if (pathApi.dirname(canonicalBoundaryPath) === canonicalBoundaryPath) return false
  const relativePath = pathApi.relative(canonicalBoundaryPath, canonicalPath)
  return relativePath === ''
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relativePath))
}

export function assertOwnedTempSecurityBoundary({
  stat,
  canonicalPath,
  canonicalUserProfilePath = null,
  currentUid,
  platform = process.platform,
  subject = 'Owned temporary attachment',
} = {}) {
  if (platform === 'win32') {
    // Windows mode bits are synthesized from ACLs and cannot establish privacy.
    // Keep the capability inside the canonical user profile instead.
    if (!canonicalUserProfilePath || !isPathWithinBoundary(canonicalUserProfilePath, canonicalPath, platform)) {
      throw new Error(`${subject} must remain inside the current user profile`)
    }
    return
  }

  const expectedUid = currentUid === undefined
    ? typeof process.getuid === 'function' ? process.getuid() : null
    : currentUid
  if (!stat || (stat.mode & 0o077) !== 0 || (expectedUid != null && stat.uid !== expectedUid)) {
    throw new Error(`${subject} must be private and owned by this user`)
  }
}

export async function resolveOwnedTempSecurityContext() {
  const platform = process.platform
  if (platform !== 'win32') {
    return {
      platform,
      currentUid: typeof process.getuid === 'function' ? process.getuid() : null,
    }
  }
  const canonicalUserProfilePath = await fs.realpath(resolve(homedir()))
  const profileStat = await fs.lstat(canonicalUserProfilePath)
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
    throw new Error('Current user profile must be a canonical directory')
  }
  return { platform, canonicalUserProfilePath }
}

function ownedNameTimestamp(name) {
  const match = OWNED_TEMP_ATTACHMENT_NAME_PATTERN.exec(name)
  if (!match) return null
  const timestamp = Number(match[1])
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

async function resolveOwnedTempRoot(value) {
  const requestedRoot = resolve(String(value ?? '').trim())
  if (basename(requestedRoot) !== 'chat-attachments') {
    throw new Error('Owned temporary attachment root is invalid')
  }
  const rootStat = await fs.lstat(requestedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Owned temporary attachment root must be a canonical directory')
  }
  const canonicalRoot = await fs.realpath(requestedRoot)
  const securityContext = await resolveOwnedTempSecurityContext()
  assertOwnedTempSecurityBoundary({
    stat: rootStat,
    canonicalPath: canonicalRoot,
    subject: 'Owned temporary attachment root',
    ...securityContext,
  })
  return { requestedRoot, canonicalRoot, securityContext }
}

function assertOwnedTempPathShape(requestedPath, ownedTempRoot, now = Date.now()) {
  if (dirname(requestedPath) !== ownedTempRoot.requestedRoot) {
    throw new Error('Owned temporary attachment path must be a direct child of the app-owned root')
  }
  const timestamp = ownedNameTimestamp(basename(requestedPath))
  if (timestamp == null) {
    throw new Error('Owned temporary attachment name is invalid')
  }
  if (
    timestamp > now + OWNED_NAME_CLOCK_SKEW_MS
    || now - timestamp > OWNED_TEMP_ATTACHMENT_TTL_MS
  ) {
    throw new Error('Owned temporary attachment name is outside the issuance window')
  }
}

function assertOwnedTempOpenedFile(requestedPath, resolvedPath, stat, ownedTempRoot) {
  if (
    basename(requestedPath) !== basename(resolvedPath)
    || dirname(resolvedPath) !== ownedTempRoot.canonicalRoot
  ) {
    throw new Error('Owned temporary attachment path must remain canonical')
  }
  if (!stat.isFile() || stat.isSymbolicLink?.()) {
    throw new Error('Owned temporary attachment must be a regular file')
  }
  assertOwnedTempSecurityBoundary({
    stat,
    canonicalPath: resolvedPath,
    subject: 'Owned temporary attachment',
    ...ownedTempRoot.securityContext,
  })
  if (stat.size > MAX_OWNED_TEMP_ATTACHMENT_BYTES) {
    throw new Error(`Owned temporary attachment exceeds ${MAX_OWNED_TEMP_ATTACHMENT_BYTES} bytes`)
  }
}

async function unlinkOwnedRecordPath(record) {
  if (!record?.ownedTemporary || record.ownedPathDeleted) return false
  try {
    const pathStat = await fs.lstat(record.resolvedPath)
    if (pathStat.isSymbolicLink()) return false
    assertFileIdentity(pathStat, record, 'Owned temporary attachment')
    await fs.unlink(record.resolvedPath)
    record.ownedPathDeleted = true
    return true
  } catch {
    // A missing, replaced, or inaccessible path is deliberately left alone.
    // In particular, never unlink a replacement merely because it occupies
    // the path that was attested when the capability was issued.
    return false
  }
}

async function closeRecord(record, { deleteOwned = true } = {}) {
  if (!record) return false
  if (record.timer) clearTimeout(record.timer)
  record.timer = null
  let deleted = deleteOwned ? await unlinkOwnedRecordPath(record) : false
  const handle = record.handle
  record.handle = null
  await handle?.close().catch(() => {})
  // Windows can reject unlink while the read handle is open. Retry only after
  // closing, with the same path identity check, so POSIX gets unlink-before-
  // read semantics while Windows still gets bounded cleanup.
  if (deleteOwned && !deleted) deleted = await unlinkOwnedRecordPath(record)
  return deleted
}

async function deferOwnedRecordCleanup(record) {
  await closeRecord(record, { deleteOwned: false })
  record.timer = setTimeout(() => {
    deferredOwnedRecords.delete(record)
    void closeRecord(record)
  }, OWNED_TEMP_ATTACHMENT_TTL_MS)
  record.timer.unref?.()
  deferredOwnedRecords.add(record)
}

async function expire(capability) {
  const record = records.get(capability)
  if (!record) return
  if (record.reservationId) {
    record.expiredWhileReserved = true
    return
  }
  records.delete(capability)
  await closeRecord(record)
}

function workspaceCount(workspaceId) {
  let count = 0
  for (const record of records.values()) if (record.workspaceId === workspaceId) count += 1
  return count
}

function assertPrincipal(record, workspaceId, cardId) {
  if (!workspaceId || !cardId || record.workspaceId !== workspaceId || record.cardId !== cardId) {
    throw new Error('Attachment capability does not belong to this workspace and card')
  }
}

async function assertLiveRecord(record) {
  if (record.expiresAt <= Date.now()) {
    records.delete(record.capability)
    await closeRecord(record)
    throw new Error('Attachment capability has expired')
  }
  const stat = await record.handle.stat()
  assertFileIdentity(stat, record, 'Attachment')
  let pathStat
  try {
    pathStat = await fs.lstat(record.resolvedPath)
  } catch {
    throw new Error('Attachment changed during validation')
  }
  if (pathStat.isSymbolicLink()) throw new Error('Attachment changed during validation')
  assertFileIdentity(pathStat, record, 'Attachment')
  return stat
}

function getRecord(capability) {
  if (!CAPABILITY_PATTERN.test(String(capability ?? ''))) {
    throw new Error('Attachment capability is invalid')
  }
  const record = records.get(capability)
  if (!record) throw new Error('Attachment capability is invalid, expired, or already used')
  return record
}

export async function issueAttachmentCapabilities({
  workspaceId,
  cardId,
  paths,
  ownedTemporary = false,
  ownedTempRoot = null,
} = {}) {
  const scopedWorkspaceId = normalizeId(workspaceId)
  const scopedCardId = normalizeId(cardId)
  if (!scopedWorkspaceId) throw new Error('A valid workspaceId is required')
  if (!scopedCardId) throw new Error('A valid cardId is required')
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PER_ISSUE) {
    throw new Error(`paths must contain 1-${MAX_PER_ISSUE} files`)
  }
  if (
    records.size + paths.length > MAX_CAPABILITIES
    || workspaceCount(scopedWorkspaceId) + paths.length > MAX_WORKSPACE_CAPABILITIES
  ) throw new Error('Too many pending attachment capabilities')
  const canonicalOwnedTempRoot = ownedTemporary
    ? await resolveOwnedTempRoot(ownedTempRoot)
    : null

  const issued = []
  try {
    for (const pathValue of paths) {
      const requestedPath = resolve(String(pathValue ?? '').trim())
      if (canonicalOwnedTempRoot) {
        assertOwnedTempPathShape(requestedPath, canonicalOwnedTempRoot)
      }
      const opened = await openNoFollowFile(requestedPath, null, 'Attachment')
      try {
        const resolvedPath = await fs.realpath(requestedPath)
        if (canonicalOwnedTempRoot) {
          assertOwnedTempOpenedFile(
            requestedPath,
            resolvedPath,
            opened.stat,
            canonicalOwnedTempRoot,
          )
        }
        let capability
        do capability = randomBytes(32).toString('base64url')
        while (records.has(capability))
        const record = {
          capability,
          workspaceId: scopedWorkspaceId,
          cardId: scopedCardId,
          resolvedPath,
          displayName: sanitizeAttachmentDisplayName(requestedPath),
          ...fileIdentity(opened.stat),
          expiresAt: Date.now() + CAPABILITY_TTL_MS,
          ownedTemporary: Boolean(canonicalOwnedTempRoot),
          ownedPathDeleted: false,
          reservationId: null,
          expiredWhileReserved: false,
          handle: opened.handle,
          timer: null,
        }
        record.timer = setTimeout(() => void expire(capability), CAPABILITY_TTL_MS)
        record.timer.unref?.()
        records.set(capability, record)
        issued.push(record)
      } catch (error) {
        await opened.handle.close().catch(() => {})
        throw error
      }
    }
    return {
      attachments: issued.map(({ capability, displayName }) => ({ capability, displayName })),
    }
  } catch (error) {
    for (const record of issued) {
      records.delete(record.capability)
      await closeRecord(record)
    }
    throw error
  }
}

function assertReservation(reservation) {
  if (!reservation || reservation.status !== 'reserved' || !(reservation.records instanceof Map)) {
    throw new Error('Attachment capability reservation is no longer active')
  }
}

function restoreCapabilityTimer(record) {
  if (record.timer) clearTimeout(record.timer)
  const remaining = Math.max(0, record.expiresAt - Date.now())
  record.timer = setTimeout(() => void expire(record.capability), remaining)
  record.timer.unref?.()
}

export async function reserveAttachmentCapabilities({
  capabilities,
  workspaceId,
  cardId,
  sampleBytes = 16 * 1024,
} = {}) {
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > MAX_PER_ISSUE) {
    throw new Error(`capabilities must contain 1-${MAX_PER_ISSUE} values`)
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error('Attachment capabilities must not contain duplicates')
  }
  const reservation = {
    id: randomBytes(24).toString('base64url'),
    status: 'reserved',
    records: new Map(),
    preflight: [],
  }

  // Claim every record synchronously before the first await. Node can then
  // interleave other requests during file validation without allowing a
  // second expansion to consume any member of this transaction.
  try {
    for (const capability of capabilities) {
      const record = getRecord(capability)
      assertPrincipal(record, workspaceId, cardId)
      if (record.reservationId) {
        throw new Error('Attachment capability is already reserved by another expansion')
      }
      record.reservationId = reservation.id
      record.expiredWhileReserved = false
      if (record.timer) clearTimeout(record.timer)
      record.timer = null
      reservation.records.set(capability, record)
    }

    for (const [capability, record] of reservation.records) {
      const stat = await assertLiveRecord(record)
      const sample = await readHandlePrefix(record.handle, stat.size, sampleBytes, true)
      reservation.preflight.push({
        capability,
        resolvedPath: record.resolvedPath,
        displayName: record.displayName,
        device: record.device,
        inode: record.inode,
        byteCount: record.byteCount,
        binarySample: sample.includes(0),
        ownedTemporary: record.ownedTemporary === true,
      })
    }
    return reservation
  } catch (error) {
    await rollbackAttachmentCapabilityReservation(reservation)
    throw error
  }
}

export async function getReservedAttachmentCapability(reservation, capability) {
  assertReservation(reservation)
  const record = reservation.records.get(capability)
  if (!record || record.reservationId !== reservation.id || records.get(capability) !== record) {
    throw new Error('Attachment capability is not part of this reservation')
  }
  const stat = await assertLiveRecord(record)
  return { record, stat, handle: record.handle }
}

export async function rollbackAttachmentCapabilityReservation(reservation) {
  if (!reservation || reservation.status !== 'reserved' || !(reservation.records instanceof Map)) return
  reservation.status = 'rolled-back'
  for (const [capability, record] of reservation.records) {
    if (record.reservationId !== reservation.id) continue
    record.reservationId = null
    if (
      record.expiredWhileReserved
      || record.expiresAt <= Date.now()
      || records.get(capability) !== record
    ) {
      records.delete(capability)
      await closeRecord(record)
      continue
    }
    record.expiredWhileReserved = false
    restoreCapabilityTimer(record)
  }
}

export async function commitAttachmentCapabilityReservation(
  reservation,
  { deferOwnedCapabilities = [] } = {},
) {
  assertReservation(reservation)
  const deferred = new Set(deferOwnedCapabilities)
  for (const capability of deferred) {
    if (!reservation.records.has(capability)) {
      throw new Error('Deferred owned capability is not part of this reservation')
    }
  }
  for (const [capability, record] of reservation.records) {
    if (record.reservationId !== reservation.id || records.get(capability) !== record) {
      throw new Error('Attachment capability reservation changed before commit')
    }
  }

  // Consume the full set as one synchronous state transition. Cleanup may
  // await filesystem operations afterwards, but no observer can see a partial
  // capability transaction.
  reservation.status = 'committing'
  for (const [capability, record] of reservation.records) {
    records.delete(capability)
    record.reservationId = null
    if (record.timer) clearTimeout(record.timer)
    record.timer = null
  }
  for (const [capability, record] of reservation.records) {
    if (record.ownedTemporary && deferred.has(capability)) {
      await deferOwnedRecordCleanup(record)
    } else {
      await closeRecord(record)
    }
  }
  reservation.status = 'committed'
}

export async function preflightAttachmentCapabilities(args = {}) {
  const reservation = await reserveAttachmentCapabilities(args)
  try {
    return reservation.preflight
  } finally {
    await rollbackAttachmentCapabilityReservation(reservation)
  }
}

export async function disposeAttachmentCapabilities() {
  const pending = [...records.values()]
  const deferred = [...deferredOwnedRecords]
  records.clear()
  deferredOwnedRecords.clear()
  await Promise.all([...pending, ...deferred].map(record => closeRecord(record)))
}

export async function expireAttachmentCapabilitiesForTests() {
  await Promise.all([...records.keys()].map(expire))
}

export async function sweepStaleOwnedTempAttachments({
  ownedTempRoot,
  now = Date.now(),
  ttlMs = OWNED_TEMP_ATTACHMENT_TTL_MS,
  protectedPaths = [],
} = {}) {
  const boundedNow = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const boundedTtlMs = Math.max(
    OWNED_TEMP_ATTACHMENT_TTL_MS,
    Math.min(24 * 60 * 60 * 1000, Number(ttlMs) || OWNED_TEMP_ATTACHMENT_TTL_MS),
  )
  let ownedRoot
  try {
    ownedRoot = await resolveOwnedTempRoot(ownedTempRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return { scanned: 0, deleted: 0, skipped: 0 }
    throw error
  }
  const canonicalRoot = ownedRoot.canonicalRoot
  const securityContext = ownedRoot.securityContext
  const protectedOwnedPaths = new Set()
  for (const value of protectedPaths) {
    const protectedPath = resolve(String(value ?? '').trim())
    protectedOwnedPaths.add(protectedPath)
    try {
      protectedOwnedPaths.add(await fs.realpath(protectedPath))
    } catch {
      // Missing protected records are handled by the durable selection sweep.
    }
  }
  const entries = (await fs.readdir(canonicalRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_STARTUP_SWEEP_ENTRIES)
  let scanned = 0
  let deleted = 0
  let skipped = 0
  for (const entry of entries) {
    scanned += 1
    const timestamp = ownedNameTimestamp(entry.name)
    if (!entry.isFile() || timestamp == null || boundedNow - timestamp < boundedTtlMs) {
      skipped += 1
      continue
    }
    const candidatePath = resolve(canonicalRoot, entry.name)
    if (protectedOwnedPaths.has(candidatePath)) {
      skipped += 1
      continue
    }
    if (dirname(candidatePath) !== canonicalRoot) {
      skipped += 1
      continue
    }
    let opened
    try {
      const pathStat = await fs.lstat(candidatePath)
      if (
        !pathStat.isFile()
        || pathStat.isSymbolicLink()
        || (() => {
          try {
            assertOwnedTempSecurityBoundary({
              stat: pathStat,
              canonicalPath: candidatePath,
              subject: 'Owned temporary attachment',
              ...securityContext,
            })
            return false
          } catch {
            return true
          }
        })()
        || pathStat.size > MAX_OWNED_TEMP_ATTACHMENT_BYTES
        || boundedNow - pathStat.mtimeMs < boundedTtlMs
      ) {
        skipped += 1
        continue
      }
      opened = await openNoFollowFile(candidatePath, fileIdentity(pathStat), 'Owned temporary attachment')
      const record = {
        resolvedPath: candidatePath,
        ...fileIdentity(opened.stat),
        ownedTemporary: true,
        ownedPathDeleted: false,
        handle: opened.handle,
        timer: null,
      }
      opened = null
      if (await closeRecord(record)) deleted += 1
      else skipped += 1
    } catch {
      await opened?.handle?.close().catch(() => {})
      skipped += 1
    }
  }
  return { scanned, deleted, skipped }
}

export function attachmentCapabilityStatsForTests() {
  return {
    total: records.size,
    deferredOwned: deferredOwnedRecords.size,
    byWorkspace: Object.fromEntries(
      [...new Set([...records.values()].map(record => record.workspaceId))]
        .map(workspaceId => [workspaceId, workspaceCount(workspaceId)]),
    ),
  }
}
