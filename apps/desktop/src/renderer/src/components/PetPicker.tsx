// PetPicker — modal for browsing, installing, and selecting pets.
//
// Layout: left = vertical scrollable list (thumbnail + name + slug per row),
// right = live animated preview of the highlighted pet cycling through its
// idle animation row. Bottom = size slider.
//
// Gallery fetched from petdex.dev (falls back to local-only on network
// failure). Pets install on click. Selecting a pet sets it active.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Download, Trash2, Loader2 } from 'lucide-react'
import {
  ATLAS,
  FRAME_DURATIONS,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  ROW_INDEX,
  type PetGalleryEntry,
  type PetManifest,
} from '../../../shared/pet-types'
import { useTheme } from '../ThemeContext'

interface PetPickerProps {
  onClose: () => void
  currentSlug: string
  scale: number
  onSelect: (slug: string) => void
  onScaleChange: (scale: number) => void
}

interface PetEntry extends PetGalleryEntry {
  thumbnailUrl?: string
  spritesheetUrl?: string
  installing?: boolean
  error?: string
}

// ── Animated preview ─────────────────────────────────────────────────────────

function PetPreview({ entry }: { entry: PetEntry | null }) {
  const [frame, setFrame] = useState(0)
  const rafRef = useRef<number>(0)

  // Cycle through idle frames
  useEffect(() => {
    if (!entry?.spritesheetUrl) return
    const durations = FRAME_DURATIONS.idle
    let idx = 0
    let last = performance.now()
    let raf: number
    const tick = (now: number) => {
      const elapsed = (now - last) / 1000
      const dur = durations[idx]
      if (dur !== undefined && elapsed >= dur) {
        idx = (idx + 1) % durations.length
        setFrame(idx)
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    rafRef.current = raf
    return () => cancelAnimationFrame(raf)
  }, [entry?.spritesheetUrl])

  if (!entry?.spritesheetUrl) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666', fontSize: 12 }}>
        Select a pet to preview
      </div>
    )
  }

  const row = ROW_INDEX.idle
  const displayW = 192
  const displayH = 208
  const sheetW = displayW * ATLAS.columns
  const sheetH = displayH * ATLAS.rows
  const bgX = -(frame * displayW)
  const bgY = -(row * displayH)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
      <div
        style={{
          width: displayW,
          height: displayH,
          overflow: 'hidden',
          backgroundImage: `url(${entry.spritesheetUrl})`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: `${bgX}px ${bgY}px`,
          backgroundSize: `${sheetW}px ${sheetH}px`,
          imageRendering: 'pixelated',
          filter: 'drop-shadow(2px 4px 8px rgba(0,0,0,0.5))',
        }}
      />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0' }}>{entry.displayName}</div>
        <div style={{ fontSize: 11, color: '#888', maxWidth: 200, marginTop: 2 }}>{entry.description}</div>
      </div>
    </div>
  )
}

// ── Main picker ──────────────────────────────────────────────────────────────

export function PetPicker({
  onClose,
  currentSlug,
  scale,
  onSelect,
  onScaleChange,
}: PetPickerProps): JSX.Element {
  const theme = useTheme()
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<PetEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSlug, setSelectedSlug] = useState<string>(currentSlug)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [gallery, installed] = await Promise.all([
        window.electron.pets.gallery(),
        window.electron.pets.list(),
      ])

      // Merge gallery + installed. Installed pets get their spritesheet data
      // fetched as base64 data URLs for the preview animation + thumbnail.
      const map = new Map<string, PetEntry>()
      for (const g of gallery) map.set(g.id, { ...g })
      for (const pet of installed as PetManifest[]) {
        const existing = map.get(pet.id)
        if (existing) {
          map.set(pet.id, { ...existing, installed: true })
        } else {
          map.set(pet.id, {
            id: pet.id,
            displayName: pet.displayName,
            description: pet.description,
            category: pet.category,
            installed: true,
          })
        }
      }

      // Fetch thumbnails + spritesheets as base64 data URLs for installed pets
      const withData = await Promise.all(
        Array.from(map.values()).map(async (entry) => {
          if (!entry.installed) return entry
          try {
            const [thumbData, sheetData] = await Promise.all([
              window.electron.pets.thumbnailData(entry.id),
              window.electron.pets.spritesheetData(entry.id),
            ])
            return {
              ...entry,
              thumbnailUrl: thumbData ?? undefined,
              spritesheetUrl: sheetData ?? undefined,
            }
          } catch {
            return entry
          }
        }),
      )
      setEntries(withData)
    } catch (err) {
      console.warn('[PetPicker] refresh failed:', err)
      const local = await window.electron.pets.galleryLocal()
      setEntries(local)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const unsub = window.electron.pets.onGalleryChanged(() => void refresh())
    return unsub
  }, [refresh])

  useEffect(() => { searchRef.current?.focus() }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) =>
      e.displayName.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q),
    )
  }, [entries, search])

  // Keyboard navigation within the list
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        const idx = filtered.findIndex((f) => f.id === selectedSlug)
        const next = filtered[Math.min(filtered.length - 1, idx + 1)]
        if (next) setSelectedSlug(next.id)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        const idx = filtered.findIndex((f) => f.id === selectedSlug)
        const prev = filtered[Math.max(0, idx - 1)]
        if (prev) setSelectedSlug(prev.id)
      } else if (e.key === 'Enter') {
        const entry = filtered.find((f) => f.id === selectedSlug)
        if (entry && entry.installed) {
          onSelect(entry.id)
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [filtered, selectedSlug, onSelect, onClose])

  const handleInstall = useCallback(async (slug: string) => {
    setEntries((prev) => prev.map((e) => (e.id === slug ? { ...e, installing: true, error: undefined } : e)))
    const result = await window.electron.pets.install(slug)
    if (!result.ok) {
      setEntries((prev) => prev.map((e) => (e.id === slug ? { ...e, installing: false, error: result.error } : e)))
    } else {
      setEntries((prev) => prev.map((e) => (e.id === slug ? { ...e, installing: false } : e)))
    }
  }, [])

  const handleRemove = useCallback(async (slug: string) => {
    await window.electron.pets.remove(slug)
  }, [])

  const handleSelect = useCallback((slug: string) => {
    setSelectedSlug(slug)
    onSelect(slug)
  }, [onSelect])

  // Theme colors
  const text = theme.text.primary
  const textMuted = theme.text.muted
  const accent = theme.accent.base
  const border = theme.border.default
  const hoverBg = theme.surface.hover
  const inputBg = theme.surface.input

  const selectedEntry = filtered.find((e) => e.id === selectedSlug) ?? null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(640px, 90vw)', maxHeight: '80vh',
          backgroundColor: '#161616', border: `1px solid ${border}`, borderRadius: 12,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: text }}>Choose a pet</h2>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 4, color: textMuted, display: 'flex' }}>
              <X size={16} />
            </button>
          </div>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: textMuted }}>
            Picking one installs it (if needed) and makes it active.
          </p>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, color: textMuted, pointerEvents: 'none' }} />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pets…"
              style={{
                width: '100%', padding: '7px 12px 7px 32px', fontSize: 13,
                backgroundColor: inputBg, border: `1px solid ${border}`, borderRadius: 6,
                color: text, outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Body: vertical list (left) + preview (right) */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Vertical list */}
          <div
            ref={listRef}
            style={{
              flex: 1, overflowY: 'auto', padding: '6px 4px',
              minWidth: 0,
            }}
          >
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 32, color: textMuted }}>
                <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: 32, color: textMuted, fontSize: 13 }}>
                No pets found{search ? ` for "${search}"` : ''}.
              </div>
            )}
            {!loading && filtered.map((entry) => (
              <PetRow
                key={entry.id}
                entry={entry}
                selected={entry.id === selectedSlug}
                isCurrent={entry.id === currentSlug}
                onSelect={() => handleSelect(entry.id)}
                onInstall={() => handleInstall(entry.id)}
                onRemove={() => handleRemove(entry.id)}
                text={text}
                textMuted={textMuted}
                accent={accent}
                border={border}
                hoverBg={hoverBg}
              />
            ))}
          </div>

          {/* Preview pane */}
          <div
            style={{
              width: 240,
              borderLeft: `1px solid ${border}`,
              backgroundColor: '#0d0d0d',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <PetPreview entry={selectedEntry} />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 16px 14px', borderTop: `1px solid ${border}` }}>
          <div style={{ fontSize: 11, color: textMuted, marginBottom: 8 }}>
            Showing {filtered.length} of {entries.length}
            {search ? ' — type to narrow it down.' : '.'}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: text, marginBottom: 2 }}>Size</div>
          <p style={{ margin: '0 0 6px', fontSize: 11, color: textMuted }}>
            Resize the floating mascot. Applies everywhere instantly.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range"
              min={PET_SCALE_MIN}
              max={PET_SCALE_MAX}
              step={0.01}
              value={scale}
              onChange={(e) => onScaleChange(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: accent, cursor: 'pointer' }}
            />
            <span style={{ fontSize: 11, color: textMuted, minWidth: 36, textAlign: 'right' }}>
              {Math.round(scale * 100)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Pet row ──────────────────────────────────────────────────────────────────

interface PetRowProps {
  entry: PetEntry
  selected: boolean
  isCurrent: boolean
  onSelect: () => void
  onInstall: () => void
  onRemove: () => void
  text: string
  textMuted: string
  accent: string
  border: string
  hoverBg: string
}

function PetRow({
  entry, selected, isCurrent, onSelect, onInstall, onRemove,
  text, textMuted, accent, border, hoverBg,
}: PetRowProps): JSX.Element {
  return (
    <div
      onClick={entry.installed ? onSelect : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 8px', borderRadius: 6, margin: '1px 0',
        backgroundColor: selected ? hoverBg : 'transparent',
        border: selected ? `1px solid ${accent}` : '1px solid transparent',
        cursor: entry.installed ? 'pointer' : 'default',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.backgroundColor = hoverBg }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.backgroundColor = 'transparent' }}
    >
      {/* Thumbnail */}
      <div
        style={{
          width: 28, height: 28, flexShrink: 0, borderRadius: 4,
          backgroundColor: '#0d0d0d', overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {entry.thumbnailUrl ? (
          <img
            src={entry.thumbnailUrl}
            alt={entry.displayName}
            style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <div style={{ width: 14, height: 14, borderRadius: '50%', backgroundColor: '#333' }} />
        )}
      </div>
      {/* Name + slug */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, color: text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {entry.displayName}
          {isCurrent && <span style={{ color: accent, marginLeft: 4 }}>●</span>}
        </div>
        <div style={{
          fontSize: 11, color: textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {entry.id}{entry.installed ? ' · installed' : ''}
        </div>
        {entry.error && <div style={{ fontSize: 10, color: '#ff6b6b' }}>{entry.error}</div>}
      </div>
      {/* Action */}
      {entry.installing ? (
        <Loader2 size={13} style={{ color: textMuted, animation: 'spin 1s linear infinite' }} />
      ) : !entry.installed ? (
        <button
          onClick={(e) => { e.stopPropagation(); onInstall() }}
          style={{
            background: 'none', border: `1px solid ${border}`, borderRadius: 4,
            padding: '2px 6px', cursor: 'pointer', color: textMuted,
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
          }}
        >
          <Download size={11} /> Install
        </button>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 2,
            color: textMuted, display: 'flex', opacity: 0.4,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.4' }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
