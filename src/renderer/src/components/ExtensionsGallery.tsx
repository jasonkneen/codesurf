import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Package, Search, Star, X, Check, Plus } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'

const EXTENSIONS_CHANGED_EVENT = 'codesurf:extensions-changed'

type ExtensionListEntry = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  tier: 'safe' | 'power'
  ui?: import('../../../shared/types').ExtensionManifest['ui']
  enabled: boolean
  contributes?: import('../../../shared/types').ExtensionManifest['contributes']
  dirPath?: string | null
}

type Tab = 'recent' | 'popular' | 'installed'

interface Props {
  onClose: () => void
  workspacePath?: string | null
}

export function ExtensionsGallery({ onClose, workspacePath }: Props): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [tab, setTab] = useState<Tab>('popular')
  const [entries, setEntries] = useState<ExtensionListEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.electron.extensions.list()
      setEntries(list as ExtensionListEntry[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const notify = () => window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED_EVENT))

  const setEnabled = useCallback(async (id: string, nextEnabled: boolean) => {
    setBusyId(id)
    try {
      if (nextEnabled) await window.electron.extensions.enable(id)
      else await window.electron.extensions.disable(id)
      await window.electron.extensions.refresh(workspacePath ?? null)
      notify()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }, [load, workspacePath])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = entries
    if (tab === 'installed') {
      list = list.filter(e => e.enabled)
    } else if (tab === 'recent') {
      // Sort by id desc as a proxy for install order until a real "addedAt" exists
      list = [...list].reverse()
    } else {
      // Popular: alphabetical by name as a stable placeholder
      list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    }
    if (q) {
      list = list.filter(e =>
        e.name.toLowerCase().includes(q)
        || (e.description ?? '').toLowerCase().includes(q)
        || e.id.toLowerCase().includes(q)
      )
    }
    return list
  }, [entries, tab, query])

  const counts = useMemo(() => ({
    recent: entries.length,
    popular: entries.length,
    installed: entries.filter(e => e.enabled).length,
  }), [entries])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Extensions Gallery"
        style={{
          width: 'min(920px, 100%)',
          maxHeight: '85vh',
          background: theme.surface.panel,
          border: `1px solid ${theme.border.default}`,
          borderRadius: 14,
          boxShadow: theme.shadow.panel,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: fonts.primary,
          color: theme.text.primary,
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${theme.border.subtle}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <Package size={20} style={{ color: theme.accent.base }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: fonts.size + 2, fontWeight: 700 }}>Extensions</div>
            <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary }}>
              Browse and install capabilities. Extensions integrate into toolbars, menus and context actions once enabled.
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close"
            style={{
              width: 30, height: 30, borderRadius: 6,
              border: 'none', background: 'transparent',
              color: theme.text.secondary, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = theme.surface.panelMuted }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs + search */}
        <div style={{
          padding: '10px 20px',
          borderBottom: `1px solid ${theme.border.subtle}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <div style={{ display: 'flex', gap: 2 }}>
            {([
              { id: 'recent', label: 'Recent' },
              { id: 'popular', label: 'Popular' },
              { id: 'installed', label: 'Installed' },
            ] as { id: Tab; label: string }[]).map(t => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: 'none',
                    background: active ? theme.surface.selection : 'transparent',
                    color: active ? theme.text.primary : theme.text.secondary,
                    fontSize: fonts.size,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t.label}
                  <span style={{
                    fontSize: Math.max(10, fonts.secondarySize - 1),
                    color: active ? theme.text.secondary : theme.text.disabled,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {counts[t.id]}
                  </span>
                </button>
              )
            })}
          </div>
          <div style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: theme.surface.panelMuted,
            border: `1px solid ${theme.border.subtle}`,
            borderRadius: 8,
            padding: '4px 8px',
            minWidth: 220,
          }}>
            <Search size={13} style={{ color: theme.text.disabled }} />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search extensions"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: theme.text.primary,
                fontSize: fonts.size,
                fontFamily: fonts.primary,
              }}
            />
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {error && (
            <div style={{
              padding: 10,
              marginBottom: 10,
              background: `${theme.status.danger}22`,
              border: `1px solid ${theme.status.danger}`,
              borderRadius: 8,
              color: theme.status.danger,
              fontSize: fonts.secondarySize,
            }}>
              {error}
            </div>
          )}

          {loading && entries.length === 0 ? (
            <div style={{ color: theme.text.disabled, fontSize: fonts.size, textAlign: 'center', padding: 40 }}>
              Loading extensions…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ color: theme.text.disabled, fontSize: fonts.size, textAlign: 'center', padding: 40 }}>
              {query ? 'No extensions match your search.'
                : tab === 'installed' ? 'No extensions installed yet. Browse Popular or Recent to add some.'
                : 'No extensions available.'}
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 10,
            }}>
              {filtered.map(ext => (
                <ExtensionCard
                  key={ext.id}
                  ext={ext}
                  busy={busyId === ext.id}
                  onToggle={() => setEnabled(ext.id, !ext.enabled)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ExtensionCard({
  ext, busy, onToggle,
}: { ext: ExtensionListEntry; busy: boolean; onToggle: () => void }): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const installed = ext.enabled

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: 12,
      background: theme.surface.panelMuted,
      border: `1px solid ${theme.border.subtle}`,
      borderRadius: 10,
      minHeight: 110,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6,
          background: theme.surface.panel,
          border: `1px solid ${theme.border.subtle}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: theme.accent.base,
          flexShrink: 0,
        }}>
          <Star size={14} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: fonts.size, fontWeight: 700, color: theme.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ext.name}
          </div>
          <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontVariantNumeric: 'tabular-nums' }}>
            v{ext.version}{ext.author ? ` · ${ext.author}` : ''}
          </div>
        </div>
        {ext.tier === 'power' && (
          <span style={{
            fontSize: Math.max(9, fonts.secondarySize - 2),
            padding: '2px 6px',
            borderRadius: 4,
            background: `${theme.status.warning}22`,
            color: theme.status.warning,
            letterSpacing: 0.4,
            fontWeight: 700,
          }}>POWER</span>
        )}
      </div>
      <div style={{
        flex: 1,
        fontSize: fonts.secondarySize,
        color: theme.text.secondary,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      }}>
        {ext.description ?? 'No description provided.'}
      </div>
      <button
        onClick={onToggle}
        disabled={busy}
        style={{
          marginTop: 2,
          alignSelf: 'flex-start',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          borderRadius: 6,
          border: `1px solid ${installed ? theme.border.default : theme.accent.base}`,
          background: installed ? 'transparent' : theme.accent.base,
          color: installed ? theme.text.secondary : theme.text.inverse,
          fontSize: fonts.size,
          fontWeight: 600,
          cursor: busy ? 'progress' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {installed ? <><Check size={13} /> Installed</> : <><Plus size={13} /> Add</>}
      </button>
    </div>
  )
}
