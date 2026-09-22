import test from 'node:test'
import assert from 'node:assert/strict'
import { renameSync, writeFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertOwnedTempSecurityBoundary,
  attachmentCapabilityStatsForTests,
  disposeAttachmentCapabilities,
  expireAttachmentCapabilitiesForTests,
  issueAttachmentCapabilities,
  OWNED_TEMP_ATTACHMENT_TTL_MS,
  sweepStaleOwnedTempAttachments,
} from '../bin/attachment-capabilities.mjs'
import { expandFileReferences } from '../bin/file-references.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-attachment-caps-'))
  const workspaceDir = join(root, 'workspace')
  const outsideDir = join(root, 'selected')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  return { root, workspaceDir, outsideDir }
}

function capabilityMessage(capability, forgedLabel = 'forged-name.txt') {
  return `Review this selection.\n\nAttached file capabilities:\n${capability}\t${forgedLabel}`
}

function capabilitiesMessage(attachments, prefix = 'Review these selections.') {
  return `${prefix}\n\nAttached file capabilities:\n${attachments
    .map(attachment => `${attachment.capability}\t${attachment.displayName}`)
    .join('\n')}`
}

function ownedTempName(timestamp, suffix = 'note.txt', id = '00000000-0000-4000-8000-000000000000') {
  return `codesurf-owned-v1-${timestamp}-${id}-${suffix}`
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}

test.afterEach(async () => {
  await disposeAttachmentCapabilities()
})

test('win32 owned-temp policy accepts synthesized modes only inside the current user profile', () => {
  const windowsProfile = 'C:\\Users\\alice'
  const synthesizedDirectoryStat = { mode: 0o40777, uid: 0 }
  const synthesizedFileStat = { mode: 0o100666, uid: 0 }

  assert.doesNotThrow(() => assertOwnedTempSecurityBoundary({
    stat: synthesizedDirectoryStat,
    canonicalPath: `${windowsProfile}\\AppData\\Local\\CodeSurf\\chat-attachments`,
    canonicalUserProfilePath: windowsProfile,
    platform: 'win32',
    subject: 'Owned temporary attachment root',
  }))
  assert.doesNotThrow(() => assertOwnedTempSecurityBoundary({
    stat: synthesizedFileStat,
    canonicalPath: `${windowsProfile}\\AppData\\Local\\CodeSurf\\chat-attachments\\owned.txt`,
    canonicalUserProfilePath: windowsProfile,
    platform: 'win32',
    subject: 'Owned temporary attachment',
  }))
  assert.throws(() => assertOwnedTempSecurityBoundary({
    stat: synthesizedFileStat,
    canonicalPath: 'C:\\Users\\alice-other\\owned.txt',
    canonicalUserProfilePath: windowsProfile,
    platform: 'win32',
    subject: 'Owned temporary attachment',
  }), /current user profile/i)
  assert.throws(() => assertOwnedTempSecurityBoundary({
    stat: synthesizedFileStat,
    canonicalPath: 'D:\\shared\\owned.txt',
    canonicalUserProfilePath: windowsProfile,
    platform: 'win32',
    subject: 'Owned temporary attachment',
  }), /current user profile/i)

  assert.throws(() => assertOwnedTempSecurityBoundary({
    stat: synthesizedFileStat,
    canonicalPath: '/Users/alice/.codesurf/chat-attachments/owned.txt',
    canonicalUserProfilePath: '/Users/alice',
    currentUid: 0,
    platform: 'darwin',
    subject: 'Owned temporary attachment',
  }), /private and owned by this user/i)
})

test('outside-workspace picker capability expands once using the registry display name', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const selected = join(files.outsideDir, 'trusted-selection.txt')
  await writeFile(selected, 'CAPABILITY-CONTENT\n', 'utf8')
  const issued = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [selected],
  })
  const capability = issued.attachments[0].capability

  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    executionTarget: 'cloud',
    message: capabilityMessage(capability),
  })
  assert.equal(expanded.references[0].displayPath, 'trusted-selection.txt')
  assert.match(expanded.contextText, /CAPABILITY-CONTENT/)
  assert.doesNotMatch(expanded.message, /forged-name|Attached file capabilities/)
  assert.doesNotMatch(expanded.message, new RegExp(files.outsideDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  await assert.rejects(
    expandFileReferences({
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      workspaceDir: files.workspaceDir,
      message: capabilityMessage(capability),
    }),
    /invalid, expired, or already used/i,
  )
})

test('wrong workspace or card does not consume the rightful principal capability', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const selected = join(files.outsideDir, 'scoped.txt')
  await writeFile(selected, 'SCOPED-CONTENT\n', 'utf8')
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [selected],
  })
  const message = capabilityMessage(attachments[0].capability)

  await assert.rejects(
    expandFileReferences({ workspaceId: 'workspace-b', cardId: 'card-a', workspaceDir: files.workspaceDir, message }),
    /does not belong/i,
  )
  await assert.rejects(
    expandFileReferences({ workspaceId: 'workspace-a', cardId: 'card-b', workspaceDir: files.workspaceDir, message }),
    /does not belong/i,
  )
  assert.equal(attachmentCapabilityStatsForTests().total, 1)
  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message,
  })
  assert.match(expanded.contextText, /SCOPED-CONTENT/)
})

test('renamed or swapped picker selection is rejected before redemption', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const selected = join(files.outsideDir, 'swap.txt')
  const original = join(files.outsideDir, 'original.txt')
  await writeFile(selected, 'ORIGINAL\n', 'utf8')
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [selected],
  })
  await rename(selected, original)
  await writeFile(selected, 'REPLACEMENT\n', 'utf8')

  await assert.rejects(
    expandFileReferences({
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      workspaceDir: files.workspaceDir,
      message: capabilityMessage(attachments[0].capability),
    }),
    /changed during validation/i,
  )
})

test('unsupported binary preflight fails without consuming the capability', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const selected = join(files.outsideDir, 'image.png')
  await writeFile(selected, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [selected],
  })
  const message = capabilityMessage(attachments[0].capability)

  await assert.rejects(
    expandFileReferences({
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      workspaceDir: files.workspaceDir,
      message,
      supportedImageMediaTypes: [],
    }),
    /not supported/i,
  )
  assert.equal(attachmentCapabilityStatsForTests().total, 1)
  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message,
    supportedImageMediaTypes: ['image/png'],
  })
  assert.equal(expanded.references[0].binary, true)
  assert.equal(expanded.references[0].mediaType, 'image/png')
})

test('expired capability is closed and cannot be redeemed', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const selected = join(files.outsideDir, 'expires.txt')
  await writeFile(selected, 'expires\n', 'utf8')
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [selected],
  })
  await expireAttachmentCapabilitiesForTests()
  assert.equal(attachmentCapabilityStatsForTests().total, 0)
  await assert.rejects(
    expandFileReferences({
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      workspaceDir: files.workspaceDir,
      message: capabilityMessage(attachments[0].capability),
    }),
    /invalid, expired, or already used/i,
  )
})

test('picker files remain user-owned after redemption and expiry', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const redeemed = join(files.outsideDir, 'picked-redeemed.txt')
  const expired = join(files.outsideDir, 'picked-expired.txt')
  await writeFile(redeemed, 'redeemed picker file\n', 'utf8')
  await writeFile(expired, 'expired picker file\n', 'utf8')

  const redeemedIssue = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [redeemed],
  })
  await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilityMessage(redeemedIssue.attachments[0].capability),
  })
  assert.equal(await readFile(redeemed, 'utf8'), 'redeemed picker file\n')

  await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [expired],
  })
  await expireAttachmentCapabilitiesForTests()
  assert.equal(await readFile(expired, 'utf8'), 'expired picker file\n')
})

test('owned temporary files are deleted on redemption and expiry', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const ownedRoot = join(files.root, 'chat-attachments')
  await mkdir(ownedRoot, { mode: 0o700 })
  const redeemed = join(ownedRoot, ownedTempName(Date.now(), 'redeemed.txt'))
  const expired = join(
    ownedRoot,
    ownedTempName(Date.now(), 'expired.txt', '11111111-1111-4111-8111-111111111111'),
  )
  await writeFile(redeemed, 'owned redemption content\n', { mode: 0o600 })
  await writeFile(expired, 'owned expiry content\n', { mode: 0o600 })

  const redeemedIssue = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [redeemed],
    ownedTemporary: true,
    ownedTempRoot: ownedRoot,
  })
  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilityMessage(redeemedIssue.attachments[0].capability),
  })
  assert.match(expanded.contextText, /owned redemption content/)
  await assertMissing(redeemed)

  await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [expired],
    ownedTemporary: true,
    ownedTempRoot: ownedRoot,
  })
  await expireAttachmentCapabilitiesForTests()
  await assertMissing(expired)
})

test('owned cleanup never deletes a replacement at the attested path', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const ownedRoot = join(files.root, 'chat-attachments')
  await mkdir(ownedRoot, { mode: 0o700 })
  const ownedPath = join(ownedRoot, ownedTempName(Date.now(), 'replace.txt'))
  const movedOriginal = join(files.root, 'moved-original.txt')
  await writeFile(ownedPath, 'ORIGINAL\n', { mode: 0o600 })
  await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [ownedPath],
    ownedTemporary: true,
    ownedTempRoot: ownedRoot,
  })
  await rename(ownedPath, movedOriginal)
  await writeFile(ownedPath, 'REPLACEMENT\n', { mode: 0o600 })

  await expireAttachmentCapabilitiesForTests()
  assert.equal(await readFile(ownedPath, 'utf8'), 'REPLACEMENT\n')
  assert.equal(await readFile(movedOriginal, 'utf8'), 'ORIGINAL\n')
})

test('owned issuance rollback deletes only files successfully enrolled before failure', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const ownedRoot = join(files.root, 'chat-attachments')
  await mkdir(ownedRoot, { mode: 0o700 })
  const first = join(ownedRoot, ownedTempName(Date.now(), 'first.txt'))
  const missing = join(
    ownedRoot,
    ownedTempName(Date.now(), 'missing.txt', '22222222-2222-4222-8222-222222222222'),
  )
  await writeFile(first, 'ROLL ME BACK\n', { mode: 0o600 })

  await assert.rejects(issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [first, missing],
    ownedTemporary: true,
    ownedTempRoot: ownedRoot,
  }))
  assert.equal(attachmentCapabilityStatsForTests().total, 0)
  await assertMissing(first)
  await assertMissing(missing)
})

test('owned issuance rejects non-canonical picker paths without deleting them', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const ownedRoot = join(files.root, 'chat-attachments')
  await mkdir(ownedRoot, { mode: 0o700 })
  const picked = join(files.outsideDir, ownedTempName(Date.now(), 'picked.txt'))
  await writeFile(picked, 'PICKED\n', { mode: 0o600 })

  await assert.rejects(issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [picked],
    ownedTemporary: true,
    ownedTempRoot: ownedRoot,
  }), /owned temporary attachment path/i)
  assert.equal(await readFile(picked, 'utf8'), 'PICKED\n')
})

test('startup sweep deletes only stale strict owned files in the direct temp root', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const ownedRoot = join(files.root, 'chat-attachments')
  const outsideTarget = join(files.root, 'outside-target.txt')
  await mkdir(ownedRoot, { mode: 0o700 })
  await writeFile(outsideTarget, 'OUTSIDE\n', 'utf8')
  const now = Date.now()
  const staleTime = now - OWNED_TEMP_ATTACHMENT_TTL_MS - 5_000
  const fresh = join(ownedRoot, ownedTempName(now, 'fresh.txt'))
  const stale = join(ownedRoot, ownedTempName(staleTime, 'stale.txt'))
  const protectedStale = join(
    ownedRoot,
    ownedTempName(staleTime, 'protected.txt', '66666666-6666-4666-8666-666666666666'),
  )
  const ordinary = join(ownedRoot, 'user-note.txt')
  const suspiciousMode = join(
    ownedRoot,
    ownedTempName(staleTime, 'wide.txt', '33333333-3333-4333-8333-333333333333'),
  )
  const symlinkPath = join(
    ownedRoot,
    ownedTempName(staleTime, 'link.txt', '44444444-4444-4444-8444-444444444444'),
  )
  const directoryPath = join(
    ownedRoot,
    ownedTempName(staleTime, 'directory', '55555555-5555-4555-8555-555555555555'),
  )
  await writeFile(fresh, 'FRESH\n', { mode: 0o600 })
  await writeFile(stale, 'STALE\n', { mode: 0o600 })
  await writeFile(protectedStale, 'PROTECTED\n', { mode: 0o600 })
  await writeFile(ordinary, 'USER\n', { mode: 0o600 })
  await writeFile(suspiciousMode, 'WIDE\n', { mode: 0o600 })
  await chmod(suspiciousMode, 0o644)
  await symlink(outsideTarget, symlinkPath)
  await mkdir(directoryPath)
  const staleDate = new Date(staleTime)
  await utimes(stale, staleDate, staleDate)
  await utimes(protectedStale, staleDate, staleDate)
  await utimes(suspiciousMode, staleDate, staleDate)

  const result = await sweepStaleOwnedTempAttachments({
    ownedTempRoot: ownedRoot,
    now,
    protectedPaths: new Set([protectedStale]),
  })

  assert.equal(result.deleted, 1)
  await assertMissing(stale)
  assert.equal(await readFile(fresh, 'utf8'), 'FRESH\n')
  assert.equal(await readFile(protectedStale, 'utf8'), 'PROTECTED\n')
  assert.equal(await readFile(ordinary, 'utf8'), 'USER\n')
  assert.equal(await readFile(suspiciousMode, 'utf8'), 'WIDE\n')
  assert.equal(await readFile(symlinkPath, 'utf8'), 'OUTSIDE\n')
  assert.equal((await lstat(directoryPath)).isDirectory(), true)
  assert.equal(await readFile(outsideTarget, 'utf8'), 'OUTSIDE\n')
})

test('large selected text is read through the configured positional preview bound', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const selected = join(files.outsideDir, 'large.txt')
  await writeFile(selected, `HEAD-${'x'.repeat(1024 * 1024)}-TAIL`, 'utf8')
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [selected],
  })
  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilityMessage(attachments[0].capability),
    maxBytesPerFile: 64,
  })
  assert.equal(expanded.references[0].truncated, true)
  assert.equal(expanded.references[0].byteCount, 1024 * 1024 + 10)
  assert.match(expanded.contextText, /HEAD-/)
  assert.doesNotMatch(expanded.contextText, /-TAIL/)
})

test('the issue and expansion limits agree for twelve attachments', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const paths = []
  for (let index = 0; index < 12; index += 1) {
    const path = join(files.outsideDir, `attachment-${index}.txt`)
    await writeFile(path, `attachment ${index}\n`, 'utf8')
    paths.push(path)
  }
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths,
  })
  assert.equal(attachments.length, 12)

  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilitiesMessage(attachments),
  })
  assert.equal(expanded.references.length, 12)
  assert.deepEqual(
    expanded.references.map(reference => reference.capability),
    attachments.map(attachment => attachment.capability),
  )
  assert.equal(attachmentCapabilityStatsForTests().total, 0)
})

test('combined reference overflow rejects atomically before redeeming attachments', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  await writeFile(join(files.workspaceDir, 'inside.txt'), 'inside\n', 'utf8')
  const paths = []
  for (let index = 0; index < 12; index += 1) {
    const path = join(files.outsideDir, `pending-${index}.txt`)
    await writeFile(path, `pending ${index}\n`, 'utf8')
    paths.push(path)
  }
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths,
  })

  await assert.rejects(expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilitiesMessage(attachments, 'Review @file:inside.txt as well.'),
  }), /at most 12 combined file references and attachments/)
  assert.equal(attachmentCapabilityStatsForTests().total, 12)
})

test('duplicate capability references are rejected without consuming the capability', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const selected = join(files.outsideDir, 'duplicate.txt')
  await writeFile(selected, 'DUPLICATE\n', 'utf8')
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [selected],
  })
  const duplicateMessage = capabilitiesMessage([attachments[0], attachments[0]])

  await assert.rejects(expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: duplicateMessage,
  }), /must not contain duplicates/i)
  assert.equal(attachmentCapabilityStatsForTests().total, 1)

  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilityMessage(attachments[0].capability),
  })
  assert.match(expanded.contextText, /DUPLICATE/)
})

test('a second capability read failure rolls back the entire expansion transaction', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const first = join(files.outsideDir, 'atomic-first.txt')
  const second = join(files.outsideDir, 'atomic-second.txt')
  await writeFile(first, 'ATOMIC FIRST\n', 'utf8')
  await writeFile(second, 'ATOMIC SECOND\n', 'utf8')
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [first, second],
  })
  let readConversions = 0
  const failOnSecondRead = {
    valueOf() {
      readConversions += 1
      if (readConversions === 3) throw new Error('simulated second read failure')
      return 64
    },
  }

  await assert.rejects(expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilitiesMessage(attachments),
    maxBytesPerFile: failOnSecondRead,
  }), /simulated second read failure/i)
  assert.equal(attachmentCapabilityStatsForTests().total, 2)

  const retried = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilitiesMessage(attachments),
    maxBytesPerFile: 64,
  })
  assert.match(retried.contextText, /ATOMIC FIRST/)
  assert.match(retried.contextText, /ATOMIC SECOND/)
  assert.equal(attachmentCapabilityStatsForTests().total, 0)
})

test('an in-flight path replacement aborts without consuming the reserved capability', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const selected = join(files.outsideDir, 'in-flight.txt')
  const moved = join(files.outsideDir, 'in-flight-original.txt')
  await writeFile(selected, 'ORIGINAL IN FLIGHT\n', 'utf8')
  const { attachments } = await issueAttachmentCapabilities({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [selected],
  })
  let replaced = false
  const replaceDuringRead = {
    valueOf() {
      if (!replaced) {
        replaced = true
        renameSync(selected, moved)
        writeFileSync(selected, 'REPLACEMENT IN FLIGHT\n')
      }
      return 64
    },
  }

  await assert.rejects(expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: capabilityMessage(attachments[0].capability),
    maxBytesPerFile: replaceDuringRead,
  }), /changed during validation/i)
  assert.equal(attachmentCapabilityStatsForTests().total, 1)
  assert.equal(await readFile(selected, 'utf8'), 'REPLACEMENT IN FLIGHT\n')
  assert.equal(await readFile(moved, 'utf8'), 'ORIGINAL IN FLIGHT\n')
})
