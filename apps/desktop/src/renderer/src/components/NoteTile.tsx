import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Type } from 'lucide-react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { useTileColor } from '../TileColorContext'
import { createLoadableModuleTile } from '../lib/loadableTile'

export { renderMarkdown } from './noteMarkdown'

const LazyFileNoteTile = createLoadableModuleTile(
  () => import('./FileNoteTile'),
  module => module.FileNoteTile,
)

export type NoteTileProps = {
  tileId?: string
  workspaceId?: string
  filePath?: string
  initialContent?: string
  workspacePath?: string
}

// Sticky note colours
const STICKY_COLOURS = [
  { id: 'yellow',  bg: '#fff9c4', border: '#f9e547', text: '#5d4e00' },
  { id: 'green',   bg: '#c8f7c5', border: '#69d662', text: '#1b4d16' },
  { id: 'blue',    bg: '#bbdefb', border: '#5fa8e8', text: '#0d3b66' },
  { id: 'pink',    bg: '#f8bbd0', border: '#e57399', text: '#6b1a3a' },
  { id: 'purple',  bg: '#e1bee7', border: '#b368c9', text: '#3e1650' },
  { id: 'orange',  bg: '#ffe0b2', border: '#f5a623', text: '#5e3a00' },
  { id: 'white',   bg: '#ffffff', border: '#d0d0d0', text: '#333333' },
  { id: 'dark',    bg: '#2a2a2a', border: '#444444', text: '#e0e0e0' },
] as const

const STICKY_FONTS = [
  {
    id: 'sans',
    label: 'System Sans',
    family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  {
    id: 'rounded',
    label: 'Rounded',
    family: '"SF Pro Rounded", "Avenir Next Rounded", "Segoe UI", sans-serif',
  },
  {
    id: 'serif',
    label: 'Book Serif',
    family: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
  },
  {
    id: 'marker',
    label: 'Marker',
    family: '"Marker Felt", "Comic Sans MS", "Segoe Print", cursive',
  },
  {
    id: 'hand',
    label: 'Handwritten',
    family: '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
  },
] as const

function StickyNote({ initialContent, tileId, workspaceId, workspacePath }: { initialContent: string; tileId?: string; workspaceId?: string; workspacePath?: string }): JSX.Element {
  const fonts = useAppFonts()
  const [content, setContent] = useState(initialContent || '')
  const { colorId, setColor, setColorId, fontId, setFontId } = useTileColor()
  const colour = STICKY_COLOURS.find(c => c.id === colorId) ?? STICKY_COLOURS[0]
  const noteFont = STICKY_FONTS.find(f => f.id === fontId) ?? STICKY_FONTS[0]
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)

  // Push colour to titlebar via context
  useEffect(() => {
    setColor(colour.bg)
    return () => setColor(null)
  }, [colour.bg, setColor])

  // Persist note content + appearance to tile context directory so agents can read via get_context
  const contextDir = tileId && workspacePath ? `${workspacePath}/.codesurf/${tileId}/context` : null
  const contextFile = contextDir ? `${contextDir}/note.txt` : null
  const settingsFile = contextDir ? `${contextDir}/note-settings.json` : null

  // Load saved content and appearance on mount.
  // Check existence first to avoid noisy ENOENT logs from the main-process fs IPC.
  useEffect(() => {
    let cancelled = false
    loaded.current = false
    if (!contextDir || !contextFile || !settingsFile) {
      loaded.current = true
      return
    }

    ;(async () => {
      try {
        const [contentStat, settingsStat] = await Promise.all([
          window.electron.fs.stat(contextFile, workspaceId).catch(() => null),
          window.electron.fs.stat(settingsFile, workspaceId).catch(() => null),
        ])

        if (cancelled) return

        if (contentStat?.isFile) {
          const text = await window.electron.fs.readFile(contextFile, workspaceId).catch(() => '')
          if (!cancelled && text && text.trim()) setContent(text)
        }

        if (settingsStat?.isFile) {
          const raw = await window.electron.fs.readFile(settingsFile, workspaceId).catch(() => '')
          if (!cancelled && raw) {
            try {
              const parsed = JSON.parse(raw)
              if (typeof parsed?.colorId === 'string' && STICKY_COLOURS.some(c => c.id === parsed.colorId)) {
                setColorId(parsed.colorId)
              }
              if (typeof parsed?.fontId === 'string' && STICKY_FONTS.some(f => f.id === parsed.fontId)) {
                setFontId(parsed.fontId)
              }
            } catch {
              // Ignore invalid appearance settings
            }
          }
        }
      } finally {
        if (!cancelled) loaded.current = true
      }
    })()

    return () => { cancelled = true }
  }, [contextDir, contextFile, settingsFile, setColorId, setFontId, workspaceId])

  // Auto-save content to context dir
  const persistContent = useCallback((value: string) => {
    if (!contextDir || !contextFile || !loaded.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.electron.fs.createDir(contextDir, workspaceId).catch(() => {}).then(() => {
        window.electron.fs.writeFile(contextFile, value, workspaceId)
      })
    }, 500)
  }, [contextDir, contextFile, workspaceId])

  const handleChange = useCallback((value: string) => {
    setContent(value)
    persistContent(value)
  }, [persistContent])

  useEffect(() => {
    if (!contextDir || !settingsFile || !loaded.current) return
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current)
    settingsSaveTimer.current = setTimeout(() => {
      window.electron.fs.createDir(contextDir, workspaceId).catch(() => {}).then(() => {
        window.electron.fs.writeFile(settingsFile, JSON.stringify({ colorId, fontId }, null, 2), workspaceId)
      })
    }, 200)
  }, [contextDir, settingsFile, colorId, fontId, workspaceId])

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current)
  }, [])

  // Listen for MCP note_append_context commands via bus
  useEffect(() => {
    if (!workspaceId || !tileId) return
    const channel = `tile:${workspaceId}:${tileId}`
    const subscriberId = `note-${workspaceId}-${tileId}`
    const unsub = window.electron?.bus?.subscribe(channel, subscriberId, (event: { payload?: { command?: string; content?: string } }) => {
      if (event.payload?.command === 'note_append_context' && event.payload.content) {
        setContent(prev => {
          const next = prev ? `${prev}\n${event.payload!.content}` : event.payload!.content!
          persistContent(next)
          return next
        })
      }
      if (event.payload?.command === 'note_write_content' && typeof event.payload.content === 'string') {
        setContent(event.payload.content)
        persistContent(event.payload.content)
      }
    })
    return () => unsub?.()
  }, [persistContent, workspaceId, tileId])

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      background: colour.bg,
      position: 'relative',
      overflow: 'hidden',
    }}>
      <textarea
        value={content}
        onChange={e => handleChange(e.target.value)}
        placeholder="Type a note..."
        style={{
          flex: 1, resize: 'none', border: 'none', outline: 'none',
          background: 'transparent',
          color: colour.text,
          fontSize: fonts.size, lineHeight: fonts.lineHeight, fontWeight: fonts.weight,
          padding: '8px 14px 14px',
          fontFamily: noteFont.family,
          letterSpacing: 0.1,
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
    </div>
  )
}

function StickyPopover({ anchorRef, children }: { anchorRef: React.RefObject<HTMLElement | null>; children: React.ReactNode }): JSX.Element | null {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return

    const update = () => {
      const rect = el.getBoundingClientRect()
      setPos({
        top: rect.bottom + 6,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef])

  if (!pos) return null
  return createPortal(
    <div
      data-sticky-note-popover="true"
      style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 99999 }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}

// Exported for use as titlebarExtra in TileChrome — reads/writes colour via TileColorContext
export function StickyColorPicker(): JSX.Element {
  const { colorId, setColorId, fontId, setFontId } = useTileColor()
  const theme = useTheme()
  const fonts = useAppFonts()
  const [showColourPicker, setShowColourPicker] = useState(false)
  const [showFontPicker, setShowFontPicker] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const colourButtonRef = useRef<HTMLButtonElement>(null)
  const fontButtonRef = useRef<HTMLButtonElement>(null)
  const colour = STICKY_COLOURS.find(c => c.id === colorId) ?? STICKY_COLOURS[0]
  const activeFont = STICKY_FONTS.find(f => f.id === fontId) ?? STICKY_FONTS[0]
  const chromeColor = colour.text

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      const targetEl = e.target instanceof Element ? e.target : null
      if (!popoverRef.current?.contains(target) && !targetEl?.closest('[data-sticky-note-popover="true"]')) {
        setShowColourPicker(false)
        setShowFontPicker(false)
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [])

  return (
    <div ref={popoverRef} data-no-drag style={{ display: 'flex', gap: 6, alignItems: 'center', marginRight: 4, position: 'relative' }}>
      <button
        ref={colourButtonRef}
        data-no-drag
        onClick={() => { setShowColourPicker(v => !v); setShowFontPicker(false) }}
        title="Change note colour"
        style={{
          width: 14, height: 14, borderRadius: 7,
          background: colour.bg, border: `1.5px solid ${colour.border}`,
          cursor: 'pointer', padding: 0,
          flexShrink: 0,
        }}
      />

      <button
        ref={fontButtonRef}
        data-no-drag
        onClick={() => { setShowFontPicker(v => !v); setShowColourPicker(false) }}
        title="Change note font"
        style={{
          width: 18, height: 18,
          borderRadius: 5,
          border: `1px solid ${showFontPicker ? chromeColor : `${chromeColor}55`}`,
          background: showFontPicker ? `${chromeColor}14` : 'transparent',
          color: showFontPicker ? chromeColor : `${chromeColor}cc`,
          cursor: 'pointer', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Type size={11} strokeWidth={2.2} />
      </button>

      {showColourPicker && (
        <StickyPopover anchorRef={colourButtonRef}>
          <div
            data-no-drag
            style={{
              display: 'flex',
              gap: 5,
              padding: '6px 7px',
              borderRadius: 999,
              background: theme.surface.panelElevated,
              border: `1px solid ${theme.border.default}`,
              boxShadow: theme.shadow.panel,
              backdropFilter: 'blur(10px)',
            }}
          >
            {STICKY_COLOURS.map(c => (
              <button
                key={c.id}
                data-no-drag
                onClick={() => { setColorId(c.id); setShowColourPicker(false) }}
                title={c.id}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  background: c.bg,
                  border: `1.5px solid ${c.id === colorId ? c.text : c.border}`,
                  cursor: 'pointer',
                  padding: 0,
                  transform: c.id === colorId ? 'scale(1.15)' : 'scale(1)',
                  transition: 'transform 0.12s ease',
                }}
              />
            ))}
          </div>
        </StickyPopover>
      )}

      {showFontPicker && (
        <StickyPopover anchorRef={fontButtonRef}>
          <div
            data-no-drag
            style={{
              width: 196,
              maxHeight: 220,
              overflowY: 'auto',
              padding: 4,
              borderRadius: 10,
              background: theme.surface.panelElevated,
              border: `1px solid ${theme.border.default}`,
              boxShadow: theme.shadow.panel,
              backdropFilter: 'blur(10px)',
            }}
          >
            {STICKY_FONTS.map(font => {
              const active = font.id === activeFont.id
              return (
                <button
                  key={font.id}
                  data-no-drag
                  onClick={() => { setFontId(font.id); setShowFontPicker(false) }}
                  style={{
                    width: '100%',
                    border: 'none',
                    background: active ? theme.accent.soft : 'transparent',
                    color: active ? theme.accent.base : theme.text.primary,
                    cursor: 'pointer',
                    borderRadius: 8,
                    padding: '8px 10px',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 11, fontFamily: fonts.secondary, color: active ? theme.accent.base : theme.text.secondary }}>
                    {font.label}
                  </span>
                  <span style={{ fontSize: 15, fontFamily: font.family, color: theme.text.primary, lineHeight: 1.25 }}>
                    Sticky note preview
                  </span>
                </button>
              )
            })}
          </div>
        </StickyPopover>
      )}
    </div>
  )
}

export function NoteTile({ tileId, workspaceId, filePath, initialContent = '', workspacePath }: NoteTileProps): JSX.Element {
  if (filePath) {
    return <LazyFileNoteTile tileId={tileId} workspaceId={workspaceId} filePath={filePath} initialContent={initialContent} />
  }
  return <StickyNote initialContent={initialContent} tileId={tileId} workspaceId={workspaceId} workspacePath={workspacePath} />
}
