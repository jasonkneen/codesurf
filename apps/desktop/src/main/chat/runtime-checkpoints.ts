/**
 * Shared runtime checkpoint helpers used by Claude and Codex chat providers.
 *
 * Pure helpers (session entry id, labels, skip policy, display paths) have no
 * daemon/runtime imports so unit tests can drive them under plain node:test.
 * createRuntimeCheckpoint lazy-loads daemon I/O only on the non-skip path.
 */

import { relative, resolve, sep } from 'path'
import type { ChatRequest } from './types'
import {
  createChatStreamScope,
  type ChatStreamScope,
} from './room-stream-scope.ts'

export type RuntimeCheckpointRequest = Pick<
  ChatRequest,
  'cardId' | 'workspaceId' | 'workspaceDir' | 'provider' | 'model'
>

export type CreateRuntimeCheckpointResult = {
  ok: boolean
  checkpointId?: string
  skipped?: boolean
  error?: string
}

/** Stable session-entry id for a chat tile / card. */
export function buildRuntimeSessionEntryId(cardId: string): string {
  return `codesurf-runtime:${cardId}`
}

/**
 * Workspace-relative display path for checkpoint labels and summaries.
 * Absolute paths outside the workspace are left absolute.
 */
export function displayPathForCheckpoint(
  filePath: string,
  workspaceDir?: string | null,
): string {
  if (!filePath) return ''
  const resolvedPath = resolve(filePath)
  const resolvedWorkspace = workspaceDir ? resolve(workspaceDir) : ''
  if (
    resolvedWorkspace
    && (resolvedPath === resolvedWorkspace || resolvedPath.startsWith(`${resolvedWorkspace}${sep}`))
  ) {
    const rel = relative(resolvedWorkspace, resolvedPath)
    return rel || resolvedPath.split(sep).pop() || resolvedPath
  }
  return resolvedPath
}

/** Label stored on the checkpoint record (and used in UI restore chips). */
export function buildCheckpointLabel(
  toolName: string,
  filePaths: string[],
  workspaceDir?: string | null,
): string {
  if (filePaths.length === 0) return `Before ${toolName}`
  if (filePaths.length === 1) {
    return `Before ${toolName} ${displayPathForCheckpoint(filePaths[0], workspaceDir)}`
  }
  return `Before ${toolName} (${filePaths.length} files)`
}

/** True when createRuntimeCheckpoint should return { ok: true, skipped: true }. */
export function shouldSkipRuntimeCheckpoint(
  filePaths: string[],
  workspaceId?: string | null,
): boolean {
  return filePaths.length === 0 || !workspaceId
}

export function buildCheckpointSavedSummary(
  toolName: string,
  filePaths: string[],
  workspaceDir?: string | null,
): string {
  const displayPaths = filePaths
    .slice(0, 2)
    .map(filePath => displayPathForCheckpoint(filePath, workspaceDir))
  const suffix = filePaths.length > 2 ? ` +${filePaths.length - 2} more` : ''
  return `Saved checkpoint before ${toolName}${
    displayPaths.length > 0 ? ` for ${displayPaths.join(', ')}${suffix}` : ''
  }`
}

type CheckpointIo = {
  createCheckpoint: (
    workspaceId: string,
    sessionEntryId: string,
    body: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string; checkpoint?: { id?: string } }>
  sendStream: (scope: ChatStreamScope, event: Record<string, unknown>) => void
  log: (...args: unknown[]) => void
}

/** Optional override for tests; production uses daemon + chat stream. */
let checkpointIoOverride: CheckpointIo | null = null

export function setRuntimeCheckpointIoForTests(io: CheckpointIo | null): void {
  checkpointIoOverride = io
}

async function loadCheckpointIo(): Promise<CheckpointIo> {
  if (checkpointIoOverride) return checkpointIoOverride
  // Extensionless relative imports match the rest of main-process TS (electron-vite).
  const [{ daemonClient }, runtime] = await Promise.all([
    import('../daemon/client'),
    import('./runtime'),
  ])
  return {
    createCheckpoint: (workspaceId, sessionEntryId, body) =>
      daemonClient.createCheckpoint(workspaceId, sessionEntryId, body as any),
    sendStream: runtime.sendStream,
    log: runtime.log,
  }
}

export function emitCheckpointSaved(
  req: RuntimeCheckpointRequest,
  toolName: string,
  filePaths: string[],
  checkpointId: string,
  sendStream: CheckpointIo['sendStream'],
): void {
  const summary = buildCheckpointSavedSummary(toolName, filePaths, req.workspaceDir)
  const toolId = `codesurf-checkpoint-${checkpointId}`
  const scope = createChatStreamScope(req.workspaceId, req.cardId)
  sendStream(scope, { type: 'tool_start', toolId, toolName: 'Checkpoint saved' })
  sendStream(scope, { type: 'tool_summary', toolId, toolName: 'Checkpoint saved', text: summary })
}

/**
 * Create a pre-tool checkpoint via the daemon, or skip when there are no files / no workspace.
 * On success with a checkpoint id, emits the "Checkpoint saved" stream chips.
 */
export async function createRuntimeCheckpoint(
  req: RuntimeCheckpointRequest,
  toolName: string,
  filePaths: string[],
  metadata: Record<string, unknown> = {},
): Promise<CreateRuntimeCheckpointResult> {
  if (shouldSkipRuntimeCheckpoint(filePaths, req.workspaceId)) {
    return { ok: true, skipped: true }
  }

  const io = await loadCheckpointIo()
  try {
    const response = await io.createCheckpoint(
      req.workspaceId!,
      buildRuntimeSessionEntryId(req.cardId),
      {
        label: buildCheckpointLabel(toolName, filePaths, req.workspaceDir),
        reason: `tool:${toolName}`,
        files: filePaths,
        metadata: {
          provider: req.provider,
          model: req.model,
          toolName,
          cardId: req.cardId,
          ...metadata,
        },
        source: 'main-ipc-chat',
      },
    )
    if (!response.ok) {
      return {
        ok: false,
        error: response.error ?? `Failed to create checkpoint for ${toolName}`,
      }
    }
    if (response.checkpoint?.id) {
      emitCheckpointSaved(req, toolName, filePaths, response.checkpoint.id, io.sendStream)
    }
    return { ok: true, checkpointId: response.checkpoint?.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.log('createRuntimeCheckpoint error', req.cardId, toolName, message)
    return { ok: false, error: message }
  }
}
