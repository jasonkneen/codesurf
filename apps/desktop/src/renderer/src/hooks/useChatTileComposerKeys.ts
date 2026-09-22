import { useCallback } from 'react'
import type { AutocompleteItem } from './useChatAutocomplete'

type UseChatTileComposerKeysOptions = {
  input: string
  isDictating: boolean
  toggleDictation: () => void
  acType: 'slash' | 'mention' | null
  acItems: AutocompleteItem[]
  acIndex: number
  setAcIndex: (updater: number | ((index: number) => number)) => void
  setAcType: (type: 'slash' | 'mention' | null) => void
  setAcQuery: (query: string) => void
  selectAcItem: (item: AutocompleteItem) => void
  sendMessage: () => void
}

export function useChatTileComposerKeys({
  input,
  isDictating,
  toggleDictation,
  acType,
  acItems,
  acIndex,
  setAcIndex,
  setAcType,
  setAcQuery,
  selectAcItem,
  sendMessage,
}: UseChatTileComposerKeysOptions) {
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === ' '
      && !event.repeat
      && !event.metaKey && !event.ctrlKey && !event.altKey
      && input.length === 0
      && !isDictating
    ) {
      event.preventDefault()
      toggleDictation()
      return
    }
    if (event.key === ' ' && isDictating) {
      event.preventDefault()
      return
    }

    if (acType && acItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setAcIndex(index => (index + 1) % acItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setAcIndex(index => (index - 1 + acItems.length) % acItems.length)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        selectAcItem(acItems[acIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setAcType(null)
        setAcQuery('')
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  }, [
    acIndex,
    acItems,
    acType,
    input.length,
    isDictating,
    selectAcItem,
    sendMessage,
    setAcIndex,
    setAcQuery,
    setAcType,
    toggleDictation,
  ])

  const handleKeyUp = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === ' ' && isDictating) {
      event.preventDefault()
      toggleDictation()
    }
  }, [isDictating, toggleDictation])

  return { handleKeyDown, handleKeyUp }
}