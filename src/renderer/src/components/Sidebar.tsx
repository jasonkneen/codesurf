import React, { useEffect, useState, useCallback, useRef } from 'react'
import type { Workspace } from '../../../shared/types'
import { ContextMenu, MenuItem } from './ContextMenu'

interface FsEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
}

interface Props {
  workspace: Workspace | null
  workspaces: Workspace[]
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: (name: string) => void
  onOpenFile: (filePath: string) => void
  onNewTerminal: () => void
  onNewKanban: () => void
  collapsed: boolean
  onToggleCollapse: () => void
}

type SortMode = 'name' | 'ext' | 'type'
const SORT_MODES: SortMode[] = ['name', 'type', 'ext']
const SORT_LABELS: Record<SortMode, string> = { name: 'Name', type: 'Type', ext: 'Ext' }

const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.DS_Store', '__pycache__', '.cache', 'out'])

const EXT_COLORS: Record<string, string> = {
  '.ts': '#3178c6', '.tsx': '#3178c6',
  '.js': '#c8b400', '.jsx': '#c8b400',
  '.json': '#c8b400',
  '.md': '#6db33f', '.markdown': '#6db33f', '.mdx': '#6db33f', '.txt': '#666',
  '.css': '#7b5ea7', '.html': '#e34c26',
  '.py': '#3572a5', '.rs': '#dea584', '.go': '#00acd7',
  '.png': '#c0392b', '.jpg': '#c0392b', '.jpeg': '#c0392b',
  '.gif': '#c0392b', '.webp': '#c0392b', '.svg': '#e67e22',
  '.sh': '#89e051', '.bash': '#89e051', '.zsh': '#89e051',
  '.yaml': '#cb171e', '.yml': '#cb171e', '.toml': '#9c4221',
}

// Category groupings for ext mode
const EXT_CATEGORIES: { label: string; exts: Set<string> }[] = [
  { label: 'TypeScript',  exts: new Set(['.ts', '.tsx']) },
  { label: 'JavaScript',  exts: new Set(['.js', '.jsx', '.mjs', '.cjs']) },
  { label: 'Styles',      exts: new Set(['.css', '.scss', '.sass', '.less']) },
  { label: 'Markup',      exts: new Set(['.html', '.xml', '.svg']) },
  { label: 'Data',        exts: new Set(['.json', '.yaml', '.yml', '.toml', '.csv', '.env']) },
  { label: 'Docs',        exts: new Set(['.md', '.mdx', '.markdown', '.txt', '.rst']) },
  { label: 'Scripts',     exts: new Set(['.sh', '.bash', '.zsh', '.fish']) },
  { label: 'Images',      exts: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp']) },
  { label: 'Python',      exts: new Set(['.py', '.pyx', '.pyi']) },
  { label: 'Rust',        exts: new Set(['.rs', '.toml']) },
  { label: 'Go',          exts: new Set(['.go', '.mod', '.sum']) },
  { label: 'Config',      exts: new Set(['.lock', '.gitignore', '.eslintrc', '.prettierrc', '.editorconfig']) },
]

function extCategory(ext: string): string {
  for (const cat of EXT_CATEGORIES) {
    if (cat.exts.has(ext)) return cat.label
  }
  return 'Other'
}

function sortEntries(entries: FsEntry[], mode: SortMode): FsEntry[] {
  const dirs = [...entries.filter(e => e.isDir)].sort((a, b) => a.name.localeCompare(b.name))
  const files = entries.filter(e => !e.isDir)
  let sorted: FsEntry[]
  if (mode === 'name') {
    sorted = [...files].sort((a, b) => a.name.localeCompare(b.name))
  } else if (mode === 'ext') {
    sorted = [...files].sort((a, b) => {
      const ca = extCategory(a.ext), cb = extCategory(b.ext)
      const cc = ca.localeCompare(cb)
      return cc !== 0 ? cc : a.name.localeCompare(b.name)
    })
  } else {
    sorted = [...files].sort((a, b) => a.name.localeCompare(b.name))
  }
  return [...dirs, ...sorted]
}

function FileDot({ ext }: { ext: string }): JSX.Element {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%',
      background: EXT_COLORS[ext] ?? '#3a3a3a',
      flexShrink: 0, display: 'inline-block',
      marginRight: 8
    }} />
  )
}

// ─── Flat directory block ─────────────────────────────────────────────────────
// Each directory renders as a collapsible header + flat list of its direct children
// Sub-directories render as nested blocks (but without indentation — same left edge)

interface DirBlockProps {
  path: string
  name: string
  depth: number
  sortMode: SortMode
  onOpenFile: (p: string) => void
  onCtxMenu: (e: React.MouseEvent, entry: FsEntry) => void
  onRefresh: () => void
  defaultOpen?: boolean
}

function DirBlock({ path, name, depth, sortMode, onOpenFile, onCtxMenu, onRefresh, defaultOpen }: DirBlockProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen ?? depth === 0)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [hovered, setHovered] = useState(false)

  const load = useCallback(async () => {
    const items: FsEntry[] = await window.electron.fs.readDir(path).catch(() => [])
    const filtered = items.filter(e => !IGNORED.has(e.name))
    setEntries(sortEntries(filtered, sortMode))
    setLoaded(true)
  }, [path, sortMode])

  useEffect(() => {
    if (open && !loaded) load()
  }, [open, loaded, load])

  useEffect(() => {
    if (loaded) {
      setEntries(prev => sortEntries(prev, sortMode))
    }
  }, [sortMode])

  const toggle = () => {
    if (!loaded && !open) load()
    setOpen(p => !p)
  }

  const dirs = entries.filter(e => e.isDir)
  const files = entries.filter(e => !e.isDir)

  return (
    <div>
      {/* Folder header — only show for non-root */}
      {depth > 0 && (
        <div
          style={{
            display: 'flex', alignItems: 'center',
            height: 22, paddingLeft: 10, paddingRight: 8,
            cursor: 'pointer', userSelect: 'none',
            background: hovered ? '#252525' : 'transparent',
            margin: '0 3px', borderRadius: 3,
            marginTop: open ? 4 : 0
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={toggle}
          onContextMenu={e => { e.preventDefault(); onCtxMenu(e, { name, path, isDir: true, ext: '' }) }}
        >
          <span style={{
            fontSize: 9, color: open ? '#777' : '#555',
            marginRight: 7, display: 'inline-block', width: 8, flexShrink: 0
          }}>
            {open ? '▾' : '▸'}
          </span>
          <span style={{
            fontSize: 11, color: '#666', fontWeight: 500,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            letterSpacing: '0.02em'
          }}>
            {name}
          </span>
        </div>
      )}

      {open && (
        <div style={depth > 0 ? { borderLeft: '1px solid #252525', marginLeft: 14, paddingLeft: 0 } : {}}>
          {/* Files — with category headers in ext mode */}
          {sortMode === 'ext'
            ? (() => {
                const rows: JSX.Element[] = []
                let lastCat = ''
                for (const f of files) {
                  const cat = extCategory(f.ext)
                  if (cat !== lastCat) {
                    lastCat = cat
                    rows.push(
                      <div key={`cat-${cat}-${f.path}`} style={{
                        padding: '6px 10px 2px',
                        fontSize: 9, color: '#444',
                        letterSpacing: '0.07em', textTransform: 'uppercase',
                        userSelect: 'none'
                      }}>
                        {cat}
                      </div>
                    )
                  }
                  rows.push(<FileRow key={f.path} entry={f} onOpenFile={onOpenFile} onCtxMenu={onCtxMenu} />)
                }
                return rows
              })()
            : files.map(f => (
                <FileRow key={f.path} entry={f} onOpenFile={onOpenFile} onCtxMenu={onCtxMenu} />
              ))
          }
          {/* Sub-dirs as nested blocks */}
          {dirs.map(d => (
            <DirBlock
              key={d.path}
              path={d.path}
              name={d.name}
              depth={depth + 1}
              sortMode={sortMode}
              onOpenFile={onOpenFile}
              onCtxMenu={onCtxMenu}
              onRefresh={onRefresh}
            />
          ))}
          {loaded && entries.length === 0 && (
            <div style={{ paddingLeft: 10, height: 20, fontSize: 11, color: '#3a3a3a', display: 'flex', alignItems: 'center' }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── File row ─────────────────────────────────────────────────────────────────
function FileRow({ entry, onOpenFile, onCtxMenu }: {
  entry: FsEntry
  onOpenFile: (p: string) => void
  onCtxMenu: (e: React.MouseEvent, entry: FsEntry) => void
}): JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center',
        height: 22, paddingLeft: 10, paddingRight: 8,
        cursor: 'pointer', userSelect: 'none',
        background: hovered ? '#2a2d2e' : 'transparent',
        borderRadius: 3, margin: '0 3px'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onOpenFile(entry.path)}
      onContextMenu={e => { e.preventDefault(); onCtxMenu(e, entry) }}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', entry.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <FileDot ext={entry.ext} />
      <span style={{
        fontSize: 12, color: '#999',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flex: 1
      }}>
        {entry.name}
      </span>
    </div>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
interface CtxState { x: number; y: number; entry: FsEntry }

export function Sidebar({
  workspace, workspaces, onSwitchWorkspace, onNewWorkspace, onOpenFile, onNewTerminal, onNewKanban,
  collapsed, onToggleCollapse
}: Props): JSX.Element {
  const [sortMode, setSortMode] = useState<SortMode>('name')
  const [width, setWidth] = useState(240)
  const [refreshKey, setRefreshKey] = useState(0)
  const resizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false)
  const [newWsInput, setNewWsInput] = useState(false)
  const [newWsName, setNewWsName] = useState('')
  const [ctx, setCtx] = useState<CtxState | null>(null)
  const [creatingIn, setCreatingIn] = useState<{ dir: string; type: 'file' | 'folder' } | null>(null)
  const [createName, setCreateName] = useState('')

  const refresh = useCallback(() => setRefreshKey(k => k + 1), [])

  // File watcher
  useEffect(() => {
    if (!workspace) return
    const unsub = window.electron.fs.watch?.(workspace.path, refresh)
    return () => unsub?.()
  }, [workspace, refresh])

  // Sidebar resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return
      setWidth(Math.max(160, Math.min(500, startWidth.current + e.clientX - startX.current)))
    }
    const onUp = () => { resizing.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const cycleSortMode = useCallback(() => {
    setSortMode(prev => SORT_MODES[(SORT_MODES.indexOf(prev) + 1) % SORT_MODES.length])
  }, [])

  const handleCtxMenu = useCallback((e: React.MouseEvent, entry: FsEntry) => {
    setCtx({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const submitCreate = useCallback(async () => {
    if (!creatingIn || !createName.trim()) { setCreatingIn(null); return }
    const fullPath = `${creatingIn.dir}/${createName.trim()}`
    if (creatingIn.type === 'file') await window.electron.fs.createFile(fullPath)
    else await window.electron.fs.createDir?.(fullPath)
    setCreatingIn(null)
    setCreateName('')
    refresh()
  }, [creatingIn, createName, refresh])

  const ctxItems = useCallback((): MenuItem[] => {
    if (!ctx) return []
    const { entry } = ctx
    const dir = entry.isDir ? entry.path : entry.path.split('/').slice(0, -1).join('/')
    const items: MenuItem[] = []
    if (!entry.isDir) items.push({ label: 'Open', action: () => onOpenFile(entry.path) })
    items.push({ label: 'New File',   action: () => { setCreatingIn({ dir, type: 'file' });   setCreateName('') } })
    items.push({ label: 'New Folder', action: () => { setCreatingIn({ dir, type: 'folder' }); setCreateName('') } })
    items.push({ label: '', action: () => {}, divider: true })
    items.push({ label: 'Copy Path',         action: () => navigator.clipboard.writeText(entry.path) })
    items.push({ label: 'Reveal in Finder',  action: () => window.electron.fs.revealInFinder?.(entry.path) })
    items.push({ label: '', action: () => {}, divider: true })
    items.push({
      label: `Delete ${entry.isDir ? 'Folder' : 'File'}`,
      danger: true,
      action: async () => {
        await window.electron.fs.deleteFile?.(entry.path)
        refresh()
      }
    })
    return items
  }, [ctx, onOpenFile, refresh])

  return (
    <div style={{
      width: collapsed ? 0 : width,
      minWidth: collapsed ? 0 : undefined,
      flexShrink: 0,
      background: '#1e1e1e', borderRight: collapsed ? 'none' : '1px solid #2d2d2d',
      display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
      transition: 'width 0.15s ease'
    }}>

      {/* Workspace switcher */}
      <div style={{ padding: '8px 10px 6px', borderBottom: '1px solid #2d2d2d' }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            padding: '4px 8px', borderRadius: 6,
            background: wsDropdownOpen ? '#2a2d2e' : 'transparent'
          }}
          onClick={() => setWsDropdownOpen(p => !p)}
        >
          <span style={{
            fontSize: 13, color: '#cccccc', fontWeight: 600,
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {workspace?.name ?? 'No workspace'}
          </span>
          <span style={{ fontSize: 9, color: '#555' }}>{wsDropdownOpen ? '▴' : '▾'}</span>
        </div>

        {wsDropdownOpen && (
          <div style={{ marginTop: 4, background: '#252526', border: '1px solid #3a3a3a', borderRadius: 6, overflow: 'hidden' }}>
            {workspaces.map(ws => (
              <div key={ws.id}
                style={{ padding: '6px 12px', fontSize: 12, color: ws.id === workspace?.id ? '#4a9eff' : '#cccccc', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#2a2d2e')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onClick={() => { onSwitchWorkspace(ws.id); setWsDropdownOpen(false) }}
              >
                {ws.name}
              </div>
            ))}
            <div style={{ height: 1, background: '#333', margin: '2px 0' }} />
            {newWsInput ? (
              <div style={{ padding: '4px 8px' }}>
                <input autoFocus value={newWsName} onChange={e => setNewWsName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newWsName.trim()) {
                      onNewWorkspace(newWsName.trim())
                      setNewWsName(''); setNewWsInput(false); setWsDropdownOpen(false)
                    }
                    if (e.key === 'Escape') { setNewWsInput(false); setNewWsName('') }
                  }}
                  placeholder="Workspace name…"
                  style={{ width: '100%', padding: '4px 8px', fontSize: 12, borderRadius: 4, background: '#1e1e1e', color: '#ccc', border: '1px solid #4a9eff', outline: 'none' }}
                />
              </div>
            ) : (
              <div style={{ padding: '6px 12px', fontSize: 12, color: '#888', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#2a2d2e')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onClick={() => setNewWsInput(true)}
              >
                + Add workspace
              </div>
            )}
          </div>
        )}
      </div>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '5px 12px 3px', borderBottom: '1px solid #262626'
      }}>
        <span style={{ fontSize: 10, color: '#444', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Files
        </span>
        <button
          onClick={cycleSortMode}
          style={{
            fontSize: 10, color: '#555', background: 'transparent', border: 'none',
            cursor: 'pointer', padding: '2px 6px', borderRadius: 4, letterSpacing: '0.04em'
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#999'; e.currentTarget.style.background = '#2a2d2e' }}
          onMouseLeave={e => { e.currentTarget.style.color = '#555'; e.currentTarget.style.background = 'transparent' }}
        >
          {SORT_LABELS[sortMode]}
        </button>
      </div>

      {/* File list */}
      <div
        style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}
        onContextMenu={e => {
          if (e.target === e.currentTarget && workspace) {
            e.preventDefault()
            setCtx({ x: e.clientX, y: e.clientY, entry: { name: workspace.name, path: workspace.path, isDir: true, ext: '' } })
          }
        }}
      >
        {workspace ? (
          <DirBlock
            key={`${workspace.id}-${refreshKey}`}
            path={workspace.path}
            name={workspace.name}
            depth={0}
            sortMode={sortMode}
            onOpenFile={onOpenFile}
            onCtxMenu={handleCtxMenu}
            onRefresh={refresh}
            defaultOpen
          />
        ) : (
          <div style={{ padding: '16px', fontSize: 12, color: '#555' }}>No workspace open</div>
        )}

        {/* Inline create input */}
        {creatingIn && (
          <div style={{ padding: '4px 10px' }}>
            <input
              autoFocus
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitCreate()
                if (e.key === 'Escape') { setCreatingIn(null); setCreateName('') }
                e.stopPropagation()
              }}
              onBlur={submitCreate}
              placeholder={creatingIn.type === 'file' ? 'filename.ts' : 'folder-name'}
              style={{
                width: '100%', padding: '4px 8px', fontSize: 12, borderRadius: 4,
                background: '#161616', color: '#ccc',
                border: '1px solid #4a9eff', outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div style={{ borderTop: '1px solid #2d2d2d', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          style={{ width: '100%', padding: '6px 0', borderRadius: 6, border: '1px solid #3a3a3a', background: '#252526', color: '#c8c8c8', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
          onMouseEnter={e => (e.currentTarget.style.background = '#2a2d2e')}
          onMouseLeave={e => (e.currentTarget.style.background = '#252526')}
          onClick={onNewTerminal}
        >
          New Terminal
        </button>
        <button
          style={{ width: '100%', padding: '6px 0', borderRadius: 6, border: '1px solid #3a3a3a', background: '#252526', color: '#8b949e', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
          onMouseEnter={e => (e.currentTarget.style.background = '#2a2d2e')}
          onMouseLeave={e => (e.currentTarget.style.background = '#252526')}
          onClick={onNewKanban}
        >
          Agent Board
        </button>
      </div>

      {/* Resize handle */}
      {!collapsed && (
        <div
          style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize' }}
          onMouseDown={e => { resizing.current = true; startX.current = e.clientX; startWidth.current = width; e.preventDefault() }}
          onMouseEnter={e => (e.currentTarget.style.background = '#4a9eff44')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        />
      )}

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems()} onClose={() => setCtx(null)} />
      )}
    </div>
  )
}
