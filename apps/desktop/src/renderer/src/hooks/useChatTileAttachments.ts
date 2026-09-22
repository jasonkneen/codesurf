import { useCallback, useState } from 'react'
import { isImagePath } from '../utils/dnd.ts'
import type { PendingAttachment } from '../components/chat/chatTileUtils'

type AttachmentInput = string | { capability: string; displayName: string }

type UseChatTileAttachmentsOptions = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  workspaceId: string
  cardId: string
  syncComposerHeight: () => void
  setAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>
  setAcType: (type: 'slash' | 'mention' | null) => void
  setAcQuery: (query: string) => void
  setShowInsertMenu: (show: boolean) => void
}

export function useChatTileAttachments({
  textareaRef,
  workspaceId,
  cardId,
  syncComposerHeight,
  setAttachments,
  setAcType,
  setAcQuery,
  setShowInsertMenu,
}: UseChatTileAttachmentsOptions) {
  const [isDropTarget, setIsDropTarget] = useState(false)

  const addAttachments = useCallback((inputs: AttachmentInput[]) => {
    if (inputs.length === 0) return
    setAttachments(prev => {
      const seen = new Set(prev.map(item => item.capability ?? item.path))
      const next = [...prev]
      for (const input of inputs) {
        const path = typeof input === 'string' ? input : input.displayName
        const capability = typeof input === 'string' ? undefined : input.capability
        const key = capability ?? path
        if (seen.has(key)) continue
        seen.add(key)
        next.push({ path, kind: isImagePath(path) ? 'image' : 'file', ...(capability ? { capability } : {}) })
      }
      return next
    })
    setAcType(null)
    setAcQuery('')
    requestAnimationFrame(() => {
      syncComposerHeight()
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      const pos = textarea.value.length
      textarea.setSelectionRange(pos, pos)
    })
  }, [setAcQuery, setAcType, setAttachments, syncComposerHeight, textareaRef])

  const openAttachmentPicker = useCallback(async () => {
    const attachments = await window.electron.chat?.selectFiles(workspaceId, cardId)
    if (attachments && attachments.length > 0) addAttachments(attachments)
    setShowInsertMenu(false)
  }, [addAttachments, cardId, setShowInsertMenu, workspaceId])

  const removeAttachment = useCallback((path: string) => {
    setAttachments(prev => prev.filter(item => item.path !== path))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [setAttachments, textareaRef])

  const handleTileDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const dataTransfer = event.dataTransfer
    if (dataTransfer.types.includes('application/x-codesurf-queued-turn')) return
    const hasFiles = dataTransfer.types.includes('Files')
    const hasUri = dataTransfer.types.includes('text/uri-list')
    const hasPlain = dataTransfer.types.includes('text/plain')
    const hasFileRef = dataTransfer.types.includes('application/file-reference-path')
    if (!hasFiles && !hasUri && !hasPlain && !hasFileRef) return
    event.preventDefault()
    event.stopPropagation()
    dataTransfer.dropEffect = 'copy'
    setIsDropTarget(true)
  }, [])

  const handleTileDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setIsDropTarget(false)
  }, [])

  const handleTileDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('application/x-codesurf-queued-turn')) {
      setIsDropTarget(false)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    setIsDropTarget(false)
    const droppedFiles = Array.from(event.dataTransfer.files ?? [])
    if (droppedFiles.length > 0) {
      const attachments = await window.electron.chat?.authorizeDroppedFiles(
        workspaceId,
        cardId,
        droppedFiles,
      )
      if (!attachments || attachments.length === 0) {
        window.alert('Dropped files could not be verified. Use the attachment picker instead.')
        return
      }
      addAttachments(attachments)
      return
    }
    window.alert('Path-only drops cannot be verified as attachments. Use the attachment picker instead.')
  }, [addAttachments, cardId, workspaceId])

  return {
    isDropTarget,
    addAttachments,
    openAttachmentPicker,
    removeAttachment,
    handleTileDragOver,
    handleTileDragLeave,
    handleTileDrop,
  }
}
