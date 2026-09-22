/**
 * Sidebar — workspace/session list shell.
 * Session model + streaming logic lives in ./sidebar/useSidebarController.
 */
import React from 'react'
import { Maximize2, Minimize2, Pencil, Search } from 'lucide-react'
import { ContextMenu } from './ContextMenu'
import { SidebarFooter } from './sidebar/SidebarFooter'
import { SidebarTextDialog } from './sidebar/SidebarTextDialog'
import { SidebarTopItem } from './sidebar/SidebarTopItem'
import { SidebarSearchPalette } from './sidebar/SidebarSearchPalette'
import { SIDEBAR_MENU_WIDTH, SidebarMenuPortal, ThreadMenuItem, ThreadMenuSectionLabel } from './sidebar/ui'
import { RESOURCE_ITEMS } from './sidebar/utils'
import {
  useSidebarController,
  type SidebarControllerProps,
} from './sidebar/useSidebarController'

export type { SidebarControllerProps as SidebarProps }

export function Sidebar(props: SidebarControllerProps): React.JSX.Element {
  const {
    fonts,
    theme,
    widthRef,
    scrollRef,
    searchPaletteOpen,
    setSearchPaletteOpen,
    searchPaletteQuery,
    setSearchPaletteQuery,
    sessionCtx,
    setSessionCtx,
    projectCtx,
    setProjectCtx,
    threadMenuOpen,
    setThreadMenuOpen,
    threadOrganizeMode,
    setThreadOrganizeMode,
    threadSortMode,
    setThreadSortMode,
    showArchivedSessions,
    setShowArchivedSessions,
    showCronSessions,
    setShowCronSessions,
    showSubagentSessions,
    setShowSubagentSessions,
    hiddenSessionAgents,
    setHiddenSessionAgents,
    projectSessionVisibleCounts,
    setProjectSessionVisibleCounts,
    hoveredProjectRow,
    setHoveredProjectRow,
    setVisibleSessionCount,
    selectedProjectId,
    textDialog,
    setTextDialog,
    threadMenuRef,
    openSearchPalette,
    isThreadGroupCollapsed,
    allProjectThreadGroupsCollapsed,
    resizing,
    startX,
    startWidth,
    toggleThreadGroup,
    toggleAllThreadGroups,
    pinnedVisibleSessions,
    normalVisibleSessions,
    availableSessionAgents,
    displayedSessions,
    filteredSessionGroups,
    hasMoreSessions,
    searchPaletteSessions,
    openSessionFromSidebar,
    sessionContextMenuItems,
    handleOpenProjectFromSidebar,
    projectContextMenuItems,
    renderSessionRow,
    PROJECT_SESSION_PREVIEW_COUNT,
    PROJECT_SESSION_SHOW_MORE_COUNT,
    SESSION_PAGE_SIZE,
  } = useSidebarController(props)

  const {
    onNewChat,
    onNewTerminal,
    onNewKanban,
    onNewBrowser,
    onNewFiles,
    onOpenSettings,
    onNewChatForProject,
    extensionTiles,
    extensionEntries,
    onAddExtensionTile,
    collapsed,
    width,
    minWidth: minWidthProp,
    onResizeStateChange,
    showFooter,
  } = props
  const minWidth = minWidthProp ?? 270

    return (
    <div style={{
      width: collapsed ? 0 : Math.max(width, minWidth),
      minWidth: collapsed ? 0 : minWidth,
      height: '100%',
      display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
      transition: 'width 0.15s ease',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      fontFamily: fonts.primary,
      fontSize: fonts.size,
      fontWeight: fonts.weight,
      lineHeight: fonts.lineHeight,
    }}>
      <div
        style={{
          flexShrink: 0,
          zIndex: 2,
          padding: '16px 8px 8px',
          background: 'transparent',
          fontSize: fonts.secondarySize,
          fontWeight: fonts.secondaryWeight,
          lineHeight: fonts.secondaryLineHeight * 0.9,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SidebarTopItem
            label="New Chat"
            icon={<Pencil size={18} strokeWidth={1.9} />}
            onClick={onNewChat}
          />
          <SidebarTopItem
            label="Search"
            icon={<Search size={18} strokeWidth={1.9} />}
            onClick={openSearchPalette}
          />
          {RESOURCE_ITEMS.map(item => (
            <SidebarTopItem
              key={item.id}
              label={item.label}
              icon={item.icon}
              onClick={() => onOpenSettings(item.id)}
            />
          ))}
        </div>
      </div>

      {/* Scrollable sections */}
      <div
        ref={scrollRef}
        className="cs-fade-scroll-y cs-fade-scroll-y-lg"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingTop: 6, paddingBottom: 18, userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <div style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>

        <div style={{ padding: '0 8px 10px', fontSize: fonts.secondarySize, fontWeight: fonts.secondaryWeight, lineHeight: fonts.secondaryLineHeight }}>
          {pinnedVisibleSessions.length > 0 && (
            <div style={{ padding: '0 0 14px' }}>
              <div style={{
                padding: '4px 4px 6px',
                fontSize: fonts.size + 1,
                fontWeight: 700,
                color: theme.text.disabled,
              }}>
                Pinned
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {pinnedVisibleSessions.map(renderSessionRow)}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span style={{
              fontSize: fonts.secondarySize - 2,
              fontWeight: 700,
              color: theme.text.disabled,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}>
              Projects
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }} ref={threadMenuRef}>
              <button
                type="button"
                title={allProjectThreadGroupsCollapsed ? 'Reopen all projects' : 'Collapse all projects'}
                aria-label={allProjectThreadGroupsCollapsed ? 'Reopen all projects' : 'Collapse all projects'}
                onClick={toggleAllThreadGroups}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: 'transparent',
                  color: theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: 0.85,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary; e.currentTarget.style.background = theme.surface.hover }}
                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled; e.currentTarget.style.background = 'transparent' }}
              >
                {allProjectThreadGroupsCollapsed
                  ? <Maximize2 size={16} strokeWidth={1.7} />
                  : <Minimize2 size={16} strokeWidth={1.7} />}
              </button>
              <button
                title="Filter and sort projects and threads"
                aria-label="Filter and sort projects and threads"
                onClick={() => setThreadMenuOpen(open => !open)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: threadMenuOpen ? theme.surface.hover : 'transparent',
                  color: threadMenuOpen ? theme.text.secondary : theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: threadMenuOpen || showArchivedSessions || showCronSessions || showSubagentSessions || Object.values(hiddenSessionAgents).some(Boolean) || threadOrganizeMode !== 'project' || threadSortMode !== 'updated' ? 1 : 0.8,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              <button
                title="Open project folder"
                aria-label="Open project folder"
                onClick={handleOpenProjectFromSidebar}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: 'transparent',
                  color: theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: 0.85,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
              >
                <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
                  <path d="M2.75 5.25c0-1.1.9-2 2-2h2.9l1.6 1.6h4.05c1.1 0 2 .9 2 2v5.95c0 1.1-.9 2-2 2H4.75c-1.1 0-2-.9-2-2v-7.55Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M13.5 2.75v4M11.5 4.75h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                </svg>
              </button>
              {threadMenuOpen && (
                <SidebarMenuPortal anchorRef={threadMenuRef}>
                  <div style={{
                    width: SIDEBAR_MENU_WIDTH,
                    background: theme.surface.panelElevated,
                    border: `1px solid ${theme.border.default}`,
                    borderRadius: 14,
                    boxShadow: theme.shadow.panel,
                    padding: 6,
                  }}>
                  <ThreadMenuSectionLabel>Organize</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 5c0-.83.67-1.5 1.5-1.5h2.5l1.4 1.4H12c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5V5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg>}
                    label="By project"
                    active={threadOrganizeMode === 'project'}
                    onClick={() => setThreadOrganizeMode('project')}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.1" stroke="currentColor" strokeWidth="1.25" /><path d="M8 5.2v3.3l2 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Chronological list"
                    active={threadOrganizeMode === 'chronological'}
                    onClick={() => setThreadOrganizeMode('chronological')}
                  />
                  <div style={{ height: 1, background: theme.border.default, margin: '6px 4px' }} />
                  <ThreadMenuSectionLabel>Sort by</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 12.5V6.2M3.5 6.2l-1.8 1.8M3.5 6.2 5.3 8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /><rect x="7" y="3.25" width="6" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /><rect x="7" y="7" width="4.5" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /><rect x="7" y="10.75" width="3" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /></svg>}
                    label="Updated"
                    active={threadSortMode === 'updated'}
                    onClick={() => setThreadSortMode('updated')}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 4h9M5.5 7h5M6.5 10h4M7.5 13h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>}
                    label="Title"
                    active={threadSortMode === 'title'}
                    onClick={() => setThreadSortMode('title')}
                  />
                  <div style={{ height: 1, background: theme.border.default, margin: '6px 4px' }} />
                  <ThreadMenuSectionLabel>Show</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.25 4.5h9.5v7.25a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V4.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M5.5 2.75h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="M6.25 7.25h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>}
                    label="Archived"
                    active={showArchivedSessions}
                    onClick={() => setShowArchivedSessions(value => !value)}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 5.1h10M3 10.9h10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /><path d="M4.3 5.1v2.2c0 .92.75 1.67 1.67 1.67h1.06c.92 0 1.67.75 1.67 1.67v1" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Sub-threads"
                    active={showSubagentSessions}
                    onClick={() => setShowSubagentSessions(value => !value)}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.1" stroke="currentColor" strokeWidth="1.25" /><path d="M8 5.2v3.3l2 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Cron jobs"
                    active={showCronSessions}
                    onClick={() => setShowCronSessions(value => !value)}
                  />
                  {availableSessionAgents.length > 0 && (
                    <>
                      <div style={{ height: 1, background: theme.border.default, margin: '6px 4px' }} />
                      <ThreadMenuSectionLabel>Agents</ThreadMenuSectionLabel>
                      {availableSessionAgents.map(agent => (
                        <ThreadMenuItem
                          key={agent.key}
                          icon={agent.icon}
                          label={agent.label}
                          active={hiddenSessionAgents[agent.key] !== true}
                          onClick={() => {
                            setHiddenSessionAgents(prev => ({
                              ...prev,
                              [agent.key]: prev[agent.key] === true ? false : true,
                            }))
                          }}
                        />
                      ))}
                    </>
                  )}
                  </div>
                </SidebarMenuPortal>
              )}
              </div>
            </div>
          </div>

          {threadOrganizeMode === 'chronological' && normalVisibleSessions.length === 0 ? (
            <div style={{ padding: '4px 0', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No threads yet</div>
          ) : (
            <>
              {filteredSessionGroups.map(group => {
                const projectSessionVisibleCount = projectSessionVisibleCounts[group.key] ?? PROJECT_SESSION_PREVIEW_COUNT
                const displayedGroupSessions = threadOrganizeMode === 'project'
                  ? group.sessions.slice(0, projectSessionVisibleCount)
                  : group.sessions
                const hiddenProjectSessionCount = threadOrganizeMode === 'project'
                  ? Math.max(0, group.sessions.length - displayedGroupSessions.length)
                  : 0
                const canShowLessProjectSessions = threadOrganizeMode === 'project' && displayedGroupSessions.length > PROJECT_SESSION_PREVIEW_COUNT
                const groupCollapsed = threadOrganizeMode === 'project' && isThreadGroupCollapsed(group)
                const groupSelected = threadOrganizeMode === 'project' && group.projectId === selectedProjectId

                return (
                <div key={group.key} style={{ paddingBottom: 8 }}>
                  {threadOrganizeMode === 'project' && (
                    <div
                      onMouseEnter={() => setHoveredProjectRow(group.key)}
                      onMouseLeave={() => setHoveredProjectRow(curr => curr === group.key ? null : curr)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        width: '100%',
                        padding: '6px 4px 8px 0',
                        color: groupSelected ? theme.text.primary : theme.text.secondary,
                        background: 'transparent',
                        boxShadow: 'none',
                        borderRadius: 8,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => toggleThreadGroup(group.key)}
                        title={`${isThreadGroupCollapsed(group) ? 'Expand' : 'Collapse'} ${group.label}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          flex: 1,
                          minWidth: 0,
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          color: 'inherit',
                          textAlign: 'left',
                          cursor: 'pointer',
                          userSelect: 'none',
                          WebkitUserSelect: 'none',
                        }}
                      >
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 10,
                            color: theme.text.disabled,
                            flexShrink: 0,
                          }}
                        >
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 8 8"
                            style={{
                              transition: 'transform 0.15s ease',
                              transform: groupCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                            }}
                          >
                            <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', color: theme.text.disabled, flexShrink: 0 }}>
                          <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
                            <path d="M1.8 4.1c0-.9.7-1.6 1.6-1.6h2l1.1 1.2h4.1c.9 0 1.6.7 1.6 1.6v4.4c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6V4.1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <span style={{
                          fontSize: fonts.size + 1,
                          fontWeight: 600,
                          color: groupSelected ? theme.text.primary : theme.text.secondary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          flex: 1,
                        }}>
                          {group.label}
                        </span>
                      </button>
                      <button
                        type="button"
                        title={`Project actions: ${group.label}`}
                        onClick={e => {
                          e.stopPropagation()
                          const rect = e.currentTarget.getBoundingClientRect()
                          setProjectCtx({ x: rect.right, y: rect.bottom + 4, group })
                        }}
                        style={{
                          width: 20,
                          height: 20,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'transparent',
                          border: 'none',
                          borderRadius: 5,
                          color: theme.text.disabled,
                          cursor: 'pointer',
                          padding: 0,
                          flexShrink: 0,
                          opacity: hoveredProjectRow === group.key ? 1 : 0,
                          transition: 'opacity 0.1s ease, background 0.1s ease, color 0.1s ease',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = theme.surface.hover; e.currentTarget.style.color = theme.text.primary }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = theme.text.disabled }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <circle cx="3.2" cy="7" r="1.05" fill="currentColor" />
                          <circle cx="7" cy="7" r="1.05" fill="currentColor" />
                          <circle cx="10.8" cy="7" r="1.05" fill="currentColor" />
                        </svg>
                      </button>
                      {onNewChatForProject && (
                        <button
                          type="button"
                          title={`New chat in ${group.label}`}
                          onClick={e => {
                            e.stopPropagation()
                            onNewChatForProject({
                              projectId: group.projectId,
                              projectPath: group.projectPath,
                              workspaceId: group.representativeWorkspaceId,
                            })
                          }}
                          style={{
                            width: 20,
                            height: 20,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'transparent',
                            border: 'none',
                            borderRadius: 5,
                            color: theme.text.disabled,
                            cursor: 'pointer',
                            padding: 0,
                            flexShrink: 0,
                            opacity: hoveredProjectRow === group.key ? 1 : 0,
                            transition: 'opacity 0.1s ease, background 0.1s ease, color 0.1s ease',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = theme.surface.hover; e.currentTarget.style.color = theme.text.primary }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = theme.text.disabled }}
                        >
                          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                            <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}

                  {threadOrganizeMode === 'project' ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateRows: groupCollapsed ? '0fr' : '1fr',
                        opacity: groupCollapsed ? 0 : 1,
                        transition: 'grid-template-rows 180ms ease, opacity 140ms ease',
                      }}
                    >
                      <div style={{ overflow: 'hidden', minHeight: 0 }}>
                        {displayedGroupSessions.map(renderSessionRow)}

                        {(hiddenProjectSessionCount > 0 || canShowLessProjectSessions) && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 12,
                              padding: '4px 0 4px 24px',
                            }}
                          >
                            {hiddenProjectSessionCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setProjectSessionVisibleCounts(prev => ({
                                  ...prev,
                                  [group.key]: Math.min(
                                    group.sessions.length,
                                    (prev[group.key] ?? PROJECT_SESSION_PREVIEW_COUNT) + PROJECT_SESSION_SHOW_MORE_COUNT,
                                  ),
                                }))}
                                style={{
                                  padding: 0,
                                  border: 'none',
                                  background: 'transparent',
                                  color: theme.text.disabled,
                                  cursor: 'pointer',
                                  fontSize: fonts.secondarySize,
                                  fontFamily: 'inherit',
                                  textAlign: 'left',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                              >
                                Show more
                              </button>
                            )}
                            {canShowLessProjectSessions && (
                              <button
                                type="button"
                                onClick={() => setProjectSessionVisibleCounts(prev => {
                                  const next = { ...prev }
                                  delete next[group.key]
                                  return next
                                })}
                                style={{
                                  padding: 0,
                                  border: 'none',
                                  background: 'transparent',
                                  color: theme.text.disabled,
                                  cursor: 'pointer',
                                  fontSize: fonts.secondarySize,
                                  fontFamily: 'inherit',
                                  textAlign: 'left',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                              >
                                Show less
                              </button>
                            )}
                          </div>
                        )}

                        {group.sessions.length === 0 && (
                          <div
                            style={{
                              padding: '0 0 2px 24px',
                              fontSize: fonts.secondarySize,
                              color: theme.text.disabled,
                            }}
                          >
                            No threads yet
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    displayedGroupSessions.map(renderSessionRow)
                  )}

                </div>
                )
              })}

              {hasMoreSessions && (
                <div style={{ padding: '2px 0 0', textAlign: 'center' }}>
                  <button
                    onClick={() => setVisibleSessionCount(count => count + SESSION_PAGE_SIZE)}
                    style={{
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: theme.text.disabled,
                      cursor: 'pointer',
                      fontSize: fonts.secondarySize,
                      fontFamily: 'inherit',
                      textAlign: 'center',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                    onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                  >
                    More ({normalVisibleSessions.length - displayedSessions.length})
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        </div>
      </div>

      {showFooter && (
        <SidebarFooter
          onNewTerminal={onNewTerminal} onNewKanban={onNewKanban} onNewBrowser={onNewBrowser}
          onNewChat={onNewChat} onNewFiles={onNewFiles}
          onOpenSettings={onOpenSettings}
          extensionTiles={extensionTiles}
          extensionEntries={extensionEntries}
          onAddExtensionTile={onAddExtensionTile}
        />
      )}

      {sessionCtx && (
        <ContextMenu x={sessionCtx.x} y={sessionCtx.y} items={sessionContextMenuItems(sessionCtx.session)} onClose={() => setSessionCtx(null)} />
      )}

      {projectCtx && (
        <ContextMenu x={projectCtx.x} y={projectCtx.y} items={projectContextMenuItems(projectCtx.group)} onClose={() => setProjectCtx(null)} />
      )}

      {textDialog && (
        <SidebarTextDialog
          state={textDialog}
          onClose={() => setTextDialog(null)}
        />
      )}

      {searchPaletteOpen && (
        <SidebarSearchPalette
          query={searchPaletteQuery}
          sessions={searchPaletteSessions}
          onQueryChange={setSearchPaletteQuery}
          onOpenSession={openSessionFromSidebar}
          onClose={() => setSearchPaletteOpen(false)}
        />
      )}

      {/* Resize handle */}
      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'col-resize', background: 'transparent' }}
        onMouseDown={e => { resizing.current = true; startX.current = e.clientX; startWidth.current = widthRef.current; onResizeStateChange?.(true); e.preventDefault() }}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      />
    </div>
  )
}

export { SidebarFooter } from './sidebar/SidebarFooter'


