import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readUtf8FilePrefixNoFollow } from '../src/main/ipc/fs.ts'
import {
  collectTrustedRecentEditChanges,
  loadTrustedRecentEditFiles,
  readRecentEditFilePrefix,
  type RecentEditOrigin,
} from '../src/renderer/src/components/chat/recentEditContextReader.ts'
import { applyChatStreamEvent } from '../src/renderer/src/hooks/chatStreamReducer.ts'
import type { ChatMessage } from '../src/shared/chat-types.ts'

const activeOrigin: RecentEditOrigin = {
  workspaceId: 'workspace-a',
  cardId: 'card-a',
  provider: 'codex',
  executionTarget: 'local',
  sessionId: 'session-a',
}

function assistantWithChange(overrides: Record<string, unknown> = {}) {
  return [{
    role: 'assistant',
    toolBlocks: [{
      fileChangesTrusted: true,
      fileChangesOrigin: activeOrigin,
      fileChanges: [{
        path: 'src/app.ts',
        diff: '@@ -1 +1 @@',
        changeType: 'update',
      }],
      ...overrides,
    }],
  }]
}

test('host recent-edit reader allocates and returns only the requested large-file prefix', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-recent-edit-prefix-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'large.ts')
  await writeFile(path, `HEAD\n${'x'.repeat(2 * 1024 * 1024)}\nTAIL`, 'utf8')

  const prefix = await readUtf8FilePrefixNoFollow(path, 64 * 1024)
  assert.equal(Buffer.byteLength(prefix, 'utf8'), 64 * 1024)
  assert.match(prefix, /^HEAD\n/)
  assert.doesNotMatch(prefix, /TAIL/)
})

test('renderer recent-edit reader uses workspace-scoped bounded prefix IPC and never full readFile', async () => {
  let prefixCall: { path: string; maxBytes: number; workspaceId?: string } | null = null
  let fullReads = 0
  const fs = {
    readFile: async () => {
      fullReads += 1
      throw new Error('full read must not be used')
    },
    readFilePrefix: async (path: string, maxBytes: number, workspaceId?: string) => {
      prefixCall = { path, maxBytes, workspaceId }
      return 'const value = 42\n'
    },
  }
  const content = await readRecentEditFilePrefix(fs, '/workspace/src/large.ts', 'workspace-a')

  assert.equal(fullReads, 0)
  assert.deepEqual(prefixCall, {
    path: '/workspace/src/large.ts',
    maxBytes: 64 * 1024,
    workspaceId: 'workspace-a',
  })
  assert.match(content, /const value = 42/)
})

test('untrusted remote file-change events cause zero host file reads', async () => {
  const start: ChatMessage = {
    id: 'assistant-a',
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolBlocks: [],
  }
  const remoteBlock = applyChatStreamEvent(start, {
    type: 'tool_summary',
    toolId: 'remote-edit',
    toolName: 'Edit',
    text: 'claimed edit',
    fileChanges: [{
      path: '/workspace/src/secret.ts',
      changeType: 'update',
      additions: 1,
      deletions: 0,
      diff: '@@ -1 +1 @@',
    }],
    fileChangesTrusted: false,
    fileChangesOrigin: activeOrigin,
  })
  let reads = 0
  const loaded = await loadTrustedRecentEditFiles(
    [remoteBlock],
    '/workspace',
    activeOrigin,
    {
      async readFilePrefix() {
        reads += 1
        return 'secret'
      },
    },
    'workspace-a',
  )
  assert.equal(reads, 0)
  assert.deepEqual(loaded, [])
})

test('recent-edit provenance rejects provider, session, target, and workspace mismatches before reads', async () => {
  const cases: Array<{ name: string; origin: RecentEditOrigin }> = [
    { name: 'provider switch', origin: { ...activeOrigin, provider: 'claude' } },
    { name: 'session switch', origin: { ...activeOrigin, sessionId: 'session-b' } },
    { name: 'cloud target', origin: { ...activeOrigin, executionTarget: 'cloud' } },
    { name: 'workspace switch', origin: { ...activeOrigin, workspaceId: 'workspace-b' } },
  ]

  for (const fixture of cases) {
    let reads = 0
    const loaded = await loadTrustedRecentEditFiles(
      assistantWithChange(),
      '/workspace',
      fixture.origin,
      {
        async readFilePrefix() {
          reads += 1
          return 'must not be read'
        },
      },
      fixture.origin.workspaceId,
    )
    assert.equal(reads, 0, fixture.name)
    assert.deepEqual(loaded, [], fixture.name)
  }
})

test('trusted local origin reads only current-workspace paths', async () => {
  assert.deepEqual(
    collectTrustedRecentEditChanges(
      assistantWithChange({
        fileChanges: [
          { path: '/other/secret.ts', diff: '', changeType: 'update' },
          { path: 'src/app.ts', diff: '', changeType: 'update' },
        ],
      }),
      '/workspace',
      activeOrigin,
    ),
    [{
      displayPath: 'src/app.ts',
      resolvedPath: '/workspace/src/app.ts',
      diff: '',
      changeType: 'update',
    }],
  )
})
