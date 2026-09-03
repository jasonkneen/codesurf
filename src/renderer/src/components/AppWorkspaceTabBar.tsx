import React from 'react'
import { Plus, Package } from 'lucide-react'
import type { Workspace } from '../../../shared/types'
import type { AppTheme } from '../theme'

function WorkspaceTabIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return <Package size={size} strokeWidth={2} aria-hidden="true" />
}

function WorkspaceTabLabel({ children, active }: { children: string, active: boolean }): React.JSX.Element {
  const sharedStyle: React.CSSProperties = {
    gridArea: '1 / 1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  }

  return (
    <span
      style={{
        display: 'grid',
        alignItems: 'center',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
        lineHeight: 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          ...sharedStyle,
          visibility: 'hidden',
          fontWeight: 700,
        }}
      >
        {children}
      </span>
      <span
        style={{
          ...sharedStyle,
          fontWeight: active ? 700 : 400,
        }}
      >
        {children}
      </span>
    </span>
  )
}

export type AppWorkspaceTabBarProps = {
  theme: AppTheme
  sidebarCollapsed: boolean
  sidebarWidth: number
  sidebarResizing: boolean
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  workspaceTabsMinimumLeft: number
  collapsedSidebarPillSize: number
  sidebarToggleLeft: number
  sidebarToggleTop: number
  openWorkspaceTabs: Workspace[]
  hasWorkspaceTabs: boolean
  workspace: Workspace | null
  workspaceTitleFallback: string
  showTopWorkspacePickerTab: boolean
  workspaceTabMaxWidth: string
  workspaceTabActiveHeight: number
  workspaceTabInactiveHeight: number
  workspaceTabActiveBottomGap: number
  workspaceTabInactiveBottomGap: number
  workspaceTabBackground: string
  workspaceTabInactiveBackground: string
  workspaceTabInactiveHoverBackground: string
  workspaceTabCloseHoverBackground: string
  workspaceTabLabelSize: number
  workspaceTabTextOffset: number
  workspaceTabInactiveTextOffset: number
  selectedTabDropShadow: string
  onSwitchWorkspace: (id: string) => void | Promise<void>
  onCloseWorkspaceTab: (id: string) => void | Promise<void>
  onNewWorkspaceTab: (options: { preserveOpenTabs: boolean }) => void
  onCloseWorkspacePickerTab: (fallbackWorkspaceId: string | null) => void
  workspacePickerReturnWorkspaceId: string | null
}

export function AppWorkspaceTabBar(props: AppWorkspaceTabBarProps): JSX.Element {
  const {
    theme,
    sidebarCollapsed,
    sidebarWidth,
    sidebarResizing,
    setSidebarCollapsed,
    workspaceTabsMinimumLeft,
    collapsedSidebarPillSize,
    sidebarToggleLeft,
    sidebarToggleTop,
    openWorkspaceTabs,
    hasWorkspaceTabs,
    workspace,
    workspaceTitleFallback,
    showTopWorkspacePickerTab,
    workspaceTabMaxWidth,
    workspaceTabActiveHeight,
    workspaceTabInactiveHeight,
    workspaceTabActiveBottomGap,
    workspaceTabInactiveBottomGap,
    workspaceTabBackground,
    workspaceTabInactiveBackground,
    workspaceTabInactiveHoverBackground,
    workspaceTabCloseHoverBackground,
    workspaceTabLabelSize,
    workspaceTabTextOffset,
    workspaceTabInactiveTextOffset,
    selectedTabDropShadow,
    onSwitchWorkspace,
    onCloseWorkspaceTab,
    onNewWorkspaceTab,
    onCloseWorkspacePickerTab,
    workspacePickerReturnWorkspaceId,
  } = props

  return (
      <div
        className="flex items-center flex-shrink-0"
        style={{
          height: 38,            
          WebkitAppRegion: 'drag',
          paddingLeft: sidebarCollapsed ? workspaceTabsMinimumLeft : Math.max(sidebarWidth + 4, workspaceTabsMinimumLeft),
          transition: 'padding-left 0.15s ease',
          position: 'relative',
          zIndex: 90,
          paddingTop: 2,
        }}
      >
        <button
          type="button"
          title={sidebarCollapsed ? 'Open sidebar' : 'Collapse sidebar'}
          aria-label={sidebarCollapsed ? 'Open sidebar' : 'Collapse sidebar'}
          aria-pressed={!sidebarCollapsed}
          data-no-drag=""
          onMouseDown={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDown={event => {
            event.preventDefault()
            event.stopPropagation()
            setSidebarCollapsed(p => !p)
          }}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
          style={{
            position: 'fixed',
            top: sidebarToggleTop,
            left: sidebarToggleLeft,
            zIndex: 2147483647,
            width: collapsedSidebarPillSize,
            height: collapsedSidebarPillSize,
            // Tahoe toolbar control: the old hover state is now the
            // resting state so it reads as an actual button next to the
            // traffic lights instead of disappearing into vibrancy.
            borderRadius: '50%',
            border: '0.5px solid transparent',
            // Glass overlay anchored on text.primary so it reads as a
            // light tint over a dark surface (and a near-paper tint over
            // a light surface). Both modes look right and the contrast
            // slider tracks because text.primary tracks.
            background: `color-mix(in srgb, ${theme.text.primary} 10%, transparent)`,
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            boxShadow: 'var(--cs-edge-shadow-strong)',
            color: theme.text.primary,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: sidebarResizing ? 0.35 : 1,
            pointerEvents: 'auto',
            WebkitAppRegion: 'no-drag',
            transition: 'background 0.12s ease, color 0.12s ease, opacity 0.12s ease, transform 0.12s ease',
          } as React.CSSProperties}
          onMouseEnter={event => {
            event.currentTarget.style.background = `color-mix(in srgb, ${theme.text.primary} 16%, transparent)`
            event.currentTarget.style.color = theme.text.primary
            event.currentTarget.style.transform = 'scale(1.03)'
          }}
          onMouseLeave={event => {
            event.currentTarget.style.background = `color-mix(in srgb, ${theme.text.primary} 10%, transparent)`
            event.currentTarget.style.color = theme.text.primary
            event.currentTarget.style.transform = 'scale(1)'
          }}
        >
          {/* Tahoe-style sidebar toggle: outlined rounded rectangle with a
              filled left column. Mirrors macOS's `sidebar.leading` SF
              Symbol (which lucide doesn't ship — its PanelLeft variants
              use only an outline divider, which read as visually identical
              to one another at 17px). */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 20 20"
            aria-hidden="true"
            style={{ transform: sidebarCollapsed ? 'scaleX(-1)' : 'none' }}
          >
            <rect x="2.5" y="3.5" width="15" height="13" rx="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="2.5" y="3.5" width="5.5" height="13" rx="2.6" fill="currentColor" />
          </svg>
        </button>
    
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 8,
            minWidth: 0,
            height: '100%',
            paddingLeft: 8,
            WebkitAppRegion: 'no-drag',
          }}
        >
          {hasWorkspaceTabs ? openWorkspaceTabs.map(ws => {
            const isActive = ws.id === workspace?.id
            return (
              <div
                key={ws.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  maxWidth: workspaceTabMaxWidth,
                  minWidth: 0,
                  height: isActive ? workspaceTabActiveHeight : workspaceTabInactiveHeight,
                  padding: '0 8px 0 10px',
                  gap: 5,
                  marginBottom: isActive ? workspaceTabActiveBottomGap : workspaceTabInactiveBottomGap,
                  borderRadius: 8,
                  background: isActive
                    ? (theme.mode === 'light' ? `color-mix(in srgb, ${theme.surface.app} 86%, transparent)` : workspaceTabBackground)
                    : workspaceTabInactiveBackground,
                  color: isActive ? theme.text.primary : theme.text.secondary,
                  transition: 'color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease',
                  border: '0.5px solid transparent',
                  boxShadow: isActive
                    ? (theme.mode === 'light'
                        // Match the non-selected tab's bright white "paper
                        // edge" inset (--cs-edge-shadow-strong already has
                        // it at 0.92 alpha in light mode); add a darker
                        // outer hairline + drop shadow for elevation.
                        ? `var(--cs-edge-shadow-strong), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent), ${selectedTabDropShadow}`
                        : `var(--cs-edge-shadow-strong), ${selectedTabDropShadow}`)
                    : 'var(--cs-edge-shadow)',
                  boxSizing: 'border-box',
                  position: 'relative',
                  zIndex: isActive ? 1 : 0,
                }}
                onMouseEnter={e => {
                  if (!isActive) e.currentTarget.style.background = workspaceTabInactiveHoverBackground
                }}
                onMouseLeave={e => {
                  if (!isActive) e.currentTarget.style.background = workspaceTabInactiveBackground
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (!isActive) void onSwitchWorkspace(ws.id)
                  }}
                  title={ws.name}
                  aria-current={isActive ? 'page' : undefined}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    flex: 1,
                    minWidth: 0,
                    height: 20,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    fontSize: Math.max(11, workspaceTabLabelSize),
                    fontWeight: 400,
                    lineHeight: 1,
                    letterSpacing: 0,
                    cursor: isActive ? 'default' : 'pointer',
                    transform: `translateY(${isActive ? workspaceTabTextOffset : workspaceTabInactiveTextOffset}px)`,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, lineHeight: 0, color: 'currentColor', flexShrink: 0 }}>
                    <WorkspaceTabIcon size={12} />
                  </span>
                  <WorkspaceTabLabel active={isActive}>{ws.name}</WorkspaceTabLabel>
                </button>
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    void onCloseWorkspaceTab(ws.id)
                  }}
                  aria-label={`Close ${ws.name}`}
                  title={`Close ${ws.name}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    border: 'none',
                    borderRadius: 4,
                    background: 'transparent',
                    color: 'currentColor',
                    cursor: 'pointer',
                    flexShrink: 0,
                    padding: 0,
                    transform: `translateY(${isActive ? workspaceTabTextOffset : workspaceTabInactiveTextOffset}px)`,
                    transition: 'background 0.12s ease, color 0.12s ease',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = workspaceTabCloseHoverBackground
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = 'currentColor'
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: 'block' }}>
                    <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            )
          }) : !showTopWorkspacePickerTab ? (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                maxWidth: workspaceTabMaxWidth,
                minWidth: 0,
                height: workspaceTabActiveHeight,
                padding: '0 8px 0 10px',
                gap: 5,
                marginBottom: workspaceTabActiveBottomGap,
                borderRadius: 8,
                background: theme.mode === 'light' ? `color-mix(in srgb, ${theme.surface.app} 86%, transparent)` : workspaceTabBackground,
                color: theme.text.primary,
                fontSize: Math.max(11, workspaceTabLabelSize),
                fontWeight: 700,
                lineHeight: 1,
                letterSpacing: 0,
                border: '0.5px solid transparent',
                boxShadow: theme.mode === 'light'
                  ? `inset 0 0 0 0.5px color-mix(in srgb, ${theme.surface.app} 92%, transparent), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent), ${selectedTabDropShadow}`
                  : `var(--cs-edge-shadow-strong), ${selectedTabDropShadow}`,
                boxSizing: 'border-box',
                position: 'relative',
                zIndex: 1,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, lineHeight: 0, color: 'currentColor', flexShrink: 0 }}>
                <WorkspaceTabIcon size={12} />
              </span>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  lineHeight: 1,
                  transform: 'translateY(-1px)',
                }}
              >
                {workspaceTitleFallback}
              </span>
            </div>
          ) : null}
    
          {showTopWorkspacePickerTab && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                maxWidth: workspaceTabMaxWidth,
                minWidth: 0,
                height: workspaceTabActiveHeight,
                padding: '0 10px',
                gap: 5,
                marginBottom: workspaceTabActiveBottomGap,
                borderRadius: 8,
                background: theme.mode === 'light' ? `color-mix(in srgb, ${theme.surface.app} 86%, transparent)` : workspaceTabBackground,
                color: theme.text.primary,
                border: '0.5px solid transparent',
                boxShadow: theme.mode === 'light'
                  ? `inset 0 0 0 0.5px color-mix(in srgb, ${theme.surface.app} 92%, transparent), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent), ${selectedTabDropShadow}`
                  : `var(--cs-edge-shadow-strong), ${selectedTabDropShadow}`,
                boxSizing: 'border-box',
                position: 'relative',
                zIndex: 1,
              }}
            >
              <button
                type="button"
                onClick={() => onNewWorkspaceTab({ preserveOpenTabs: openWorkspaceTabs.length > 0 })}
                aria-current="page"
                title="New workspace"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  flex: 1,
                  minWidth: 0,
                  height: 20,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: Math.max(11, workspaceTabLabelSize),
                  fontWeight: 400,
                  lineHeight: 1,
                  letterSpacing: 0,
                  cursor: 'default',
                  transform: `translateY(${workspaceTabTextOffset}px)`,
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, lineHeight: 0, color: 'currentColor', flexShrink: 0 }}>
                  <Plus size={12} strokeWidth={2.1} />
                </span>
                <WorkspaceTabLabel active>Workspace</WorkspaceTabLabel>
              </button>
              {openWorkspaceTabs.length > 0 && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    onCloseWorkspacePickerTab(
                      workspacePickerReturnWorkspaceId
                        ?? workspace?.id
                        ?? openWorkspaceTabs[openWorkspaceTabs.length - 1]?.id
                        ?? null,
                    )
                  }}
                  aria-label="Close new workspace tab"
                  title="Close new workspace tab"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 16,
                    height: 16,
                    border: 'none',
                    borderRadius: 4,
                    background: 'transparent',
                    color: 'currentColor',
                    cursor: 'pointer',
                    flexShrink: 0,
                    padding: 0,
                    transition: 'background 0.12s ease, color 0.12s ease',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = workspaceTabCloseHoverBackground
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = 'currentColor'
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: 'block', transform: 'translateY(-0.5px)' }}>
                    <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          )}
    
          <button
            type="button"
            onClick={() => onNewWorkspaceTab({ preserveOpenTabs: true })}
            aria-label="New workspace"
            title="New workspace"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              marginBottom: workspaceTabInactiveBottomGap,
              padding: 0,
              border: '0.5px solid transparent',
              borderRadius: '50%',
              background: workspaceTabInactiveBackground,
              boxShadow: 'var(--cs-edge-shadow)',
              color: theme.text.muted,
              cursor: 'pointer',
              transition: 'background 0.12s ease, color 0.12s ease, transform 0.12s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = workspaceTabInactiveHoverBackground
              e.currentTarget.style.color = theme.text.primary
              e.currentTarget.style.transform = 'scale(1.03)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = workspaceTabInactiveBackground
              e.currentTarget.style.color = theme.text.muted
              e.currentTarget.style.transform = 'scale(1)'
            }}
          >
            <Plus size={13} strokeWidth={2.2} />
          </button>
        </div>
      </div>
  )
}
