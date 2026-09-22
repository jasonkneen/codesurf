import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Storage } from '../../lib/storage.js'

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Storage', () => {
  it('writes and reads index.json atomically', async () => {
    const s = new Storage(tmp)
    await s.writeIndex({ version: 1, files: {} })
    const got = await s.readIndex()
    expect(got).toEqual({ version: 1, files: {} })
  })

  it('returns null when index missing', async () => {
    const s = new Storage(tmp)
    expect(await s.readIndex()).toBeNull()
  })

  it('appends to activity.jsonl', async () => {
    const s = new Storage(tmp)
    await s.appendActivity({ tool: 'Read', path: 'a.ts', ts: 1 })
    await s.appendActivity({ tool: 'Edit', path: 'b.ts', ts: 2 })
    const lines = fs.readFileSync(path.join(tmp, 'activity.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).tool).toBe('Read')
  })

  it('rotates activity.jsonl when over limit', async () => {
    const s = new Storage(tmp, { rotateBytes: 200 })
    for (let i = 0; i < 10; i++) await s.appendActivity({ tool: 'Read', path: `f${i}.ts`, ts: i })
    const files = fs.readdirSync(tmp).filter(f => f.startsWith('activity'))
    expect(files.length).toBeGreaterThan(1)
  })

  it('debounced writeIndex coalesces writes', async () => {
    const s = new Storage(tmp, { writeDebounceMs: 50 })
    s.scheduleWrite({ version: 1, files: { a: 1 } })
    s.scheduleWrite({ version: 1, files: { a: 2 } })
    s.scheduleWrite({ version: 1, files: { a: 3 } })
    await new Promise(r => setTimeout(r, 100))
    const got = await s.readIndex()
    expect(got.files.a).toBe(3)
  })

  it('atomic write survives mid-write crash simulation', async () => {
    const s = new Storage(tmp)
    await s.writeIndex({ version: 1, files: { a: 1 } })
    // Manually create a stale .tmp file as if a previous process crashed mid-write
    fs.writeFileSync(path.join(tmp, 'index.json.tmp'), '{ broken')
    const got = await s.readIndex()
    expect(got.files.a).toBe(1)
  })
})
