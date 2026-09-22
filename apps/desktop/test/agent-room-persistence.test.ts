import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  AgentRoomPersistenceQueue,
  NodeAgentRoomFileAdapter,
  nodeAgentRoomFileIO,
  type AgentRoomFileAdapter,
  type AgentRoomRetryScheduler,
} from '../src/main/agent-room/persistence.ts'

const tempRoots = new Set<string>()

async function makeTempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `codesurf-agent-room-${label}-`))
  tempRoots.add(root)
  return root
}

afterEach(async () => {
  await Promise.all([...tempRoots].map(root => rm(root, { recursive: true, force: true })))
  tempRoots.clear()
})

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class ManualRetryScheduler implements AgentRoomRetryScheduler {
  readonly tasks: Array<() => void> = []

  schedule(task: () => void): object {
    this.tasks.push(task)
    return task
  }

  cancel(handle: object): void {
    const index = this.tasks.indexOf(handle as () => void)
    if (index >= 0) this.tasks.splice(index, 1)
  }

  runNext(): void {
    const task = this.tasks.shift()
    task?.()
  }
}

class MemoryAdapter implements AgentRoomFileAdapter {
  readonly values = new Map<string, string>()
  readonly writes: Array<{ path: string, contents: string }> = []
  readonly firstStarted = deferred()
  readonly firstRelease = deferred()
  readonly failed = deferred<Error>()
  blockFirst = false
  failuresRemaining = 0

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    this.writes.push({ path, contents })
    if (this.writes.length === 1) {
      this.firstStarted.resolve()
      if (this.blockFirst) await this.firstRelease.promise
    }
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      const error = new Error('injected write failure')
      this.failed.resolve(error)
      throw error
    }
    this.values.set(path, contents)
  }

  async removeOwnedFile(path: string): Promise<void> {
    this.values.delete(path)
  }
}

describe('AgentRoomPersistenceQueue', () => {
  test('serializes delayed A before newer B and flush waits for B', async () => {
    const adapter = new MemoryAdapter()
    adapter.blockFirst = true
    const queue = new AgentRoomPersistenceQueue(adapter)
    const path = '/virtual/room.json'

    queue.writeJson(path, { revision: 'A' })
    await adapter.firstStarted.promise
    queue.writeJson(path, { revision: 'B' })

    let flushed = false
    const flush = queue.flush().then(() => { flushed = true })
    await Promise.resolve()
    assert.equal(flushed, false)

    adapter.firstRelease.resolve()
    await flush

    assert.deepEqual(adapter.writes.map(write => JSON.parse(write.contents)), [
      { revision: 'A' },
      { revision: 'B' },
    ])
    assert.deepEqual(JSON.parse(adapter.values.get(path)!), { revision: 'B' })
    assert.equal(queue.getStats().pendingPaths, 0)
  })

  test('serializes case-folded path aliases before applying the newest spelling', async () => {
    const adapter = new MemoryAdapter()
    adapter.blockFirst = true
    const queue = new AgentRoomPersistenceQueue(adapter, { caseInsensitivePaths: true })

    queue.writeJson('/virtual/Inbox/ROOM.md', { revision: 'A' })
    await adapter.firstStarted.promise
    queue.writeJson('/virtual/inbox/ROOM.md', { revision: 'B' })
    await Promise.resolve()

    assert.equal(adapter.writes.length, 1)
    adapter.firstRelease.resolve()
    await queue.flush()

    assert.deepEqual(adapter.writes.map(write => ({
      path: write.path,
      value: JSON.parse(write.contents),
    })), [
      { path: '/virtual/Inbox/ROOM.md', value: { revision: 'A' } },
      { path: '/virtual/inbox/ROOM.md', value: { revision: 'B' } },
    ])
    assert.equal(queue.getStats().pendingPaths, 0)
  })

  test('coalesces 100 concurrent updates without allowing an older write to win', async () => {
    const adapter = new MemoryAdapter()
    adapter.blockFirst = true
    const queue = new AgentRoomPersistenceQueue(adapter)
    const path = '/virtual/inbox.md'

    queue.writeJson(path, { revision: 0 })
    await adapter.firstStarted.promise
    for (let revision = 1; revision < 100; revision += 1) {
      queue.writeJson(path, { revision })
    }
    adapter.firstRelease.resolve()
    await queue.flush()

    assert.deepEqual(JSON.parse(adapter.values.get(path)!), { revision: 99 })
    assert.deepEqual(JSON.parse(adapter.writes.at(-1)!.contents), { revision: 99 })
    assert.ok(adapter.writes.length <= 2)
  })

  test('restarts draining when a newer revision lands at the completion boundary', async () => {
    const firstRelease = deferred()
    const secondWritten = deferred()
    const writes: string[] = []
    const adapter: AgentRoomFileAdapter = {
      async writeFileAtomic(_path, contents) {
        writes.push(contents)
        if (writes.length === 1) await firstRelease.promise
        if (writes.length === 2) secondWritten.resolve()
      },
      async removeOwnedFile() {},
    }
    const queue = new AgentRoomPersistenceQueue(adapter)
    const path = '/virtual/boundary.json'

    queue.writeJson(path, { revision: 'A' })
    firstRelease.resolve()
    queueMicrotask(() => queue.writeJson(path, { revision: 'B' }))
    await secondWritten.promise

    assert.deepEqual(writes.map(value => JSON.parse(value)), [
      { revision: 'A' },
      { revision: 'B' },
    ])
    await queue.flush()
    assert.equal(queue.getStats().pendingPaths, 0)
  })

  test('preserves the old value on failure and retries the latest revision', async () => {
    const adapter = new MemoryAdapter()
    const scheduler = new ManualRetryScheduler()
    const queue = new AgentRoomPersistenceQueue(adapter, { retryScheduler: scheduler })
    const path = '/virtual/room.json'
    adapter.values.set(path, JSON.stringify({ revision: 'old' }))
    adapter.failuresRemaining = 1

    queue.writeJson(path, { revision: 'new' })
    await adapter.failed.promise
    assert.deepEqual(JSON.parse(adapter.values.get(path)!), { revision: 'old' })
    assert.equal(scheduler.tasks.length, 1)

    scheduler.runNext()
    await queue.flush()
    assert.deepEqual(JSON.parse(adapter.values.get(path)!), { revision: 'new' })
    assert.equal(queue.getStats().pendingPaths, 0)
  })

  test('a failed explicit flush reports the error without disabling eventual retry', async () => {
    const adapter = new MemoryAdapter()
    const scheduler = new ManualRetryScheduler()
    const queue = new AgentRoomPersistenceQueue(adapter, { retryScheduler: scheduler })
    const path = '/virtual/flush-retry.json'
    adapter.values.set(path, JSON.stringify({ revision: 'old' }))
    adapter.failuresRemaining = 2

    queue.writeJson(path, { revision: 'new' })
    await adapter.failed.promise
    await assert.rejects(queue.flush(), /injected write failure/)
    assert.deepEqual(JSON.parse(adapter.values.get(path)!), { revision: 'old' })
    assert.equal(scheduler.tasks.length, 1)

    scheduler.runNext()
    await queue.flush()
    assert.deepEqual(JSON.parse(adapter.values.get(path)!), { revision: 'new' })
  })

  test('retries directory durability after unlink succeeded but its fsync failed', async () => {
    const root = await makeTempRoot('delete-durability-retry')
    const directory = join(root, 'rooms')
    const path = join(directory, 'room-a.json')
    await mkdir(directory, { recursive: true })
    await writeFile(path, 'old')

    const firstDirectorySync = deferred()
    let directorySyncAttempts = 0
    const adapter = new NodeAgentRoomFileAdapter(root, {
      ...nodeAgentRoomFileIO,
      open: async (candidate, flags, mode) => {
        if (candidate === directory && flags === 'r') {
          directorySyncAttempts += 1
          if (directorySyncAttempts === 1) {
            const error = Object.assign(new Error('injected directory fsync failure'), {
              code: 'EIO',
            })
            firstDirectorySync.resolve()
            throw error
          }
        }
        return nodeAgentRoomFileIO.open(candidate, flags, mode)
      },
    })
    const scheduler = new ManualRetryScheduler()
    const queue = new AgentRoomPersistenceQueue(adapter, { retryScheduler: scheduler })

    queue.removeFile(path)
    await firstDirectorySync.promise
    await Promise.resolve()
    await assert.rejects(lstat(path), /ENOENT/)
    assert.equal(scheduler.tasks.length, 1)

    scheduler.runNext()
    await queue.flush()
    assert.equal(directorySyncAttempts, 2)
    assert.equal(queue.getStats().pendingPaths, 0)
  })
})

describe('NodeAgentRoomFileAdapter', () => {
  test('writes mode-0600 JSON atomically and leaves parseable old data on rename failure', async () => {
    const root = await makeTempRoot('atomic')
    const path = join(root, 'rooms', 'room-a.json')
    const adapter = new NodeAgentRoomFileAdapter(root)
    await adapter.writeFileAtomic(path, `${JSON.stringify({ revision: 'old' })}\n`)

    const failingAdapter = new NodeAgentRoomFileAdapter(root, {
      ...nodeAgentRoomFileIO,
      rename: async () => {
        throw new Error('injected rename failure')
      },
    })
    await assert.rejects(
      failingAdapter.writeFileAtomic(path, `${JSON.stringify({ revision: 'new' })}\n`),
      /injected rename failure/,
    )

    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { revision: 'old' })
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const names = await import('node:fs/promises').then(fs => fs.readdir(dirname(path)))
    assert.deepEqual(names, ['room-a.json'])
  })

  test('rejects symlinked ancestors and never writes outside the owned root', async () => {
    const root = await makeTempRoot('symlink-root')
    const outside = await makeTempRoot('symlink-outside')
    await mkdir(join(root, 'room-inboxes'), { recursive: true })
    await symlink(outside, join(root, 'room-inboxes', 'tile-a'))
    const outsideFile = join(outside, 'ROOM.md')
    await writeFile(outsideFile, 'sentinel')

    const adapter = new NodeAgentRoomFileAdapter(root)
    await assert.rejects(
      adapter.writeFileAtomic(join(root, 'room-inboxes', 'tile-a', 'ROOM.md'), 'leaked'),
      /symbolic link/i,
    )
    assert.equal(await readFile(outsideFile, 'utf8'), 'sentinel')
  })

  test('rejects a symlinked final write target without modifying its referent', async () => {
    const root = await makeTempRoot('write-target-root')
    const outside = await makeTempRoot('write-target-outside')
    const rooms = join(root, 'rooms')
    const outsideFile = join(outside, 'outside.json')
    const target = join(rooms, 'room-a.json')
    await mkdir(rooms, { recursive: true })
    await writeFile(outsideFile, 'sentinel')
    await symlink(outsideFile, target)

    const adapter = new NodeAgentRoomFileAdapter(root)
    await assert.rejects(adapter.writeFileAtomic(target, 'replacement'), /symbolic link/i)
    assert.equal(await readFile(outsideFile, 'utf8'), 'sentinel')
    assert.equal((await lstat(target)).isSymbolicLink(), true)
  })

  test('rejects a symlinked ancestor when deleting and leaves outside data untouched', async () => {
    const root = await makeTempRoot('delete-ancestor-root')
    const outside = await makeTempRoot('delete-ancestor-outside')
    await mkdir(join(root, 'room-inboxes'), { recursive: true })
    await writeFile(join(outside, 'ROOM.md'), 'sentinel')
    await symlink(outside, join(root, 'room-inboxes', 'tile-a'))

    const adapter = new NodeAgentRoomFileAdapter(root)
    await assert.rejects(
      adapter.removeOwnedFile(join(root, 'room-inboxes', 'tile-a', 'ROOM.md')),
      /symbolic link/i,
    )
    assert.equal(await readFile(join(outside, 'ROOM.md'), 'utf8'), 'sentinel')
  })

  test('rejects a symlinked final delete target without unlinking it or its referent', async () => {
    const root = await makeTempRoot('delete-target-root')
    const outside = await makeTempRoot('delete-target-outside')
    const rooms = join(root, 'rooms')
    const outsideFile = join(outside, 'outside.json')
    const target = join(rooms, 'room-a.json')
    await mkdir(rooms, { recursive: true })
    await writeFile(outsideFile, 'sentinel')
    await symlink(outsideFile, target)

    const adapter = new NodeAgentRoomFileAdapter(root)
    await assert.rejects(adapter.removeOwnedFile(target), /symbolic link/i)
    assert.equal(await readFile(outsideFile, 'utf8'), 'sentinel')
    assert.equal((await lstat(target)).isSymbolicLink(), true)
  })

  test('only tolerates documented unsupported directory-sync errors on Windows', async () => {
    const root = await makeTempRoot('windows-directory-sync')
    const path = join(root, 'rooms', 'room-a.json')
    const unsupported = Object.assign(new Error('directory sync unsupported'), {
      code: 'EINVAL',
    })
    const denied = Object.assign(new Error('directory sync denied'), {
      code: 'EACCES',
    })
    const ioWithDirectorySyncError = (error: Error): typeof nodeAgentRoomFileIO => ({
      ...nodeAgentRoomFileIO,
      open: async (candidate, flags, mode) => {
        if (candidate === dirname(path) && flags === 'r') throw error
        return nodeAgentRoomFileIO.open(candidate, flags, mode)
      },
    })

    const windowsAdapter = new NodeAgentRoomFileAdapter(
      root,
      ioWithDirectorySyncError(unsupported),
      { platform: 'win32' },
    )
    await windowsAdapter.writeFileAtomic(path, 'committed')
    assert.equal(await readFile(path, 'utf8'), 'committed')

    const actionableAdapter = new NodeAgentRoomFileAdapter(
      root,
      ioWithDirectorySyncError(denied),
      { platform: 'win32' },
    )
    await assert.rejects(actionableAdapter.writeFileAtomic(path, 'newer'), /denied/)

    const posixAdapter = new NodeAgentRoomFileAdapter(
      root,
      ioWithDirectorySyncError(unsupported),
      { platform: 'darwin' },
    )
    await assert.rejects(posixAdapter.writeFileAtomic(path, 'newest'), /unsupported/)
  })
})
