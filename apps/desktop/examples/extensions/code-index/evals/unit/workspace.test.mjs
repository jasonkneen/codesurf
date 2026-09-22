import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveWorkspace, workspaceKey } from '../../lib/workspace.js'

let tmp
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('workspace', () => {
  it('walks up to .git', () => {
    fs.mkdirSync(path.join(tmp, '.git'))
    fs.mkdirSync(path.join(tmp, 'src', 'lib'), { recursive: true })
    expect(resolveWorkspace(path.join(tmp, 'src', 'lib'))).toBe(tmp)
  })

  it('falls back to cwd when no .git found', () => {
    expect(resolveWorkspace(tmp)).toBe(tmp)
  })

  it('honors CODE_INDEX_WORKSPACE_ROOT env override', () => {
    const orig = process.env.CODE_INDEX_WORKSPACE_ROOT
    process.env.CODE_INDEX_WORKSPACE_ROOT = '/explicit/root'
    try {
      expect(resolveWorkspace('/some/deep/path')).toBe('/explicit/root')
    } finally {
      if (orig === undefined) delete process.env.CODE_INDEX_WORKSPACE_ROOT
      else process.env.CODE_INDEX_WORKSPACE_ROOT = orig
    }
  })

  it('workspaceKey is stable sha1-based hex', () => {
    const k1 = workspaceKey('/Users/x/repo')
    const k2 = workspaceKey('/Users/x/repo')
    expect(k1).toBe(k2)
    expect(k1).toMatch(/^[a-f0-9]{40}$/)
  })

  it('different paths produce different keys', () => {
    expect(workspaceKey('/a')).not.toBe(workspaceKey('/b'))
  })
})
