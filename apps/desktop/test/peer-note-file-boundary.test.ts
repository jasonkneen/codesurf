import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import {
  appendAuthorizedNoteFile,
  authorizeWorkspaceNoteFile,
  readAuthorizedNoteFile,
  writeAuthorizedNoteFile,
} from '../src/main/mcp/note-file-boundary.ts'

test('note backing files stay workspace-contained and no-follow across read and write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-note-boundary-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(workspace), mkdir(outside)])
  t.after(() => rm(root, { recursive: true, force: true }))

  const notePath = join(workspace, 'note.txt')
  const secretPath = join(outside, 'secret.txt')
  await writeFile(notePath, 'inside', 'utf8')
  await writeFile(secretPath, 'secret', 'utf8')

  const readable = await authorizeWorkspaceNoteFile(notePath, workspace, 'read')
  assert.equal(await readAuthorizedNoteFile(readable), 'inside')
  await assert.rejects(
    authorizeWorkspaceNoteFile(secretPath, workspace, 'read'),
    /outside allowed workspace roots/i,
  )

  const writable = await authorizeWorkspaceNoteFile(notePath, workspace, 'write')
  await writeAuthorizedNoteFile(writable, 'replaced')
  await appendAuthorizedNoteFile(writable, 'appended')
  assert.equal(await readFile(notePath, 'utf8'), 'replaced\nappended')
})

test('note handle authorization rejects a post-authorization symlink swap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-note-swap-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(workspace), mkdir(outside)])
  t.after(() => rm(root, { recursive: true, force: true }))

  const notePath = join(workspace, 'note.txt')
  const movedPath = join(workspace, 'moved.txt')
  const secretPath = join(outside, 'secret.txt')
  await writeFile(notePath, 'inside', 'utf8')
  await writeFile(secretPath, 'secret', 'utf8')
  const authorized = await authorizeWorkspaceNoteFile(notePath, workspace, 'read')

  await rename(notePath, movedPath)
  await symlink(secretPath, notePath)
  await assert.rejects(
    readAuthorizedNoteFile(authorized),
    /symbolic link|outside allowed workspace roots|changed during access/i,
  )
  assert.equal(await readFile(secretPath, 'utf8'), 'secret')
})
