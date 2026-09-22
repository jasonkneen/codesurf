import type { ToolBlock } from '../../../../shared/chat-types'

export const CHECKPOINT_TOOL_NAME = 'Checkpoint saved'
export const CHECKPOINT_TOOL_ID_PREFIX = 'codesurf-checkpoint-'

export interface CheckpointRestoreContextInfo {
  workspaceId?: string | null
  tileId?: string | null
}

export interface CheckpointRestoreAction {
  checkpointId: string
  workspaceId: string
  sessionEntryId: string
  label: string
}

export function buildCheckpointSessionEntryId(tileId: string | null | undefined): string | null {
  const normalizedTileId = String(tileId ?? '').trim()
  return normalizedTileId ? `codesurf-runtime:${normalizedTileId}` : null
}

function parseCheckpointInput(input: string): { checkpointId?: string; sessionEntryId?: string } {
  if (!input.trim()) return {}
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>
    return {
      checkpointId: typeof parsed.checkpointId === 'string' ? parsed.checkpointId.trim() : undefined,
      sessionEntryId: typeof parsed.sessionEntryId === 'string' ? parsed.sessionEntryId.trim() : undefined,
    }
  } catch {
    return {}
  }
}

export function getCheckpointIdFromToolBlock(block: ToolBlock): string | null {
  if (block.name !== CHECKPOINT_TOOL_NAME) return null

  const parsedInput = parseCheckpointInput(block.input ?? '')
  if (parsedInput.checkpointId) return parsedInput.checkpointId

  const id = String(block.id ?? '')
  if (!id.startsWith(CHECKPOINT_TOOL_ID_PREFIX)) return null
  const checkpointId = id.slice(CHECKPOINT_TOOL_ID_PREFIX.length).trim()
  return checkpointId || null
}

export function isCheckpointToolBlock(block: ToolBlock): boolean {
  return getCheckpointIdFromToolBlock(block) !== null
}

export function getCheckpointRestoreAction(
  block: ToolBlock,
  context: CheckpointRestoreContextInfo,
): CheckpointRestoreAction | null {
  const workspaceId = String(context.workspaceId ?? '').trim()
  if (!workspaceId) return null

  const checkpointId = getCheckpointIdFromToolBlock(block)
  if (!checkpointId) return null

  const parsedInput = parseCheckpointInput(block.input ?? '')
  const sessionEntryId = parsedInput.sessionEntryId || buildCheckpointSessionEntryId(context.tileId)
  if (!sessionEntryId) return null

  return {
    checkpointId,
    workspaceId,
    sessionEntryId,
    label: String(block.summary ?? '').trim() || 'Saved checkpoint',
  }
}
