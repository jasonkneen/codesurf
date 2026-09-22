import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export type ChatTileComposerMenuId =
  | 'model'
  | 'provider'
  | 'insert'
  | 'mode'
  | 'thinking'
  | 'location'
  | 'branch'
  | 'context'
  | 'agent'

export type ChatTileComposerMenuRefs = {
  modelMenuRef: RefObject<HTMLDivElement | null>
  providerMenuRef: RefObject<HTMLDivElement | null>
  insertMenuRef: RefObject<HTMLDivElement | null>
  modeMenuRef: RefObject<HTMLDivElement | null>
  thinkingMenuRef: RefObject<HTMLDivElement | null>
  locationMenuRef: RefObject<HTMLDivElement | null>
  branchMenuRef: RefObject<HTMLDivElement | null>
  contextMenuRef: RefObject<HTMLDivElement | null>
  agentMenuRef: RefObject<HTMLDivElement | null>
}

type UseChatTileComposerMenusArgs = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  acRef: RefObject<HTMLDivElement | null>
  onCloseAutocomplete?: () => void
}

/** True when the event started on a menu trigger or the portaled menu itself. */
export function isInsideComposerMenu(
  target: EventTarget | null,
  menuRoots: readonly { current: Element | null }[],
): boolean {
  if (!target) return false
  const maybeEl = target as Partial<Element> & { parentElement?: Element | null }
  const el = typeof maybeEl.closest === 'function' ? maybeEl as Element : maybeEl.parentElement
  if (el && typeof el.closest === 'function' && el.closest('[data-chat-menu-portal="true"]')) return true
  return menuRoots.some(ref => Boolean(ref.current?.contains(target as Node)))
}

export function useChatTileComposerMenus({
  textareaRef,
  acRef,
  onCloseAutocomplete,
}: UseChatTileComposerMenusArgs) {
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const [showInsertMenu, setShowInsertMenu] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [showThinkingMenu, setShowThinkingMenu] = useState(false)
  const [showLocationMenu, setShowLocationMenu] = useState(false)
  const [showBranchMenu, setShowBranchMenu] = useState(false)
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [modelFilter, setModelFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState('')

  const modelMenuRef = useRef<HTMLDivElement>(null)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const insertMenuRef = useRef<HTMLDivElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const thinkingMenuRef = useRef<HTMLDivElement>(null)
  const locationMenuRef = useRef<HTMLDivElement>(null)
  const branchMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)

  const closeAllMenus = useCallback(() => {
    setShowModelMenu(false)
    setShowProviderMenu(false)
    setShowInsertMenu(false)
    setShowModeMenu(false)
    setShowThinkingMenu(false)
    setShowLocationMenu(false)
    setShowBranchMenu(false)
    setShowContextMenu(false)
    setShowAgentMenu(false)
    setModelFilter('')
    setBranchFilter('')
  }, [])

  const toggleMenu = useCallback((which: ChatTileComposerMenuId) => {
    setShowModelMenu(prev => {
      const next = which === 'model' ? !prev : false
      if (!next) setModelFilter('')
      return next
    })
    setShowProviderMenu(prev => which === 'provider' ? !prev : false)
    setShowInsertMenu(prev => which === 'insert' ? !prev : false)
    setShowModeMenu(prev => which === 'mode' ? !prev : false)
    setShowThinkingMenu(prev => which === 'thinking' ? !prev : false)
    setShowLocationMenu(prev => which === 'location' ? !prev : false)
    setShowBranchMenu(prev => {
      const next = which === 'branch' ? !prev : false
      if (!next) setBranchFilter('')
      return next
    })
    setShowContextMenu(prev => which === 'context' ? !prev : false)
    setShowAgentMenu(prev => which === 'agent' ? !prev : false)
  }, [])

  const anyMenuOpen = showModelMenu
    || showProviderMenu
    || showInsertMenu
    || showModeMenu
    || showThinkingMenu
    || showLocationMenu
    || showBranchMenu
    || showContextMenu
    || showAgentMenu

  const menuRefs = [
    modelMenuRef,
    providerMenuRef,
    insertMenuRef,
    modeMenuRef,
    thinkingMenuRef,
    locationMenuRef,
    branchMenuRef,
    contextMenuRef,
    agentMenuRef,
  ]

  useEffect(() => {
    const handlePointerDown = (e: Event) => {
      // Capture: panel layout / canvas tiles stop mousedown bubbling so the
      // canvas doesn't pan. Bubble-phase document listeners never see those.
      if (isInsideComposerMenu(e.target, menuRefs)) return
      closeAllMenus()
      const target = e.target as Node
      if (acRef.current && !acRef.current.contains(target) && target !== textareaRef.current) {
        onCloseAutocomplete?.()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && anyMenuOpen) {
        e.stopPropagation()
        e.preventDefault()
        closeAllMenus()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [anyMenuOpen, acRef, closeAllMenus, onCloseAutocomplete, textareaRef])

  return {
    showModelMenu,
    setShowModelMenu,
    showProviderMenu,
    setShowProviderMenu,
    showInsertMenu,
    setShowInsertMenu,
    showModeMenu,
    setShowModeMenu,
    showThinkingMenu,
    setShowThinkingMenu,
    showLocationMenu,
    setShowLocationMenu,
    showBranchMenu,
    setShowBranchMenu,
    showContextMenu,
    showAgentMenu,
    setShowAgentMenu,
    modelFilter,
    setModelFilter,
    branchFilter,
    setBranchFilter,
    modelMenuRef,
    providerMenuRef,
    insertMenuRef,
    modeMenuRef,
    thinkingMenuRef,
    locationMenuRef,
    branchMenuRef,
    contextMenuRef,
    agentMenuRef,
    toggleMenu,
    closeAllMenus,
  }
}