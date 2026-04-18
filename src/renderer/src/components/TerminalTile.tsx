import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { getDroppedPaths, shellEscapePath } from '../utils/dnd'

interface Props {
  tileId: string
  workspaceDir: string
  width: number
  height: number
  fontSize?: number
  fontFamily?: string
  launchBin?: string
  launchArgs?: string[]
}

export function TerminalTile({ tileId, workspaceDir, width, height, fontSize = 13, fontFamily, launchBin, launchArgs }: Props): JSX.Element {
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
  // Track fontSize in a ref so the async font-load path reads the current
  // value (not the mount-time prop captured by the effect closure).
  const fontSizeRef = useRef(fontSize)
  const [isDropTarget, setIsDropTarget] = useState(false)

  const doFit = () => {
    if (!fitRef.current || !termRef.current) return
    try {
      fitRef.current.fit()
      const dims = fitRef.current.proposeDimensions()
      if (dims?.cols && dims?.rows) {
        window.electron?.terminal?.resize(tileId, dims.cols, dims.rows)
      }
    } catch { /* ignore */ }
  }

  // Mount-only effect: creates the Terminal instance. fontSize, resolvedFont,
  // and theme are intentionally omitted from deps — remounting would destroy
  // the PTY buffer and scrollback. Reactive updates for those live below.
  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return
    mountedRef.current = true
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
        allowProposedApi: true,
        scrollback: 5000,
      })

      const fitAddon = new FitAddon()
      const unicode11 = new Unicode11Addon()
      term.loadAddon(fitAddon)
      term.loadAddon(unicode11)
      term.unicode.activeVersion = '11'
      term.open(container)

      // WebGL renderer handles Nerd Font / PUA glyphs better than the canvas renderer
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => { webgl.dispose() })
        term.loadAddon(webgl)
      } catch { /* fall back to canvas renderer */ }

      // Apply padding inside xterm element so viewport bg covers behind it
      const xtermEl = container.querySelector('.xterm') as HTMLElement | null
      if (xtermEl) {
        xtermEl.style.paddingLeft = '8px'
        xtermEl.style.paddingTop = '8px'
      }

      termRef.current = term
      fitRef.current = fitAddon

      // ResizeObserver so fit runs whenever the container actually changes size
      ro = new ResizeObserver(() => doFit())
      ro.observe(container)

      // Initial fit after paint
      requestAnimationFrame(() => requestAnimationFrame(() => doFit()))

      // Track PTY readiness so key handler can write safely
      let ptyReady = false

      // Shift+Enter → send escaped newline so shells continue on next line
      // and TUI apps (Claude CLI) treat it as multi-line input.
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.key === 'Enter' && ev.shiftKey && ev.type === 'keydown') {
          if (ptyReady) {
            // Send backslash + carriage return — universal shell line continuation
            window.electron.terminal.write(tileId, '\\\r')
            return false
          }
        }
        return true
      })

      window.electron.terminal.create(tileId, workspaceDir, launchBin, launchArgs).then(({ buffer }) => {
        ptyReady = true
        if (buffer) term.write(buffer)
        const cleanup = window.electron.terminal.onData(tileId, (data: string) => {
          term.write(data)
        })
        cleanupRef.current = cleanup

        term.onData((data: string) => {
          window.electron.terminal.write(tileId, data)
        })

        // Fit once more after pty is ready
        doFit()
      }).catch(err => {
        term.write(`\r\n\x1b[31mFailed to start terminal: ${err?.message ?? err}\x1b[0m\r\n`)
      })
    })

    return () => {
      cancelled = true
      mountedRef.current = false
      ro?.disconnect()
      cleanupRef.current?.()
      // Detach (not destroy) so tmux sessions survive unmount/reload
      window.electron?.terminal?.detach?.(tileId)
      termRef.current?.dispose()
    }
  }, [tileId, workspaceDir, launchBin, launchArgs])

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
    window.electron?.terminal?.write(tileId, `${payload} `)
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
