import { useState, useCallback } from 'react'

export type ActiveOverlay =
  | { type: 'mcp' }
  | { type: 'settings', section?: string }
  | { type: 'extensionsGallery' }
  | { type: 'agentSetup' }
  | { type: 'skillInstall', path: string }
  | { type: 'commandPalette' }
  | null

export interface OverlayState {
  activeOverlay: ActiveOverlay
  showMinimap: boolean
}

export interface OverlayActions {
  openMCP: () => void
  openSettings: (section?: string) => void
  openExtensionsGallery: () => void
  openAgentSetup: () => void
  openSkillInstall: (path: string) => void
  openCommandPalette: () => void
  closeOverlay: () => void
  setShowMinimap: (show: boolean) => void
}

export function useOverlayState(): OverlayState & OverlayActions {
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null)
  const [showMinimap] = useState(false)

  const openMCP = useCallback(() => setActiveOverlay({ type: 'mcp' }), [])
  const openSettings = useCallback((section?: string) => setActiveOverlay({ type: 'settings', section }), [])
  const openExtensionsGallery = useCallback(() => setActiveOverlay({ type: 'extensionsGallery' }), [])
  const openAgentSetup = useCallback(() => setActiveOverlay({ type: 'agentSetup' }), [])
  const openSkillInstall = useCallback((path: string) => setActiveOverlay({ type: 'skillInstall', path }), [])
  const openCommandPalette = useCallback(() => setActiveOverlay({ type: 'commandPalette' }), [])
  const closeOverlay = useCallback(() => setActiveOverlay(null), [])
  const setShowMinimap = useCallback((_show: boolean) => { /* minimap disabled */ }, [])

  return {
    activeOverlay,
    showMinimap,
    openMCP,
    openSettings,
    openExtensionsGallery,
    openAgentSetup,
    openSkillInstall,
    openCommandPalette,
    closeOverlay,
    setShowMinimap,
  }
}

// Backward-compatible accessors for components that still use individual booleans
export function isMcpOpen(overlay: ActiveOverlay): boolean {
  return overlay?.type === 'mcp'
}

export function isSettingsOpen(overlay: ActiveOverlay): boolean {
  return overlay?.type === 'settings'
}

export function getSettingsSection(overlay: ActiveOverlay): string | false {
  return overlay?.type === 'settings' ? (overlay.section ?? '') : false
}

export function isExtensionsGalleryOpen(overlay: ActiveOverlay): boolean {
  return overlay?.type === 'extensionsGallery'
}

export function isAgentSetupOpen(overlay: ActiveOverlay): boolean {
  return overlay?.type === 'agentSetup'
}

export function getSkillInstallPath(overlay: ActiveOverlay): string | null {
  return overlay?.type === 'skillInstall' ? overlay.path : null
}

export function isCommandPaletteOpen(overlay: ActiveOverlay): boolean {
  return overlay?.type === 'commandPalette'
}
