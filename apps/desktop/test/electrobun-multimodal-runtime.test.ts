import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  buildClaudeStreamInput,
  insertCodexImageArgs,
  materializeVerifiedElectrobunImages,
  readVerifiedElectrobunImages,
  sweepStaleElectrobunImageDirectories,
} from '../electrobun/bun/multimodal-runtime.ts'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Electrobun verified multimodal delivery', () => {
  test('bounds and identity-checks bytes before building Claude stream input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-image-'))
    cleanup.push(root)
    const path = join(root, 'pixel.png')
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    await writeFile(path, content)
    const identity = await stat(path)
    const images = await readVerifiedElectrobunImages([{
      path,
      mediaType: 'image/png',
      displayPath: 'pixel.png',
      byteCount: content.length,
      device: String(identity.dev),
      inode: String(identity.ino),
      mtimeMs: identity.mtimeMs,
      ctimeMs: identity.ctimeMs,
    }])

    const packet = JSON.parse(buildClaudeStreamInput('Inspect this image', images))
    assert.equal(packet.type, 'user')
    assert.equal(packet.message.content[0].text, 'Inspect this image')
    assert.equal(packet.message.content[1].source.media_type, 'image/png')
    assert.equal(packet.message.content[1].source.data, content.toString('base64'))
  })

  test('rejects a same-inode same-size rewrite after capability expansion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-image-rewrite-'))
    cleanup.push(root)
    const path = join(root, 'pixel.png')
    await writeFile(path, Buffer.from('AAAA'))
    const identity = await stat(path)
    await writeFile(path, Buffer.from('BBBB'))
    const changedTime = new Date(identity.mtimeMs + 5_000)
    await utimes(path, changedTime, changedTime)

    await assert.rejects(readVerifiedElectrobunImages([{
      path,
      mediaType: 'image/png',
      displayPath: 'pixel.png',
      byteCount: 4,
      device: String(identity.dev),
      inode: String(identity.ino),
      mtimeMs: identity.mtimeMs,
      ctimeMs: identity.ctimeMs,
    }]), /changed before delivery/)
  })

  test('rejects an attachment without host-verified identity', async () => {
    await assert.rejects(
      readVerifiedElectrobunImages([{
        path: '/tmp/untrusted.png',
        mediaType: 'image/png',
        displayPath: 'untrusted.png',
        byteCount: 4,
      }]),
      /lacks verified file identity/,
    )
  })

  test('materializes private Codex copies and keeps image options before resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-image-copy-'))
    cleanup.push(root)
    const materialized = await materializeVerifiedElectrobunImages([{
      path: '/trusted/original.png',
      mediaType: 'image/png',
      displayPath: 'original.png',
      byteCount: 4,
      device: '1',
      inode: '2',
      mtimeMs: 3,
      ctimeMs: 4,
      bytes: Buffer.from([1, 2, 3, 4]),
    }], root)
    const args = insertCodexImageArgs(
      ['exec', '--json', 'resume', 'thread-1', 'Inspect'],
      materialized.paths,
    )
    assert.deepEqual(args.slice(0, 4), ['exec', '--json', '--image', materialized.paths[0]])
    assert.equal(args[4], 'resume')
    await materialized.cleanup()
    await assert.rejects(stat(materialized.paths[0]), /ENOENT/)
  })

  test('startup sweep removes crashed and legacy Codex image directories but preserves live owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-image-sweep-'))
    cleanup.push(root)
    const crashed = join(root, 'request-crashed')
    const legacy = join(root, 'request-legacy')
    const live = join(root, 'request-live')
    await Promise.all([crashed, legacy, live].map(path => mkdir(path, { mode: 0o700 })))
    await writeFile(join(crashed, '.owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }), { mode: 0o600 })
    await writeFile(join(live, '.owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 })
    await writeFile(join(legacy, 'image-0.png'), Buffer.from([1]), { mode: 0o600 })

    const result = await sweepStaleElectrobunImageDirectories(root)

    assert.deepEqual(result, { removed: 2, retained: 1 })
    await assert.rejects(stat(crashed), /ENOENT/)
    await assert.rejects(stat(legacy), /ENOENT/)
    assert.equal((await stat(live)).isDirectory(), true)
  })
})
