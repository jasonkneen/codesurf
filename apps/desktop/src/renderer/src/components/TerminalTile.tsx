import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { isDaemonBackedHost } from '../platform/detect'
import { getDroppedPaths, shellEscapePath } from '../utils/dnd'
import { resolveTerminalPeerWrite } from './terminalPeerCommands'
import { terminalSessionLease } from '../lib/terminalSessionRetain'

interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  fontSize?: number
  fontFamily?: string
  launchBin?: string
  launchArgs?: string[]
}

type RemoteTerminalCreate = (
  tileId: string,
  workspaceId: string,
  workspaceDir: string,
  launchBin?: string,
  launchArgs?: string[],
  options?: { cols?: number, rows?: number },
) => Promise<{ cols: number, rows: number, buffer?: string }>

function terminalErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error || 'Terminal service is unavailable')
}

export function TerminalTile({ tileId, workspaceId, workspaceDir, width, height, fontSize = 13, fontFamily, launchBin, launchArgs }: Props): JSX.Element {
  const appFonts = useAppFonts()
  const theme = useTheme()
  // Ensure a Nerd Font variant is in the stack so PUA glyphs (icons) render.
  // User settings may specify a non-Nerd font; prepend the Nerd variant as fallback.
  const NERD_FONTS = ['"FiraCode Nerd Font Mono"', '"FiraCode Nerd Font"']
  const baseFont = fontFamily ?? appFonts.mono
  const hasNerd = /nerd/i.test(baseFont)
  const resolvedFont = hasNerd ? baseFont : `${NERD_FONTS.join(', ')}, ${baseFont}`
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(false)
  const ptyReadyRef = useRef(false)
  const unavailableRef = useRef(false)
  const terminalFailureRef = useRef<(error: unknown) => void>(() => {})
  // Track fontSize in a ref so the async font-load path reads the current
  // value (not the mount-time prop captured by the effect closure).
  const fontSizeRef = useRef(fontSize)
  const [isDropTarget, setIsDropTarget] = useState(false)
  const [terminalUnavailable, setTerminalUnavailable] = useState<string | null>(null)

  const doFit = () => {
    if (!fitRef.current || !termRef.current) return
    try {
      fitRef.current.fit()
      const dims = fitRef.current.proposeDimensions()
      if (dims?.cols && dims?.rows && ptyReadyRef.current && !unavailableRef.current) {
        void window.electron?.terminal?.resize(tileId, dims.cols, dims.rows).catch(terminalFailureRef.current)
      }
    } catch { /* ignore */ }
  }

  // Mount-only effect: creates the Terminal instance. fontSize, resolvedFont,
  // and theme are intentionally omitted from deps — remounting would destroy
  // the PTY buffer and scrollback. Reactive updates for those live below.
  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return
    mountedRef.current = true
    terminalSessionLease.retain(tileId)
    ptyReadyRef.current = false
    unavailableRef.current = false
    setTerminalUnavailable(null)
    const container = containerRef.current
    let cancelled = false
    let ro: ResizeObserver | null = null

    // Register system fonts (e.g. Nerd Fonts) via @font-face local() so
    // Chromium's Canvas/WebGL text renderers can resolve them. Without this,
    // system-installed fonts may not be available to canvas contexts, causing
    // Private Use Area glyphs (Nerd Font icons) to render as underscores.
    const fontLoads: Promise<void>[] = []
    for (const raw of resolvedFont.split(',')) {
      const name = raw.trim().replace(/^["']|["']$/g, '')
      if (!name || name === 'monospace' || name === 'sans-serif') continue
      const alreadyDeclared = [...document.fonts].some(f => f.family.replace(/["']/g, '') === name)
      if (!alreadyDeclared) {
        const face = new FontFace(name, `local("${name}")`)
        fontLoads.push(face.load().then(loaded => { document.fonts.add(loaded) }).catch(() => {}))
      }
    }

    Promise.all(fontLoads).then(() => {
      if (cancelled) return

      const term = new Terminal({
        theme: {
          background: theme.terminal.background,
          foreground: theme.terminal.foreground,
          cursor: theme.terminal.cursor,
          cursorAccent: theme.terminal.cursorAccent,
          selectionBackground: theme.terminal.selection,
          black: theme.terminal.black, red: theme.terminal.red, green: theme.terminal.green,
          yellow: theme.terminal.yellow, blue: theme.terminal.blue, magenta: theme.terminal.magenta,
          cyan: theme.terminal.cyan, white: theme.terminal.white,
          brightBlack: theme.terminal.brightBlack, brightRed: theme.terminal.brightRed, brightGreen: theme.terminal.brightGreen,
          brightYellow: theme.terminal.brightYellow, brightBlue: theme.terminal.brightBlue, brightMagenta: theme.terminal.brightMagenta,
          brightCyan: theme.terminal.brightCyan, brightWhite: theme.terminal.brightWhite,
          overviewRulerBorder: theme.terminal.background,
        },
        overviewRuler: {
          width: 10,
        },
        fontFamily: resolvedFont,
        fontSize: fontSizeRef.current,
        lineHeight: 1,
        cursorBlink: true,
        scrollback: 5000,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(container)

      // Apply padding inside xterm element so viewport bg covers behind it
      const xtermEl = container.querySelector('.xterm') as HTMLElement | null
      if (xtermEl) {
        xtermEl.style.paddingLeft = '8px'
        xtermEl.style.paddingTop = '8px'
      }

      termRef.current = term
      fitRef.current = fitAddon

      const showTerminalUnavailable = (error: unknown) => {
        if (cancelled || unavailableRef.current) return
        const message = terminalErrorMessage(error)
        unavailableRef.current = true
        ptyReadyRef.current = false
        term.options.disableStdin = true
        setTerminalUnavailable(message)
        term.write(`\r\n\x1b[31mTerminal unavailable: ${message}\x1b[0m\r\n`)
      }
      terminalFailureRef.current = showTerminalUnavailable

      // ResizeObserver so fit runs whenever the container actually changes size
      ro = new ResizeObserver(() => doFit())
      ro.observe(container)

      // Initial fit after paint
      requestAnimationFrame(() => requestAnimationFrame(() => doFit()))

      // Track PTY readiness so key handler can write safely
      let ptyReady = false
      // True once the PTY process has exited; typed input is swallowed until
      // Enter is pressed to respawn a fresh session.
      let exited = false
      let respawning = false

      // Shift+Enter → send escaped newline so shells continue on next line
      // and TUI apps (Claude CLI) treat it as multi-line input.
      const writeToTerminal = (data: string) => {
        if (!ptyReady || unavailableRef.current) return
        void window.electron.terminal.write(tileId, data).catch(showTerminalUnavailable)
      }

      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.key === 'Enter' && ev.shiftKey && ev.type === 'keydown') {
          if (ptyReady && !unavailableRef.current) {
            // Send backslash + carriage return — universal shell line continuation
            writeToTerminal('\\\r')
            return false
          }
        }
        return true
      })

      const startPty = () => {
        if (unavailableRef.current) return
        let initialDimensions: { cols?: number, rows?: number } = {}
        try {
          fitAddon.fit()
          const proposed = fitAddon.proposeDimensions()
          initialDimensions = { cols: proposed?.cols, rows: proposed?.rows }
        } catch {
          // The gateway has safe 80x24 defaults when xterm cannot measure yet.
        }

        const create = window.electron.terminal.create as unknown as RemoteTerminalCreate
        const request = isDaemonBackedHost()
          ? create(
              tileId,
              workspaceId,
              workspaceDir,
              launchBin,
              launchArgs,
              initialDimensions,
            )
          : create(tileId, workspaceId, workspaceDir, launchBin, launchArgs)

        request.then(({ buffer }) => {
          if (cancelled) return
          ptyReady = true
          ptyReadyRef.current = true
          exited = false
          respawning = false
          if (buffer) term.write(buffer)
          const dataCleanup = window.electron.terminal.onData(tileId, (data: string) => {
            term.write(data)
          })
          const exitCleanup = window.electron.terminal.onExit(tileId, (exitCode: number) => {
            ptyReady = false
            ptyReadyRef.current = false
            exited = true
            term.write(`\r\n\x1b[33m[process exited (code ${exitCode})] — press Enter to restart\x1b[0m\r\n`)
          })
          cleanupRef.current = () => {
            dataCleanup()
            exitCleanup()
          }

          // Fit once more after pty is ready
          doFit()
        }).catch(err => {
          respawning = false
          showTerminalUnavailable(err)
        })
      }

      term.onData((data: string) => {
        if (unavailableRef.current) return
        if (exited) {
          if (!respawning && (data === '\r' || data === '\n')) {
            respawning = true
            cleanupRef.current?.()
            cleanupRef.current = null
            startPty()
          }
          return
        }
        writeToTerminal(data)
      })

      startPty()
    })

    return () => {
      cancelled = true
      mountedRef.current = false
      ptyReadyRef.current = false
      ro?.disconnect()
      cleanupRef.current?.()
      cleanupRef.current = null
      // Refcounted detach: fullscreen + canvas both mount this tile.
      // Only the last instance may drop the PTY attachment.
      terminalSessionLease.release(tileId)
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
      terminalFailureRef.current = () => {}
    }
  }, [tileId, workspaceId, workspaceDir, launchBin, launchArgs])

  // Also refit when tile width/height props change (drag resize)
  useEffect(() => {
    doFit()
  }, [width, height])

  // Apply fontSize prop changes without remounting the Terminal.
  // Also keep fontSizeRef current so the mount effect's async font-load
  // path (which may complete well after this) picks up the latest value.
  useEffect(() => {
    fontSizeRef.current = fontSize
    if (!termRef.current) return
    termRef.current.options.fontSize = fontSize
    doFit()
  }, [fontSize])

  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.theme = {
      background: theme.terminal.background,
      foreground: theme.terminal.foreground,
      cursor: theme.terminal.cursor,
      cursorAccent: theme.terminal.cursorAccent,
      selectionBackground: theme.terminal.selection,
      black: theme.terminal.black,
      red: theme.terminal.red,
      green: theme.terminal.green,
      yellow: theme.terminal.yellow,
      blue: theme.terminal.blue,
      magenta: theme.terminal.magenta,
      cyan: theme.terminal.cyan,
      white: theme.terminal.white,
      brightBlack: theme.terminal.brightBlack,
      brightRed: theme.terminal.brightRed,
      brightGreen: theme.terminal.brightGreen,
      brightYellow: theme.terminal.brightYellow,
      brightBlue: theme.terminal.brightBlue,
      brightMagenta: theme.terminal.brightMagenta,
      brightCyan: theme.terminal.brightCyan,
      brightWhite: theme.terminal.brightWhite,
      overviewRulerBorder: theme.terminal.background,
    }
  }, [theme])

  useEffect(() => {
    if (!workspaceId || !tileId) return

    const unsubscribeBus = window.electron?.bus?.subscribe(
      `tile:${workspaceId}:${tileId}`,
      `terminal:${workspaceId}:${tileId}:mcp`,
      (event) => {
        const payload = event?.payload && typeof event.payload === 'object'
          ? event.payload as Record<string, unknown>
          : {}
        const data = resolveTerminalPeerWrite(workspaceId, tileId, payload)
        if (data === null) return
        void window.electron.terminal.write(tileId, data).catch(terminalFailureRef.current)
      },
    )

    const unsubscribeInject = window.electron?.mcp?.onInject?.(
      (eventWorkspaceId, cardId, message, appendNewline) => {
        if (eventWorkspaceId !== workspaceId || cardId !== tileId) return
        const data = `${message}${appendNewline ? '\r' : ''}`
        void window.electron.terminal.write(tileId, data).catch(terminalFailureRef.current)
      },
    )

    return () => {
      unsubscribeBus?.()
      unsubscribeInject?.()
    }
  }, [workspaceId, tileId])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // During dragover, getData() is restricted — check types instead
    const dt = e.dataTransfer
    const hasFiles = dt.types.includes('Files')
    const hasUri = dt.types.includes('text/uri-list')
    const hasPlain = dt.types.includes('text/plain')
    const hasFileRef = dt.types.includes('application/file-reference-path')
    if (!hasFiles && !hasUri && !hasPlain && !hasFileRef) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setIsDropTarget(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setIsDropTarget(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDropTarget(false)
    const droppedPaths = getDroppedPaths(e.dataTransfer)
    if (droppedPaths.length === 0) return
    const payload = droppedPaths.map(shellEscapePath).join(' ')
    if (!payload) return
    termRef.current?.focus()
    if (!ptyReadyRef.current || unavailableRef.current) return
    void window.electron?.terminal?.write(tileId, `${payload} `).catch(terminalFailureRef.current)
  }, [tileId])

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        width: '100%', height: '100%', background: isDropTarget ? theme.surface.accentSoft : theme.terminal.background, overflow: 'hidden', position: 'relative',
        boxShadow: isDropTarget ? `inset 0 0 0 2px ${theme.accent.base}, 0 0 22px ${theme.accent.soft}` : 'none',
        transition: 'background 120ms ease, box-shadow 120ms ease'
      }}
    >
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', background: theme.terminal.background, overflow: 'hidden' }}
      />
      {terminalUnavailable && (
        <div
          role="alert"
          style={{
            position: 'absolute', inset: 12, zIndex: 3,
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 7,
            padding: '16px 18px', borderRadius: 10,
            border: `1px solid ${theme.status.danger}`,
            background: theme.surface.panelElevated,
            boxShadow: '0 12px 34px rgba(0,0,0,0.38)',
            color: theme.text.primary,
            pointerEvents: 'auto',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>Terminal unavailable</div>
          <div style={{ fontSize: 12, lineHeight: 1.45, color: theme.text.secondary, overflowWrap: 'anywhere' }}>
            {terminalUnavailable}
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.4, color: theme.text.muted }}>
            Check the terminal sandbox connection or open this workspace in the desktop runtime.
          </div>
        </div>
      )}
      {isDropTarget && (
        <div style={{
          position: 'absolute', inset: 12, zIndex: 2,
          border: `1px dashed ${theme.accent.base}`, borderRadius: 10,
          background: theme.accent.soft,
          pointerEvents: 'none',
        }} />
      )}
    </div>
  )
}
