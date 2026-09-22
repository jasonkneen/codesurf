import { useCallback } from 'react'
import { isImagePath } from '../utils/dnd'
import type { AutocompleteItem } from './useChatAutocomplete'

type Attachment = { path: string, kind: 'image' | 'file' }

type UseChatAutocompleteSelectionOptions = {
  input: string
  acType: 'slash' | 'mention' | null
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  syncComposerHeight: () => void
  setInput: (value: string) => void
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
  setAcType: (type: 'slash' | 'mention' | null) => void
  setAcQuery: (query: string) => void
}

export function useChatAutocompleteSelection({
  input,
  acType,
  textareaRef,
  syncComposerHeight,
  setInput,
  setAttachments,
  setAcType,
  setAcQuery,
}: UseChatAutocompleteSelectionOptions) {
  const selectAcItem = useCallback((item: AutocompleteItem) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const pos = textarea.selectionStart ?? input.length
    const textBefore = input.slice(0, pos)
    const textAfter = input.slice(pos)

    let triggerStart = pos
    if (acType === 'slash') {
      const match = textBefore.match(/(^|\s)(\/\w*)$/)
      if (match) triggerStart = pos - match[2].length
    } else if (acType === 'mention') {
      const match = textBefore.match(/@[\w./]*$/)
      if (match) triggerStart = pos - match[0].length
    }

    const replacement = `${item.value} `
    const newVal = input.slice(0, triggerStart) + replacement + textAfter
    setInput(newVal)
    if (item.attachPath) {
      const attachPath = item.attachPath
      setAttachments(prev => {
        if (prev.some(existing => existing.path === attachPath)) return prev
        return [...prev, { path: attachPath, kind: isImagePath(attachPath) ? 'image' : 'file' }]
      })
    }
    setAcType(null)
    setAcQuery('')

    requestAnimationFrame(() => {
      syncComposerHeight()
      if (textarea) {
        textarea.focus()
        const newPos = triggerStart + replacement.length
        textarea.setSelectionRange(newPos, newPos)
      }
    })
  }, [acType, input, setAcQuery, setAcType, setAttachments, setInput, syncComposerHeight, textareaRef])

  return { selectAcItem }
}