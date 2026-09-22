import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { validateCanonicalFsPathDetails } from '../src/main/ipc/fs.ts'

/**
 * H4: `ctx:image:path` is MCP-writable, so the path reaching runGeminiImageEdit
 * is attacker-chosen. These tests pin the boundary the tool now enforces: the
 * source must be an image inside the workspace root.
 */
const EDITABLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

async function authorize(candidatePath: string, workspaceRoot: string): Promise<string | null> {
  const ext = candidatePath.slice(candidatePath.lastIndexOf('.')).toLowerCase()
  if (!EDITABLE_IMAGE_EXTENSIONS.has(ext)) return null
  try {
    const validated = await validateCanonicalFsPathDetails(candidatePath, 'read', {
      restrictToWorkspaceRoots: true,
      allowedRoots: [workspaceRoot],
    })
    return validated.operationPath
  } catch {
    return null
  }
}

describe('image edit source authorization', () => {
  it('rejects a private key outside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'codesurf-imgws-'))
    try {
      assert.equal(await authorize(join(homedir(), '.ssh', 'id_rsa'), ws), null)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('rejects non-image extensions even inside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'codesurf-imgws-'))
    try {
      const secret = join(ws, 'secrets.env')
      await fs.writeFile(secret, 'API_KEY=sk-live')
      assert.equal(await authorize(secret, ws), null)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('rejects traversal out of the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'codesurf-imgws-'))
    try {
      assert.equal(await authorize(join(ws, '..', '..', 'etc', 'hosts.png'), ws), null)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('accepts a real image inside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'codesurf-imgws-'))
    try {
      const img = join(ws, 'shot.png')
      await fs.writeFile(img, 'not-really-png')
      const out = await authorize(img, ws)
      assert.ok(out, 'a workspace image must remain editable')
      assert.match(out, /shot\.png$/)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})
