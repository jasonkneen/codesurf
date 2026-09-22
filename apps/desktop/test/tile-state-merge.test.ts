import { describe, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from './node-expect.ts'
import { mergeTileState } from '../src/main/storage/workspaceArtifacts.ts'
import { readJsonArtifact, writeJsonArtifactAtomic } from '../src/main/storage/jsonArtifacts.ts'

describe('mergeTileState', () => {
  test('preserves existing fields when patching partial chat state', () => {
    const existing = { messages: [{ text: 'hi' }], agentMode: false }
    const patch = { agentMode: true }

    expect(mergeTileState(existing, patch)).toEqual({
      messages: [{ text: 'hi' }],
      agentMode: true,
    })
  })

  test('replaces arrays from patch instead of merging them', () => {
    const existing = { messages: [{ text: 'hi' }], tags: ['a', 'b'] }
    const patch = { messages: [{ text: 'bye' }] }

    expect(mergeTileState(existing, patch)).toEqual({
      messages: [{ text: 'bye' }],
      tags: ['a', 'b'],
    })
  })

  test('merges nested objects recursively', () => {
    const existing = { ui: { theme: 'dark', sidebar: { open: true } } }
    const patch = { ui: { sidebar: { width: 320 } } }

    expect(mergeTileState(existing, patch)).toEqual({
      ui: {
        theme: 'dark',
        sidebar: { open: true, width: 320 },
      },
    })
  })

  test('uses patch wholesale when existing state is not an object', () => {
    expect(mergeTileState(null, { ready: true })).toEqual({ ready: true })
    expect(mergeTileState(['old'], { ready: true })).toEqual({ ready: true })
  })
})

describe('tile state save merge flow', () => {
  test('reads existing JSON, merges patch, and writes atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codesurf-tile-state-merge-'))
    const filePath = join(dir, 'tile-state-chat.json')

    try {
      await writeJsonArtifactAtomic(filePath, {
        messages: [{ text: 'hi' }],
        agentMode: false,
      })

      const existing = await readJsonArtifact(filePath)
      expect(existing).toEqual({
        value: {
          messages: [{ text: 'hi' }],
          agentMode: false,
        },
        recovered: false,
      })

      const merged = mergeTileState(existing?.value, { agentMode: true })
      await writeJsonArtifactAtomic(filePath, merged)

      const raw = JSON.parse(await readFile(filePath, 'utf8'))
      expect(raw).toEqual({
        messages: [{ text: 'hi' }],
        agentMode: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})