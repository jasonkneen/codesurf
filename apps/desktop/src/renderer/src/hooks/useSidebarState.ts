import { useState, useCallback, useRef, useEffect } from 'react'

export interface SidebarState {
  sidebarCollapsed: boolean
  sidebarWidth: number
  sidebarResizing: boolean
  sidebarSelectedPath: string | null
}

export interface SidebarActions {
  setSidebarCollapsed: (collapsed: boolean) => void
  setSidebarWidth: (width: number) => void
  setSidebarResizing: (resizing: boolean) => void
  setSidebarSelectedPath: (path: string | null) => void
  toggleSidebar: () => void
}

const DEFAULT_SIDEBAR_WIDTH = 300
const MIN_SIDEBAR_WIDTH = 200
const MAX_SIDEBAR_WIDTH = 600

export function useSidebarState(): SidebarState & SidebarActions & { sidebarWidthRef: React.MutableRefObject<number> } {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidthState] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null)
  const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH)

  const setSidebarWidth = useCallback((width: number) => {
    const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width))
    sidebarWidthRef.current = clamped
    setSidebarWidthState(clamped)
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev)
  }, [])

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
  }, [sidebarWidth])

  return {
    sidebarCollapsed,
    sidebarWidth,
    sidebarResizing,
    sidebarSelectedPath,
    setSidebarCollapsed,
    setSidebarWidth,
    setSidebarResizing,
    setSidebarSelectedPath,
    toggleSidebar,
    sidebarWidthRef,
  }
}
