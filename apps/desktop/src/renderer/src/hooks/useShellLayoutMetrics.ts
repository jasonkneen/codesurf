import { useMemo } from 'react'
import type { AppSettings, Workspace } from '../../../shared/types'
import type { PanelNode } from '../components/panelLayoutTree'
import type { AppFonts } from './useAppThemeCssVars'
import type { AppTheme } from '../theme'

function withAlpha(color: string, alpha: number): string {
  const trimmed = color.trim()

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1)
    if (hex.length === 3) {
      const [r, g, b] = hex.split('').map(ch => parseInt(ch + ch, 16))
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }
  }

  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i)
  if (rgbMatch) {
    const [r = '0', g = '0', b = '0'] = rgbMatch[1].split(',').map(part => part.trim())
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  return color
}

/** Sidebar chrome geometry. */
export type ShellSidebarMetrics = {
  footerBottom: number
  footerLeft: number
  footerHeight: number
  statusBarLeft: number
  collapsedPillSize: number
  toggleLeft: number
  toggleTop: number
  tabsMinimumLeft: number
}

/** Main content panel chrome. */
export type ShellMainPanelMetrics = {
  bottomInset: number
  top: number
  left: number
  cornerRadii: { topLeft: number, topRight: number, bottomRight: number, bottomLeft: number }
  borderRadius: string
  background: string
  insetEdgeShadow: string
  outerEdgeShadow: string
  shadow: string
}

/** Workspace tab strip metrics. */
export type ShellWorkspaceTabMetrics = {
  labelSize: number
  background: string
  inactiveBackground: string
  inactiveHoverBackground: string
  closeHoverBackground: string
  maxWidth: string
  activeHeight: number
  inactiveHeight: number
  textOffset: number
  inactiveTextOffset: number
  activeBottomGap: number
  inactiveBottomGap: number
  selectedDropShadow: string
}

/** Discovery connection overlay z-index stack. */
export type ShellDiscoveryMetrics = {
  highlightZIndex: number
  glowZIndex: number
  pillZIndex: number
  colors: { line: string, dot: string, bg: string, text: string }
}

/**
 * Grouped shell metrics (preferred API). Flat `ShellLayoutMetrics` remains for
 * existing App destructuring via `flattenShellLayoutMetrics`.
 */
export type ShellLayoutMetricsGrouped = {
  canvasLayerBackground: string
  sidebar: ShellSidebarMetrics
  mainPanel: ShellMainPanelMetrics
  workspaceTabs: ShellWorkspaceTabMetrics
  discovery: ShellDiscoveryMetrics
  openWorkspaceTabs: Workspace[]
  hasWorkspaceTabs: boolean
  workspaceTitleFallback: string
  showTopWorkspacePickerTab: boolean
}

/** Flat layout metrics — backward-compatible App surface. */
export type ShellLayoutMetrics = {
  canvasLayerBackground: string
  sidebarFooterBottom: number
  sidebarFooterLeft: number
  sidebarFooterHeight: number
  mainPanelBottomInset: number
  mainPanelTop: number
  mainStatusBarLeft: number
  collapsedSidebarPillSize: number
  sidebarToggleLeft: number
  sidebarToggleTop: number
  workspaceTabsMinimumLeft: number
  mainPanelLeft: number
  discoveryHighlightZIndex: number
  discoveryGlowZIndex: number
  discoveryPillZIndex: number
  openWorkspaceTabs: Workspace[]
  hasWorkspaceTabs: boolean
  workspaceTitleFallback: string
  showTopWorkspacePickerTab: boolean
  mainPanelCornerRadii: { topLeft: number, topRight: number, bottomRight: number, bottomLeft: number }
  mainPanelBorderRadius: string
  mainPanelBackground: string
  mainPanelInsetEdgeShadow: string
  mainPanelOuterEdgeShadow: string
  selectedTabDropShadow: string
  mainPanelShadow: string
  workspaceTabLabelSize: number
  workspaceTabBackground: string
  workspaceTabInactiveBackground: string
  workspaceTabInactiveHoverBackground: string
  workspaceTabCloseHoverBackground: string
  workspaceTabMaxWidth: string
  workspaceTabActiveHeight: number
  workspaceTabInactiveHeight: number
  workspaceTabTextOffset: number
  workspaceTabInactiveTextOffset: number
  workspaceTabActiveBottomGap: number
  workspaceTabInactiveBottomGap: number
  dsc: { line: string, dot: string, bg: string, text: string }
}

/** Pure: flatten grouped metrics for legacy consumers. */
export function flattenShellLayoutMetrics(g: ShellLayoutMetricsGrouped): ShellLayoutMetrics {
  return {
    canvasLayerBackground: g.canvasLayerBackground,
    sidebarFooterBottom: g.sidebar.footerBottom,
    sidebarFooterLeft: g.sidebar.footerLeft,
    sidebarFooterHeight: g.sidebar.footerHeight,
    mainPanelBottomInset: g.mainPanel.bottomInset,
    mainPanelTop: g.mainPanel.top,
    mainStatusBarLeft: g.sidebar.statusBarLeft,
    collapsedSidebarPillSize: g.sidebar.collapsedPillSize,
    sidebarToggleLeft: g.sidebar.toggleLeft,
    sidebarToggleTop: g.sidebar.toggleTop,
    workspaceTabsMinimumLeft: g.sidebar.tabsMinimumLeft,
    mainPanelLeft: g.mainPanel.left,
    discoveryHighlightZIndex: g.discovery.highlightZIndex,
    discoveryGlowZIndex: g.discovery.glowZIndex,
    discoveryPillZIndex: g.discovery.pillZIndex,
    openWorkspaceTabs: g.openWorkspaceTabs,
    hasWorkspaceTabs: g.hasWorkspaceTabs,
    workspaceTitleFallback: g.workspaceTitleFallback,
    showTopWorkspacePickerTab: g.showTopWorkspacePickerTab,
    mainPanelCornerRadii: g.mainPanel.cornerRadii,
    mainPanelBorderRadius: g.mainPanel.borderRadius,
    mainPanelBackground: g.mainPanel.background,
    mainPanelInsetEdgeShadow: g.mainPanel.insetEdgeShadow,
    mainPanelOuterEdgeShadow: g.mainPanel.outerEdgeShadow,
    selectedTabDropShadow: g.workspaceTabs.selectedDropShadow,
    mainPanelShadow: g.mainPanel.shadow,
    workspaceTabLabelSize: g.workspaceTabs.labelSize,
    workspaceTabBackground: g.workspaceTabs.background,
    workspaceTabInactiveBackground: g.workspaceTabs.inactiveBackground,
    workspaceTabInactiveHoverBackground: g.workspaceTabs.inactiveHoverBackground,
    workspaceTabCloseHoverBackground: g.workspaceTabs.closeHoverBackground,
    workspaceTabMaxWidth: g.workspaceTabs.maxWidth,
    workspaceTabActiveHeight: g.workspaceTabs.activeHeight,
    workspaceTabInactiveHeight: g.workspaceTabs.inactiveHeight,
    workspaceTabTextOffset: g.workspaceTabs.textOffset,
    workspaceTabInactiveTextOffset: g.workspaceTabs.inactiveTextOffset,
    workspaceTabActiveBottomGap: g.workspaceTabs.activeBottomGap,
    workspaceTabInactiveBottomGap: g.workspaceTabs.inactiveBottomGap,
    dsc: g.discovery.colors,
  }
}

export type UseShellLayoutMetricsParams = {
  settings: AppSettings
  theme: AppTheme
  sidebarCollapsed: boolean
  sidebarWidth: number
  panelLayout: PanelNode | null
  openWorkspaceIds: string[]
  workspaces: Workspace[]
  workspace: Workspace | null
  showWorkspacePickerTab: boolean
  appFonts: AppFonts
}

/** Build grouped shell metrics (pure, testable). */
export function computeShellLayoutMetricsGrouped(params: UseShellLayoutMetricsParams): ShellLayoutMetricsGrouped {
  const {
    settings,
    theme,
    sidebarCollapsed,
    sidebarWidth,
    panelLayout,
    openWorkspaceIds,
    workspaces,
    workspace,
    showWorkspacePickerTab,
    appFonts,
  } = params

  const translucentBackgroundOpacity = Math.max(0.05, Math.min(1, settings.translucentBackgroundOpacity ?? 1))
  const canvasBackground = withAlpha(settings.canvasBackground, translucentBackgroundOpacity)
  const canvasLayerBackground = theme.canvas.backgroundEffect
    ? `${theme.canvas.backgroundEffect}, ${canvasBackground}`
    : canvasBackground

  const sidebar: ShellSidebarMetrics = {
    footerBottom: 2,
    footerLeft: 0,
    footerHeight: 42,
    statusBarLeft: sidebarCollapsed ? 0 : sidebarWidth,
    collapsedPillSize: 24,
    toggleLeft: 78,
    toggleTop: 10,
    tabsMinimumLeft: 78 + 24 + 14,
  }

  const mainPanelRadius = 10
  const cornerRadii = {
    topLeft: mainPanelRadius,
    topRight: mainPanelRadius,
    bottomRight: mainPanelRadius,
    bottomLeft: mainPanelRadius,
  }
  const expandedLayoutLeft = sidebarWidth + 12
  const mainPanelBackground = panelLayout ? theme.surface.app : canvasLayerBackground
  const insetEdgeShadow = theme.mode === 'light'
    ? `inset 0 0 0 0.5px color-mix(in srgb, ${theme.surface.app} 96%, transparent), inset -0.5px 0 0 color-mix(in srgb, ${theme.text.primary} 2.5%, transparent), inset 0 -0.5px 0 color-mix(in srgb, ${theme.text.primary} 2.5%, transparent)`
    : `inset 0 0 0 0.5px rgba(255,255,255,0.045)`
  const outerEdgeShadow = theme.mode === 'light'
    ? `0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 4%, transparent)`
    : `0 0 0 0.5px rgba(0,0,0,0.30)`
  const selectedDropShadow = theme.mode === 'light'
    ? `0 5px 12px color-mix(in srgb, ${theme.text.primary} 10%, transparent)`
    : `0 5px 12px rgba(0,0,0,0.36)`

  const mainPanel: ShellMainPanelMetrics = {
    bottomInset: sidebar.footerHeight - 6,
    top: 39,
    left: sidebarCollapsed ? 6 : expandedLayoutLeft,
    cornerRadii,
    borderRadius: `${cornerRadii.topLeft}px ${cornerRadii.topRight}px ${cornerRadii.bottomRight}px ${cornerRadii.bottomLeft}px`,
    background: mainPanelBackground,
    insetEdgeShadow,
    outerEdgeShadow,
    shadow: `${outerEdgeShadow}, ${selectedDropShadow}`,
  }

  const workspaceTabActiveBottomGap = 3
  const workspaceTabs: ShellWorkspaceTabMetrics = {
    labelSize: Math.max(12, appFonts.size - 1),
    background: panelLayout ? theme.surface.panel : mainPanelBackground,
    inactiveBackground: theme.mode === 'light'
      ? `color-mix(in srgb, ${theme.surface.panel} 58%, transparent)`
      : 'transparent',
    inactiveHoverBackground: theme.mode === 'light'
      ? `color-mix(in srgb, ${theme.surface.panel} 78%, transparent)`
      : theme.surface.hover,
    closeHoverBackground: `color-mix(in srgb, ${theme.surface.selection} 70%, ${theme.surface.hover})`,
    maxWidth: 'min(248px, 24vw)',
    activeHeight: 27,
    inactiveHeight: 22,
    textOffset: -1,
    inactiveTextOffset: 0,
    activeBottomGap: workspaceTabActiveBottomGap,
    inactiveBottomGap: workspaceTabActiveBottomGap + 3,
    selectedDropShadow,
  }

  const discovery: ShellDiscoveryMetrics = {
    highlightZIndex: 0,
    glowZIndex: 0,
    pillZIndex: 99997,
    colors: theme.mode === 'light'
      ? { line: '53, 104, 255', dot: '53, 104, 255', bg: '255, 255, 255', text: theme.accent.base }
      : { line: '123, 241, 255', dot: '123, 241, 255', bg: '5, 13, 19', text: 'rgba(215, 247, 255, 0.97)' },
  }

  const openWorkspaceTabs = openWorkspaceIds
    .map(id => workspaces.find(ws => ws.id === id) ?? null)
    .filter((ws): ws is Workspace => Boolean(ws))

  return {
    canvasLayerBackground,
    sidebar,
    mainPanel,
    workspaceTabs,
    discovery,
    openWorkspaceTabs,
    hasWorkspaceTabs: openWorkspaceTabs.length > 0,
    workspaceTitleFallback: workspace?.name?.trim() || 'Workspaces',
    showTopWorkspacePickerTab: showWorkspacePickerTab || (!workspace && openWorkspaceTabs.length === 0),
  }
}

export function useShellLayoutMetrics(params: UseShellLayoutMetricsParams): ShellLayoutMetrics {
  return useMemo(
    () => flattenShellLayoutMetrics(computeShellLayoutMetricsGrouped(params)),
    [
      params.appFonts.size,
      params.openWorkspaceIds,
      params.panelLayout,
      params.settings.canvasBackground,
      params.settings.translucentBackgroundOpacity,
      params.showWorkspacePickerTab,
      params.sidebarCollapsed,
      params.sidebarWidth,
      params.theme,
      params.workspace,
      params.workspaces,
    ],
  )
}

/** Prefer grouped metrics when adding new consumers. */
export function useShellLayoutMetricsGrouped(params: UseShellLayoutMetricsParams): ShellLayoutMetricsGrouped {
  return useMemo(
    () => computeShellLayoutMetricsGrouped(params),
    [
      params.appFonts.size,
      params.openWorkspaceIds,
      params.panelLayout,
      params.settings.canvasBackground,
      params.settings.translucentBackgroundOpacity,
      params.showWorkspacePickerTab,
      params.sidebarCollapsed,
      params.sidebarWidth,
      params.theme,
      params.workspace,
      params.workspaces,
    ],
  )
}
