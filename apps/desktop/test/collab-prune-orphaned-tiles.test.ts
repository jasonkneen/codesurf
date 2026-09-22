import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'node:test'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isTileContextDirName,
  pruneOrphanedTileDirs,
} from '../src/main/ipc/collab-helpers.ts'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'codesurf-prune-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  while (roots.length) {
    await fs.rm(roots.pop()!, { recursive: true, force: true })
  }
})

async function seed(root: string, dirs: string[], files: string[] = []): Promise<void> {
  for (const d of dirs) await fs.mkdir(join(root, d), { recursive: true })
  for (const f of files) await fs.writeFile(join(root, f), 'x')
}

const exists = async (p: string): Promise<boolean> =>
  fs.access(p).then(() => true, () => false)

describe('isTileContextDirName', () => {
  it('accepts every tile id shape the renderer mints', () => {
    assert.equal(isTileContextDirName('tile-1788477917202'), true)
    assert.equal(isTileContextDirName('tile-1788477917202-0'), true)
    assert.equal(isTileContextDirName('tile-template-kanban-1'), true)
  })

  it('rejects the reserved sibling directories', () => {
    for (const name of ['agents', 'sessions', 'skills', 'tools', 'plugins', 'extensions']) {
      assert.equal(isTileContextDirName(name), false, `${name} must not look like a tile dir`)
    }
  })
})

describe('pruneOrphanedTileDirs', () => {
  it('removes orphaned tile dirs but never the reserved app directories', async () => {
    const root = makeRoot()
    const reserved = ['agents', 'sessions', 'skills', 'tools', 'plugins', 'extensions']
    await seed(
      root,
      ['tile-keep', 'tile-orphan', ...reserved, '.hidden'],
      ['DREAMING.md'],
    )

    const removed = await pruneOrphanedTileDirs(root, new Set(['tile-keep']))

    assert.deepEqual(removed, ['tile-orphan'], 'only the orphaned tile dir is reported')
    assert.equal(await exists(join(root, 'tile-orphan')), false, 'orphan is gone')
    assert.equal(await exists(join(root, 'tile-keep')), true, 'live tile survives')

    for (const name of reserved) {
      assert.equal(
        await exists(join(root, name)),
        true,
        `reserved directory ${name}/ must survive a prune`,
      )
    }
    assert.equal(await exists(join(root, '.hidden')), true, 'dotfile dirs survive')
    assert.equal(await exists(join(root, 'DREAMING.md')), true, 'plain files survive')
  })

  it('removes nothing when every tile is still live', async () => {
    const root = makeRoot()
    await seed(root, ['tile-a', 'tile-b', 'agents'])

    const removed = await pruneOrphanedTileDirs(root, new Set(['tile-a', 'tile-b']))

    assert.deepEqual(removed, [])
    assert.equal(await exists(join(root, 'agents')), true)
  })

  it('leaves an unreadable root untouched', async () => {
    const removed = await pruneOrphanedTileDirs(join(tmpdir(), 'codesurf-does-not-exist-xyz'), new Set())
    assert.deepEqual(removed, [])
  })
})
