import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Workspace } from '../../../shared/types'
import { ContextMenu, MenuItem } from './ContextMenu'
import { useAppFonts } from '../FontContext'

interface FsEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
  mtime?: number
}

interface TreeEntry extends FsEntry {
  children: TreeEntry[]
}

type GitStatus = 'modified' | 'untracked' | 'added' | 'deleted' | 'renamed' | 'conflict'
type SortMode = 'name' | 'ext' | 'type'
type ViewMode = 'tree' | 'list'

const GIT_COLORS: Record<GitStatus, string> = {
  modified: '#e2c08d',
  untracked: '#73c991',
  added: '#73c991',
  deleted: '#f44747',
  renamed: '#e2c08d',
  conflict: '#f44747',
}

const GIT_LABELS: Record<GitStatus, string> = {
  modified: 'M',
  untracked: 'U',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  conflict: '!',
}

const SORT_MODES: SortMode[] = ['name', 'type', 'ext']
const SORT_LABELS: Record<SortMode, string> = { name: 'Name', type: 'Type', ext: 'Ext' }
const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.DS_Store', '__pycache__', '.cache', 'out'])

interface Props {
  workspace: Workspace | null
  workspaces: Workspace[]
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: (name: string) => void
  onOpenFolder: () => void
  onOpenFile: (filePath: string) => void
  onNewTerminal: () => void
  onNewKanban: () => void
  onNewBrowser: () => void
  onNewChat: () => void
  onSettings: () => void
  collapsed: boolean
  onToggleCollapse: () => void
}

interface CtxState { x: number; y: number; entry: FsEntry }
interface CreateState { dir: string; type: 'file' | 'folder' }

function sortEntries(entries: FsEntry[], mode: SortMode): FsEntry[] {
  const dirs = [...entries.filter(e => e.isDir)].sort((a, b) => a.name.localeCompare(b.name))
  const files = [...entries.filter(e => !e.isDir)]

  if (mode === 'ext') {
    files.sort((a, b) => {
      const byExt = a.ext.localeCompare(b.ext)
      return byExt !== 0 ? byExt : a.name.localeCompare(b.name)
    })
  } else {
    files.sort((a, b) => a.name.localeCompare(b.name))
  }

  return [...dirs, ...files]
}

function isIgnored(name: string): boolean {
  return IGNORED.has(name)
}

function relativePath(rootPath: string, fullPath: string): string {
  if (!fullPath.startsWith(rootPath)) return fullPath
  return fullPath.slice(rootPath.length).replace(/^\//, '') || '.'
}

function mapPathPrefixes(paths: Set<string>, oldPrefix: string, newPrefix: string): Set<string> {
  const next = new Set<string>()
  for (const path of paths) {
    if (path === oldPrefix || path.startsWith(`${oldPrefix}/`)) {
      next.add(`${newPrefix}${path.slice(oldPrefix.length)}`)
    } else {
      next.add(path)
    }
  }
  return next
}

function removePathPrefixes(paths: Set<string>, prefix: string): Set<string> {
  const next = new Set<string>()
  for (const path of paths) {
    if (path === prefix || path.startsWith(`${prefix}/`)) continue
    next.add(path)
  }
  return next
}

async function loadOneLevel(dir: string, sortMode: SortMode): Promise<TreeEntry[]> {
  const items: FsEntry[] = await window.electron.fs.readDir(dir).catch(() => [])
  const filtered = sortEntries(items.filter(item => !isIgnored(item.name)), sortMode)

  return filtered.map((item) => ({
    ...item,
    children: [],
  }))
}

function flattenFiles(entries: TreeEntry[], acc: TreeEntry[] = []): TreeEntry[] {
  for (const entry of entries) {
    if (entry.isDir) flattenFiles(entry.children, acc)
    else acc.push(entry)
  }
  return acc
}

function filterTree(entries: TreeEntry[], query: string): TreeEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries

  const result: TreeEntry[] = []
  for (const entry of entries) {
    if (entry.isDir) {
      const children = filterTree(entry.children, q)
      const matchesSelf = entry.name.toLowerCase().includes(q)
      if (matchesSelf || children.length > 0) result.push({ ...entry, children })
    } else if (entry.name.toLowerCase().includes(q)) {
      result.push(entry)
    }
  }
  return result
}

// ─── File icon — VSCode-style colored badge ───────────────────────────────────
const SPECIAL_FILES: Record<string, { label: string; color: string; bg: string }> = {
  'package.json': { label: 'PKG', color: '#fff', bg: '#cb3837' },
  'package-lock.json': { label: 'PKG', color: '#fff', bg: '#8a2627' },
  'yarn.lock': { label: 'YRN', color: '#fff', bg: '#2c8ebb' },
  'pnpm-lock.yaml': { label: 'PNP', color: '#fff', bg: '#f69220' },
  'tsconfig.json': { label: 'TSC', color: '#fff', bg: '#3178c6' },
  '.gitignore': { label: 'GIT', color: '#fff', bg: '#f34f29' },
  '.gitattributes': { label: 'GIT', color: '#fff', bg: '#f34f29' },
  '.env': { label: 'ENV', color: '#fff', bg: '#3a4a1a' },
  '.env.local': { label: 'ENV', color: '#fff', bg: '#3a4a1a' },
  '.env.example': { label: 'ENV', color: '#888', bg: '#2a2a2a' },
  dockerfile: { label: 'DOC', color: '#fff', bg: '#2496ed' },
  Dockerfile: { label: 'DOC', color: '#fff', bg: '#2496ed' },
  makefile: { label: 'MK', color: '#fff', bg: '#6d4c41' },
  Makefile: { label: 'MK', color: '#fff', bg: '#6d4c41' },
  'readme.md': { label: 'MD', color: '#fff', bg: '#1565c0' },
  'README.md': { label: 'MD', color: '#fff', bg: '#1565c0' },
  license: { label: 'LIC', color: '#fff', bg: '#4a4a1a' },
  LICENSE: { label: 'LIC', color: '#fff', bg: '#4a4a1a' },
}

const EXT_META: Record<string, { label: string; color: string; bg: string }> = {
  '.ts': { label: 'TS', color: '#fff', bg: '#3178c6' },
  '.tsx': { label: 'TX', color: '#fff', bg: '#3178c6' },
  '.mts': { label: 'TS', color: '#fff', bg: '#3178c6' },
  '.cts': { label: 'TS', color: '#fff', bg: '#3178c6' },
  '.js': { label: 'JS', color: '#000', bg: '#f7df1e' },
  '.jsx': { label: 'JX', color: '#000', bg: '#f7df1e' },
  '.mjs': { label: 'JS', color: '#000', bg: '#f7df1e' },
  '.cjs': { label: 'JS', color: '#000', bg: '#f7df1e' },
  '.json': { label: '{ }', color: '#f7df1e', bg: '#2a2a1a' },
  '.jsonc': { label: '{ }', color: '#f7df1e', bg: '#2a2a1a' },
  '.md': { label: 'MD', color: '#fff', bg: '#4a7a3a' },
  '.mdx': { label: 'MX', color: '#fff', bg: '#4a7a3a' },
  '.txt': { label: 'TXT', color: '#888', bg: '#252525' },
  '.css': { label: 'CSS', color: '#fff', bg: '#563d7c' },
  '.scss': { label: 'SCS', color: '#fff', bg: '#cd669a' },
  '.sass': { label: 'SAS', color: '#fff', bg: '#cd669a' },
  '.less': { label: 'LES', color: '#fff', bg: '#1d365d' },
  '.html': { label: 'HTM', color: '#fff', bg: '#e34c26' },
  '.htm': { label: 'HTM', color: '#fff', bg: '#e34c26' },
  '.xml': { label: 'XML', color: '#fff', bg: '#f34f29' },
  '.svg': { label: 'SVG', color: '#fff', bg: '#e67e22' },
  '.vue': { label: 'VUE', color: '#fff', bg: '#42b883' },
  '.svelte': { label: 'SV', color: '#fff', bg: '#ff3e00' },
  '.astro': { label: 'AST', color: '#fff', bg: '#ff5d01' },
  '.py': { label: 'PY', color: '#fff', bg: '#3572a5' },
  '.pyi': { label: 'PY', color: '#fff', bg: '#3572a5' },
  '.rb': { label: 'RB', color: '#fff', bg: '#cc342d' },
  '.rs': { label: 'RS', color: '#fff', bg: '#a95028' },
  '.go': { label: 'GO', color: '#fff', bg: '#00acd7' },
  '.java': { label: 'JV', color: '#fff', bg: '#b07219' },
  '.kt': { label: 'KT', color: '#fff', bg: '#7f52ff' },
  '.swift': { label: 'SW', color: '#fff', bg: '#fa7343' },
  '.c': { label: 'C', color: '#fff', bg: '#555599' },
  '.cpp': { label: 'C++', color: '#fff', bg: '#f34b7d' },
  '.cs': { label: 'C#', color: '#fff', bg: '#178600' },
  '.php': { label: 'PHP', color: '#fff', bg: '#4f5d95' },
  '.sh': { label: 'SH', color: '#fff', bg: '#4a6a1a' },
  '.bash': { label: 'SH', color: '#fff', bg: '#4a6a1a' },
  '.zsh': { label: 'ZSH', color: '#fff', bg: '#4a6a1a' },
  '.fish': { label: 'FSH', color: '#fff', bg: '#4a6a1a' },
  '.yaml': { label: 'YML', color: '#fff', bg: '#7a1a1a' },
  '.yml': { label: 'YML', color: '#fff', bg: '#7a1a1a' },
  '.toml': { label: 'TOM', color: '#fff', bg: '#9c4121' },
  '.ini': { label: 'INI', color: '#fff', bg: '#5a4a3a' },
  '.env': { label: 'ENV', color: '#fff', bg: '#3a4a1a' },
  '.lock': { label: 'LCK', color: '#888', bg: '#252525' },
  '.log': { label: 'LOG', color: '#888', bg: '#252525' },
  '.png': { label: 'IMG', color: '#fff', bg: '#7a2a6a' },
  '.jpg': { label: 'IMG', color: '#fff', bg: '#7a2a6a' },
  '.jpeg': { label: 'IMG', color: '#fff', bg: '#7a2a6a' },
  '.gif': { label: 'GIF', color: '#fff', bg: '#7a3a6a' },
  '.webp': { label: 'WBP', color: '#fff', bg: '#7a3a6a' },
  '.ico': { label: 'ICO', color: '#fff', bg: '#7a3a6a' },
  '.woff': { label: 'FON', color: '#fff', bg: '#4a3a6a' },
  '.woff2': { label: 'FON', color: '#fff', bg: '#4a3a6a' },
  '.ttf': { label: 'FON', color: '#fff', bg: '#4a3a6a' },
  '.pdf': { label: 'PDF', color: '#fff', bg: '#b31b1b' },
  '.zip': { label: 'ZIP', color: '#fff', bg: '#5a5a1a' },
  '.tar': { label: 'TAR', color: '#fff', bg: '#5a5a1a' },
  '.gz': { label: 'GZ', color: '#fff', bg: '#5a5a1a' },
  '.sql': { label: 'SQL', color: '#fff', bg: '#1a6a8a' },
  '.prisma': { label: 'PRI', color: '#fff', bg: '#2d3748' },
  '.graphql': { label: 'GQL', color: '#fff', bg: '#e10098' },
}

function FileIcon({ name, ext }: { name: string; ext: string }): JSX.Element {
  const meta = SPECIAL_FILES[name] ?? EXT_META[ext] ?? {
    label: ext.replace('.', '').slice(0, 3).toUpperCase() || 'TXT',
    color: '#888',
    bg: '#252525'
  }

  return (
    <div style={{
      width: 22, height: 14, flexShrink: 0, marginRight: 6,
      background: meta.bg, borderRadius: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <span style={{
        fontSize: 7, fontWeight: 700, color: meta.color,
        fontFamily: 'inherit', letterSpacing: '-0.02em', lineHeight: 1
      }}>
        {meta.label}
      </span>
    </div>
  )
}

function FolderIcon({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginRight: 5, flexShrink: 0, gap: 3 }}>
      {/* Chevron — rotates 90deg when expanded */}
      <svg
        width="8" height="8" viewBox="0 0 8 8"
        style={{
          transition: 'transform 0.15s ease',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          opacity: expanded ? 0.9 : 0.45,
        }}
      >
        <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* Folder */}
      <svg width="14" height="12" viewBox="0 0 14 12" fill="none">
        <path
          d="M0 2.5C0 1.67 0.67 1 1.5 1H4.5L6 2.5H12.5C13.33 2.5 14 3.17 14 4V10C14 10.83 13.33 11.5 12.5 11.5H1.5C0.67 11.5 0 10.83 0 10V2.5Z"
          fill={expanded ? '#dcb67a' : '#c09a5c'}
        />
      </svg>
    </div>
  )
}

function Badge({ count }: { count: number }): JSX.Element {
  return (
    <span style={{
      fontSize: 10, color: '#aaa',
      background: '#2a2a2a', borderRadius: 8,
      padding: '1px 6px', marginLeft: 6,
      fontFamily: 'inherit', flexShrink: 0
    }}>
      {count}
    </span>
  )
}

function SortIcon({ mode }: { mode: SortMode }): JSX.Element {
  if (mode === 'name') {
    // A→Z icon
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 3h4M2 7h3M2 11h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M10 3v8M8 9l2 2 2-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (mode === 'type') {
    // Folder sort icon
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M1.5 3.5h4l1 1.5h6v6.5h-11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M10 3v-1M8 0l2 2 2-2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
      </svg>
    )
  }
  // ext — dot/extension sort
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M3 4h5v8H3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 6h2v-4H5v2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="5.5" cy="9" r="1" fill="currentColor" />
    </svg>
  )
}

function CreateInline({
  depth,
  type,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number
  type: 'file' | 'folder'
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}): JSX.Element {
  const fonts = useAppFonts()
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      height: 28, paddingLeft: 8 + depth * 16, paddingRight: 12
    }}>
      {type === 'folder' ? <FolderIcon expanded={false} /> : <FileIcon name="new.txt" ext=".txt" />}
      <input
        autoFocus
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={onSubmit}
        placeholder={type === 'file' ? 'filename.ts' : 'folder-name'}
        style={{
          flex: 1, padding: '4px 8px', fontSize: fonts.size, borderRadius: 4,
          background: '#161616', color: '#ccc',
          border: '1px solid #4a9eff', outline: 'none',
          boxSizing: 'border-box', fontFamily: 'inherit'
        }}
      />
    </div>
  )
}

function RenameInput({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}): JSX.Element {
  const fonts = useAppFonts()
  return (
    <input
      autoFocus
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') onSubmit()
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={onSubmit}
      onClick={e => e.stopPropagation()}
      style={{
        flex: 1, padding: '1px 4px', fontSize: fonts.size, borderRadius: 3,
        background: '#1a1a2a', color: '#d4d4d4',
        border: '1px solid #4a9eff', outline: 'none',
        fontFamily: 'inherit'
      }}
    />
  )
}

function GitBadge({ status }: { status: GitStatus }): JSX.Element {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color: GIT_COLORS[status],
      marginLeft: 6, flexShrink: 0, fontFamily: 'inherit', lineHeight: 1
    }} title={status}>
      {GIT_LABELS[status]}
    </span>
  )
}

function TreeNode({
  entry,
  depth,
  rootPath,
  expandedPaths,
  gitStatus,
  creatingIn,
  createName,
  setCreateName,
  onToggle,
  onOpenFile,
  onCtxMenu,
  onSubmitCreate,
  onCancelCreate,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
}: {
  entry: TreeEntry
  depth: number
  rootPath: string
  expandedPaths: Set<string>
  gitStatus: Record<string, GitStatus>
  creatingIn: CreateState | null
  createName: string
  setCreateName: (value: string) => void
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onCtxMenu: (e: React.MouseEvent, entry: FsEntry) => void
  onSubmitCreate: () => void
  onCancelCreate: () => void
  renamingPath: string | null
  onRenameSubmit: (oldPath: string, newName: string) => void
  onRenameCancel: () => void
}): JSX.Element {
  const fonts = useAppFonts()
  const expanded = entry.isDir && expandedPaths.has(entry.path)
  const [hovered, setHovered] = useState(false)
  const [renameVal, setRenameVal] = useState(entry.name)
  const isRenaming = renamingPath === entry.path
  const isCreateTarget = creatingIn?.dir === entry.path && entry.isDir

  useEffect(() => {
    if (isRenaming) setRenameVal(entry.name)
  }, [isRenaming, entry.name])

  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'center',
          height: 26, paddingLeft: 8 + depth * 16, paddingRight: 12,
          cursor: 'pointer', userSelect: 'none',
          background: hovered ? 'rgba(255,255,255,0.04)' : 'transparent',
          position: 'relative'
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={isRenaming ? undefined : () => (entry.isDir ? onToggle(entry.path) : onOpenFile(entry.path))}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onCtxMenu(e, entry) }}
        draggable={!entry.isDir && !isRenaming}
        onDragStart={e => {
          e.dataTransfer.setData('text/plain', entry.path)
          e.dataTransfer.effectAllowed = 'copy'
        }}
      >
        {Array.from({ length: depth }).map((_, i) => (
          <div key={i} style={{
            position: 'absolute', left: 8 + i * 16 + 5,
            width: 1, top: 0, bottom: 0,
            background: 'rgba(255,255,255,0.05)', pointerEvents: 'none'
          }} />
        ))}

        {entry.isDir ? <FolderIcon expanded={expanded} /> : <FileIcon name={entry.name} ext={entry.ext} />}

        {isRenaming ? (
          <RenameInput
            value={renameVal}
            onChange={setRenameVal}
            onSubmit={() => onRenameSubmit(entry.path, renameVal.trim())}
            onCancel={onRenameCancel}
          />
        ) : (
          <span style={{
            fontSize: fonts.size,
                       color: entry.isDir ? '#d4d4d4' : '#b8b8b8',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1
          }}>
            {entry.isDir ? (
              <>
                <span style={{ fontWeight: 500 }}>{entry.name}</span>
                {entry.children.length > 0 && <Badge count={entry.children.length} />}
              </>
            ) : (
              <>
                <span style={{ fontWeight: 400 }}>{entry.name.replace(entry.ext, '')}</span>
                <span style={{ color: '#4a4a4a' }}>{entry.ext}</span>
              </>
            )}
          </span>
        )}

        {!isRenaming && gitStatus[entry.path] && (
          <GitBadge status={gitStatus[entry.path]} />
        )}
      </div>

      {entry.isDir && expanded && (
        <div style={{ position: 'relative' }}>
          {isCreateTarget && (
            <CreateInline
              depth={depth + 1}
              type={creatingIn.type}
              value={createName}
              onChange={setCreateName}
              onSubmit={onSubmitCreate}
              onCancel={onCancelCreate}
            />
          )}

          {entry.children.length === 0 && !isCreateTarget ? (
            <div style={{
              paddingLeft: 8 + (depth + 1) * 16 + 22,
              height: 24, fontSize: fonts.size, color: '#3a3a3a',
              display: 'flex', alignItems: 'center', fontFamily: 'inherit'
            }}>
              empty
            </div>
          ) : (
            entry.children.map(child => (
              <TreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                rootPath={rootPath}
                expandedPaths={expandedPaths}
                gitStatus={gitStatus}
                creatingIn={creatingIn}
                createName={createName}
                setCreateName={setCreateName}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onCtxMenu={onCtxMenu}
                onSubmitCreate={onSubmitCreate}
                onCancelCreate={onCancelCreate}
                renamingPath={renamingPath}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function FlatEntry({
  entry,
  rootPath,
  gitStatus,
  onOpenFile,
  onCtxMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
}: {
  entry: TreeEntry
  rootPath: string
  gitStatus: Record<string, GitStatus>
  onOpenFile: (path: string) => void
  onCtxMenu: (e: React.MouseEvent, entry: FsEntry) => void
  renamingPath: string | null
  onRenameSubmit: (oldPath: string, newName: string) => void
  onRenameCancel: () => void
}): JSX.Element {
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  const [renameVal, setRenameVal] = useState(entry.name)
  const isRenaming = renamingPath === entry.path

  useEffect(() => {
    if (isRenaming) setRenameVal(entry.name)
  }, [isRenaming, entry.name])

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center',
        height: 26, paddingLeft: 10, paddingRight: 12,
        cursor: 'pointer', userSelect: 'none',
        background: hovered ? 'rgba(255,255,255,0.04)' : 'transparent',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={isRenaming ? undefined : () => onOpenFile(entry.path)}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onCtxMenu(e, entry) }}
    >
      <FileIcon name={entry.name} ext={entry.ext} />

      {isRenaming ? (
        <RenameInput
          value={renameVal}
          onChange={setRenameVal}
          onSubmit={() => onRenameSubmit(entry.path, renameVal.trim())}
          onCancel={onRenameCancel}
        />
      ) : (
        <>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{
              fontSize: fonts.size, fontFamily: 'inherit', color: '#b8b8b8',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>
              <span style={{ fontWeight: 400 }}>{entry.name.replace(entry.ext, '')}</span>
              <span style={{ color: '#4a4a4a' }}>{entry.ext}</span>
            </span>
            <span style={{
              fontSize: fonts.size - 1, fontFamily: 'inherit', color: '#575757',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>
              {relativePath(rootPath, entry.path)}
            </span>
          </div>
          {gitStatus[entry.path] && (
            <GitBadge status={gitStatus[entry.path]} />
          )}
        </>
      )}
    </div>
  )
}

export function Sidebar({
  workspace, workspaces, onSwitchWorkspace, onNewWorkspace, onOpenFolder, onOpenFile, onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onSettings,
  collapsed, onToggleCollapse: _onToggleCollapse
}: Props): JSX.Element {
  const fonts = useAppFonts()
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([])
  const [sortMode, setSortMode] = useState<SortMode>('name')
  const [viewMode, setViewMode] = useState<ViewMode>('tree')
  const [search, setSearch] = useState('')
  const [gitStatus, setGitStatus] = useState<Record<string, GitStatus>>({})
  const [width, setWidth] = useState(280)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false)
  const [newWsInput, setNewWsInput] = useState(false)
  const [newWsName, setNewWsName] = useState('')
  const [ctx, setCtx] = useState<CtxState | null>(null)
  const [creatingIn, setCreatingIn] = useState<CreateState | null>(null)
  const [createName, setCreateName] = useState('')
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [loadingTree, setLoadingTree] = useState(false)
  const [showFileMenu, setShowFileMenu] = useState(false)
  const fileMenuRef = useRef<HTMLDivElement>(null)
  const expandedPathsRef = useRef(expandedPaths)
  expandedPathsRef.current = expandedPaths
  const resizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const loadGit = useCallback(() => {
    if (!workspace) return
    window.electron.git?.status(workspace.path).then((result: { isRepo: boolean; root: string; files: { path: string; status: string }[] }) => {
      if (!result.isRepo) {
        setGitStatus({})
        return
      }
      const map: Record<string, GitStatus> = {}
      for (const file of result.files) {
        map[`${result.root}/${file.path}`] = file.status as GitStatus
      }
      setGitStatus(map)
    }).catch(() => setGitStatus({}))
  }, [workspace])

  const loadDirChildren = useCallback(async (dirPath: string): Promise<TreeEntry[]> => {
    return await loadOneLevel(dirPath, sortMode).catch(() => [])
  }, [sortMode])

  const updateChildrenInTree = useCallback((
    entries: TreeEntry[],
    dirPath: string,
    children: TreeEntry[],
  ): TreeEntry[] => {
    return entries.map(entry => {
      if (entry.path === dirPath) {
        return { ...entry, children }
      }
      if (entry.isDir && entry.children.length > 0) {
        return { ...entry, children: updateChildrenInTree(entry.children, dirPath, children) }
      }
      return entry
    })
  }, [])

  const loadTree = useCallback(async () => {
    if (!workspace) {
      setTreeEntries([])
      return
    }
    setLoadingTree(true)
    const rootChildren = await loadOneLevel(workspace.path, sortMode).catch(() => [])
    setTreeEntries(rootChildren)
    setLoadingTree(false)
  }, [workspace, sortMode])

  const reloadAll = useCallback(async () => {
    if (!workspace) {
      loadGit()
      return
    }
    setLoadingTree(true)
    const expanded = expandedPathsRef.current
    const rootChildren = await loadOneLevel(workspace.path, sortMode).catch(() => [])

    // Recursively reload children for currently-expanded dirs
    const reloadExpanded = async (entries: TreeEntry[]): Promise<TreeEntry[]> => {
      return await Promise.all(entries.map(async (entry) => {
        if (entry.isDir && expanded.has(entry.path)) {
          const children = await loadOneLevel(entry.path, sortMode).catch(() => [])
          const reloadedChildren = await reloadExpanded(children)
          return { ...entry, children: reloadedChildren }
        }
        return entry
      }))
    }

    const reloaded = await reloadExpanded(rootChildren)
    setTreeEntries(reloaded)
    setLoadingTree(false)
    loadGit()
  }, [workspace, sortMode, loadGit])

  useEffect(() => {
    if (!workspace) {
      setExpandedPaths(new Set())
      setCreatingIn(null)
      setCreateName('')
      return
    }
    setExpandedPaths(new Set([workspace.path]))
    void reloadAll()
  }, [workspace?.id, reloadAll])

  useEffect(() => {
    if (!workspace) return
    void loadTree()
  }, [sortMode, workspace?.id, loadTree])

  useEffect(() => {
    loadGit()
  }, [loadGit])

  useEffect(() => {
    if (!workspace) return
    const unsub = window.electron.fs.watch(workspace.path, () => { void reloadAll() })
    return () => unsub?.()
  }, [workspace, reloadAll])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return
      setWidth(Math.max(200, Math.min(520, startWidth.current + e.clientX - startX.current)))
    }
    const onUp = () => { resizing.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (fileMenuRef.current && !fileMenuRef.current.contains(e.target as Node)) setShowFileMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const flatFiles = useMemo(() => flattenFiles(treeEntries), [treeEntries])
  const filteredTree = useMemo(() => filterTree(treeEntries, search), [treeEntries, search])
  const filteredFlat = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? flatFiles.filter(entry => relativePath(workspace?.path ?? '', entry.path).toLowerCase().includes(q)) : flatFiles
  }, [flatFiles, search, workspace?.path])

  const cycleSortMode = useCallback(() => {
    setSortMode(prev => SORT_MODES[(SORT_MODES.indexOf(prev) + 1) % SORT_MODES.length])
  }, [])

  const handleCtxMenu = useCallback((e: React.MouseEvent, entry: FsEntry) => {
    setCtx({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const handleBgCtxMenu = useCallback((e: React.MouseEvent) => {
    if (!workspace) return
    e.preventDefault()
    setCtx({ x: e.clientX, y: e.clientY, entry: { name: workspace.name, path: workspace.path, isDir: true, ext: '' } })
  }, [workspace])

  const startCreate = useCallback(async (dir: string, type: 'file' | 'folder') => {
    const wasExpanded = expandedPathsRef.current.has(dir)
    setExpandedPaths(prev => new Set(prev).add(dir))
    if (!wasExpanded) {
      const children = await loadDirChildren(dir)
      setTreeEntries(prev => updateChildrenInTree(prev, dir, children))
    }
    setCreatingIn({ dir, type })
    setCreateName('')
    setCtx(null)
  }, [loadDirChildren, updateChildrenInTree])

  const submitCreate = useCallback(async () => {
    if (!creatingIn || !workspace) {
      setCreatingIn(null)
      return
    }
    const name = createName.trim()
    if (!name) {
      setCreatingIn(null)
      setCreateName('')
      return
    }
    const fullPath = `${creatingIn.dir}/${name}`
    try {
      if (creatingIn.type === 'file') await window.electron.fs.createFile(fullPath)
      else await window.electron.fs.createDir(fullPath)

      if (creatingIn.type === 'folder') {
        setExpandedPaths(prev => new Set(prev).add(creatingIn.dir).add(fullPath))
      }
    } catch (err) {
      console.error(`Failed to create ${creatingIn.type}:`, err)
    }
    setCreatingIn(null)
    setCreateName('')
    await reloadAll()
  }, [creatingIn, createName, workspace, reloadAll])

  const cancelCreate = useCallback(() => {
    setCreatingIn(null)
    setCreateName('')
  }, [])

  const handleRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    setRenamingPath(null)
    const trimmed = newName.trim()
    const oldBase = oldPath.split('/').pop() ?? ''
    if (!trimmed || trimmed === oldBase) return
    const dir = oldPath.split('/').slice(0, -1).join('/')
    const newPath = `${dir}/${trimmed}`
    try {
      await window.electron.fs.renameFile(oldPath, newPath)
      setExpandedPaths(prev => mapPathPrefixes(prev, oldPath, newPath))
    } catch (err) {
      console.error('Rename failed:', err)
    }
    await reloadAll()
  }, [reloadAll])

  const handleDelete = useCallback(async (entry: FsEntry) => {
    try {
      await window.electron.fs.deleteFile(entry.path)
      setExpandedPaths(prev => removePathPrefixes(prev, entry.path))
      if (renamingPath && (renamingPath === entry.path || renamingPath.startsWith(`${entry.path}/`))) setRenamingPath(null)
      if (creatingIn && (creatingIn.dir === entry.path || creatingIn.dir.startsWith(`${entry.path}/`))) cancelCreate()
    } catch (err) {
      console.error('Delete failed:', err)
    }
    await reloadAll()
  }, [renamingPath, creatingIn, cancelCreate, reloadAll])

  const ctxItems = useCallback((): MenuItem[] => {
    if (!ctx) return []
    const { entry } = ctx
    const dir = entry.isDir ? entry.path : entry.path.split('/').slice(0, -1).join('/')
    const items: MenuItem[] = []
    if (!entry.isDir) items.push({ label: 'Open', action: () => onOpenFile(entry.path) })
    items.push({ label: 'New File', action: () => startCreate(dir, 'file') })
    items.push({ label: 'New Folder', action: () => startCreate(dir, 'folder') })
    items.push({ label: '', action: () => {}, divider: true })
    items.push({ label: 'Rename', action: () => setRenamingPath(entry.path) })
    items.push({ label: 'Copy Path', action: () => navigator.clipboard.writeText(entry.path) })
    items.push({ label: 'Reveal in Finder', action: () => window.electron.fs.revealInFinder?.(entry.path) })
    items.push({ label: '', action: () => {}, divider: true })
    items.push({ label: `Delete ${entry.isDir ? 'Folder' : 'File'}`, danger: true, action: () => { void handleDelete(entry) } })
    return items
  }, [ctx, onOpenFile, startCreate, handleDelete])

  const toggleExpanded = useCallback(async (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
        return next
      }
      next.add(path)
      return next
    })

    // If expanding, lazy-load children
    if (!expandedPathsRef.current.has(path)) {
      const children = await loadDirChildren(path)
      setTreeEntries(prev => updateChildrenInTree(prev, path, children))
    }
  }, [loadDirChildren, updateChildrenInTree])

  return (
    <div style={{
      width: collapsed ? 0 : width,
      height: '100%',
      display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
      transition: 'width 0.15s ease',
    }}>
      {/* Workspace selector — tight to top */}
      <div style={{ padding: '4px 10px 6px' }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            padding: '5px 10px', borderRadius: 8,
            background: '#252525', border: '1px solid #2d2d2d'
          }}
          onClick={() => setWsDropdownOpen(p => !p)}
        >
          <span style={{
            fontSize: fonts.size, color: '#d4d4d4', fontWeight: 500,
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'inherit'
          }}>
            {workspace?.name ?? 'No workspace'}
          </span>
          <span style={{ fontSize: 9, color: '#555' }}>{wsDropdownOpen ? '▴' : '▾'}</span>
        </div>

        {wsDropdownOpen && (
          <div style={{ marginTop: 4, background: '#222', border: '1px solid #333', borderRadius: 8, overflow: 'hidden' }}>
            {workspaces.map(ws => (
              <div
                key={ws.id}
                style={{ padding: '7px 14px', fontSize: fonts.size, fontFamily: 'inherit', color: ws.id === workspace?.id ? '#4a9eff' : '#ccc', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onClick={() => { onSwitchWorkspace(ws.id); setWsDropdownOpen(false) }}
              >
                {ws.name}
              </div>
            ))}
            <div style={{ height: 1, background: '#2d2d2d', margin: '2px 0' }} />
            {newWsInput ? (
              <div style={{ padding: '4px 8px' }}>
                <input
                  autoFocus
                  value={newWsName}
                  onChange={e => setNewWsName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newWsName.trim()) {
                      onNewWorkspace(newWsName.trim())
                      setNewWsName('')
                      setNewWsInput(false)
                      setWsDropdownOpen(false)
                    }
                    if (e.key === 'Escape') {
                      setNewWsInput(false)
                      setNewWsName('')
                    }
                  }}
                  placeholder="Workspace name…"
                  style={{ width: '100%', padding: '4px 8px', fontSize: fonts.size, borderRadius: 4, background: '#1a1a1a', color: '#ccc', border: '1px solid #4a9eff', outline: 'none', fontFamily: 'inherit' }}
                />
              </div>
            ) : (
              <>
                <div
                  style={{ padding: '7px 14px', fontSize: fonts.size, color: '#555', cursor: 'pointer', fontFamily: 'inherit' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => { onOpenFolder(); setWsDropdownOpen(false) }}
                >
                  Open Folder…
                </div>
                <div
                  style={{ padding: '7px 14px', fontSize: fonts.size, color: '#555', cursor: 'pointer', fontFamily: 'inherit' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => setNewWsInput(true)}
                >
                  + New empty workspace
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Compact toolbar: [ Search ] [Sort] [Menu] */}
      <div style={{ padding: '4px 10px 6px', borderBottom: '1px solid #1f1f1f', display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search files"
          style={{
            flex: 1, padding: '4px 10px', fontSize: fonts.size,
            background: '#222', color: '#ccc',
            border: '1px solid #2d2d2d', borderRadius: 6,
            outline: 'none', fontFamily: 'inherit', minWidth: 0
          }}
        />
        <button
          onClick={cycleSortMode}
          title={`Sort: ${SORT_LABELS[sortMode]}`}
          style={{
            background: 'transparent', border: 'none',
            cursor: 'pointer', padding: '4px 5px', borderRadius: 4,
            color: '#666', display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#ccc' }}
          onMouseLeave={e => { e.currentTarget.style.color = '#666' }}
        >
          <SortIcon mode={sortMode} />
        </button>
        <div ref={fileMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setShowFileMenu(p => !p)}
            title="File actions"
            style={{
              background: showFileMenu ? '#252525' : 'transparent', border: 'none',
              cursor: 'pointer', padding: '4px 5px', borderRadius: 4,
              color: showFileMenu ? '#ccc' : '#666', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={e => { if (!showFileMenu) e.currentTarget.style.color = '#ccc' }}
            onMouseLeave={e => { if (!showFileMenu) e.currentTarget.style.color = '#666' }}
          >
            {/* Hamburger / list icon */}
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          {showFileMenu && (
            <div style={{
              position: 'absolute', top: '100%', right: 0,
              marginTop: 4, minWidth: 150,
              background: '#1c1c1c', border: '1px solid #2a2a2a',
              borderRadius: 8, padding: 4,
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              zIndex: 9999,
            }}>
              {([
                { label: 'New File', action: () => { workspace && startCreate(workspace.path, 'file'); setShowFileMenu(false) } },
                { label: 'New Folder', action: () => { workspace && startCreate(workspace.path, 'folder'); setShowFileMenu(false) } },
                { label: 'Refresh', action: () => { void reloadAll(); setShowFileMenu(false) } },
                { label: 'Show in Finder', action: () => { workspace && window.electron.fs.revealInFinder?.(workspace.path); setShowFileMenu(false) } },
              ]).map(item => (
                <div
                  key={item.label}
                  onClick={item.action}
                  style={{
                    padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                    fontSize: fonts.size, color: '#ccc', fontFamily: 'inherit',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#252525')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {item.label}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', position: 'relative' }} onContextMenu={handleBgCtxMenu}>
        {!workspace ? (
          <div style={{ padding: '16px', fontSize: fonts.size, color: '#444', fontFamily: 'inherit' }}>No workspace open</div>
        ) : loadingTree && treeEntries.length === 0 ? (
          <div style={{ padding: '16px', fontSize: fonts.size, color: '#666', fontFamily: 'inherit' }}>Loading files…</div>
        ) : viewMode === 'list' ? (
          filteredFlat.length === 0 ? (
            <div style={{ padding: '16px', fontSize: fonts.size, color: '#444', fontFamily: 'inherit' }}>{search ? 'No matches' : 'Empty'}</div>
          ) : (
            filteredFlat.map(entry => (
              <FlatEntry
                key={entry.path}
                entry={entry}
                rootPath={workspace.path}
                gitStatus={gitStatus}
                onOpenFile={onOpenFile}
                onCtxMenu={handleCtxMenu}
                renamingPath={renamingPath}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={() => setRenamingPath(null)}
              />
            ))
          )
        ) : (
          <>
            {creatingIn?.dir === workspace.path && (
              <CreateInline
                depth={0}
                type={creatingIn.type}
                value={createName}
                onChange={setCreateName}
                onSubmit={submitCreate}
                onCancel={cancelCreate}
              />
            )}

            {filteredTree.length === 0 ? (
              <div style={{ padding: '16px', fontSize: fonts.size, color: '#444', fontFamily: 'inherit' }}>{search ? 'No matches' : 'Empty'}</div>
            ) : (
              filteredTree.map(entry => (
                <TreeNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  rootPath={workspace.path}
                  expandedPaths={expandedPaths}
                  gitStatus={gitStatus}
                  creatingIn={creatingIn?.dir === workspace.path ? null : creatingIn}
                  createName={createName}
                  setCreateName={setCreateName}
                  onToggle={toggleExpanded}
                  onOpenFile={onOpenFile}
                  onCtxMenu={handleCtxMenu}
                  onSubmitCreate={submitCreate}
                  onCancelCreate={cancelCreate}
                  renamingPath={renamingPath}
                  onRenameSubmit={handleRenameSubmit}
                  onRenameCancel={() => setRenamingPath(null)}
                />
              ))
            )}
          </>
        )}
      </div>

      <div style={{ borderTop: '1px solid #252525', padding: '8px 12px', display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
        {([
          { label: 'New Terminal', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M7 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>, action: onNewTerminal },
          { label: 'Agent Board', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" /><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" /><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" /><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" /></svg>, action: onNewKanban },
          { label: 'Browser', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" /><path d="M1 5h12" stroke="currentColor" strokeWidth="1.2" /><circle cx="3" cy="3.5" r="0.5" fill="currentColor" /><circle cx="5" cy="3.5" r="0.5" fill="currentColor" /></svg>, action: onNewBrowser },
          { label: 'Chat', icon: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2h10a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 2.5V10H2a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>, action: onNewChat },
          { label: 'Settings', icon: <span style={{ fontSize: 25, lineHeight: 1 }}>⚙</span>, action: onSettings },
        ] as { label: string; icon: React.ReactNode; action: () => void }[]).map(btn => (
          <button
            key={btn.label}
            title={btn.label}
            style={{
              width: 28, height: 28, borderRadius: 6,
              border: '1px solid #2d2d2d', background: 'transparent',
              color: '#555', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#2a2a2a'; e.currentTarget.style.color = '#ccc' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#555' }}
            onClick={btn.action}
          >
            {btn.icon}
          </button>
        ))}
      </div>

      <div
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 3, cursor: 'col-resize' }}
        onMouseDown={e => { resizing.current = true; startX.current = e.clientX; startWidth.current = width; e.preventDefault() }}
        onMouseEnter={e => (e.currentTarget.style.background = '#4a9eff44')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      />

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems()} onClose={() => setCtx(null)} />}
    </div>
  )
}
