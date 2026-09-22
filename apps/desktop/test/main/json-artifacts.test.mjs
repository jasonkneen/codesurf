import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseJsonArtifact,
  readJsonArtifact,
  writeJsonArtifactAtomic,
} from '../../src/main/storage/jsonArtifacts.ts'

test('parseJsonArtifact parses valid JSON without recovery', () => {
  const parsed = parseJsonArtifact('{"ok":true,"count":2}')
  assert.deepEqual(parsed, {
    value: { ok: true, count: 2 },
    recovered: false,
  })
})

test('parseJsonArtifact recovers a balanced JSON object with trailing garbage', () => {
  const parsed = parseJsonArtifact('{"messages":[{"role":"user","content":"hi"}]}}\n}  }\n')
  assert.deepEqual(parsed, {
    value: { messages: [{ role: 'user', content: 'hi' }] },
    recovered: true,
  })
})

test('readJsonArtifact returns recovered content from a partially corrupted file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-json-artifact-'))
  const filePath = join(dir, 'tile-state.json')

  try {
    await writeFile(filePath, '{\n  "messages": [\n    { "role": "user", "content": "hello" }\n  ]\n}}\n}', 'utf8')
    const parsed = await readJsonArtifact(filePath)
    assert.deepEqual(parsed, {
      value: { messages: [{ role: 'user', content: 'hello' }] },
      recovered: true,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeJsonArtifactAtomic writes complete JSON documents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesurf-json-atomic-'))
  const filePath = join(dir, 'state.json')

  try {
    await writeJsonArtifactAtomic(filePath, { id: 'tile-1', ready: true })
    const raw = await readFile(filePath, 'utf8')
    assert.deepEqual(JSON.parse(raw), { id: 'tile-1', ready: true })
    assert.match(raw, /\n$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
