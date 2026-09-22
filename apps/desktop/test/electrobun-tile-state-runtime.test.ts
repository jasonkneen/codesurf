import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { ElectrobunTileStateRuntime } from '../electrobun/bun/tile-state-runtime.ts'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('Electrobun tile state merges context and survives runtime restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-tile-state-'))
  cleanup.push(root)
  const firstRuntime = new ElectrobunTileStateRuntime(root)
  await firstRuntime.save('workspace-a', 'tile-1', {
    currentUrl: 'https://example.com',
    nested: { preserved: true },
  })
  await Promise.all([
    firstRuntime.saveContext('workspace-a', 'tile-1', {
      'ctx:durable': {
        key: 'ctx:durable',
        value: 1,
        updatedAt: 123,
        source: 'tile-1',
      },
    }),
    firstRuntime.save('workspace-a', 'tile-1', { nested: { added: true } }),
  ])

  const restartedRuntime = new ElectrobunTileStateRuntime(root)
  assert.deepEqual(await restartedRuntime.loadContext('workspace-a', 'tile-1'), {
    'ctx:durable': {
      key: 'ctx:durable',
      value: 1,
      updatedAt: 123,
      source: 'tile-1',
    },
  })
  assert.deepEqual(await restartedRuntime.load('workspace-a', 'tile-1'), {
    currentUrl: 'https://example.com',
    nested: { preserved: true, added: true },
    _context: {
      'ctx:durable': {
        key: 'ctx:durable',
        value: 1,
        updatedAt: 123,
        source: 'tile-1',
      },
    },
  })
})
