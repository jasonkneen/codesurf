import { useCallback, useEffect, useMemo, useState, type SetStateAction } from 'react'
import type { ChatMessage, FileChange } from '../../../shared/chat-types'
import type { LatestChangeDrawerState } from '../components/chat/ChatTileLatestChangeDrawer'
import { hasVisibleFileChangeStats } from '../components/chat/chatTileUtils'
import type { CheckpointRestoreContextValue } from '../components/chat/chatTileTypes'

function mergeDrawerFileChanges(fileChanges: FileChange[]): FileChange[] {
  const merged = new Map<string, FileChange>()
  for (const change of fileChanges) {
    const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...change })
      continue
    }
    existing.additions += change.additions
    existing.deletions += change.deletions
    existing.diff = `${existing.diff}\n\n${change.diff}`.trim()
  }
  return Array.from(merged.values())
}

type UseChatTileLatestChangeDrawerArgs = {
  workspaceId: string
  tileId: string
  messages: ChatMessage[]
  setMessagesSafe: (updater: SetStateAction<ChatMessage[]>) => void
}

export function useChatTileLatestChangeDrawer({
  workspaceId,
  tileId,
  messages,
  setMessagesSafe,
}: UseChatTileLatestChangeDrawerArgs) {
  const latestChangeDrawer = useMemo<LatestChangeDrawerState | null>(() => {
    const batchMessages: ChatMessage[] = []
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]
      if (message.role === 'user') break
      batchMessages.unshift(message)
    }
    if (batchMessages.length === 0) return null

    const rawFileChanges: FileChange[] = []
    let latestMessageId: string | null = null
    let latestToolBlockId: string | null = null
    let changeBlockCount = 0

    for (const message of batchMessages) {
      for (const block of message.toolBlocks ?? []) {
        const fileChanges = block.fileChanges ?? []
        if (fileChanges.length === 0) continue
        changeBlockCount += 1
        rawFileChanges.push(...fileChanges)
        latestMessageId = message.id
        latestToolBlockId = block.id
      }
    }

    if (rawFileChanges.length === 0 || !latestMessageId || !latestToolBlockId) return null

    const fileChanges = mergeDrawerFileChanges(rawFileChanges)
    return {
      key: `${latestMessageId}:${latestToolBlockId}:${changeBlockCount}:${fileChanges.length}`,
      messageId: latestMessageId,
      toolBlockId: latestToolBlockId,
      fileChanges,
      fileCount: fileChanges.length,
      additions: fileChanges.reduce((sum, change) => sum + change.additions, 0),
      deletions: fileChanges.reduce((sum, change) => sum + change.deletions, 0),
      changeBlockCount,
    }
  }, [messages])

  const latestChangeDrawerHasStats = latestChangeDrawer ? hasVisibleFileChangeStats(latestChangeDrawer) : false
  const [latestChangeDrawerExpanded, setLatestChangeDrawerExpanded] = useState(false)
  const [latestChangeDrawerExpandedFiles, setLatestChangeDrawerExpandedFiles] = useState<Record<string, boolean>>({})
  const [latestCheckpointId, setLatestCheckpointId] = useState<string | null>(null)
  const [isRestoringLatestCheckpoint, setIsRestoringLatestCheckpoint] = useState(false)
  const [restoringCheckpointId, setRestoringCheckpointId] = useState<string | null>(null)

  useEffect(() => {
    if (!latestChangeDrawer) {
      setLatestCheckpointId(null)
      return
    }

    setLatestChangeDrawerExpanded(false)
    setLatestChangeDrawerExpandedFiles({})
  }, [latestChangeDrawer?.key])

  useEffect(() => {
    let cancelled = false
    if (!workspaceId || !latestChangeDrawer) {
      setLatestCheckpointId(null)
      return
    }

    void window.electron.canvas
      .listCheckpoints(workspaceId, `codesurf-runtime:${tileId}`)
      .then(checkpoints => {
        if (cancelled) return
        const undoIndex = Math.max(0, (latestChangeDrawer.changeBlockCount ?? 1) - 1)
        setLatestCheckpointId(checkpoints[undoIndex]?.id ?? checkpoints[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setLatestCheckpointId(null)
      })

    return () => { cancelled = true }
  }, [workspaceId, tileId, latestChangeDrawer?.key])

  const toggleLatestChangeDrawerFile = useCallback((key: string) => {
    setLatestChangeDrawerExpandedFiles(prev => ({ ...prev, [key]: !(prev[key] ?? false) }))
  }, [])

  const restoreLatestCheckpoint = useCallback(async () => {
    if (!workspaceId || !latestCheckpointId || isRestoringLatestCheckpoint) return
    setIsRestoringLatestCheckpoint(true)
    try {
      const result = await window.electron.canvas.restoreCheckpoint(workspaceId, latestCheckpointId, `codesurf-runtime:${tileId}`)
      if (!result.ok) {
        const errorText = result.error ?? 'Checkpoint restore failed'
        setMessagesSafe(prev => [...prev, {
          id: `msg-restore-checkpoint-error-${Date.now()}`,
          role: 'assistant',
          content: `Undo failed: ${errorText}`,
          timestamp: Date.now(),
        }])
        return
      }
      const restoredParts: string[] = []
      if (typeof result.filesRestored === 'number' && result.filesRestored > 0) {
        restoredParts.push(`${result.filesRestored} restored`)
      }
      if (typeof result.filesDeleted === 'number' && result.filesDeleted > 0) {
        restoredParts.push(`${result.filesDeleted} deleted`)
      }
      const suffix = restoredParts.length > 0 ? ` (${restoredParts.join(', ')})` : ''
      setMessagesSafe(prev => [...prev, {
        id: `msg-restore-checkpoint-${Date.now()}`,
        role: 'assistant',
        content: `Restored the latest checkpoint before those changes${suffix}.`,
        timestamp: Date.now(),
      }])
      setLatestCheckpointId(null)
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      setMessagesSafe(prev => [...prev, {
        id: `msg-restore-checkpoint-error-${Date.now()}`,
        role: 'assistant',
        content: `Undo failed: ${errorText}`,
        timestamp: Date.now(),
      }])
    } finally {
      setIsRestoringLatestCheckpoint(false)
    }
  }, [workspaceId, tileId, latestCheckpointId, isRestoringLatestCheckpoint, setMessagesSafe])

  const restoreCheckpointFromToolBlock = useCallback(async (checkpointId: string, sessionEntryId: string, label = 'checkpoint') => {
    if (!workspaceId || !checkpointId || !sessionEntryId || restoringCheckpointId || isRestoringLatestCheckpoint) return
    setRestoringCheckpointId(checkpointId)
    try {
      const result = await window.electron.canvas.restoreCheckpoint(workspaceId, checkpointId, sessionEntryId)
      if (!result.ok) {
        const errorText = result.error ?? 'Checkpoint restore failed'
        setMessagesSafe(prev => [...prev, {
          id: `msg-restore-checkpoint-error-${Date.now()}`,
          role: 'assistant',
          content: `Restore failed: ${errorText}`,
          timestamp: Date.now(),
        }])
        return
      }
      const restoredParts: string[] = []
      if (typeof result.filesRestored === 'number' && result.filesRestored > 0) {
        restoredParts.push(`${result.filesRestored} restored`)
      }
      if (typeof result.filesDeleted === 'number' && result.filesDeleted > 0) {
        restoredParts.push(`${result.filesDeleted} deleted`)
      }
      const suffix = restoredParts.length > 0 ? ` (${restoredParts.join(', ')})` : ''
      setMessagesSafe(prev => [...prev, {
        id: `msg-restore-checkpoint-${Date.now()}`,
        role: 'assistant',
        content: `Restored checkpoint: ${label}${suffix}.`,
        timestamp: Date.now(),
      }])
      if (latestCheckpointId === checkpointId) setLatestCheckpointId(null)
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      setMessagesSafe(prev => [...prev, {
        id: `msg-restore-checkpoint-error-${Date.now()}`,
        role: 'assistant',
        content: `Restore failed: ${errorText}`,
        timestamp: Date.now(),
      }])
    } finally {
      setRestoringCheckpointId(current => current === checkpointId ? null : current)
    }
  }, [workspaceId, restoringCheckpointId, isRestoringLatestCheckpoint, latestCheckpointId, setMessagesSafe])

  const checkpointRestoreContextValue = useMemo<CheckpointRestoreContextValue>(() => ({
    workspaceId: workspaceId ?? null,
    tileId,
    restoringCheckpointId,
    restoreCheckpoint: restoreCheckpointFromToolBlock,
  }), [workspaceId, tileId, restoringCheckpointId, restoreCheckpointFromToolBlock])

  return {
    latestChangeDrawer,
    latestChangeDrawerHasStats,
    latestChangeDrawerExpanded,
    setLatestChangeDrawerExpanded,
    latestChangeDrawerExpandedFiles,
    latestCheckpointId,
    isRestoringLatestCheckpoint,
    toggleLatestChangeDrawerFile,
    restoreLatestCheckpoint,
    checkpointRestoreContextValue,
  }
}