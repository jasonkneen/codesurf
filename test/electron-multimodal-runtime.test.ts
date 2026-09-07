import assert from 'node:assert/strict'
import { daemonUrl, daemonFile, daemonSource } from './helpers/daemon-path.mjs'
import { describe, test } from 'node:test'
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const { fileIdentity } = await import(daemonUrl('bin/secure-file-reader.mjs'))
const { attachmentCapabilityStatsForTests,
  disposeAttachmentCapabilities,
  issueAttachmentCapabilities, } = await import(daemonUrl('bin/attachment-capabilities.mjs'))
const { expandFileReferences } = await import(daemonUrl('bin/file-references.mjs'))
import { routeHostForAttachments } from '../src/main/chat/attachment-route-policy.ts'
import {
  buildClaudePromptWithImages,
  buildCsagentImages,
  cleanupMaterializedCodexImages,
  insertCodexImageArgs,
  materializeVerifiedCodexImages,
} from '../src/main/chat/provider-image-attachments.ts'

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const item of input) output.push(item)
  return output
}

async function attachmentFixture(name = 'image.png', data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])) {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electron-images-'))
  const path = join(root, name)
  await writeFile(path, data)
  const identity = fileIdentity(await stat(path))
  return {
    root,
    path,
    attachment: {
      path,
      mediaType: 'image/png',
      displayPath: name,
      ...identity,
    },
  }
}

describe('Electron multimodal provider boundary', () => {
  test('text-only Claude input yields one valid user message with no attachments', async () => {
    const messages = await collect(buildClaudePromptWithImages('plain text request', undefined))
    assert.equal(messages.length, 1)
    assert.deepEqual(messages[0].message.content, [{ type: 'text', text: 'plain text request' }])
  })

  test('Claude uses identity-verified image bytes and rejects swapped or oversized files', async t => {
    const fixture = await attachmentFixture()
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const messages = await collect(buildClaudePromptWithImages('inspect', [fixture.attachment]))
    const image = messages[0].message.content[1] as { source: { data: string } }
    assert.equal(image.source.data, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64'))

    const oldPath = join(fixture.root, 'old.png')
    await rename(fixture.path, oldPath)
    await writeFile(fixture.path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]))
    await assert.rejects(
      collect(buildClaudePromptWithImages('inspect', [fixture.attachment])),
      /changed during validation/i,
    )

    const large = await attachmentFixture('large.png', Buffer.alloc(5 * 1024 * 1024 + 1, 1))
    t.after(() => rm(large.root, { recursive: true, force: true }))
    await assert.rejects(
      collect(buildClaudePromptWithImages('inspect', [large.attachment])),
      /exceeds the .* byte limit/i,
    )
  })

  test('Codex materializes private verified copies, inserts --image before resume, and cleans up', async t => {
    const fixture = await attachmentFixture()
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const materialized = await materializeVerifiedCodexImages([fixture.attachment])
    assert.ok(materialized.directory)
    assert.equal(materialized.paths.length, 1)
    assert.notEqual(materialized.paths[0], fixture.path)
    assert.equal((await stat(materialized.paths[0])).mode & 0o777, 0o600)
    const args = insertCodexImageArgs(
      ['exec', '--json', '--model', 'gpt-test', 'resume', 'thread-a', 'prompt'],
      materialized.paths,
    )
    assert.ok(args.indexOf('--image') < args.indexOf('resume'))
    assert.equal(args[args.indexOf('--image') + 1], materialized.paths[0])

    await cleanupMaterializedCodexImages(materialized.directory)
    await assert.rejects(stat(materialized.directory!), /ENOENT/)

    const oldPath = join(fixture.root, 'old.png')
    await rename(fixture.path, oldPath)
    await writeFile(fixture.path, Buffer.from([1, 2, 3]))
    await assert.rejects(materializeVerifiedCodexImages([fixture.attachment]), /changed during validation/i)
  })

  test('Pi runtime uses verified image bytes and enforces per-file limits', async t => {
    const fixture = await attachmentFixture()
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const images = await buildCsagentImages([fixture.attachment])
    assert.deepEqual(images, [{
      type: 'image',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64'),
      mimeType: 'image/png',
    }])

    const large = await attachmentFixture('large.png', Buffer.alloc(5 * 1024 * 1024 + 1, 1))
    t.after(() => rm(large.root, { recursive: true, force: true }))
    await assert.rejects(buildCsagentImages([large.attachment]), /exceeds the .* byte limit/i)
  })

  test('default auto mode routes an owned PNG through the capable runtime before cleanup', async t => {
    const root = await mkdtemp(join(tmpdir(), 'codesurf-owned-provider-image-'))
    const workspaceDir = join(root, 'workspace')
    const ownedRoot = join(root, 'chat-attachments')
    await mkdir(workspaceDir)
    await mkdir(ownedRoot, { mode: 0o700 })
    t.after(async () => {
      await disposeAttachmentCapabilities()
      await rm(root, { recursive: true, force: true })
    })
    const path = join(
      ownedRoot,
      `codesurf-owned-v1-${Date.now()}-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-sketch.png`,
    )
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
    await writeFile(path, bytes, { mode: 0o600 })
    const issued = await issueAttachmentCapabilities({
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      paths: [path],
      ownedTemporary: true,
      ownedTempRoot: ownedRoot,
    })
    const selectedHost = routeHostForAttachments({
      selectedHost: {
        id: 'local-daemon',
        type: 'local-daemon',
        label: 'CodeSurf daemon',
        enabled: true,
      },
      executionMode: 'auto',
      hasHostAttachments: true,
    })
    assert.equal(selectedHost, null)
    const capability = issued.attachments[0].capability
    const expansion = await expandFileReferences({
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      workspaceDir,
      message: `Inspect this image.\n\nAttached file capabilities:\n${capability}\tsketch.png`,
      supportedImageMediaTypes: ['image/png'],
    })
    const reference = expansion.references[0]
    assert.equal(reference.binary, true)
    assert.equal(reference.ownedTemporary, true)
    assert.equal(expansion.ownedTemporaryAttachments?.length, 1)
    assert.equal(expansion.ownedTemporaryAttachments?.[0].path, await realpath(path))
    assert.equal((await stat(path)).isFile(), true)
    assert.equal(attachmentCapabilityStatsForTests().deferredOwned, 1)

    const images = await buildCsagentImages([{
      path: reference.resolvedPath!,
      mediaType: reference.mediaType!,
      displayPath: reference.displayPath,
      byteCount: reference.byteCount,
      device: reference.device!,
      inode: reference.inode!,
      mtimeMs: reference.mtimeMs!,
      ctimeMs: reference.ctimeMs!,
      ownedTemporary: reference.ownedTemporary,
    }])
    assert.equal(images[0].data, bytes.toString('base64'))
    await assert.rejects(stat(path), { code: 'ENOENT' })
  })
})
