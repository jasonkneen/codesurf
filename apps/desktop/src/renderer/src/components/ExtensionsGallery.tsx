import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Package, Search, Star, X, Check, Plus, AlertTriangle } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import { getExtensionTrustDisclosure } from './extensionTrustDisclosure'

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
  capabilities?: import('../../../shared/types').ExtensionCapabilityRequest[]
  dirPath?: string | null
}

type Tab = 'recent' | 'popular' | 'installed'

interface Props {
  onClose: () => void
  workspacePath?: string | null
  /** Called after any settings mutation performed by the gallery (e.g. the
   *  "Enable extensions" banner flipping `extensionsDisabled`) so the parent
   *  (App.tsx) can keep its in-memory settings state in sync with disk. */
  onSettingsChange?: (settings: import('../../../shared/types').AppSettings) => void
}

export function ExtensionsGallery({ onClose, workspacePath, onSettingsChange }: Props): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [tab, setTab] = useState<Tab>('popular')
  const [entries, setEntries] = useState<ExtensionListEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [extensionsGloballyDisabled, setExtensionsGloballyDisabled] = useState(false)
  const [enablingGlobal, setEnablingGlobal] = useState(false)
  // `ready` stays false until the first extension list resolves, so the
  // dialog can fade in at its final size instead of snapping larger once
  // content arrives. Backdrop still renders immediately so the user gets
  // instant feedback when they click the menu item.
  const [ready, setReady] = useState(false)

  const refreshGlobalFlag = useCallback(async () => {
    try {
      const s = await window.electron.settings?.get?.()
      setExtensionsGloballyDisabled(Boolean((s as { extensionsDisabled?: boolean } | null)?.extensionsDisabled))
    } catch { /* ignore */ }
  }, [])

  const load = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      // Force-refresh on open so bundled extensions are picked up even if an
      // earlier scan happened while `extensionsDisabled` was flipped. We fall
      // back to `list()` when refresh isn't available or errors out.
      let list: unknown[] | null = null
      if (opts?.force && window.electron.extensions.refresh) {
        try {
          list = (await window.electron.extensions.refresh(workspacePath ?? null)) as unknown[]
        } catch {
          list = null
        }
      }
      if (!list) {
        list = (await window.electron.extensions.list()) as unknown[]
      }
      setEntries((list ?? []) as ExtensionListEntry[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      // Defer one frame so the initial render (opacity 0) commits before
      // we flip to opacity 1 — otherwise the CSS transition has nothing
      // to animate from.
      requestAnimationFrame(() => setReady(true))
    }
  }, [workspacePath])

  const [installing, setInstalling] = useState(false)
  // Marketplace: install a plugin the user picks from disk (.vsix / .zip). The
  // native file dialog runs in main; on success we force a rescan so the new
  // plugin appears (disabled by default, capability-gated) and notify the app.
  const installFromFile = useCallback(async () => {
    setInstalling(true)
    setError(null)
    try {
      const result = await window.electron.extensions.installFromFile?.()
      if (result?.ok) {
        await load({ force: true })
        notify()
      } else if (result && !result.canceled && result.error) {
        setError(result.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }, [load])

  const enableExtensionsGlobally = useCallback(async () => {
    setEnablingGlobal(true)
    try {
      const current = await window.electron.settings?.get?.()
      if (current) {
        const next = await window.electron.settings?.set?.({ ...current, extensionsDisabled: false })
        // Propagate to App.tsx so `settings.extensionsDisabled` state flips
        // there too — otherwise sidebar `useExtensions` stays disabled and
        // won't react to the EXTENSIONS_CHANGED_EVENT below.
        if (next && onSettingsChange) onSettingsChange(next)
      }
      setExtensionsGloballyDisabled(false)
      // Now force a rescan + reload so the gallery populates.
      await load({ force: true })
      // Notify the rest of the renderer (sidebar, chat composer `+` menu,
      // etc.) so they re-query their lists instead of showing the stale
      // "disabled" view captured when the app started.
      notify()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setEnablingGlobal(false)
    }
  }, [load, onSettingsChange])

  useEffect(() => {
    // Force a rescan when the gallery opens so bundled extensions and any
    // newly-installed ones appear without requiring an app restart.
    refreshGlobalFlag()
    load({ force: true })
  }, [load, refreshGlobalFlag])

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
    // Popular now lists everything — installed + available — sorted
    // alphabetically. Filters only narrow by the search query.
    let list = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    if (q) {
      list = list.filter(e =>
        e.name.toLowerCase().includes(q)
        || (e.description ?? '').toLowerCase().includes(q)
        || e.id.toLowerCase().includes(q)
      )
    }
    return list
  }, [entries, query])

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
        // Match SettingsPanel backdrop so both modals feel identical
        // when opened from different entry points.
        background: theme.mode === 'light'
          ? `color-mix(in srgb, ${theme.text.primary} 18%, transparent)`
          : `color-mix(in srgb, #000 70%, transparent)`,
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        opacity: ready ? 1 : 0,
        transition: 'opacity 160ms ease-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Plugins Gallery"
        style={{
          // Fixed footprint so the dialog doesn't snap to a larger size
          // the moment the first `extensions.list()` call resolves.
          width: 'min(920px, 100%)',
          height: '85vh',
          maxHeight: 780,
          background: theme.surface.panel,
          border: `1px solid ${theme.border.default}`,
          borderRadius: 14,
          boxShadow: theme.shadow.panel,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: fonts.primary,
          color: theme.text.primary,
          transform: ready ? 'scale(1)' : 'scale(0.98)',
          transition: 'transform 160ms ease-out',
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
            <div style={{ fontSize: fonts.size + 2, fontWeight: 700 }}>Plugins</div>
            <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary }}>
              Browse and install capabilities. Plugins integrate into toolbars, menus and context actions once enabled.
            </div>
          </div>
          <button
            onClick={installFromFile}
            disabled={installing}
            title="Install a plugin from a .vsix or .zip file"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 8,
              border: `1px solid ${theme.border.default}`,
              background: theme.surface.panelMuted,
              color: theme.text.primary, cursor: installing ? 'progress' : 'pointer',
              fontSize: fonts.size, fontWeight: 600, opacity: installing ? 0.6 : 1,
            }}
          >
            <Plus size={14} /> {installing ? 'Installing…' : 'Add from file'}
          </button>
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
              { id: 'popular', label: 'Popular' },
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
                    color: active ? theme.accent.base : theme.text.secondary,
                    fontSize: fonts.size,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    boxShadow: active ? `inset 0 0 0 1px color-mix(in srgb, ${theme.accent.base} 14%, transparent)` : 'none',
                    transition: 'background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
                  }}
                  onMouseEnter={e => {
                    if (!active) e.currentTarget.style.background = theme.surface.hover
                  }}
                  onMouseLeave={e => {
                    if (!active) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {t.label}
                  <span style={{
                    fontSize: Math.max(10, fonts.secondarySize - 1),
                    color: active ? theme.text.muted : theme.text.disabled,
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
              placeholder="Search plugins"
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
          {extensionsGloballyDisabled && (
            <div style={{
              padding: '10px 12px',
              marginBottom: 12,
              background: `${theme.status.warning}18`,
              border: `1px solid ${theme.status.warning}55`,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: fonts.size,
              color: theme.text.primary,
            }}>
              <AlertTriangle size={15} style={{ color: theme.status.warning, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>Plugins are globally disabled</div>
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary }}>
                  Turn them back on to browse, add, and use available plugins.
                </div>
              </div>
              <button
                onClick={enableExtensionsGlobally}
                disabled={enablingGlobal}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: `1px solid ${theme.accent.base}`,
                  background: theme.accent.base,
                  color: theme.text.inverse,
                  fontSize: fonts.size,
                  fontWeight: 600,
                  cursor: enablingGlobal ? 'progress' : 'pointer',
                  opacity: enablingGlobal ? 0.7 : 1,
                }}
              >
                {enablingGlobal ? 'Enabling…' : 'Enable extensions'}
              </button>
            </div>
          )}

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
              {query ? 'No extensions match your search.' : 'No extensions available.'}
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
  const trustDisclosure = getExtensionTrustDisclosure(ext.tier)

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
      {trustDisclosure && (
        <div
          aria-label="POWER plugin trust notice"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
            padding: '7px 8px',
            borderRadius: 6,
            background: `${theme.status.warning}14`,
            border: `1px solid ${theme.status.warning}44`,
            color: theme.text.secondary,
            fontSize: Math.max(10, fonts.secondarySize - 1),
            lineHeight: 1.35,
          }}
        >
          <AlertTriangle
            size={13}
            aria-hidden="true"
            style={{ color: theme.status.warning, flexShrink: 0, marginTop: 1 }}
          />
          <span>{trustDisclosure}</span>
        </div>
      )}
      {ext.capabilities && ext.capabilities.length > 0 && (
        <div
          title={ext.capabilities.map(c => `${c.name}${c.reason ? ` — ${c.reason}` : ''}`).join('\n')}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 4,
            fontSize: Math.max(9, fonts.secondarySize - 2),
            color: theme.text.disabled,
          }}
        >
          <span style={{ letterSpacing: 0.3 }}>Wants</span>
          {ext.capabilities.map(c => (
            <span
              key={c.name}
              style={{
                padding: '1px 5px',
                borderRadius: 4,
                background: theme.surface.panel,
                border: `1px solid ${theme.border.subtle}`,
                color: theme.text.secondary,
                fontWeight: 600,
              }}
            >
              {c.name}
            </span>
          ))}
        </div>
      )}
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
