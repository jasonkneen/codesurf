/**
 * Command Palette — the human-facing command surface (point 3).
 *
 * Lists every enabled plugin's `contributes.commands[]` plus built-in host
 * commands and runs the selected one. Built bespoke (NOT shadcn/cmdk) so it
 * matches the app's own "Search chats" dialog exactly — rounded panel, elevated
 * surface, soft border + shadow, padded rows, themed highlight — instead of the
 * generic shadcn chrome. Mounted from App.tsx and toggled with a global shortcut.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useContributions } from '../hooks/useContributions'
import { useLayoutTemplates } from '../hooks/useLayoutTemplates'
import { executeCommand, type PaletteCommand } from '../lib/commandRegistry'
import { BUILTIN_VIEWS } from '../lib/builtinViews'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'

/** Built-in (host) commands. Plugins contribute the rest via contributes.commands. */
type BuiltinCommand = PaletteCommand & { _run: () => void }

/** Built-in layout presets, available out of the box (point 10). Plugins add more. */
const BUILTIN_LAYOUT_PRESETS: Array<{ extId: string; id: string; title: string; layout: unknown }> = [
  {
    extId: 'codesurf', id: 'ai-workspace', title: 'AI Workspace',
    layout: {
      type: 'split', direction: 'horizontal', sizes: [25, 50, 25],
      children: [
        { type: 'leaf', slots: [{ tileType: 'files', label: 'Files' }] },
        { type: 'leaf', slots: [{ tileType: 'chat', label: 'Chat' }] },
        { type: 'leaf', slots: [{ tileType: 'terminal', label: 'Terminal' }] },
      ],
    },
  },
]
const el = (window as { electron?: any }).electron
const BUILTIN_COMMANDS: BuiltinCommand[] = [
  // Built-in views surfaced uniformly with plugin views (point 7).
  ...BUILTIN_VIEWS.map((v): BuiltinCommand => ({
    extId: 'codesurf', id: `new.${v.type}`, title: `New: ${v.label}`, category: 'New',
    _run: () => { window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: v.type } })) },
  })),
  {
    extId: 'codesurf', id: 'layout.save', title: 'Layout: Save Current as Preset',
    category: 'Layouts', _run: () => { window.dispatchEvent(new CustomEvent('codesurf:save-layout')) },
  },
  {
    extId: 'codesurf', id: 'pets.open', title: 'Pets: Choose Pet',
    category: 'Customise', _run: () => { window.dispatchEvent(new CustomEvent('codesurf:open-pet-picker')) },
  },
  {
    extId: 'codesurf', id: 'pets.toggle', title: 'Pets: Toggle Pet On/Off',
    category: 'Customise', _run: () => { window.dispatchEvent(new CustomEvent('codesurf:toggle-pet')) },
  },
  {
    extId: 'codesurf', id: 'devSandbox.open', title: 'Developer: Open Dev Sandbox',
    category: 'Developer', _run: () => { void el?.window?.openDevSandbox?.() },
  },
  {
    extId: 'codesurf', id: 'window.new', title: 'Window: New Window',
    category: 'Window', _run: () => { void el?.window?.new?.() },
  },
]

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const theme = useTheme()
  const fonts = useAppFonts()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const pluginCommands = useContributions('commands') as PaletteCommand[]
  const layoutPresets = useContributions('layoutPresets')
  const { templates: savedLayouts } = useLayoutTemplates()

  // Each registered layout preset (built-in + plugin-contributed) becomes a one-click
  // "Layout: <title>" command that applies the arrangement (point 10 — reusable layouts).
  const presetCommands = useMemo<BuiltinCommand[]>(() => {
    const contributed = layoutPresets.map(p => {
      const preset = p as typeof p & { title?: string }
      return { extId: preset.extId, id: preset.id, title: preset.title ?? preset.id, layout: (preset as { layout?: unknown }).layout }
    })
    const saved = savedLayouts.map(t => ({ extId: 'codesurf', id: `saved.${t.id}`, title: t.name, layout: t.tree }))
    const all = [...BUILTIN_LAYOUT_PRESETS, ...saved, ...contributed]
    const seen = new Set<string>()
    const deduped = all.filter(p => {
      const name = (p.title ?? '').trim()
      if (!name || seen.has(name.toLowerCase())) return false
      seen.add(name.toLowerCase())
      return true
    })
    return deduped.map(p => ({
      extId: p.extId, id: `layout.${p.id}`,
      title: `Layout: ${p.title}`, category: 'Layouts',
      _run: () => window.dispatchEvent(new CustomEvent('codesurf:open-layout-preset', { detail: p })),
    }))
  }, [layoutPresets, savedLayouts])

  const visible = useMemo<PaletteCommand[]>(
    () => [...BUILTIN_COMMANDS, ...presetCommands, ...pluginCommands].filter(c => c.palette !== false),
    [presetCommands, pluginCommands],
  )

  // Filter by query (case-insensitive substring over title + slash + id).
  const filtered = useMemo<PaletteCommand[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return visible
    return visible.filter(c =>
      `${c.title} ${c.slash ?? ''} ${c.id}`.toLowerCase().includes(q),
    )
  }, [visible, query])

  // Group by category, preserving first-seen order; `flat` is the display order
  // used for keyboard selection so the highlighted row matches the rendered one.
  const { groups, flat } = useMemo(() => {
    const byCategory = new Map<string, PaletteCommand[]>()
    for (const cmd of filtered) {
      const key = cmd.category || 'Commands'
      const arr = byCategory.get(key) ?? []
      arr.push(cmd)
      byCategory.set(key, arr)
    }
    const g = [...byCategory.entries()]
    return { groups: g, flat: g.flatMap(([, cmds]) => cmds) }
  }, [filtered])

  const run = (cmd: PaletteCommand | undefined): void => {
    if (!cmd) return
    onOpenChange(false)
    const builtin = cmd as Partial<BuiltinCommand>
    if (typeof builtin._run === 'function') builtin._run()
    else void executeCommand(cmd)
  }

  // Reset query + selection and focus the input each time the palette opens.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  // Keep selection in range as the filtered list shrinks/grows.
  useEffect(() => { setSelected(s => Math.min(s, Math.max(0, flat.length - 1))) }, [flat.length])

  // Scroll the selected row into view on keyboard navigation.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onOpenChange(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(flat.length - 1, s + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(0, s - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[selected]) }
  }

  let idx = -1 // running index across groups → maps each row to its `flat` position

  return createPortal(
    <div
      role="dialog"
      aria-label="Command Palette"
      onMouseDown={e => { if (e.target === e.currentTarget) onOpenChange(false) }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: 'rgba(0, 0, 0, 0.28)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '7vh',
      }}
    >
      <div
        onKeyDown={onKeyDown}
        style={{
          width: 'min(680px, calc(100vw - 72px))',
          maxHeight: 'min(560px, calc(100vh - 96px))',
          borderRadius: 22,
          background: theme.surface.panelElevated,
          border: `1px solid ${theme.border.default}`,
          boxShadow: theme.shadow.panel,
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setSelected(0) }}
          placeholder="Type a command…"
          style={{
            width: '100%', border: 'none', outline: 'none', background: 'transparent',
            color: theme.text.primary,
            fontSize: Math.max(15, fonts.size + 2), fontFamily: fonts.primary, fontWeight: 600,
            padding: '12px 16px 10px', boxSizing: 'border-box',
          }}
        />
        <div ref={listRef} className="cs-fade-scroll-y cs-fade-scroll-y-sm" style={{ overflowY: 'auto', paddingBottom: 6 }}>
          {groups.map(([category, cmds]) => (
            <div key={category}>
              <div style={{ padding: '8px 14px 6px', color: theme.text.disabled, fontSize: Math.max(11, fonts.secondarySize), fontWeight: 700 }}>
                {category}
              </div>
              {cmds.map(cmd => {
                idx += 1
                const i = idx
                const isSel = i === selected
                const shortcut = cmd.slash ? `/${cmd.slash}` : cmd.keybinding
                return (
                  <button
                    key={`${cmd.extId}:${cmd.id}`}
                    type="button"
                    data-idx={i}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => run(cmd)}
                    style={{
                      width: '100%', border: 'none', borderRadius: 14,
                      background: isSel ? theme.surface.hover : 'transparent',
                      color: isSel ? theme.text.primary : theme.text.secondary,
                      cursor: 'pointer',
                      display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto',
                      alignItems: 'center', gap: 8,
                      padding: '7px 12px', fontFamily: fonts.primary, textAlign: 'left',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: Math.max(12, fonts.size), fontWeight: 400 }}>
                      {cmd.title}
                    </span>
                    {shortcut ? (
                      <span style={{ borderRadius: 10, background: theme.surface.panelMuted, color: theme.text.secondary, padding: '1px 7px', fontSize: Math.max(11, fonts.secondarySize), lineHeight: 1.35 }}>
                        {shortcut}
                      </span>
                    ) : <span />}
                  </button>
                )
              })}
            </div>
          ))}
          {flat.length === 0 && (
            <div style={{ padding: '16px 14px 22px', color: theme.text.disabled, fontSize: Math.max(12, fonts.size) }}>
              No commands found
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
