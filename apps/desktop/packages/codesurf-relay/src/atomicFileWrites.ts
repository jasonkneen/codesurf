import { randomUUID } from 'node:crypto'
import {
  existsSync,
  promises as fs,
  renameSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RelayOperationContext } from './types'

export type RelayFileWrite = {
  path: string
  content: string
}

export type RelayAtomicWriteDependencies = {
  createId: () => string
  ensureDirectory: (path: string) => Promise<void>
  writeTemporaryFile: (path: string, content: string) => Promise<void>
  commitTemporaryFile: (temporaryPath: string, path: string) => void
  removeTemporaryFile: (temporaryPath: string) => void
  destinationExists?: (path: string) => boolean
  moveDestinationFile?: (from: string, to: string) => void
}

const defaultDependencies: RelayAtomicWriteDependencies = {
  createId: randomUUID,
  ensureDirectory: async path => {
    await fs.mkdir(path, { recursive: true })
  },
  writeTemporaryFile: async (path, content) => {
    await fs.writeFile(path, content)
  },
  commitTemporaryFile: (temporaryPath, path) => {
    renameSync(temporaryPath, path)
  },
  removeTemporaryFile: temporaryPath => {
    rmSync(temporaryPath, { force: true })
  },
  destinationExists: path => existsSync(path),
  moveDestinationFile: (from, to) => {
    renameSync(from, to)
  },
}

function assertActive(context?: RelayOperationContext): void {
  context?.assertActive()
}

async function awaitActive<T>(
  operation: () => Promise<T>,
  context?: RelayOperationContext,
): Promise<T> {
  assertActive(context)
  try {
    const result = await operation()
    assertActive(context)
    return result
  } catch (error) {
    assertActive(context)
    throw error
  }
}

export async function writeFilesAtomically(
  files: RelayFileWrite[],
  context?: RelayOperationContext,
  dependencies: RelayAtomicWriteDependencies = defaultDependencies,
): Promise<void> {
  assertActive(context)
  const staged: Array<{
    path: string
    temporaryPath: string
    backupPath: string
    backupCreated: boolean
    committed: boolean
  }> = []
  const destinationExists = dependencies.destinationExists
    ?? defaultDependencies.destinationExists!
  const moveDestinationFile = dependencies.moveDestinationFile
    ?? defaultDependencies.moveDestinationFile!
  try {
    for (const file of files) {
      await awaitActive(
        () => dependencies.ensureDirectory(dirname(file.path)),
        context,
      )
      const temporaryPath = join(
        dirname(file.path),
        `.${basename(file.path)}.${dependencies.createId()}.tmp`,
      )
      // Register the path before writing so even a partial failed write is
      // removed by the common cleanup path.
      staged.push({
        path: file.path,
        temporaryPath,
        backupPath: join(
          dirname(file.path),
          `.${basename(file.path)}.${dependencies.createId()}.bak`,
        ),
        backupCreated: false,
        committed: false,
      })
      await awaitActive(
        () => dependencies.writeTemporaryFile(temporaryPath, file.content),
        context,
      )
    }

    // The commit and rollback phases are deliberately synchronous after the
    // final lifecycle check. Shutdown cannot interleave with either sequence.
    // Existing destinations move aside first so a later rename failure can
    // restore the complete pre-commit state instead of leaving a partial
    // mailbox/archive update visible.
    assertActive(context)
    for (const file of staged) {
      if (!destinationExists(file.path)) continue
      moveDestinationFile(file.path, file.backupPath)
      file.backupCreated = true
    }
    for (const file of staged) {
      dependencies.commitTemporaryFile(file.temporaryPath, file.path)
      file.committed = true
    }
    // All destinations now expose the new generation. Backup removal is
    // cleanup, not part of the transaction: reporting a failure here would
    // invite callers to retry an operation that already committed, while
    // attempting rollback after earlier backups were removed could destroy
    // valid destinations. A failed cleanup therefore leaves a uniquely named
    // recovery artifact but never changes or misreports the committed state.
    for (const file of staged) {
      if (!file.backupCreated) continue
      try {
        dependencies.removeTemporaryFile(file.backupPath)
        file.backupCreated = false
      } catch {}
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const file of [...staged].reverse()) {
      if (file.committed) {
        try {
          dependencies.removeTemporaryFile(file.path)
          file.committed = false
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (file.backupCreated) {
        try {
          moveDestinationFile(file.backupPath, file.path)
          file.backupCreated = false
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
    }
    for (const file of staged) {
      try {
        dependencies.removeTemporaryFile(file.temporaryPath)
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError)
      }
      if (file.backupCreated) {
        // Restoration failed, so this backup may be the only intact copy of
        // the pre-transaction destination. Preserve it for reconciliation.
        // Deleting it here would turn a recoverable rollback failure into data
        // loss, especially on Windows where rename cannot replace a locked
        // destination.
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Atomic relay write failed and rollback was incomplete',
      )
    }
    throw error
  }
}
