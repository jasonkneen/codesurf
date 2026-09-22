import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import type {
  AgentRoomFileAdapter,
  AgentRoomRetryScheduler,
} from '../src/main/agent-room/persistence.ts'

const testHome = await mkdtemp(join(tmpdir(), 'codesurf-agent-room-store-'))
process.env.CODESURF_HOME = testHome

const room = await import('../src/main/agent-room/store.ts')
const limits = await import('../src/main/agent-room/validation.ts')
const { bus } = await import('../src/main/event-bus.ts')
const workspaceId = 'workspace-hardening'

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
}

class FailingDisposeAdapter implements AgentRoomFileAdapter {
  readonly values = new Map<string, string>()
  failDeletes = false

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    this.values.set(path, contents)
  }

  async removeOwnedFile(path: string): Promise<void> {
    if (this.failDeletes) throw new Error('injected dispose delete failure')
    this.values.delete(path)
  }
}

beforeEach(async () => {
  await room.resetAgentRoomsForTests()
})

after(async () => {
  await room.disposeAgentRooms()
  await rm(testHome, { recursive: true, force: true })
})

describe('agent-room validation and bounds', () => {
  test('rejects traversal, absolute, separator, control, NUL, and non-ASCII IDs before mutation', async () => {
    const outsidePath = join(tmpdir(), `${basename(testHome)}-outside`)
    await assert.rejects(access(outsidePath))
    const invalidIds = [
      '',
      '.',
      '..',
      '../escape',
      outsidePath,
      'a/b',
      'a\\b',
      'a\0b',
      'a\nb',
      'a\u007fb',
      'tîle',
      'a\u202eb',
      'tile.',
      'CON',
      'nul.txt',
      'COM9',
      'lpt1.log',
      `a${'b'.repeat(limits.MAX_TILE_ID_BYTES)}`,
    ]

    for (const invalidId of invalidIds) {
      assert.equal(room.updateLinks(workspaceId, invalidId, ['safe-peer']), null)
      assert.equal(room.updateLinks(workspaceId, 'safe-owner', [invalidId]), null)
      assert.equal(room.post(workspaceId, { fromTileId: invalidId, text: 'nope' }), null)
      assert.equal(room.getRoomForTile(workspaceId, invalidId), null)
      assert.equal(room.setState(workspaceId, invalidId, { task: 'nope' }).tileId, 'invalid')
      assert.equal(room.sendMessage(workspaceId, invalidId, 'safe-peer', 'nope'), null)
    }
    assert.equal(
      room.updateLinks(
        workspaceId,
        'safe-owner',
        Array.from({ length: limits.MAX_ROOM_MEMBERS }, () => 'safe-peer'),
      ),
      null,
    )

    await room.flushAgentRooms()
    assert.deepEqual(room.getAgentRoomStats(), {
      rooms: 0,
      memberships: 0,
      todos: 0,
      ownedRoomFiles: 0,
      ownedInboxFiles: 0,
      pendingPersistencePaths: 0,
      retainedEventBytes: 0,
    })
    assert.deepEqual(await readdir(testHome), [])
    await assert.rejects(access(outsidePath))
  })

  test('bounds posts, targets, metadata, retained bytes, and injected prompt bytes with markers', async () => {
    const a = 'bounds-a'
    const b = 'bounds-b'
    assert.ok(room.updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'chat' }))

    const cyclic: Record<string, unknown> = {
      huge: 'm'.repeat(limits.MAX_METADATA_BYTES * 2),
      array: Array.from({ length: limits.MAX_METADATA_ARRAY_ITEMS * 2 }, (_, index) => index),
    }
    cyclic.self = cyclic

    for (let index = 0; index < limits.MAX_EVENTS_PER_ROOM * 2; index += 1) {
      const event = room.post(workspaceId, {
        fromTileId: a,
        text: `${index}:${'x'.repeat(limits.MAX_EVENT_TEXT_BYTES * 2)}`,
        targetTileIds: [
          ...Array.from({ length: limits.MAX_EVENT_TARGETS * 2 }, () => b),
        ],
        meta: cyclic,
      })
      assert.ok(event)
      assert.ok(Buffer.byteLength(event!.text, 'utf8') <= limits.MAX_EVENT_TEXT_BYTES)
      assert.match(event!.text, /\[truncated\]$/)
      assert.ok(event!.targetTileIds.length <= limits.MAX_EVENT_TARGETS)
      assert.ok(Buffer.byteLength(JSON.stringify(event!.meta), 'utf8') <= limits.MAX_METADATA_BYTES)
      assert.match(JSON.stringify(event!.meta), /truncated/i)
      assert.match(JSON.stringify(event!.meta), /TruncatedTargets/)
    }

    const prepared = room.prepareTurnContext(workspaceId, b)
    assert.ok(Buffer.byteLength(prepared.systemExtra, 'utf8') <= limits.MAX_PROMPT_BYTES)
    assert.match(prepared.systemExtra, /omitted|truncated/i)
    assert.match(prepared.systemExtra, /retained room traffic unavailable/i)
    const snapshot = room.getRoomForTile(workspaceId, a)
    assert.ok(snapshot)
    assert.ok(snapshot!.eventCount <= limits.MAX_EVENTS_PER_ROOM)
    assert.ok(room.getAgentRoomStats().retainedEventBytes! <= limits.MAX_RETAINED_EVENT_BYTES)

    const digest = room.digest(workspaceId, a)
    const consumeMetrics = limits.serializedMetrics(prepared.consumed)
    const digestMetrics = limits.serializedMetrics(digest)
    const snapshotMetrics = limits.serializedMetrics(snapshot)
    assert.ok(consumeMetrics)
    assert.ok(digestMetrics)
    assert.ok(snapshotMetrics)
    assert.ok(consumeMetrics!.bytes <= limits.MAX_CONSUME_BYTES)
    assert.ok(consumeMetrics!.estimatedTokens <= limits.MAX_CONSUME_ESTIMATED_TOKENS)
    assert.ok(digestMetrics!.bytes <= limits.MAX_DIGEST_BYTES)
    assert.ok(digestMetrics!.estimatedTokens <= limits.MAX_DIGEST_ESTIMATED_TOKENS)
    assert.ok(snapshotMetrics!.bytes <= limits.MAX_SNAPSHOT_BYTES)
    assert.ok(snapshotMetrics!.estimatedTokens <= limits.MAX_SNAPSHOT_ESTIMATED_TOKENS)

    await room.flushAgentRooms()
    const persistedPath = join(
      testHome,
      'workspaces',
      workspaceId,
      'agent-rooms',
      'rooms',
      `${snapshot!.id}.json`,
    )
    const persisted = JSON.parse(await readFile(persistedPath, 'utf8'))
    const persistedMetrics = limits.serializedMetrics(persisted)
    assert.ok(persistedMetrics)
    assert.ok(persistedMetrics!.bytes <= limits.MAX_PERSISTED_ROOM_BYTES)
    assert.ok(
      persistedMetrics!.estimatedTokens
      <= limits.MAX_PERSISTED_ROOM_ESTIMATED_TOKENS,
    )
  })

  test('bounds member names, tasks, and file lists deterministically', () => {
    const a = 'member-a'
    const b = 'member-b'
    room.updateLinks(workspaceId, a, [b])

    const member = room.setMemberState(workspaceId, a, {
      displayName: 'n'.repeat(limits.MAX_DISPLAY_NAME_BYTES * 2),
      task: 't'.repeat(limits.MAX_MEMBER_TASK_BYTES * 2),
      files: Array.from(
        { length: limits.MAX_MEMBER_FILES * 2 },
        (_, index) => `/very/long/${index}/${'f'.repeat(limits.MAX_MEMBER_FILE_BYTES * 2)}`,
      ),
    })

    assert.ok(member)
    assert.ok(Buffer.byteLength(member!.displayName!, 'utf8') <= limits.MAX_DISPLAY_NAME_BYTES)
    assert.match(member!.displayName!, /\[truncated\]$/)
    assert.ok(Buffer.byteLength(member!.task, 'utf8') <= limits.MAX_MEMBER_TASK_BYTES)
    assert.match(member!.task, /\[truncated\]$/)
    assert.equal(member!.files.length, limits.MAX_MEMBER_FILES)
    assert.ok(member!.files.every(file => Buffer.byteLength(file, 'utf8') <= limits.MAX_MEMBER_FILE_BYTES))
    assert.equal(member!.files.at(-1), limits.TRUNCATION_MARKER)

    member!.files[0] = 'mutated-by-caller'
    assert.notEqual(
      room.getRoomForTile(workspaceId, a)!.members
        .find(candidate => candidate.tileId === a)!.files[0],
      'mutated-by-caller',
    )
  })

  test('invalid direct-message targets cannot broaden into a room-wide post', () => {
    room.updateLinks(workspaceId, 'target-a', ['target-b'])
    assert.equal(room.post(workspaceId, {
      fromTileId: 'target-a',
      targetTileIds: [
        ...Array.from(
          { length: limits.MAX_EVENT_TARGETS },
          () => '../invalid-target',
        ),
        'target-b',
      ],
      text: 'must not broadcast',
    }), null)
    assert.deepEqual(room.consume(workspaceId, 'target-b').events, [])
  })

  test('todos require membership and direct messages commit only to current members', () => {
    assert.throws(
      () => room.addTodo(workspaceId, 'outsider', 'must not exist'),
      /active room member/i,
    )
    room.updateLinks(workspaceId, 'sender-a', ['recipient-a'])
    assert.equal(
      room.sendMessage(workspaceId, 'sender-a', 'valid-outsider', 'secret'),
      null,
    )
    assert.deepEqual(room.consume(workspaceId, 'recipient-a').events, [])

    const committed = room.sendMessage(
      workspaceId,
      'sender-a',
      'recipient-a',
      'bounded secret',
    )
    assert.ok(committed)
    assert.equal(committed!.text, 'bounded secret')
    const received = room.consume(workspaceId, 'recipient-a').events
    assert.equal(received.length, 1)
    assert.deepEqual(received[0]!.targetTileIds, ['recipient-a'])
  })

  test('enforces aggregate room, member, and per-member todo caps', () => {
    for (let roomIndex = 0; roomIndex < limits.MAX_ROOMS; roomIndex += 1) {
      const owner = `cap-${roomIndex}-0`
      const peers = Array.from(
        { length: 7 },
        (_, peerIndex) => `cap-${roomIndex}-${peerIndex + 1}`,
      )
      assert.ok(room.updateLinks(workspaceId, owner, peers))
    }
    assert.equal(room.getAgentRoomStats().rooms, limits.MAX_ROOMS)
    assert.equal(room.getAgentRoomStats().memberships, limits.MAX_GLOBAL_MEMBERS)
    assert.equal(room.updateLinks(workspaceId, 'overflow-a', ['overflow-b']), null)
    assert.equal(room.updateLinks(
      workspaceId,
      'cap-0-0',
      [
        ...Array.from({ length: 7 }, (_, index) => `cap-0-${index + 1}`),
        'overflow-member',
      ],
    ), null)

    for (let index = 0; index < limits.MAX_TODOS_PER_TILE; index += 1) {
      room.addTodo(workspaceId, 'cap-0-0', `todo-${index}`)
    }
    assert.throws(
      () => room.addTodo(workspaceId, 'cap-0-0', 'overflow todo'),
      /todo limit/i,
    )
  })
})

describe('agent-room lifecycle', () => {
  test('isolates identical tile IDs across workspace state, disk, and bus channels', async () => {
    const workspaceA = 'workspace-isolation-a'
    const workspaceB = 'workspace-isolation-b'
    const sender = 'same-sender'
    const peer = 'same-peer'
    const roomA = room.updateLinks(workspaceA, sender, [peer])
    const roomB = room.updateLinks(workspaceB, sender, [peer])

    assert.ok(roomA)
    assert.ok(roomB)
    assert.notEqual(roomA!.id, roomB!.id)
    assert.equal(room.post(workspaceA, {
      fromTileId: sender,
      text: 'workspace-a-only',
    })?.text, 'workspace-a-only')
    assert.equal(room.consume(workspaceA, peer).events.length, 1)
    assert.deepEqual(room.consume(workspaceB, peer).events, [])
    assert.equal(
      bus.getHistory(`tile:${workspaceA}:${peer}`).at(-1)?.payload.workspaceId,
      workspaceA,
    )
    assert.equal(
      bus.getHistory(`tile:${workspaceB}:${peer}`)
        .some(event => event.payload?.event?.text === 'workspace-a-only'),
      false,
    )

    await room.flushAgentRooms()
    await access(join(
      testHome,
      'workspaces',
      workspaceA,
      'agent-rooms',
      'rooms',
      `${roomA!.id}.json`,
    ))
    await access(join(
      testHome,
      'workspaces',
      workspaceB,
      'agent-rooms',
      'rooms',
      `${roomB!.id}.json`,
    ))
  })

  test('rejects workspace case aliases before they can collide on disk', () => {
    assert.ok(room.updateLinks('Workspace-Case', 'case-a', ['case-b']))
    assert.equal(room.updateLinks('workspace-case', 'other-a', ['other-b']), null)
    assert.equal(room.getRoomForTile('workspace-case', 'case-a'), null)
  })

  test('rejects case-folded tile collisions and clears the index on dispose', async () => {
    assert.ok(room.updateLinks(workspaceId, 'Case-A', ['case-peer']))
    assert.equal(room.updateLinks(workspaceId, 'case-a', ['other-peer']), null)
    assert.ok(room.getRoomForTile(workspaceId, 'Case-A'))
    assert.equal(room.getRoomForTile(workspaceId, 'case-a'), null)

    await room.disposeAgentRooms()
    assert.equal(room.updateLinks(workspaceId, 'case-a', ['other-peer']), null)
    await room.resetAgentRoomsForTests()
    assert.ok(room.updateLinks(workspaceId, 'case-a', ['other-peer']))
  })

  test('does not resurrect todos after leave and rejoin', async () => {
    room.updateLinks(workspaceId, 'todo-a', ['todo-b'])
    room.addTodo(workspaceId, 'todo-a', 'must disappear')
    room.leaveRoom(workspaceId, 'todo-a')
    room.leaveRoom(workspaceId, 'todo-b')
    room.updateLinks(workspaceId, 'todo-a', ['todo-c'])

    assert.deepEqual(room.getState(workspaceId, 'todo-a')?.todos, [])
    await room.flushAgentRooms()
  })

  test('splits and rejoins room components without resurrecting stale members', () => {
    const first = room.updateLinks(workspaceId, 'split-a', [
      'split-b',
      'split-c',
      'split-d',
    ])
    assert.ok(first)
    assert.deepEqual(
      first!.members.map(member => member.tileId).sort(),
      ['split-a', 'split-b', 'split-c', 'split-d'],
    )

    const left = room.updateLinks(workspaceId, 'split-a', ['split-b'])
    const right = room.updateLinks(workspaceId, 'split-c', ['split-d'])
    assert.ok(left)
    assert.ok(right)
    assert.notEqual(left!.id, right!.id)
    assert.deepEqual(
      room.getRoomForTile(workspaceId, 'split-a')!.members
        .map(member => member.tileId).sort(),
      ['split-a', 'split-b'],
    )
    assert.deepEqual(
      room.getRoomForTile(workspaceId, 'split-c')!.members
        .map(member => member.tileId).sort(),
      ['split-c', 'split-d'],
    )

    const joined = room.updateLinks(workspaceId, 'split-a', [
      'split-b',
      'split-c',
      'split-d',
    ])
    assert.ok(joined)
    assert.deepEqual(
      joined!.members.map(member => member.tileId).sort(),
      ['split-a', 'split-b', 'split-c', 'split-d'],
    )
  })

  test('reports projected filename truncation metadata', () => {
    room.updateLinks(workspaceId, 'project-a', ['project-b'])
    room.setMemberState(workspaceId, 'project-a', {
      files: [`src/${'é'.repeat(limits.MAX_PROJECTED_MEMBER_FILE_BYTES)}.ts`],
    })
    const member = room.getRoomForTile(workspaceId, 'project-a')!.members
      .find(candidate => candidate.tileId === 'project-a')!
    assert.ok(member.truncation)
    assert.equal(member.truncation!.filesOmitted, 0)
    assert.equal(member.truncation!.fileFieldsTruncated, 1)
    assert.ok(
      Buffer.byteLength(member.files[0]!, 'utf8')
      <= limits.MAX_PROJECTED_MEMBER_FILE_BYTES,
    )
  })

  test('leave and dispose preserve untracked files under the app home', async () => {
    const untrackedDir = join(
      testHome,
      'workspaces',
      workspaceId,
      'agent-rooms',
      'inboxes',
      'untracked-tile',
    )
    const untrackedFile = join(untrackedDir, 'ROOM.md')
    await mkdir(untrackedDir, { recursive: true })
    await writeFile(untrackedFile, 'sentinel')

    room.leaveRoom(workspaceId, 'untracked-tile')
    await room.disposeAgentRooms()
    assert.equal(await readFile(untrackedFile, 'utf8'), 'sentinel')

    await rm(join(testHome, 'workspaces'), { recursive: true, force: true })
  })

  test('100 update cycles flush deterministically and repeated lifecycle returns memory and disk to baseline', async () => {
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const a = `cycle-${cycle}-a`
      const b = `cycle-${cycle}-b`
      room.updateLinks(workspaceId, a, [b], { [a]: 'chat', [b]: 'terminal' })
      room.setMemberState(workspaceId, a, { status: 'working', task: `revision-${cycle}` })
      room.post(workspaceId, { fromTileId: a, text: `event-${cycle}` })
      room.removeTile(workspaceId, a)
      room.removeTile(workspaceId, b)
    }

    await room.flushAgentRooms()
    assert.deepEqual(room.getAgentRoomStats(), {
      rooms: 0,
      memberships: 0,
      todos: 0,
      ownedRoomFiles: 0,
      ownedInboxFiles: 0,
      pendingPersistencePaths: 0,
      retainedEventBytes: 0,
    })
    assert.deepEqual(await readdir(testHome), [])
  })

  test('dispose clears the terminal notifier reference before a new lifecycle', async () => {
    let notifications = 0
    room.setTerminalNotifier(() => {
      notifications += 1
    })
    room.updateLinks(workspaceId, 'notify-a', ['notify-b'], {
      'notify-a': 'chat',
      'notify-b': 'terminal',
    })
    room.post(workspaceId, { fromTileId: 'notify-a', text: 'before dispose' })
    assert.equal(notifications, 1)

    await room.disposeAgentRooms()
    await room.resetAgentRoomsForTests()
    room.updateLinks(workspaceId, 'notify-c', ['notify-d'], {
      'notify-c': 'chat',
      'notify-d': 'terminal',
    })
    room.post(workspaceId, { fromTileId: 'notify-c', text: 'after dispose' })
    assert.equal(notifications, 1)
  })

  test('failed dispose retains live state and a later retry can finish shutdown', async () => {
    await room.disposeAgentRooms()
    const adapter = new FailingDisposeAdapter()
    const scheduler = new ManualRetryScheduler()
    await room.setAgentRoomPersistenceForTests(adapter, {
      retryScheduler: scheduler,
    })
    const active = room.updateLinks('workspace-dispose-failure', 'dispose-a', ['dispose-b'])
    assert.ok(active)
    await room.flushAgentRooms()

    adapter.failDeletes = true
    await assert.rejects(room.disposeAgentRooms(), (error: unknown) => {
      const messages = error instanceof AggregateError
        ? error.errors.map(item => String(item)).join('\n')
        : String(error)
      assert.match(messages, /injected dispose delete failure/)
      return true
    })
    assert.equal(room.getAgentRoomStats().rooms, 1)
    assert.equal(room.getAgentRoomStats().memberships, 2)
    assert.equal(
      room.getRoomForTile('workspace-dispose-failure', 'dispose-a')?.id,
      active!.id,
    )

    adapter.failDeletes = false
    await room.disposeAgentRooms()
    assert.equal(room.getAgentRoomStats().rooms, 0)
    assert.equal(room.updateLinks(
      'workspace-dispose-failure',
      'dispose-a',
      ['dispose-b'],
    ), null)
  })
})
