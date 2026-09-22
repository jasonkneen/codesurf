import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowLeft, ArrowRight, Crosshair, Globe, Home, Monitor, RotateCcw, RotateCw, Smartphone } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import { dispatchCreateTile, dispatchOpenChatSurface } from '../utils/appLaunchRequests'
import {
  appendBrowserEvidence,
  createBrowserEvidenceEvent,
  createBrowserEvidenceSnapshot,
  createBrowserPageHealth,
  formatBrowserEvidenceReport,
  summarizeBrowserEvidence,
  type BrowserEvidenceEvent,
  type BrowserEvidenceInput,
  type BrowserEvidenceViewport,
} from '../../../shared/browserEvidence'
import { HOMEPAGE, normalizeUrl } from './browser/webviewManager'
import { ToolbarButton } from './browser/ToolbarButton'
import { BrowserEvidenceDrawer } from './browser/BrowserEvidenceDrawer'
import type { BrowserEvidenceFilter } from './browser/browserEvidenceViewModel'
import {
  useBrowserWebviewLifecycle,
  type BrowserMode,
  type BrowserNavigationState,
} from './browser/useBrowserWebviewLifecycle'




// ---------------------------------------------------------------------------
// ToolbarButton
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface Props {
  tileId: string
  workspaceId?: string
  initialUrl?: string
  width: number
  height: number
  zIndex: number
  isInteracting?: boolean
  isVisible?: boolean
  connectedPeers?: string[]
  hideNavbar?: boolean
}

// ---------------------------------------------------------------------------
// BrowserTile
// ---------------------------------------------------------------------------
export function BrowserTile({ tileId, workspaceId, initialUrl, width, height, zIndex: _zIndex, isInteracting, isVisible = true, connectedPeers = [], hideNavbar = false }: Props): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const browserBackground = theme.surface.panel
  const browserToolbarBackground = theme.surface.titlebar
  const browserBorder = theme.border.default
  const inputRef = useRef<HTMLInputElement>(null)
  const peerRelayUnsubscribeRef = useRef<(() => void) | null>(null)
  const mcpCommandUnsubscribeRef = useRef<(() => void) | null>(null)
  const browserEvidenceRef = useRef<BrowserEvidenceEvent[]>([])

  const initialSrc = useRef(normalizeUrl(initialUrl ?? ''))
  const startUrl = initialSrc.current
  const prevInitialUrl = useRef(startUrl)

  const [addressBar, setAddressBar] = useState(startUrl)
  const [currentUrl, setCurrentUrl] = useState(startUrl)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [mode, setMode] = useState<BrowserMode>('desktop')
  const [isToolbarHovered, setIsToolbarHovered] = useState(false)
  const [isAddressFocused, setIsAddressFocused] = useState(false)
  const [stateLoaded, setStateLoaded] = useState(!workspaceId)
  const [pageTitle, setPageTitle] = useState('')
  const [browserEvidence, setBrowserEvidence] = useState<BrowserEvidenceEvent[]>([])
  const [isEvidenceDrawerOpen, setIsEvidenceDrawerOpen] = useState(false)
  const [evidenceFilter, setEvidenceFilter] = useState<BrowserEvidenceFilter>('issues')
  const [copyStatus, setCopyStatus] = useState('')
  const [lastSnapshotAt, setLastSnapshotAt] = useState<number | null>(null)
  const browserPageStateRef = useRef({ url: startUrl, title: '', isLoading: false, mode: 'desktop' as BrowserMode })
  browserPageStateRef.current = { url: currentUrl, title: pageTitle, isLoading, mode }

  // Stable ref so getCurrentViewport doesn't close over changing width/height state —
  // prevents the webview-mount effect from re-running on every resize step.
  const sizeRef = useRef({ width, height })
  sizeRef.current = { width, height }

  const getCurrentViewport = useCallback((): BrowserEvidenceViewport | undefined => {
    const rect = wvContainerRef.current?.getBoundingClientRect()
    const viewportWidth = rect && rect.width > 0 ? rect.width : sizeRef.current.width
    const viewportHeight = rect && rect.height > 0 ? rect.height : sizeRef.current.height
    const roundedWidth = Math.max(1, Math.round(viewportWidth))
    const roundedHeight = Math.max(1, Math.round(viewportHeight))
    return {
      width: roundedWidth,
      height: roundedHeight,
      deviceScaleFactor: window.devicePixelRatio || 1,
    }
  }, []) // stable — reads size via sizeRef

  const createCurrentEvidenceSnapshot = useCallback((events = browserEvidenceRef.current) => {
    const page = browserPageStateRef.current
    return createBrowserEvidenceSnapshot({
      tileId,
      url: page.url,
      title: page.title,
      isLoading: page.isLoading,
      mode: page.mode,
      viewport: getCurrentViewport(),
      events,
    })
  }, [getCurrentViewport, tileId])

  const publishEvidenceSnapshot = useCallback((reason: string, events = browserEvidenceRef.current) => {
    const snapshot = createCurrentEvidenceSnapshot(events)
    const report = formatBrowserEvidenceReport(snapshot)
    setLastSnapshotAt(snapshot.capturedAt)
    window.electron?.bus?.publish(
      `tile:${tileId}`,
      'browser.evidence.snapshot',
      `browser:${tileId}`,
      { reason, snapshot, report },
    )
    window.electron?.bus?.publish(
      `tile:${tileId}`,
      'browser.page_health',
      `browser:${tileId}`,
      {
        reason,
        health: snapshot.health,
        page: snapshot.page,
        summary: snapshot.summary,
        ...(snapshot.viewport ? { viewport: snapshot.viewport } : {}),
      },
    )
    return snapshot
  }, [createCurrentEvidenceSnapshot, tileId])

  const recordBrowserEvidence = useCallback((input: Omit<BrowserEvidenceInput, 'tileId'>) => {
    const event = createBrowserEvidenceEvent({ tileId, ...input })
    const next = appendBrowserEvidence(browserEvidenceRef.current, event)
    browserEvidenceRef.current = next
    setBrowserEvidence(next)
    const snapshot = createCurrentEvidenceSnapshot(next)
    window.electron?.bus?.publish(
      `tile:${tileId}`,
      'browser.evidence',
      `browser:${tileId}`,
      {
        event,
        summary: snapshot.summary,
        health: snapshot.health,
        page: snapshot.page,
        ...(snapshot.viewport ? { viewport: snapshot.viewport } : {}),
      },
    )
    window.electron?.bus?.publish(
      `tile:${tileId}`,
      'browser.page_health',
      `browser:${tileId}`,
      {
        reason: 'evidence-recorded',
        health: snapshot.health,
        page: snapshot.page,
        summary: snapshot.summary,
        ...(snapshot.viewport ? { viewport: snapshot.viewport } : {}),
      },
    )
  }, [createCurrentEvidenceSnapshot, tileId])

  const handleWebviewNavigation = useCallback((navigation: BrowserNavigationState) => {
    if (navigation.url) {
      setCurrentUrl(navigation.url)
      if (document.activeElement !== inputRef.current) {
        setAddressBar(navigation.url)
      }
    }
    setPageTitle(navigation.title)
    setCanGoBack(navigation.canGoBack)
    setCanGoForward(navigation.canGoForward)
    setIsLoading(navigation.isLoading)
  }, [])

  const {
    containerRef: wvContainerRef,
    isEmbeddedPreview,
    isClusoReady,
    isClusoActive,
    loadUrl,
    restoreUrl,
    goBack,
    goForward,
    reload: reloadWebview,
    stop,
    setMode: setWebviewMode,
    toggleCluso,
  } = useBrowserWebviewLifecycle({
    tileId,
    initialUrl: initialSrc.current,
    stateLoaded,
    background: browserBackground,
    surface: {
      isVisible,
      isToolbarHovered,
      isAddressFocused,
      isInteracting: Boolean(isInteracting),
    },
    events: {
      onNavigation: handleWebviewNavigation,
      onLoadingChange: setIsLoading,
      recordEvidence: recordBrowserEvidence,
    },
  })

  const browserEvidenceSummary = summarizeBrowserEvidence(browserEvidence)
  const browserPageHealth = createBrowserPageHealth(browserEvidenceSummary, isLoading)
  const issueBadgeCount = browserEvidenceSummary.errorCount || browserEvidenceSummary.warningCount || browserEvidenceSummary.total
  const evidenceHealthColor = browserPageHealth.status === 'error'
    ? theme.status.danger
    : browserPageHealth.status === 'warning'
      ? theme.status.warning
      : browserPageHealth.status === 'loading'
        ? theme.accent.base
        : theme.status.success

  useEffect(() => {
    setStateLoaded(!workspaceId)
    if (!workspaceId) return
    window.electron.canvas.loadTileState(workspaceId, tileId).then((saved: any) => {
      if (!saved) return
      if (typeof saved.addressBar === 'string') setAddressBar(saved.addressBar)
      if (typeof saved.currentUrl === 'string') {
        setCurrentUrl(saved.currentUrl)
        initialSrc.current = saved.currentUrl
        prevInitialUrl.current = saved.currentUrl
        restoreUrl(saved.currentUrl)
      }
      if (typeof saved.canGoBack === 'boolean') setCanGoBack(saved.canGoBack)
      if (typeof saved.canGoForward === 'boolean') setCanGoForward(saved.canGoForward)
      if (typeof saved.isLoading === 'boolean') setIsLoading(saved.isLoading)
      if (saved.mode === 'desktop' || saved.mode === 'mobile') setMode(saved.mode)
    }).catch(() => {}).finally(() => {
      setStateLoaded(true)
    })
  }, [workspaceId, tileId, restoreUrl])

  useEffect(() => {
    if (!workspaceId || !stateLoaded) return
    window.electron.canvas.saveTileState(workspaceId, tileId, {
      addressBar,
      currentUrl,
      canGoBack,
      canGoForward,
      isLoading,
      mode,
    }).catch(() => {})
  }, [workspaceId, tileId, addressBar, currentUrl, canGoBack, canGoForward, isLoading, mode])

  useEffect(() => {
    if (!workspaceId || !window.electron?.tileContext) return
    const latestSnapshot = createCurrentEvidenceSnapshot(browserEvidence)
    const contextSnapshot = latestSnapshot.events.length > 20
      ? {
        ...latestSnapshot,
        events: browserEvidence.slice(-20),
      }
      : latestSnapshot
    void Promise.allSettled([
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:url', currentUrl),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:title', pageTitle),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:mode', mode),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:loading', isLoading),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:evidence_summary', browserEvidenceSummary),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:page_health', browserPageHealth),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:viewport', contextSnapshot.viewport ?? null),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:evidence_snapshot', contextSnapshot),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:navigation', {
        currentUrl,
        title: pageTitle,
        canGoBack,
        canGoForward,
        isLoading,
        mode,
      }),
    ])
  }, [workspaceId, tileId, currentUrl, pageTitle, mode, isLoading, canGoBack, canGoForward, browserEvidence, browserEvidenceSummary.total, browserEvidenceSummary.errorCount, browserEvidenceSummary.warningCount, browserPageHealth.status, createCurrentEvidenceSnapshot])

  // Fan-out bus traffic from this browser tile to canvas peers (unrelated to CodesurfRelay mailbox).
  useEffect(() => {
    const peers = new Set(connectedPeers)
    if (!window.electron?.bus || peers.size === 0) {
      if (peerRelayUnsubscribeRef.current) {
        peerRelayUnsubscribeRef.current()
        peerRelayUnsubscribeRef.current = null
      }
      return
    }

    if (peerRelayUnsubscribeRef.current) {
      peerRelayUnsubscribeRef.current()
      peerRelayUnsubscribeRef.current = null
    }

    const unsubscribe = window.electron.bus.subscribe(`tile:${tileId}`, `browser:${tileId}:relay`, (evt) => {
      // Forward only traffic that originated from this browser's web content to peers.
      // This prevents unrelated channel traffic from being mirrored infinitely.
      if (!String(evt.source || '').startsWith(`browser:${tileId}`)) {
        return
      }

      for (const peerId of peers) {
        if (peerId === tileId) continue
        window.electron.bus.publish(
          `tile:${peerId}`,
          evt.type,
          `browser-relay:${tileId}`,
          {
            ...evt.payload,
            fromTile: tileId,
            relayFrom: String(evt.source || '').replace(`browser:${tileId}`, 'browser'),
            originChannel: evt.channel,
          }
        )
      }
    })

    peerRelayUnsubscribeRef.current = unsubscribe
    return () => {
      if (peerRelayUnsubscribeRef.current) {
        peerRelayUnsubscribeRef.current()
        peerRelayUnsubscribeRef.current = null
      }
    }
  }, [connectedPeers, tileId])

  // Navigate when initialUrl prop changes (e.g. opened from sidebar)
  useEffect(() => {
    const next = normalizeUrl(initialUrl ?? '')
    if (next !== prevInitialUrl.current) {
      prevInitialUrl.current = next
      setAddressBar(next)
      setCurrentUrl(next)
      loadUrl(next)
    }
  }, [initialUrl, loadUrl])

  // ---- navigation actions -----------------------------------------------
  const navigate = useCallback((rawUrl: string) => {
    const next = normalizeUrl(rawUrl)
    setAddressBar(next)
    setCurrentUrl(next)
    setIsLoading(true)
    loadUrl(next)
  }, [loadUrl])

  const reload = useCallback(() => {
    if (reloadWebview()) setIsLoading(true)
  }, [reloadWebview])

  const goHome = useCallback(() => navigate(HOMEPAGE), [navigate])

  // Switch mobile / desktop UA and reload
  const switchMode = useCallback((next: BrowserMode) => {
    if (isEmbeddedPreview) return
    setMode(next)
    setWebviewMode(next)
  }, [isEmbeddedPreview, setWebviewMode])

  const captureEvidenceSnapshot = useCallback(() => {
    publishEvidenceSnapshot('user-capture')
  }, [publishEvidenceSnapshot])

  const clearBrowserEvidence = useCallback(() => {
    browserEvidenceRef.current = []
    setBrowserEvidence([])
    setCopyStatus('Evidence cleared')
    publishEvidenceSnapshot('user-clear', [])
  }, [publishEvidenceSnapshot])

  const copyEvidenceReport = useCallback(() => {
    const snapshot = publishEvidenceSnapshot('copy-report')
    const report = formatBrowserEvidenceReport(snapshot)
    if (!navigator.clipboard?.writeText) {
      setCopyStatus('Clipboard unavailable')
      return
    }
    navigator.clipboard.writeText(report)
      .then(() => setCopyStatus('Report copied'))
      .catch(() => setCopyStatus('Copy failed'))
  }, [publishEvidenceSnapshot])

  const openQaWorkbench = useCallback(() => {
    publishEvidenceSnapshot('open-qa-workbench')
    dispatchCreateTile({ type: 'ext:qa-workbench', focus: true, sourceTileId: tileId })
    setCopyStatus('Opening QA Workbench')
  }, [publishEvidenceSnapshot, tileId])

  const attachQaReportToChat = useCallback(() => {
    publishEvidenceSnapshot('attach-qa-report')
    dispatchOpenChatSurface({ extId: 'qa-workbench', surfaceId: 'qa-report', sourceTileId: tileId })
    setCopyStatus('Opening QA Report in chat')
  }, [publishEvidenceSnapshot, tileId])

  // ---- MCP/peer command bridge -----------------------------------------
  useEffect(() => {
    if (!workspaceId || !window.electron?.bus) return

    if (mcpCommandUnsubscribeRef.current) {
      mcpCommandUnsubscribeRef.current()
      mcpCommandUnsubscribeRef.current = null
    }

    const unsubscribe = window.electron.bus.subscribe(
      `tile:${workspaceId}:${tileId}`,
      `browser:${workspaceId}:${tileId}:mcp`,
      (evt) => {
        if (!evt?.type?.startsWith('mcp_') && !String(evt.source || '').startsWith('mcp:')) return
        const payload = (evt.payload as Record<string, unknown>) || {}
        const command = typeof payload.command === 'string' ? payload.command : ''
        if (!command) return
        if (command === 'browser_navigate' && typeof payload.url === 'string') {
          navigate(payload.url)
          return
        }
        if (command === 'browser_reload') {
          reload()
          return
        }
        if (command === 'browser_back') {
          goBack()
          return
        }
        if (command === 'browser_forward') {
          goForward()
          return
        }
        if (command === 'browser_set_mode' && (payload.mode === 'desktop' || payload.mode === 'mobile')) {
          switchMode(payload.mode)
          return
        }
        if (command === 'browser_get_evidence' || command === 'browser_capture_snapshot') {
          publishEvidenceSnapshot(command)
        }
      },
    )

    mcpCommandUnsubscribeRef.current = unsubscribe

    return () => {
      if (mcpCommandUnsubscribeRef.current) {
        mcpCommandUnsubscribeRef.current()
        mcpCommandUnsubscribeRef.current = null
      }
    }
  }, [workspaceId, tileId, navigate, reload, goBack, goForward, switchMode, publishEvidenceSnapshot])
  const focusAddressInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      const pos = input.value.length
      input.setSelectionRange(pos, pos)
    })
  }, [])

  // ---- toolbar -----------------------------------------------------------
  const toolbar = (
    <form
      onSubmit={e => {
        e.preventDefault()
        navigate(addressBar)
      }}
      onMouseEnter={() => setIsToolbarHovered(true)}
      onMouseLeave={() => setIsToolbarHovered(false)}
      onMouseDown={e => {
        e.stopPropagation()
        setIsToolbarHovered(true)
      }}
      onClick={e => e.stopPropagation()}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        paddingRight: 6
      }}
    >
      {/* Nav buttons */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <ToolbarButton label="Back" title="Back" disabled={!canGoBack} onClick={goBack}>
          <ArrowLeft size={12} />
        </ToolbarButton>
        <ToolbarButton label="Forward" title="Forward" disabled={!canGoForward} onClick={goForward}>
          <ArrowRight size={12} />
        </ToolbarButton>
        <ToolbarButton
          label={isLoading ? 'Stop' : 'Reload'}
          title={isLoading ? 'Stop' : 'Reload'}
          onClick={isLoading ? stop : reload}
        >
          {isLoading ? <RotateCcw size={12} /> : <RotateCw size={12} />}
        </ToolbarButton>
        <ToolbarButton label="Home" title="Home" onClick={goHome}>
          <Home size={12} />
        </ToolbarButton>
      </div>

      {/* Address bar */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <input
          ref={inputRef}
          aria-label="Address"
          value={addressBar}
          onFocus={() => setIsAddressFocused(true)}
          onBlur={() => setIsAddressFocused(false)}
          onChange={e => setAddressBar(e.target.value)}
          onMouseDown={e => {
            e.stopPropagation()
            setIsToolbarHovered(true)
            focusAddressInput()
          }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur()
          }}
          style={{
            width: '100%',
            height: 22,
            borderRadius: 6,
            border: `1px solid ${theme.border.default}`,
            background: theme.surface.input,
            color: theme.text.primary,
            padding: '0 8px 0 24px',
            fontSize: fonts.secondarySize,
            outline: 'none',
            boxSizing: 'border-box'
          }}
          spellCheck={false}
        />
        <div
          style={{
            position: 'absolute',
            left: 7,
            top: '50%',
            transform: 'translateY(-50%)',
            color: currentUrl.startsWith('https://') ? theme.status.success : theme.text.muted,
            display: 'flex',
            alignItems: 'center',
            pointerEvents: 'none'
          }}
        >
          <Globe size={10} />
        </div>
      </div>

      {/* Viewport mode + cluso indicator */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
        {isEmbeddedPreview ? (
          <span
            role="status"
            aria-label="Embedded preview only. Sites that block embedding cannot load here, and full browser controls are unavailable."
            title="Embedded preview only. Sites that block embedding cannot load here, and full browser controls are unavailable."
            style={{
              maxWidth: 126,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              padding: '3px 6px',
              borderRadius: 999,
              border: `1px solid ${theme.border.default}`,
              color: theme.text.muted,
              fontSize: fonts.secondarySize - 1,
            }}
          >
            Embedded preview only
          </span>
        ) : (
          <>
            <ToolbarButton
              label="Desktop"
              title="Desktop mode"
              active={mode === 'desktop'}
              onClick={() => switchMode('desktop')}
            >
              <Monitor size={12} />
            </ToolbarButton>
            <ToolbarButton
              label="Mobile"
              title="Mobile mode"
              active={mode === 'mobile'}
              onClick={() => switchMode('mobile')}
            >
              <Smartphone size={12} />
            </ToolbarButton>
            <ToolbarButton
              label="Cluso"
              title={isClusoActive ? 'Finish selection' : isClusoReady ? 'Select elements for chat context' : 'Load selector'}
              active={isClusoActive}
              disabled={!isClusoReady && !currentUrl}
              onClick={toggleCluso}
            >
              <Crosshair size={12} />
            </ToolbarButton>
          </>
        )}
        <ToolbarButton
          label="Browser evidence"
          title={`Browser evidence: ${browserPageHealth.label}`}
          active={isEvidenceDrawerOpen}
          onClick={() => setIsEvidenceDrawerOpen(prev => !prev)}
        >
          <span style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Activity size={12} />
            {issueBadgeCount > 0 && (
              <span
                aria-label={`${issueBadgeCount} evidence events`}
                style={{
                  position: 'absolute',
                  right: -7,
                  top: -7,
                  minWidth: 12,
                  height: 12,
                  padding: '0 3px',
                  borderRadius: 99,
                  background: evidenceHealthColor,
                  color: theme.text.inverse,
                  fontSize: 8,
                  lineHeight: '12px',
                  fontWeight: 700,
                  boxShadow: `0 0 0 1px ${browserToolbarBackground}`,
                }}
              >
                {issueBadgeCount > 99 ? '99+' : issueBadgeCount}
              </span>
            )}
          </span>
        </ToolbarButton>

      </div>
    </form>
  )

  // ---- render -----------------------------------------------------------
  return (
    <div style={{ position: 'absolute', inset: 0, background: browserBackground }}>
      {/* Toolbar — explicit top/height so compositor knows exact rect; zIndex above webview */}
      {!hideNavbar && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 34,
          display: 'flex', alignItems: 'center', padding: '0 6px',
          background: browserToolbarBackground, borderBottom: `1px solid ${browserBorder}`,
          zIndex: 2,
        }}>
          {toolbar}
        </div>
      )}

      {isEmbeddedPreview && hideNavbar && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            right: 8,
            zIndex: 3,
            pointerEvents: 'none',
            padding: '5px 8px',
            borderRadius: 6,
            background: theme.surface.panelElevated,
            border: `1px solid ${theme.border.default}`,
            color: theme.text.muted,
            fontSize: fonts.secondarySize - 1,
          }}
        >
          Embedded preview only — sites that block embedding cannot load here.
        </div>
      )}

      {isEvidenceDrawerOpen && !hideNavbar && (
        <BrowserEvidenceDrawer
          width={width}
          height={height}
          state={{
            events: browserEvidence,
            filter: evidenceFilter,
            health: browserPageHealth,
            summary: browserEvidenceSummary,
            pageLabel: pageTitle || currentUrl || 'No page title',
            healthColor: evidenceHealthColor,
            copyStatus,
            lastSnapshotAt,
          }}
          actions={{
            close: () => setIsEvidenceDrawerOpen(false),
            selectFilter: setEvidenceFilter,
            captureSnapshot: captureEvidenceSnapshot,
            copyReport: copyEvidenceReport,
            openQaWorkbench,
            attachQaReportToChat,
            clearEvidence: clearBrowserEvidence,
            markInteracting: () => setIsToolbarHovered(true),
          }}
        />
      )}

      {/* Webview container — starts below toolbar (or fills entire tile when navbar hidden) */}
      <div
        ref={wvContainerRef}
        style={{ position: 'absolute', top: hideNavbar ? 0 : 34, left: 0, right: 0, bottom: 0, zIndex: 1, background: browserBackground }}
      />

      {/* Invisible overlay during drag/resize — blocks mouse events from reaching webview */}
      {isInteracting && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: 'auto',
            background: 'transparent',
            zIndex: 9999
          }}
        />
      )}

      {(width < 260 || height < 170) && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 8,
            fontSize: fonts.secondarySize - 1,
            background: theme.surface.panelElevated,
            border: `1px solid ${theme.border.default}`,
            color: theme.text.muted,
            padding: '2px 6px',
            borderRadius: 4,
            pointerEvents: 'none'
          }}
        >
          Small blocks may hide browser controls
        </div>
      )}
    </div>
  )
}
