import { isAbsolute, join } from 'node:path'
import {
  appendUtf8FileNoFollow,
  readUtf8FilePrefixNoFollow,
  validateCanonicalFsPathDetails,
  writeUtf8FileNoFollow,
  type ValidatedFsPath,
} from '../ipc/fs.ts'

const MAX_NOTE_READ_BYTES = 64 * 1024

export type NoteFileIntent = 'read' | 'write'

export async function authorizeWorkspaceNoteFile(
  candidatePath: string,
  workspaceRoot: string,
  intent: NoteFileIntent,
): Promise<ValidatedFsPath> {
  const candidate = isAbsolute(candidatePath)
    ? candidatePath
    : join(workspaceRoot, candidatePath)
  return validateCanonicalFsPathDetails(candidate, intent, {
    restrictToWorkspaceRoots: true,
    allowedRoots: [workspaceRoot],
  })
}

export function readAuthorizedNoteFile(note: ValidatedFsPath): Promise<string> {
  return readUtf8FilePrefixNoFollow(
    note.operationPath,
    MAX_NOTE_READ_BYTES,
    note.authorization,
  )
}

export function writeAuthorizedNoteFile(
  note: ValidatedFsPath,
  content: string,
): Promise<void> {
  return writeUtf8FileNoFollow(note.operationPath, content, {
    authorization: note.authorization,
  })
}

export function appendAuthorizedNoteFile(
  note: ValidatedFsPath,
  content: string,
): Promise<void> {
  return appendUtf8FileNoFollow(note.operationPath, content, {
    authorization: note.authorization,
  })
}
