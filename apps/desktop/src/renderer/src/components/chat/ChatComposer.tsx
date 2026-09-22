import React from 'react'
import { FileText, Folder, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import { stackEdgeShadow, type EdgeShadowTone } from '../../theme'
import { basename } from '../../utils/dnd'
import type { Persona, ExecutionHostRecord } from '../../../../shared/types'
import type { TtsPlayerState } from '../../utils/ttsPlayer'
import { FooterPill } from './ChatComposerControls'
import { Dropdown, DropdownItem, MenuPortal } from './ChatComposerMenus'
import { getAgentIcon } from '../../config/agentModes'
import { PersonaAvatar } from '../PersonaAvatar'

export interface ChatComposerAutocompleteItem {
  key: string
  value: string
  description: string
  attachPath?: string
  priority?: number
}

export interface ChatComposerAttachment {
  path: string
  kind: 'image' | 'file'
}

export interface ChatComposerBranch {
  name: string
  current: boolean
}

export interface ChatComposerModeOption {
  id: string
  label: string
  description?: string
  color?: string
}

export interface ChatComposerSurface {
  extId: string
  surfaceId: string
  label: string
  icon?: string
  instanceId: string
  entryUrl: string
  height: number
}

export function ChatComposerWrap({
  style,
  children,
}: {
  style?: React.CSSProperties
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="cs-chat-composer-wrap" style={style}>
      {children}
    </div>
  )
}

export function ChatComposerCard({
  style,
  children,
  edgeTone = 'default',
}: {
  style?: React.CSSProperties
  children: React.ReactNode
  /** Hairline ring. One stroke only — callers must not also set a 0.5px border. */
  edgeTone?: EdgeShadowTone
}): JSX.Element {
  const theme = useTheme()
  const { boxShadow, ...restStyle } = style ?? {}

  return (
    <div className="cs-chat-composer-card" style={{ ...restStyle, boxShadow: stackEdgeShadow(theme, boxShadow as string | undefined, edgeTone) }}>
      {children}
    </div>
  )
}

export function ChatComposerPrimaryToolbar({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="cs-chat-composer-primary-toolbar" style={{
      display: 'flex',
      alignItems: 'center',
      padding: '4px 8px 4px 8px',
      gap: 2,
    }}>
      {children}
    </div>
  )
}

export function ChatComposerSecondaryToolbar({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="cs-chat-composer-secondary-toolbar" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      padding: '0 8px',
    }}>
      {children}
    </div>
  )
}

export function ChatComposerInput({
  textareaRef,
  value,
  placeholder,
  fontSize,
  fontFamily,
  lineHeight,
  minHeight,
  textColor,
  onChange,
  onKeyDown,
  onKeyUp,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  placeholder: string
  fontSize: React.CSSProperties['fontSize']
  fontFamily: string
  lineHeight: React.CSSProperties['lineHeight']
  minHeight: React.CSSProperties['minHeight']
  textColor: string
  onChange: React.ChangeEventHandler<HTMLTextAreaElement>
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>
  onKeyUp: React.KeyboardEventHandler<HTMLTextAreaElement>
}): JSX.Element {
  return (
    <textarea
      ref={textareaRef}
      className="cs-chat-composer-input"
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      placeholder={placeholder}
      rows={1}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        flex: 1,
        background: 'transparent',
        color: textColor,
        border: 'none',
        padding: '10px 14px 2px 14px',
        fontSize,
        fontFamily,
        lineHeight,
        resize: 'none',
        outline: 'none',
        overflow: 'hidden',
        minHeight,
        opacity: 1,
      }}
    />
  )
}

export function ChatComposerDrawerFrame({
  children,
  joinedToPrevious = false,
  collapsed = false,
  style,
}: {
  children: React.ReactNode
  joinedToPrevious?: boolean
  collapsed?: boolean
  style?: React.CSSProperties
}): JSX.Element {
  const theme = useTheme()

  return (
    <div
      className={`cs-chat-composer-drawer${joinedToPrevious ? ' cs-chat-composer-drawer-joined' : ''}${collapsed ? ' cs-chat-composer-drawer-collapsed' : ''}`}
      style={{
        flexShrink: 0,
        border: `0.5px solid ${theme.chat.divider}`,
        borderTop: joinedToPrevious ? 'none' : `0.5px solid ${theme.chat.divider}`,
        borderBottom: 'none',
        borderRadius: joinedToPrevious ? 0 : '16px 16px 0 0',
        background: collapsed ? theme.chat.background : theme.surface.panelMuted,
        boxShadow: collapsed ? 'none' : `${theme.shadow.panel}, inset 0 1px color-mix(in srgb, ${theme.text.primary} 4%, transparent)`,
        overflow: 'hidden',
        position: 'relative',
        zIndex: 0,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function LocalProjectIcon({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2" width="11" height="8.5" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.2 11.4h5.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function CloudProjectIcon({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M4.4 11.2h5.2a2.2 2.2 0 000-4.4 3.1 3.1 0 00-6-.6A2.2 2.2 0 004.4 11.2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

export function ChatComposerLocationMenu({
  anchorRef,
  showMenu,
  executionTarget,
  locationLabel,
  localExecutionLabel,
  normalizedRepoRoot,
  remoteHosts,
  activeCloudHost,
  fontSans,
  onToggleMenu,
  onSelectLocal,
  onSelectCloud,
  onSelectRemoteHost,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>
  showMenu: boolean
  executionTarget: 'local' | 'cloud'
  locationLabel: string
  localExecutionLabel: string
  normalizedRepoRoot: string
  remoteHosts: ExecutionHostRecord[]
  activeCloudHost: ExecutionHostRecord | null
  fontSans: string
  onToggleMenu: () => void
  onSelectLocal: () => void
  onSelectCloud: () => void
  onSelectRemoteHost: (hostId: string) => void
}): JSX.Element {
  const theme = useTheme()

  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <FooterPill
        prefix={executionTarget === 'local' ? <LocalProjectIcon /> : <CloudProjectIcon />}
        label={locationLabel}
        color={theme.chat.muted}
        active={showMenu}
        onClick={onToggleMenu}
      />
      {showMenu && (
        <MenuPortal anchorRef={anchorRef}>
          <Dropdown>
            <div style={{ padding: '8px 10px 6px', fontSize: 11, color: theme.chat.muted, fontFamily: fontSans }}>
              Continue in
            </div>
            <DropdownItem
              icon={<LocalProjectIcon size={11} />}
              label={localExecutionLabel}
              sublabel={normalizedRepoRoot || undefined}
              active={executionTarget === 'local'}
              onClick={onSelectLocal}
            />
            <DropdownItem
              icon={<CloudProjectIcon size={11} />}
              label="Cloud"
              active={executionTarget === 'cloud'}
              sublabel={activeCloudHost?.label ?? (remoteHosts.length > 0 ? undefined : 'No remote daemon configured')}
              onClick={onSelectCloud}
            />
            {remoteHosts.length > 0 && (
              <>
                <div style={{ height: 1, background: theme.chat.dropdownBorder, margin: '4px 0' }} />
                <div style={{ padding: '8px 10px 6px', fontSize: 11, color: theme.chat.muted, fontFamily: fontSans }}>
                  Remote daemons
                </div>
                {remoteHosts.map(host => (
                  <DropdownItem
                    key={host.id}
                    icon={<CloudProjectIcon size={11} />}
                    label={host.label}
                    sublabel={host.url ?? undefined}
                    active={executionTarget === 'cloud' && activeCloudHost?.id === host.id}
                    onClick={() => onSelectRemoteHost(host.id)}
                  />
                ))}
              </>
            )}
            <div style={{ height: 1, background: theme.chat.dropdownBorder, margin: '4px 0' }} />
            <div style={{ padding: '8px 10px', fontSize: 11, color: theme.chat.muted, fontFamily: fontSans }}>
              Rate limits remaining
            </div>
          </Dropdown>
        </MenuPortal>
      )}
    </div>
  )
}

function BranchIcon({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <circle cx="4" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="10" cy="6.8" r="1.2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="4" cy="11" r="1.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 3.8v5.9c0 .6.4 1 1 1h1.9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 4.1h1.8c.7 0 1.2.5 1.2 1.2v.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ChatComposerBranchMenu({
  anchorRef,
  showMenu,
  isGitRepo,
  branches,
  branchFilter,
  branchCreateEnabled,
  currentBranchLabel,
  projectFolderName,
  normalizedRepoRoot,
  changedCount,
  fontSans,
  nonSelectableStyle,
  onToggleMenu,
  onBranchFilterChange,
  onSelectBranch,
  onCreateBranch,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>
  showMenu: boolean
  isGitRepo: boolean
  branches: ChatComposerBranch[]
  branchFilter: string
  branchCreateEnabled: boolean
  currentBranchLabel: string
  projectFolderName: string
  normalizedRepoRoot: string
  changedCount: number
  fontSans: string
  nonSelectableStyle: React.CSSProperties
  onToggleMenu: () => void
  onBranchFilterChange: (nextFilter: string) => void
  onSelectBranch: (branchName: string) => void | Promise<void>
  onCreateBranch: () => void | Promise<void>
}): JSX.Element {
  const theme = useTheme()

  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <FooterPill
        prefix={<BranchIcon />}
        label={isGitRepo ? currentBranchLabel : projectFolderName}
        color={theme.chat.muted}
        active={showMenu}
        onClick={onToggleMenu}
      />
      {showMenu && (
        <MenuPortal anchorRef={anchorRef}>
          <div style={{
            minWidth: 260,
            maxWidth: 320,
            background: theme.chat.dropdownBackground,
            border: `1px solid ${theme.chat.dropdownBorder}`,
            borderRadius: 8,
            padding: 4,
            boxShadow: theme.shadow.panel,
            ...nonSelectableStyle,
          }}>
            <div style={{ padding: '4px 4px 6px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 6,
                background: theme.surface.panelMuted,
              }}>
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                  <circle cx="6" cy="6" r="4.2" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M9.8 9.8 12 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  value={branchFilter}
                  onChange={event => onBranchFilterChange(event.target.value)}
                  placeholder="Search branches"
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: theme.chat.text,
                    fontSize: 12,
                    fontFamily: fontSans,
                  }}
                  onKeyDown={event => {
                    event.stopPropagation()
                    if (event.key === 'Enter' && branchCreateEnabled) {
                      event.preventDefault()
                      void onCreateBranch()
                    }
                  }}
                />
              </div>
            </div>
            <div style={{ padding: '2px 10px 6px' }}>
              <div style={{ fontSize: 11, color: theme.chat.text, fontFamily: fontSans, fontWeight: 600 }}>
                {projectFolderName}
              </div>
              <div style={{ fontSize: 10, color: theme.chat.muted, fontFamily: fontSans, lineHeight: 1.4 }}>
                {normalizedRepoRoot}
              </div>
            </div>
            <div style={{ padding: '4px 10px 6px', fontSize: 11, color: theme.chat.muted, fontFamily: fontSans }}>
              Branches
            </div>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {isGitRepo ? branches.map(branch => (
                <DropdownItem
                  key={branch.name}
                  icon={<BranchIcon size={11} />}
                  label={branch.name}
                  sublabel={branch.current && changedCount > 0 ? `Uncommitted: ${changedCount} file${changedCount === 1 ? '' : 's'}` : undefined}
                  active={branch.current}
                  onClick={() => { if (!branch.current) void onSelectBranch(branch.name) }}
                />
              )) : (
                <div style={{ padding: '8px 10px', fontSize: 11, color: theme.chat.muted, fontFamily: fontSans }}>
                  Git metadata is not available for this workspace yet.
                </div>
              )}
              {isGitRepo && branches.length === 0 && (
                <div style={{ padding: '8px 10px', fontSize: 11, color: theme.chat.muted, fontFamily: fontSans }}>
                  No matching branches
                </div>
              )}
            </div>
            <div style={{ height: 1, background: theme.chat.dropdownBorder, margin: '4px 0' }} />
            <button
              type="button"
              onClick={() => { void onCreateBranch() }}
              disabled={!branchCreateEnabled}
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                color: branchCreateEnabled ? theme.chat.text : theme.chat.muted,
                borderRadius: 8,
                padding: '9px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: branchCreateEnabled ? 'pointer' : 'default',
                textAlign: 'left',
                opacity: branchCreateEnabled ? 1 : 0.5,
                ...nonSelectableStyle,
              }}
              onMouseEnter={event => { if (branchCreateEnabled) event.currentTarget.style.background = theme.chat.dropdownHoverBackground }}
              onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
            >
              <Plus size={14} />
              <span style={{ fontSize: 12, fontFamily: fontSans }}>
                Create and checkout new branch...
              </span>
            </button>
          </div>
        </MenuPortal>
      )}
    </div>
  )
}

export function ChatComposerAutocompletePopup({
  popupRef,
  autocompleteType,
  query,
  items,
  activeIndex,
  fontSans,
  fontMono,
  onHoverIndex,
  onSelect,
}: {
  popupRef: React.RefObject<HTMLDivElement | null>
  autocompleteType: 'slash' | 'mention' | null
  query: string
  items: ChatComposerAutocompleteItem[]
  activeIndex: number
  fontSans: string
  fontMono: string
  onHoverIndex: (index: number) => void
  onSelect: (item: ChatComposerAutocompleteItem) => void
}): JSX.Element | null {
  const theme = useTheme()

  if (!autocompleteType || items.length === 0) return null

  return (
    <div
      ref={popupRef}
      style={{
        position: 'absolute', bottom: '100%', left: 0, right: 0,
        marginBottom: 4,
        background: theme.chat.dropdownBackground, border: `1px solid ${theme.chat.dropdownBorder}`,
        borderRadius: 8, padding: 4,
        boxShadow: theme.shadow.panel,
        zIndex: 9999,
        maxHeight: 6 * 36, overflowY: 'auto',
      }}
    >
      {autocompleteType === 'mention' && !query && (
        <div style={{
          padding: '6px 10px', fontSize: 11, color: theme.chat.muted,
          fontFamily: fontMono,
        }}>
          Connected files appear first. Type to search files...
        </div>
      )}
      {items.map((item, index) => (
        <div
          key={item.key}
          onMouseDown={(event) => { event.preventDefault(); onSelect(item) }}
          onMouseEnter={() => onHoverIndex(index)}
          style={{
            padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            background: index === activeIndex ? theme.chat.dropdownActiveBackground : 'transparent',
            transition: 'background 0.1s',
          }}
        >
          <span style={{
            fontSize: 12, color: index === activeIndex ? theme.accent.base : theme.chat.text,
            fontFamily: fontMono, fontWeight: 500,
          }}>
            {item.value}
          </span>
          <span style={{
            fontSize: 11, color: theme.chat.muted, fontFamily: fontSans,
            marginLeft: 'auto',
          }}>
            {item.description}
          </span>
        </div>
      ))}
    </div>
  )
}

export function ChatComposerSurfaceHost({
  surfaces,
  activeSurface,
  fontMono,
  showBuilderEnhance,
  renderSurfaceIcon,
  onActivateSurface,
  onCloseSurface,
  onOpenBuilderFromSketch,
  onSetSurfaceIframeRef,
}: {
  surfaces: ChatComposerSurface[]
  activeSurface: ChatComposerSurface | null
  fontMono: string
  showBuilderEnhance: boolean
  renderSurfaceIcon: (icon: string | undefined, size?: number) => React.ReactNode
  onActivateSurface: (instanceId: string) => void
  onCloseSurface: (instanceId: string) => void
  onOpenBuilderFromSketch: () => void
  onSetSurfaceIframeRef: (instanceId: string, node: HTMLIFrameElement | null) => void
}): JSX.Element | null {
  const theme = useTheme()

  if (surfaces.length === 0 || !activeSurface) return null

  return (
    <div style={{
      padding: '8px 14px 0 14px',
    }}>
      <div style={{
        position: 'relative',
        width: '100%',
        height: activeSurface.height,
        borderRadius: 12,
        border: `1px solid ${theme.chat.dropdownBorder}`,
        background: theme.surface.panelElevated,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          borderBottom: `1px solid ${theme.border.subtle}`,
          background: theme.surface.overlay,
          fontSize: 11,
          fontFamily: fontMono,
          color: theme.chat.muted,
          overflowX: 'auto',
        }}>
          {surfaces.map(surface => {
            const isActive = surface.instanceId === activeSurface.instanceId
            return (
              <div
                key={surface.instanceId}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  borderRadius: 8,
                  border: `1px solid ${isActive ? theme.border.strong : theme.border.subtle}`,
                  background: isActive ? theme.chat.dropdownHoverBackground : 'transparent',
                  color: isActive ? theme.chat.text : theme.chat.muted,
                  flexShrink: 0,
                }}
              >
                <button
                  onClick={() => onActivateSurface(surface.instanceId)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 11,
                    fontFamily: fontMono,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    {renderSurfaceIcon(surface.icon ?? surface.surfaceId, 13)}
                  </span>
                  <span>{surface.label}</span>
                </button>
                <button
                  onClick={() => onCloseSurface(surface.instanceId)}
                  aria-label={`Close ${surface.label}`}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    border: `1px solid ${theme.border.default}`,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    fontSize: 10,
                    lineHeight: 1,
                  }}
                >×</button>
              </div>
            )
          })}
          {showBuilderEnhance && (
            <button
              onClick={onOpenBuilderFromSketch}
              style={{
                border: `1px solid ${theme.border.default}`,
                background: theme.chat.dropdownHoverBackground,
                color: theme.chat.text,
                borderRadius: 8,
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: fontMono,
                flexShrink: 0,
              }}
            >
              Enhance → Builder
            </button>
          )}
        </div>
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {surfaces.map(surface => (
            <iframe
              key={surface.instanceId}
              ref={node => onSetSurfaceIframeRef(surface.instanceId, node)}
              src={surface.entryUrl}
              title={surface.label}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                border: 'none',
                background: 'transparent',
                display: surface.instanceId === activeSurface.instanceId ? 'block' : 'none',
              }}
              sandbox="allow-scripts allow-same-origin"
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function ChatComposerVoiceStatus({
  isDictating,
  dictationText,
  dictationError,
  ttsState,
  onRetryDictation,
  onDismissDictationError,
  onStopVoicePlayback,
}: {
  isDictating: boolean
  dictationText: string
  dictationError: string | null
  ttsState: TtsPlayerState
  onRetryDictation?: () => void
  onDismissDictationError?: () => void
  onStopVoicePlayback: () => void
}): JSX.Element | null {
  const theme = useTheme()
  const showDictationStatus = isDictating || Boolean(dictationError)

  if (!showDictationStatus && !ttsState.isPlaying) return null

  return (
    <>
      {showDictationStatus && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 14px 0 14px', fontSize: 11,
          color: dictationError ? theme.status.warning : theme.status.danger,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: dictationError ? theme.status.warning : theme.status.danger,
            animation: isDictating ? 'chat-pulse 1s ease-in-out infinite' : 'none',
          }} />
          {dictationError ? (
            <>
              <button
                type="button"
                onClick={onRetryDictation}
                onMouseDown={e => e.preventDefault()}
                title="Retry microphone"
                style={{
                  background: 'transparent', border: 'none', padding: 0, margin: 0,
                  cursor: onRetryDictation ? 'pointer' : 'default',
                  color: theme.chat.muted, font: 'inherit', textAlign: 'left',
                }}
              >
                Voice: <span style={{ color: theme.status.warning }}>{dictationError}</span>
              </button>
              {onDismissDictationError && (
                <button
                  type="button"
                  onClick={onDismissDictationError}
                  onMouseDown={e => e.preventDefault()}
                  title="Dismiss"
                  style={{
                    marginLeft: 'auto', background: 'transparent', border: 'none',
                    cursor: 'pointer', padding: 2, display: 'flex',
                    color: theme.chat.subtle,
                  }}
                >
                  <X size={10} strokeWidth={2.2} />
                </button>
              )}
            </>
          ) : (
            <>
              <span>Recording{dictationText ? ': ' : ''}</span>
              {dictationText && <span style={{ color: theme.chat.muted, fontStyle: 'italic' }}>{dictationText}</span>}
            </>
          )}
        </div>
      )}

      {ttsState.isPlaying && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 14px 0 14px', fontSize: 11, color: theme.accent.base,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: theme.accent.base,
            animation: 'chat-pulse 1.4s ease-in-out infinite',
          }} />
          <span>Speaking…</span>
          {ttsState.queueLength > 0 && (
            <span style={{ color: theme.chat.muted, marginLeft: 4 }}>+{ttsState.queueLength} queued</span>
          )}
          <button
            onClick={onStopVoicePlayback}
            onMouseDown={e => e.preventDefault()}
            style={{
              marginLeft: 'auto', background: 'transparent', border: 'none',
              color: theme.chat.muted, cursor: 'pointer', fontSize: 11, padding: '2px 6px',
            }}
            title="Stop voice playback"
          >
            stop
          </button>
        </div>
      )}
    </>
  )
}

export function ChatComposerProjectPathButton({
  title,
  disabled,
  label,
  fontSans,
  onClick,
}: {
  title: string
  disabled: boolean
  label: string
  fontSans: string
  onClick: () => void | Promise<void>
}): JSX.Element {
  const theme = useTheme()

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => { void onClick() }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        color: theme.chat.muted,
        fontSize: 11,
        fontFamily: fontSans,
        lineHeight: 1.2,
        paddingLeft: 2,
        background: 'transparent',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.color = theme.chat.text }}
      onMouseLeave={e => { e.currentTarget.style.color = theme.chat.muted }}
    >
      <Folder size={12} strokeWidth={1.9} style={{ flexShrink: 0 }} />
      <span className="cs-composer-path-label" style={{
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
    </button>
  )
}

export function ChatComposerModeMenu({
  anchorRef,
  showMenu,
  mode,
  currentMode,
  modeOptions,
  onToggleMenu,
  onSelectMode,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>
  showMenu: boolean
  mode: string
  currentMode: ChatComposerModeOption
  modeOptions: ChatComposerModeOption[]
  onToggleMenu: () => void
  onSelectMode: (modeId: string) => void
}): JSX.Element {
  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <FooterPill
        prefix={<ShieldCheck size={13} />}
        label={currentMode.label}
        color={currentMode.color}
        active={showMenu}
        onClick={onToggleMenu}
      />
      {showMenu && (
        <MenuPortal anchorRef={anchorRef}>
          <Dropdown>
            {modeOptions.map(item => (
              <DropdownItem
                key={item.id}
                icon={<ShieldCheck size={11} />}
                label={item.label}
                sublabel={item.description}
                active={mode === item.id}
                onClick={() => onSelectMode(item.id)}
              />
            ))}
          </Dropdown>
        </MenuPortal>
      )}
    </div>
  )
}

export function ChatComposerAgentMenu({
  anchorRef,
  showMenu,
  agentId,
  agentModes,
  onToggleMenu,
  onSelectAgent,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>
  showMenu: boolean
  agentId: string | null
  agentModes: Persona[]
  onToggleMenu: () => void
  onSelectAgent: (agentId: string | null) => void
}): JSX.Element {
  const selected = agentModes.find(a => a.id === agentId) ?? null
  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <FooterPill
        prefix={selected ? <PersonaAvatar persona={selected} size={16} /> : getAgentIcon(undefined)}
        label={selected ? selected.name : 'Persona'}
        color={selected?.color ?? '#8f96a0'}
        active={showMenu}
        onClick={onToggleMenu}
      />
      {showMenu && (
        <MenuPortal anchorRef={anchorRef}>
          <Dropdown>
            <DropdownItem
              label="None"
              sublabel="No persona"
              active={!agentId}
              onClick={() => onSelectAgent(null)}
            />
            {agentModes.map(item => (
              <DropdownItem
                key={item.id}
                icon={<PersonaAvatar persona={item} size={16} />}
                label={item.name}
                sublabel={item.description}
                active={agentId === item.id}
                onClick={() => onSelectAgent(item.id)}
              />
            ))}
          </Dropdown>
        </MenuPortal>
      )}
    </div>
  )
}

export function ChatComposerContextUsageDial({
  anchorRef,
  showMenu,
  contextUsageRatio,
  contextUsagePercent,
  estimatedContextTokens,
  contextWindowLimit,
  systemOverheadTokens,
  composerBackground,
  fontSans,
  nonSelectableStyle,
  onToggleMenu,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>
  showMenu: boolean
  contextUsageRatio: number
  contextUsagePercent: number
  estimatedContextTokens: number
  contextWindowLimit: number
  systemOverheadTokens: number
  composerBackground: string
  fontSans: string
  nonSelectableStyle: React.CSSProperties
  onToggleMenu: () => void
}): JSX.Element {
  const theme = useTheme()

  return (
    <div ref={anchorRef} style={{ position: 'relative', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <button
        type="button"
        title="Context window"
        onClick={onToggleMenu}
        style={{
          width: 18,
          height: 18,
          minWidth: 18,
          borderRadius: '50%',
          border: 'none',
          background: `conic-gradient(${theme.chat.text} ${contextUsageRatio * 360}deg, ${theme.border.strong} 0deg)`,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          ...nonSelectableStyle,
        }}
      >
        <span style={{
          width: 13,
          height: 13,
          borderRadius: '50%',
          background: composerBackground,
          border: `0.5px solid ${theme.border.default}`,
          display: 'block',
        }} />
      </button>
      {showMenu && (
        <MenuPortal anchorRef={anchorRef}>
          <div style={{
            minWidth: 220,
            background: theme.chat.dropdownBackground,
            border: `1px solid ${theme.chat.dropdownBorder}`,
            borderRadius: 16,
            padding: '14px 16px',
            boxShadow: theme.shadow.panel,
            textAlign: 'center',
            ...nonSelectableStyle,
          }}>
            <div style={{ fontSize: 12, color: theme.chat.muted, fontFamily: fontSans, marginBottom: 6 }}>
              Context window:
            </div>
            <div style={{ fontSize: 13, color: theme.chat.text, fontFamily: fontSans, fontWeight: 600, marginBottom: 4 }}>
              {contextUsagePercent}% full
            </div>
            <div style={{ fontSize: 12, color: theme.chat.textSecondary, fontFamily: fontSans, marginBottom: 10 }}>
              {estimatedContextTokens.toLocaleString()} / {contextWindowLimit.toLocaleString()} tokens used
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.5, color: theme.chat.muted, fontFamily: fontSans, marginBottom: 8 }}>
              Includes ~{systemOverheadTokens.toLocaleString()} tokens of system&nbsp;prompt&nbsp;+&nbsp;tool&nbsp;schemas.
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.5, color: theme.chat.muted, fontFamily: fontSans }}>
              CodeSurf automatically compacts its context.
            </div>
          </div>
        </MenuPortal>
      )}
    </div>
  )
}

export function ChatComposerAttachments({
  attachments,
  fontMono,
  onRemoveAttachment,
}: {
  attachments: ChatComposerAttachment[]
  fontMono: string
  onRemoveAttachment: (path: string) => void
}): JSX.Element | null {
  const theme = useTheme()

  if (attachments.length === 0) return null

  return (
    <div style={{
      display: 'block', gap: 8, padding: '8px 14px 4px 14px',
      overflowX: 'auto',
    }}>
      {attachments.map(item => (
        <div
          key={item.path}
          title={item.path}
          style={{
            flexShrink: 0,
            maxWidth: 180,
            height: 54,
            borderRadius: 12,
            border: `1px solid ${theme.chat.dropdownBorder}`,
            background: theme.surface.panelElevated,
            overflow: 'hidden',
            position: 'relative',
            display: 'flex',
            alignItems: 'stretch',
          }}
        >
          <div style={{
            width: 36, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: theme.chat.muted, borderRight: `1px solid ${theme.border.subtle}`, fontSize: 15,
          }}>
            <FileText size={13} />
          </div>
          <div style={{
            minWidth: 0,
            padding: '8px 26px 8px 10px',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
          }}>
            <div style={{ fontSize: 11, color: theme.chat.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{basename(item.path)}</div>
            <div style={{ fontSize: 9, color: theme.chat.muted, fontFamily: fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.kind === 'image' ? 'image' : 'file'}</div>
          </div>
          <button
            onClick={() => onRemoveAttachment(item.path)}
            style={{
              position: 'absolute', top: 6, right: 6,
              width: 16, height: 16, borderRadius: 8,
              border: `1px solid ${theme.border.default}`, background: theme.surface.overlay,
              color: theme.chat.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0,
            }}
            title="Remove attachment"
          >
            <Trash2 size={9} />
          </button>
        </div>
      ))}
    </div>
  )
}
