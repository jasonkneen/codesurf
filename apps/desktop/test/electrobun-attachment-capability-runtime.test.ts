import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ElectrobunOwnedAttachmentRegistry,
  issueElectrobunPickedAttachments,
  revokeElectrobunAttachmentSelections,
  writeElectrobunTempAttachment,
} from '../electrobun/bun/attachment-capability-runtime.ts'

test('picked attachments are issued to the exact workspace and card scope', async () => {
  const calls: unknown[] = []
  const attachments = await issueElectrobunPickedAttachments(
    'workspace-a',
    'card-a',
    ['/private/example.txt'],
    async (...args) => {
      calls.push(args)
      return [{
        selectionReceipt: 'selection-receipt',
        hostCleanupToken: 'private-cleanup-token',
        displayPath: 'example.txt',
      }]
    },
  )
  assert.deepEqual(calls, [['workspace-a', 'card-a', ['/private/example.txt']]])
  assert.deepEqual(attachments, [{ selectionReceipt: 'selection-receipt', displayPath: 'example.txt' }])
  assert.equal(JSON.stringify(attachments).includes('private-cleanup-token'), false)
})

test('empty picker selection does not issue a capability', async () => {
  let called = false
  const attachments = await issueElectrobunPickedAttachments('', '', [], async () => {
    called = true
    return []
  })
  assert.deepEqual(attachments, [])
  assert.equal(called, false)
})

test('renderer supplied bytes are private and only return a capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-attachment-'))
  let issuedPath = ''
  const result = await writeElectrobunTempAttachment({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    data: Buffer.from('verified image bytes').toString('base64'),
    mime: 'image/png',
    filenameHint: '../../sketch',
  }, join(root, 'attachments'), async (workspaceId, cardId, paths) => {
    assert.equal(workspaceId, 'workspace-a')
    assert.equal(cardId, 'card-a')
    issuedPath = paths[0]
    return [{
      selectionReceipt: 'selection-receipt',
      hostCleanupToken: 'private-cleanup-token',
      displayPath: 'sketch.png',
      mediaType: 'image/png',
      byteCount: 20,
      ownedTemporary: true,
    }]
  })

  assert.deepEqual(result, {
    ok: true,
    attachment: {
      selectionReceipt: 'selection-receipt',
      displayPath: 'sketch.png',
      mediaType: 'image/png',
      byteCount: 20,
      ownedTemporary: true,
    },
  })
  assert.equal((await stat(join(root, 'attachments'))).mode & 0o777, 0o700)
  assert.equal((await stat(issuedPath)).mode & 0o777, 0o600)
  assert.equal((await readFile(issuedPath)).toString(), 'verified image bytes')
  assert.equal(JSON.stringify(result).includes(root), false)
})

test('invalid payloads fail closed before capability issuance', async () => {
  let called = false
  const result = await writeElectrobunTempAttachment({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    data: 'not base64',
  }, join(tmpdir(), 'unused-electrobun-attachment-dir'), async () => {
    called = true
    return []
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /canonical base64/)
  assert.equal(called, false)
})

test('encoded and decoded size limits reject before writing or issuing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-attachment-limit-'))
  const attachmentDirectory = join(root, 'attachments')
  const maxBytes = 5 * 1024 * 1024
  let called = false
  const issue = async () => {
    called = true
    return []
  }

  const encodedOversize = await writeElectrobunTempAttachment({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    data: 'A'.repeat(Math.ceil(maxBytes / 3) * 4 + 4),
  }, attachmentDirectory, issue)
  assert.equal(encodedOversize.ok, false)
  assert.match(encodedOversize.error, /byte limit/)

  const decodedOversize = await writeElectrobunTempAttachment({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    data: Buffer.alloc(maxBytes + 1).toString('base64'),
  }, attachmentDirectory, issue)
  assert.equal(decodedOversize.ok, false)
  assert.match(decodedOversize.error, /byte limit/)
  assert.equal(called, false)
  await assert.rejects(stat(attachmentDirectory), { code: 'ENOENT' })
})

test('consumed runtime-owned attachments are deleted without exposing their path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-owned-attachment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const attachmentDirectory = join(root, 'attachments')
  const registry = new ElectrobunOwnedAttachmentRegistry(attachmentDirectory)
  let issuedPath = ''
  const result = await writeElectrobunTempAttachment({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    data: Buffer.from('private bytes').toString('base64'),
  }, attachmentDirectory, async (_workspaceId, _cardId, paths) => {
    issuedPath = paths[0]
    return [{
      selectionReceipt: 'owned-selection',
      hostCleanupToken: 'owned-cleanup-token',
      displayPath: 'attachment.bin',
      ownedTemporary: true,
    }]
  }, registry)

  assert.equal(result.ok, true)
  assert.equal(registry.pendingCountForTests(), 1)
  assert.equal((await readFile(issuedPath)).toString(), 'private bytes')
  await registry.cleanupCapabilities(['owned-cleanup-token'])
  assert.equal(registry.pendingCountForTests(), 0)
  await assert.rejects(stat(issuedPath), { code: 'ENOENT' })
})

test('committed receipts register immediately and never delete a path replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-owned-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const attachmentDirectory = join(root, 'attachments')
  await mkdir(attachmentDirectory, { mode: 0o700 })
  const consumedPath = join(attachmentDirectory, 'consumed.bin')
  const replacedPath = join(attachmentDirectory, 'replaced.bin')
  await writeFile(consumedPath, 'consume', { mode: 0o600 })
  await writeFile(replacedPath, 'original', { mode: 0o600 })
  const consumedIdentity = await stat(consumedPath)
  const replacedIdentity = await stat(replacedPath)
  const registry = new ElectrobunOwnedAttachmentRegistry(attachmentDirectory)

  const cleanupTokens = registry.registerExpansionResponse({
    ownedTemporaryAttachments: [{
      hostCleanupToken: 'consumed-cleanup-token',
      selectionReceipt: 'consumed-selection',
      path: consumedPath,
      byteCount: consumedIdentity.size,
      device: String(consumedIdentity.dev),
      inode: String(consumedIdentity.ino),
      mtimeMs: consumedIdentity.mtimeMs,
      ctimeMs: consumedIdentity.ctimeMs,
      ownedTemporary: true,
    },
    {
      hostCleanupToken: 'replaced-cleanup-token',
      selectionReceipt: 'replaced-selection',
      path: replacedPath,
      byteCount: replacedIdentity.size,
      device: String(replacedIdentity.dev),
      inode: String(replacedIdentity.ino),
      mtimeMs: replacedIdentity.mtimeMs,
      ctimeMs: replacedIdentity.ctimeMs,
      ownedTemporary: true,
    }],
  })
  assert.deepEqual(cleanupTokens, ['consumed-cleanup-token', 'replaced-cleanup-token'])

  await unlink(replacedPath)
  await writeFile(replacedPath, 'replacement', { mode: 0o600 })
  await registry.cleanupCapabilities(cleanupTokens)

  await assert.rejects(stat(consumedPath), { code: 'ENOENT' })
  assert.equal((await readFile(replacedPath)).toString(), 'replacement')
  assert.equal(registry.pendingCountForTests(), 0)
})

test('expired owned attachments and abandoned startup files are swept', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-owned-expiry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const attachmentDirectory = join(root, 'attachments')
  const registry = new ElectrobunOwnedAttachmentRegistry(attachmentDirectory, { ttlMs: 20 })
  let expiringPath = ''
  await writeElectrobunTempAttachment({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    data: Buffer.from('expires').toString('base64'),
  }, attachmentDirectory, async (_workspaceId, _cardId, paths) => {
    expiringPath = paths[0]
    return [{
      selectionReceipt: 'expiring-selection',
      hostCleanupToken: 'expiring-cleanup-token',
      displayPath: 'expires.bin',
      ownedTemporary: true,
    }]
  }, registry)
  await new Promise(resolve => setTimeout(resolve, 50))
  await assert.rejects(stat(expiringPath), { code: 'ENOENT' })

  const stalePath = join(attachmentDirectory, 'abandoned.bin')
  const freshPath = join(attachmentDirectory, 'fresh.bin')
  await writeFile(stalePath, 'stale')
  await writeFile(freshPath, 'fresh')
  const old = new Date(Date.now() - 1_000)
  await utimes(stalePath, old, old)
  const sweepRegistry = new ElectrobunOwnedAttachmentRegistry(attachmentDirectory, { ttlMs: 500 })
  await sweepRegistry.sweepStale()
  await assert.rejects(stat(stalePath), { code: 'ENOENT' })
  assert.equal((await readFile(freshPath)).toString(), 'fresh')
})

test('disposing owned attachments never deletes native picker source files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-picked-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const picked = join(root, 'picked.txt')
  await writeFile(picked, 'keep me')
  const registry = new ElectrobunOwnedAttachmentRegistry(join(root, 'private'))
  await issueElectrobunPickedAttachments('workspace-a', 'card-a', [picked], async () => ([
    {
      selectionReceipt: 'picked-selection',
      hostCleanupToken: 'picked-cleanup-token',
      displayPath: 'picked.txt',
    },
  ]))
  await registry.dispose()
  assert.equal((await readFile(picked)).toString(), 'keep me')
})

test('failed enrollment rollback never deletes a same-path replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-owned-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const attachmentDirectory = join(root, 'attachments')
  let replacementPath = ''

  const result = await writeElectrobunTempAttachment({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    data: Buffer.from('original bytes').toString('base64'),
  }, attachmentDirectory, async (_workspaceId, _cardId, paths) => {
    replacementPath = paths[0]
    await unlink(replacementPath)
    await writeFile(replacementPath, 'replacement bytes', { mode: 0o600 })
    return []
  })

  assert.equal(result.ok, false)
  assert.equal((await readFile(replacementPath)).toString(), 'replacement bytes')
})

test('successful explicit revocation forgets the private cleanup token without unlinking blindly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-owned-revoke-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const attachmentDirectory = join(root, 'attachments')
  await mkdir(attachmentDirectory, { mode: 0o700 })
  const ownedPath = join(attachmentDirectory, 'owned.bin')
  await writeFile(ownedPath, 'owned bytes', { mode: 0o600 })
  const receipt = `csr1_${'a'.repeat(43)}`
  const registry = new ElectrobunOwnedAttachmentRegistry(attachmentDirectory)
  await registry.track('private-cleanup-token', ownedPath, receipt)

  const result = await revokeElectrobunAttachmentSelections({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    selectionReceipts: [receipt],
  }, async (workspaceId, cardId, selectionReceipts) => {
    assert.deepEqual({ workspaceId, cardId, selectionReceipts }, {
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      selectionReceipts: [receipt],
    })
    return { ok: true, revoked: 1 }
  }, registry)

  assert.deepEqual(result, { ok: true, revoked: 1 })
  assert.equal(registry.pendingCountForTests(), 0)
  assert.equal((await readFile(ownedPath)).toString(), 'owned bytes')
})
