import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAttachmentSelectionRegistry,
  SELECTION_RECEIPT_TTL_MS,
} from '../bin/attachment-selections.mjs'
import { expandFileReferences } from '../bin/file-references.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-attachment-selections-'))
  const workspaceDir = join(root, 'workspace')
  const pickedDir = join(root, 'picked')
  const ownedTempRoot = join(root, 'chat-attachments')
  const storePath = join(root, 'state', 'attachment-selections.json')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(pickedDir, { recursive: true })
  await mkdir(ownedTempRoot, { recursive: true, mode: 0o700 })
  return { root, workspaceDir, pickedDir, ownedTempRoot, storePath }
}

function ownedTempName(timestamp, suffix = 'note.txt') {
  return `codesurf-owned-v1-${timestamp}-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${suffix}`
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' })
}

test('durable receipt survives daemon restart and more than five minutes before one-shot success', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  let now = 1_800_000_000_000
  const picked = join(files.pickedDir, 'durable.txt')
  await writeFile(picked, 'DURABLE-SELECTION\n')

  const first = createAttachmentSelectionRegistry({
    storePath: files.storePath,
    ownedTempRoot: files.ownedTempRoot,
    now: () => now,
  })
  const issued = await first.issue({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [picked],
  })
  const receipt = issued.attachments[0].selectionReceipt
  assert.doesNotMatch(receipt, /^[A-Za-z0-9_-]{43}$/)
  await first.dispose()

  now += 10 * 60 * 1000
  const restarted = createAttachmentSelectionRegistry({
    storePath: files.storePath,
    ownedTempRoot: files.ownedTempRoot,
    now: () => now,
  })
  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: 'Review the selected file.',
    attachmentSelections: [{ selectionReceipt: receipt }],
    attachmentSelectionRegistry: restarted,
  })
  assert.match(expanded.contextText, /DURABLE-SELECTION/)
  assert.doesNotMatch(JSON.stringify(expanded), new RegExp(receipt))
  await assert.rejects(expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: 'Retry.',
    attachmentSelections: [{ selectionReceipt: receipt }],
    attachmentSelectionRegistry: restarted,
  }), /invalid, expired, or already used/i)
  assert.equal(await readFile(picked, 'utf8'), 'DURABLE-SELECTION\n')
  await restarted.dispose()
})

test('wrong scope and replaced files reject without consuming the rightful receipt', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const picked = join(files.pickedDir, 'scoped.txt')
  const original = join(files.pickedDir, 'original.txt')
  await writeFile(picked, 'ORIGINAL\n')
  const registry = createAttachmentSelectionRegistry({
    storePath: files.storePath,
    ownedTempRoot: files.ownedTempRoot,
  })
  const { attachments } = await registry.issue({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [picked],
  })
  const selectionReceipt = attachments[0].selectionReceipt

  await assert.rejects(registry.inspect({
    workspaceId: 'workspace-b',
    cardId: 'card-a',
    selectionReceipts: [selectionReceipt],
  }), /does not belong/i)
  assert.equal((await registry.inspect({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    selectionReceipts: [selectionReceipt],
  })).hasAttachments, true)

  await rename(picked, original)
  await writeFile(picked, 'REPLACEMENT\n')
  await assert.rejects(expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: 'Read it.',
    attachmentSelections: [{ selectionReceipt }],
    attachmentSelectionRegistry: registry,
  }), /changed during validation/i)
  assert.equal((await registry.stats()).total, 1)
  assert.equal(await readFile(picked, 'utf8'), 'REPLACEMENT\n')
  await registry.dispose()
})

test('multi-selection preparation is atomic and a failed preflight remains retryable', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const text = join(files.pickedDir, 'one.txt')
  const image = join(files.pickedDir, 'two.png')
  await writeFile(text, 'ONE\n')
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]))
  const registry = createAttachmentSelectionRegistry({
    storePath: files.storePath,
    ownedTempRoot: files.ownedTempRoot,
  })
  const { attachments } = await registry.issue({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [text, image],
  })
  const selections = attachments.map(({ selectionReceipt }) => ({ selectionReceipt }))

  await assert.rejects(expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: 'Review both.',
    attachmentSelections: selections,
    attachmentSelectionRegistry: registry,
    supportedImageMediaTypes: [],
  }), /not supported/i)
  assert.equal((await registry.stats()).total, 2)

  const expanded = await expandFileReferences({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    workspaceDir: files.workspaceDir,
    message: 'Review both.',
    attachmentSelections: selections,
    attachmentSelectionRegistry: registry,
    supportedImageMediaTypes: ['image/png'],
  })
  assert.equal(expanded.references.length, 2)
  assert.equal((await registry.stats()).total, 0)
  await registry.dispose()
})

test('explicit removal revokes atomically, never deletes picked files, and identity-checks owned cleanup', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  const picked = join(files.pickedDir, 'keep.txt')
  const owned = join(files.ownedTempRoot, ownedTempName(Date.now(), 'remove.txt'))
  await writeFile(picked, 'KEEP\n')
  await writeFile(owned, 'DELETE\n', { mode: 0o600 })
  const registry = createAttachmentSelectionRegistry({
    storePath: files.storePath,
    ownedTempRoot: files.ownedTempRoot,
  })
  const pickedIssue = await registry.issue({ workspaceId: 'workspace-a', cardId: 'card-a', paths: [picked] })
  const ownedIssue = await registry.issue({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [owned],
    ownedTemporary: true,
  })
  const revoked = await registry.revoke({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    selectionReceipts: [
      pickedIssue.attachments[0].selectionReceipt,
      ownedIssue.attachments[0].selectionReceipt,
    ],
  })
  assert.deepEqual(revoked, { ok: true, revoked: 2 })
  assert.equal(await readFile(picked, 'utf8'), 'KEEP\n')
  await assertMissing(owned)
  await registry.dispose()
})

test('live durable owned receipts survive startup sweep, then expire with verified cleanup', async t => {
  const files = await fixture()
  t.after(() => rm(files.root, { recursive: true, force: true }))
  let now = 1_800_000_000_000
  const owned = join(files.ownedTempRoot, ownedTempName(now, 'live.txt'))
  await writeFile(owned, 'LIVE\n', { mode: 0o600 })
  const registry = createAttachmentSelectionRegistry({
    storePath: files.storePath,
    ownedTempRoot: files.ownedTempRoot,
    now: () => now,
  })
  await registry.issue({
    workspaceId: 'workspace-a',
    cardId: 'card-a',
    paths: [owned],
    ownedTemporary: true,
  })
  await registry.dispose()

  now += 10 * 60 * 1000
  const restarted = createAttachmentSelectionRegistry({
    storePath: files.storePath,
    ownedTempRoot: files.ownedTempRoot,
    now: () => now,
  })
  assert.equal((await restarted.listProtectedOwnedPaths()).has(owned), true)
  assert.equal((await stat(owned)).isFile(), true)

  now += SELECTION_RECEIPT_TTL_MS
  const swept = await restarted.sweepExpired()
  assert.equal(swept.expired, 1)
  await assertMissing(owned)
  await restarted.dispose()
})
