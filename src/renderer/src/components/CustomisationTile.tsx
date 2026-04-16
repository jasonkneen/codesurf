import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import type { PromptTemplate, PromptField, SkillDefinition, AgentMode } from '../../../shared/types'
import { ChatMarkdown } from './shared/streamdown-utils'

type Tab = 'prompts' | 'skills' | 'tools' | 'agents'

interface Props {
  tileId: string
  workspacePath: string
  width: number
  height: number
  initialTab?: Tab
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

function dataDir(workspacePath: string): string {
  return `${workspacePath}/.contex/customisation`
}

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    // Check if file exists first to avoid noisy ENOENT logs in main process
    const stat = await window.electron.fs.stat(path).catch(() => null)
    if (!stat) return fallback
    const raw = await window.electron.fs.readFile(path)
    return JSON.parse(raw) as T
  } catch { return fallback }
}

async function saveJson(path: string, data: unknown): Promise<void> {
  const dir = path.split('/').slice(0, -1).join('/')
  await window.electron.fs.createDir(dir).catch(() => {})
  await window.electron.fs.writeFile(path, JSON.stringify(data, null, 2))
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    const stat = await window.electron.fs.stat(path).catch(() => null)
    if (!stat?.isFile) return ''
    return await window.electron.fs.readFile(path)
  } catch {
    return ''
  }
}

// ─── Tab button ──────────────────────────────────────────────────────────────

function TabBtn({ label, icon, active, onClick }: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 14px', borderRadius: 8, border: 'none',
      background: active ? theme.accent.soft : 'transparent',
      color: active ? theme.accent.base : theme.text.muted,
      fontSize: fonts.secondarySize, fontWeight: active ? 600 : 400, cursor: 'pointer',
      transition: 'all 0.12s ease',
    }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.background = theme.surface.hover; e.currentTarget.style.color = theme.text.secondary } }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = theme.text.muted } }}
    >
      {icon}{label}
    </button>
  )
}

// ─── Shared section header ───────────────────────────────────────────────────

function PageHeader({ title, description, onNew, newLabel, onLocations, hideText = false }: {
  title: string; description?: string; onNew: () => void; newLabel: string; onLocations?: () => void; hideText?: boolean
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
      {hideText ? <div /> : (
        <div>
          <div style={{ fontSize: fonts.size + 1, fontWeight: 700, color: theme.text.primary }}>{title}</div>
          {description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginTop: 2 }}>{description}</div>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        {onLocations && (
          <button onClick={onLocations} title="Configure scan locations"
            style={{ fontSize: fonts.secondarySize, padding: '5px 12px', borderRadius: 6, border: `1px solid ${theme.border.default}`, background: 'transparent', color: theme.text.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="10" y2="12"/>
            </svg>
            Locations
          </button>
        )}
        <button onClick={onNew}
          style={{ fontSize: fonts.secondarySize, padding: '5px 12px', borderRadius: 6, border: 'none', background: theme.accent.base, color: theme.text.inverse, fontWeight: 600, cursor: 'pointer' }}>
          + {newLabel}
        </button>
      </div>
    </div>
  )
}

// ─── Locations panel ─────────────────────────────────────────────────────────

function LocationsPanel({ title, value, onChange, onClose }: {
  title: string; value: string; onChange: (v: string) => void; onClose: () => void
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [draft, setDraft] = useState(value)
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: theme.surface.base, borderRadius: 8, overflow: 'hidden', border: `1px solid ${theme.border.default}` }}>
      {/* Title bar */}
      <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${theme.border.default}`, flexShrink: 0 }}>
        <div style={{ fontSize: fonts.size, fontWeight: 700, color: theme.text.primary }}>{title} Locations</div>
        <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, marginTop: 3 }}>
          One folder path per line. Scanned automatically on load.
        </div>
      </div>
      {/* Variable hint */}
      <div style={{ padding: '8px 16px', background: theme.surface.panel, borderBottom: `1px solid ${theme.border.subtle}`, flexShrink: 0, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {(['$HOME', '$WORKSPACE'] as const).map(v => (
          <span key={v} style={{ fontSize: fonts.secondarySize, fontFamily: fonts.mono, color: theme.text.muted,
            background: theme.surface.hover, padding: '2px 6px', borderRadius: 4, border: `1px solid ${theme.border.subtle}` }}>
            {v}
          </span>
        ))}
        <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>— variables resolved at scan time</span>
      </div>
      {/* Textarea */}
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        spellCheck={false}
        style={{
          flex: 1, resize: 'none', border: 'none', outline: 'none',
          background: 'transparent', color: theme.text.primary,
          fontFamily: fonts.mono, fontSize: fonts.secondarySize,
          lineHeight: 1.8, padding: '14px 16px',
        }}
      />
      {/* Footer */}
      <div style={{ padding: '10px 16px', borderTop: `1px solid ${theme.border.default}`, display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
        <button onClick={onClose}
          style={{ fontSize: fonts.secondarySize, padding: '5px 14px', borderRadius: 6, border: `1px solid ${theme.border.default}`, background: 'transparent', color: theme.text.muted, cursor: 'pointer' }}>
          Cancel
        </button>
        <button onClick={() => { onChange(draft); onClose() }}
          style={{ fontSize: fonts.secondarySize, padding: '5px 14px', borderRadius: 6, border: 'none', background: theme.accent.base, color: theme.text.inverse, fontWeight: 600, cursor: 'pointer' }}>
          Save
        </button>
      </div>
    </div>
  )
}

// ─── Card ────────────────────────────────────────────────────────────────────

function ItemCard({ title, description, chips, onEdit, onDelete, color }: {
  title: string; description?: string; chips?: string[]; onEdit: () => void; onDelete?: () => void; color?: string
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onEdit}
      style={{
        padding: '14px 16px', borderRadius: 10,
        background: theme.surface.panel,
        border: `1px solid ${hovered ? (color ?? theme.border.accent) : theme.border.default}`,
        cursor: 'pointer', transition: 'border-color 0.12s ease, box-shadow 0.12s ease, transform 0.12s ease',
        boxShadow: hovered ? theme.shadow.panel : '0 0 0 0 transparent',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: description ? 6 : 0 }}>
        {color && <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />}
        <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {onDelete && hovered && (
          <button onClick={e => { e.stopPropagation(); onDelete() }} style={{
            width: 20, height: 20, borderRadius: 4, border: 'none', background: 'transparent',
            color: theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
            onMouseEnter={e => { e.currentTarget.style.color = theme.status.danger }}
            onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
      {description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{description}</div>}
      {chips && chips.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
          {chips.map(c => <span key={c} style={{ fontSize: fonts.secondarySize - 1, padding: '2px 7px', borderRadius: 4, background: theme.surface.panelMuted, color: theme.text.disabled, fontWeight: 500 }}>{c}</span>)}
        </div>
      )}
    </div>
  )
}

// ─── Form field ──────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.disabled, letterSpacing: 0.8, textTransform: 'uppercase' }}>{label}</label>
      {children}
    </div>
  )
}

function Input({ value, onChange, placeholder, multiline, mono, rows }: {
  value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean; rows?: number
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const style: React.CSSProperties = {
    width: '100%', padding: multiline ? '8px 10px' : '6px 10px', fontSize: fonts.secondarySize, borderRadius: 6,
    background: theme.surface.input, color: theme.text.secondary,
    border: `1px solid ${theme.border.default}`, outline: 'none',
    fontFamily: mono ? '"JetBrains Mono", monospace' : 'inherit',
    resize: multiline ? 'vertical' : 'none',
    boxSizing: 'border-box' as const,
  }
  if (multiline) return <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows ?? 4} style={style} />
  return <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={style} />
}

// ─── Default scan locations ───────────────────────────────────────────────────

const DEFAULT_PROMPT_LOCATIONS = [
  '$HOME/.claude/commands',
  '$WORKSPACE/.claude/commands',
  '$HOME/.config/opencode/prompts',
  '$WORKSPACE/.opencode/prompts',
  '$WORKSPACE/.cursor/rules',
  '$WORKSPACE/.roo/rules',
  '$WORKSPACE/.continue/prompts',
  '$HOME/.aider/prompts',
].join('\n')

const DEFAULT_SKILL_LOCATIONS = [
  '$HOME/.claude/commands',
  '$WORKSPACE/.claude/commands',
  '$HOME/.claude/skills',
  '$WORKSPACE/.claude/skills',
  '$HOME/.config/opencode/skills',
  '$WORKSPACE/.opencode/skills',
  '$WORKSPACE/.cursor/rules',
  '$WORKSPACE/.continue/prompts',
].join('\n')

const DEFAULT_AGENT_LOCATIONS = [
  '$HOME/.claude/agents',
  '$WORKSPACE/.claude/agents',
  '$WORKSPACE/.cursor/agents',
  '$HOME/.config/opencode/agents',
  '$WORKSPACE/.opencode/agents',
  '$WORKSPACE/.continue/agents',
].join('\n')

function resolveLocations(raw: string, homePath: string, workspacePath: string): string[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^\$HOME/, homePath).replace(/^\$WORKSPACE/, workspacePath))
}

// ─── Prompts section ─────────────────────────────────────────────────────────

export function PromptsSection({ workspacePath, hideHeaderText = false }: { workspacePath: string; hideHeaderText?: boolean }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [items, setItems] = useState<PromptTemplate[]>([])
  const [editing, setEditing] = useState<PromptTemplate | null>(null)
  const [locationsOpen, setLocationsOpen] = useState(false)
  const [locationText, setLocationText] = useState(DEFAULT_PROMPT_LOCATIONS)

  const file = `${dataDir(workspacePath)}/prompts.json`
  const locFile = `${dataDir(workspacePath)}/locations-prompts.json`
  useEffect(() => { loadJson<PromptTemplate[]>(file, []).then(setItems) }, [file])
  useEffect(() => { loadJson<string>(locFile, DEFAULT_PROMPT_LOCATIONS).then(setLocationText) }, [locFile])
  const save = useCallback((next: PromptTemplate[]) => { setItems(next); saveJson(file, next) }, [file])
  const saveLocations = useCallback((text: string) => { setLocationText(text); saveJson(locFile, text) }, [locFile])

  const handleSave = useCallback((item: PromptTemplate) => {
    const exists = items.find(i => i.id === item.id)
    save(exists ? items.map(i => i.id === item.id ? item : i) : [...items, item])
    setEditing(null)
  }, [items, save])

  // Auto-discover prompts from configured scan locations
  useEffect(() => {
    const scanDirs = async () => {
      const homePath = window.electron.homedir
      const dirs = resolveLocations(locationText, homePath, workspacePath)
      // Single-file sources always checked (config-file style, not directories)
      const fileSources: Array<{ path: string; label: string; name: string }> = [
        { path: `${workspacePath}/.cursorrules`,                     label: 'cursor',   name: 'Cursor Rules' },
        { path: `${workspacePath}/.clinerules`,                      label: 'cline',    name: 'Cline Rules' },
        { path: `${workspacePath}/.github/copilot-instructions.md`,  label: 'copilot',  name: 'Copilot Instructions' },
        { path: `${workspacePath}/GEMINI.md`,                        label: 'gemini',   name: 'Gemini Instructions' },
        { path: `${homePath}/.gemini/GEMINI.md`,                     label: 'gemini',   name: 'Gemini Instructions (global)' },
        { path: `${workspacePath}/AGENTS.md`,                        label: 'opencode', name: 'Agents Instructions' },
      ]
      const discovered: PromptTemplate[] = []
      for (const dir of dirs) {
        const entries: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await window.electron.fs.readDir(dir).catch(() => [])
        for (const f of entries) {
          if (f.isDir || (f.ext !== '.md' && f.ext !== '.txt' && f.ext !== '.mdc')) continue
          const content = await readTextIfExists(f.path)
          if (!content) continue
          const name = f.name.replace(/\.(md|txt|mdc)$/, '')
          if (!discovered.find(p => p.name === name)) {
            discovered.push({ id: `discovered-${f.path}`, name, description: `From ${dir}`, template: content, fields: [], tags: [] })
          }
        }
      }
      for (const { path, label, name } of fileSources) {
        if (discovered.find(p => p.name === name)) continue
        const content = await readTextIfExists(path)
        if (!content) continue
        discovered.push({ id: `discovered-${path}`, name, description: `From ${label} configuration`, template: content, fields: [], tags: [label] })
      }
      if (discovered.length > 0) {
        setItems(prev => {
          const existing = new Set(prev.map(p => p.name))
          const newOnes = discovered.filter(p => !existing.has(p.name))
          return newOnes.length > 0 ? [...prev, ...newOnes] : prev
        })
      }
    }
    scanDirs()
  }, [workspacePath, locationText])

  if (editing) return <PromptEditor item={editing} onSave={handleSave} onCancel={() => setEditing(null)} />
  if (locationsOpen) return (
    <LocationsPanel
      title="Prompt"
      value={locationText}
      onChange={saveLocations}
      onClose={() => setLocationsOpen(false)}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="Prompt Templates"
        description="Reusable prompt templates with variable fields"
        newLabel="New Template"
        onNew={() => setEditing({ id: `prompt-${Date.now()}`, name: '', description: '', template: '', fields: [], tags: [] })}
        onLocations={() => setLocationsOpen(true)}
        hideText={hideHeaderText}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
        {items.map(p => (
          <ItemCard key={p.id} title={p.name || 'Untitled'} description={p.description}
            chips={[`${p.fields.length} field${p.fields.length !== 1 ? 's' : ''}`, ...p.tags]}
            onEdit={() => setEditing(p)} onDelete={() => save(items.filter(i => i.id !== p.id))}
          />
        ))}
      </div>
      {items.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: theme.text.disabled, fontSize: fonts.secondarySize }}>No templates yet. Create one to get started.</div>}
    </div>
  )
}

function PromptEditor({ item, onSave, onCancel }: { item: PromptTemplate; onSave: (p: PromptTemplate) => void; onCancel: () => void }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [draft, setDraft] = useState(item)
  const up = (patch: Partial<PromptTemplate>) => setDraft(prev => ({ ...prev, ...patch }))
  const [tagInput, setTagInput] = useState('')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>{item.name ? 'Edit Template' : 'New Template'}</span>
      </div>
      <Field label="Name"><Input value={draft.name} onChange={v => up({ name: v })} placeholder="Template name" /></Field>
      <Field label="Description"><Input value={draft.description} onChange={v => up({ description: v })} placeholder="What does this template do?" /></Field>
      <Field label="Template"><Input value={draft.template} onChange={v => up({ template: v })} placeholder="Use {{field_name}} for variables" multiline mono rows={5} /></Field>

      <Field label="Fields">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {draft.fields.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Input value={f.name} onChange={v => { const next = [...draft.fields]; next[i] = { ...f, name: v }; up({ fields: next }) }} placeholder="field name" />
              <select value={f.type} onChange={e => { const next = [...draft.fields]; next[i] = { ...f, type: e.target.value as PromptField['type'] }; up({ fields: next }) }}
                style={{ padding: '6px 8px', fontSize: fonts.secondarySize, borderRadius: 6, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, outline: 'none' }}>
                <option value="str">Text</option><option value="int">Integer</option><option value="float">Number</option><option value="select">Select</option><option value="multi-select">Multi-select</option>
              </select>
              <button onClick={() => up({ fields: draft.fields.filter((_, j) => j !== i) })} style={{ width: 20, height: 20, border: 'none', background: 'transparent', color: theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
          <button onClick={() => up({ fields: [...draft.fields, { name: '', type: 'str', required: false }] })}
            style={{ fontSize: fonts.secondarySize, padding: '4px 10px', borderRadius: 5, border: `1px dashed ${theme.border.default}`, background: 'transparent', color: theme.text.muted, cursor: 'pointer' }}>+ Add Field</button>
        </div>
      </Field>

      <Field label="Tags">
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {draft.tags.map(t => (
            <span key={t} onClick={() => up({ tags: draft.tags.filter(x => x !== t) })} style={{ fontSize: fonts.secondarySize, padding: '2px 8px', borderRadius: 4, background: theme.accent.soft, color: theme.accent.base, cursor: 'pointer' }}>{t} x</span>
          ))}
          <input value={tagInput} onChange={e => setTagInput(e.target.value)} placeholder="Add tag..."
            onKeyDown={e => { if (e.key === 'Enter' && tagInput.trim()) { up({ tags: [...draft.tags, tagInput.trim()] }); setTagInput('') } }}
            style={{ padding: '3px 8px', fontSize: fonts.secondarySize, border: 'none', background: 'transparent', color: theme.text.secondary, outline: 'none', width: 80 }}
          />
        </div>
      </Field>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 8 }}>
        <button onClick={onCancel} style={{ padding: '6px 16px', borderRadius: 6, border: `1px solid ${theme.border.default}`, background: theme.surface.panelElevated, color: theme.text.muted, fontSize: fonts.secondarySize, cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onSave(draft)} style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: theme.accent.base, color: theme.text.inverse, fontSize: fonts.secondarySize, fontWeight: 600, cursor: 'pointer' }}>Save</button>
      </div>
    </div>
  )
}

// ─── Skills section ──────────────────────────────────────────────────────────

export function SkillsSection({ workspacePath, hideHeaderText = false }: { workspacePath: string; hideHeaderText?: boolean }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [items, setItems] = useState<SkillDefinition[]>([])
  const [editing, setEditing] = useState<SkillDefinition | null>(null)
  const [selected, setSelected] = useState<SkillDefinition | null>(null)
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview')
  const [locationsOpen, setLocationsOpen] = useState(false)
  const [locationText, setLocationText] = useState(DEFAULT_SKILL_LOCATIONS)

  const file = `${dataDir(workspacePath)}/skills.json`
  const locFile = `${dataDir(workspacePath)}/locations-skills.json`
  useEffect(() => { loadJson<SkillDefinition[]>(file, []).then(setItems) }, [file])
  useEffect(() => { loadJson<string>(locFile, DEFAULT_SKILL_LOCATIONS).then(setLocationText) }, [locFile])
  const save = useCallback((next: SkillDefinition[]) => { setItems(next); saveJson(file, next) }, [file])
  const saveLocations = useCallback((text: string) => { setLocationText(text); saveJson(locFile, text) }, [locFile])

  const handleSave = useCallback((item: SkillDefinition) => {
    const exists = items.find(i => i.id === item.id)
    save(exists ? items.map(i => i.id === item.id ? item : i) : [...items, item])
    setEditing(null)
    setSelected(item)
  }, [items, save])

  // Auto-discover skills from configured scan locations
  useEffect(() => {
    const scanDirs = async () => {
      const homePath = window.electron.homedir
      const dirs = resolveLocations(locationText, homePath, workspacePath)
      const discovered: SkillDefinition[] = []
      for (const dir of dirs) {
        const entries: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await window.electron.fs.readDir(dir).catch(() => [])
        for (const f of entries) {
          if (f.isDir || (f.ext !== '.md' && f.ext !== '.txt' && f.ext !== '.mdc')) continue
          const content = await readTextIfExists(f.path)
          if (!content) continue
          const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+?)$/m)
          const name = nameMatch?.[1]?.trim() ?? f.name.replace(/\.(md|txt|mdc)$/, '')
          const descMatch = content.match(/^---[\s\S]*?description:\s*(.+?)$/m)
          if (!discovered.find(s => s.name === name)) {
            discovered.push({
              id: `discovered-${f.path}`,
              name,
              description: descMatch?.[1]?.trim() ?? `From ${dir}`,
              content,
              command: name,
            })
          }
        }
      }
      if (discovered.length > 0) {
        setItems(prev => {
          const existing = new Set(prev.map(s => s.name))
          const newOnes = discovered.filter(s => !existing.has(s.name))
          return newOnes.length > 0 ? [...prev, ...newOnes] : prev
        })
      }
    }
    scanDirs()
  }, [workspacePath, locationText])

  if (editing) return <SkillEditor item={editing} onSave={handleSave} onCancel={() => setEditing(null)} />
  if (locationsOpen) return (
    <LocationsPanel
      title="Skill"
      value={locationText}
      onChange={saveLocations}
      onClose={() => setLocationsOpen(false)}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Skills"
        description="Custom skills and discovered commands"
        newLabel="New Skill"
        onNew={() => setEditing({ id: `skill-${Date.now()}`, name: '', description: '', content: '' })}
        onLocations={() => setLocationsOpen(true)}
        hideText={hideHeaderText}
      />
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
      {/* Left list */}
      <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' }}>
        {items.map(s => (
          <div key={s.id} onClick={() => setSelected(s)} style={{
            padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
            background: selected?.id === s.id ? theme.surface.selection : 'transparent',
            border: `1px solid ${selected?.id === s.id ? theme.border.accent : 'transparent'}`,
          }}
            onMouseEnter={e => { if (selected?.id !== s.id) e.currentTarget.style.background = theme.surface.hover }}
            onMouseLeave={e => { if (selected?.id !== s.id) e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{ fontSize: fonts.secondarySize, fontWeight: 500, color: theme.text.primary }}>{s.name || 'Untitled'}</div>
            {s.command && <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 2 }}>/{s.command}</div>}
          </div>
        ))}
        {items.length === 0 && <div style={{ padding: 10, fontSize: fonts.secondarySize, color: theme.text.disabled }}>No skills yet</div>}
      </div>
      {/* Right detail */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
        {selected ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary, flex: 1 }}>{selected.name}</span>
              <button onClick={() => setEditing(selected)} style={{ fontSize: fonts.secondarySize, padding: '4px 10px', borderRadius: 5, border: `1px solid ${theme.border.default}`, background: 'transparent', color: theme.text.muted, cursor: 'pointer' }}>Edit</button>
              <button onClick={() => { save(items.filter(i => i.id !== selected.id)); setSelected(null) }} style={{ fontSize: fonts.secondarySize, padding: '4px 10px', borderRadius: 5, border: `1px solid ${theme.border.default}`, background: 'transparent', color: theme.status.danger, cursor: 'pointer' }}>Delete</button>
            </div>
            {selected.description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, lineHeight: 1.5 }}>{selected.description}</div>}
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => setViewMode('preview')} style={{ fontSize: fonts.secondarySize, padding: '3px 10px', borderRadius: 4, border: `1px solid ${viewMode === 'preview' ? theme.border.accent : theme.border.default}`, background: viewMode === 'preview' ? theme.accent.soft : 'transparent', color: viewMode === 'preview' ? theme.accent.base : theme.text.muted, cursor: 'pointer' }}>Preview</button>
              <button onClick={() => setViewMode('raw')} style={{ fontSize: fonts.secondarySize, padding: '3px 10px', borderRadius: 4, border: `1px solid ${viewMode === 'raw' ? theme.border.accent : theme.border.default}`, background: viewMode === 'raw' ? theme.accent.soft : 'transparent', color: viewMode === 'raw' ? theme.accent.base : theme.text.muted, cursor: 'pointer' }}>Raw</button>
            </div>
            {viewMode === 'raw' ? (
              <div style={{
                flex: 1, padding: 12, borderRadius: 8, overflow: 'auto',
                background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`,
                fontSize: fonts.secondarySize, lineHeight: 1.6,
                fontFamily: '"JetBrains Mono", monospace',
                color: theme.text.secondary, whiteSpace: 'pre-wrap',
              }}>
                {selected.content || 'No content'}
              </div>
            ) : (
              <div
                style={{
                  flex: 1, padding: 12, borderRadius: 8, overflow: 'auto',
                  background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`,
                  fontSize: fonts.secondarySize, lineHeight: 1.6,
                  color: theme.text.secondary,
                }}
              >
                <ChatMarkdown text={selected.content || 'No content'} />
              </div>
            )}
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text.disabled, fontSize: fonts.secondarySize }}>Select a skill to view details</div>
        )}
      </div>
      </div>

    </div>
  )
}

function SkillEditor({ item, onSave, onCancel }: { item: SkillDefinition; onSave: (s: SkillDefinition) => void; onCancel: () => void }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [draft, setDraft] = useState(item)
  const up = (patch: Partial<SkillDefinition>) => setDraft(prev => ({ ...prev, ...patch }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>{item.name ? 'Edit Skill' : 'New Skill'}</span>
      <Field label="Name"><Input value={draft.name} onChange={v => up({ name: v })} placeholder="Skill name" /></Field>
      <Field label="Description"><Input value={draft.description} onChange={v => up({ description: v })} placeholder="What does this skill do?" /></Field>
      <Field label="Command"><Input value={draft.command ?? ''} onChange={v => up({ command: v })} placeholder="e.g. my-skill" /></Field>
      <Field label="Content (Markdown)"><Input value={draft.content} onChange={v => up({ content: v })} placeholder="# Skill content..." multiline mono rows={12} /></Field>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 8 }}>
        <button onClick={onCancel} style={{ padding: '6px 16px', borderRadius: 6, border: `1px solid ${theme.border.default}`, background: theme.surface.panelElevated, color: theme.text.muted, fontSize: fonts.secondarySize, cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onSave(draft)} style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: theme.accent.base, color: theme.text.inverse, fontSize: fonts.secondarySize, fontWeight: 600, cursor: 'pointer' }}>Save</button>
      </div>
    </div>
  )
}

// ─── Tools section ───────────────────────────────────────────────────────────

// ─── Builtin tools definition ────────────────────────────────────────────────

const BUILTIN_TOOLS: Array<{ name: string; category: string; description: string }> = [
  { name: 'Read', category: 'Files', description: 'Read file contents' },
  { name: 'Write', category: 'Files', description: 'Write file contents' },
  { name: 'Edit', category: 'Files', description: 'Edit file with search/replace' },
  { name: 'Glob', category: 'Files', description: 'Find files by pattern' },
  { name: 'Grep', category: 'Files', description: 'Search file contents' },
  { name: 'Bash', category: 'System', description: 'Execute shell commands' },
  { name: 'WebSearch', category: 'Web', description: 'Search the web' },
  { name: 'WebFetch', category: 'Web', description: 'Fetch URL content' },
  { name: 'Agent', category: 'Agents', description: 'Spawn sub-agents' },
  { name: 'AskUserQuestion', category: 'Interaction', description: 'Ask the user a question' },
  { name: 'TodoWrite', category: 'Planning', description: 'Write task list' },
]

type PermLevel = 'allow' | 'ask' | 'deny'

// ─── MCP Registry types ─────────────────────────────────────────────────────

interface RegistryServer {
  name: string
  title?: string
  description: string
  version?: string
  remoteUrl?: string
  remoteType?: string
  repositoryUrl?: string
  iconUrl?: string
  stars?: number | null
  source?: string
}

// ─── Tools section ───────────────────────────────────────────────────────────

export function ToolsSection({ hideHeaderText = false }: { hideHeaderText?: boolean } = {}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [permissions, setPermissions] = useState<Record<string, PermLevel>>({})
  const [expandedCat, setExpandedCat] = useState<string | null>(null)
  const [showRegistry, setShowRegistry] = useState(false)
  const [regQuery, setRegQuery] = useState('')
  const [regResults, setRegResults] = useState<RegistryServer[]>([])
  const [regLoading, setRegLoading] = useState(false)
  const [regTotal, setRegTotal] = useState(0)

  // Group builtin tools by category
  const categories = BUILTIN_TOOLS.reduce<Record<string, typeof BUILTIN_TOOLS>>((acc, t) => {
    if (!acc[t.category]) acc[t.category] = []
    acc[t.category].push(t)
    return acc
  }, {})

  const getPerm = (name: string): PermLevel => permissions[name] ?? 'ask'
  const setPerm = (name: string, level: PermLevel) => setPermissions(prev => ({ ...prev, [name]: level }))

  const setCategoryPerm = (cat: string, level: PermLevel) => {
    setPermissions(prev => {
      const next = { ...prev }
      for (const t of categories[cat] ?? []) next[t.name] = level
      return next
    })
  }

  // Registry search
  const searchRegistry = useCallback(async (q: string) => {
    setRegLoading(true)
    try {
      const url = `https://registry.modelcontextprotocol.io/v0.1/servers?limit=30`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json() as { servers?: RegistryServer[] }
        const servers = (data.servers ?? []).filter((s: RegistryServer) =>
          !q || s.name?.toLowerCase().includes(q.toLowerCase()) || s.description?.toLowerCase().includes(q.toLowerCase())
        )
        setRegResults(servers.slice(0, 30))
        setRegTotal(servers.length)
      }
    } catch {
      setRegResults([])
    }
    setRegLoading(false)
  }, [])

  useEffect(() => {
    if (showRegistry) searchRegistry(regQuery)
  }, [showRegistry])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="Tools & Actions"
        description="Builtin tools, MCP servers, and integrations"
        newLabel="Browse Registry"
        onNew={() => setShowRegistry(true)}
        hideText={hideHeaderText}
      />

      {/* ── Builtin Tools ── */}
      <div>
        <div style={{ fontSize: fonts.secondarySize, fontWeight: 700, color: theme.text.disabled, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>Built-in Tools</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {Object.entries(categories).map(([cat, tools]) => (
            <div key={cat}>
              <div
                onClick={() => setExpandedCat(expandedCat === cat ? null : cat)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                  background: expandedCat === cat ? theme.surface.selection : 'transparent',
                }}
                onMouseEnter={e => { if (expandedCat !== cat) e.currentTarget.style.background = theme.surface.hover }}
                onMouseLeave={e => { if (expandedCat !== cat) e.currentTarget.style.background = 'transparent' }}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" style={{ transition: 'transform 0.15s', transform: expandedCat === cat ? 'rotate(90deg)' : 'rotate(0deg)', opacity: 0.5 }}>
                  <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.primary, flex: 1 }}>{cat}</span>
                <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, background: theme.surface.panelMuted, padding: '1px 7px', borderRadius: 4 }}>{tools.length}</span>
                {/* Category-level permission toggles */}
                <div style={{ display: 'flex', gap: 2 }} onClick={e => e.stopPropagation()}>
                  {(['allow', 'ask', 'deny'] as PermLevel[]).map(level => {
                    const allMatch = tools.every(t => getPerm(t.name) === level)
                    return (
                      <button key={level} onClick={() => setCategoryPerm(cat, level)} style={{
                        width: 22, height: 22, borderRadius: 5, border: 'none', cursor: 'pointer',
                        background: allMatch ? (level === 'allow' ? 'rgba(31,143,95,0.15)' : level === 'deny' ? 'rgba(209,74,74,0.15)' : 'rgba(192,123,18,0.15)') : 'transparent',
                        color: allMatch ? (level === 'allow' ? theme.status.success : level === 'deny' ? theme.status.danger : theme.status.warning) : theme.text.disabled,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: fonts.secondarySize,
                      }}>
                        {level === 'allow' ? <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 7l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          : level === 'ask' ? <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" /><path d="M5.5 5.5a1.5 1.5 0 012.8.8c0 1-1.3 1.3-1.3 2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="7" cy="10.5" r="0.6" fill="currentColor" /></svg>
                          : <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                        }
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* Expanded individual tools */}
              {expandedCat === cat && (
                <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 4 }}>
                  {tools.map(tool => (
                    <div key={tool.name} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', borderRadius: 6,
                    }}
                      onMouseEnter={e => { e.currentTarget.style.background = theme.surface.hover }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: fonts.secondarySize, fontWeight: 500, color: theme.text.primary }}>{tool.name}</div>
                        <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>{tool.description}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 2 }}>
                        {(['allow', 'ask', 'deny'] as PermLevel[]).map(level => {
                          const active = getPerm(tool.name) === level
                          return (
                            <button key={level} onClick={() => setPerm(tool.name, level)} title={level === 'allow' ? 'Always allow' : level === 'ask' ? 'Ask each time' : 'Deny'} style={{
                              width: 22, height: 22, borderRadius: 5, border: 'none', cursor: 'pointer',
                              background: active ? (level === 'allow' ? 'rgba(31,143,95,0.15)' : level === 'deny' ? 'rgba(209,74,74,0.15)' : 'rgba(192,123,18,0.15)') : 'transparent',
                              color: active ? (level === 'allow' ? theme.status.success : level === 'deny' ? theme.status.danger : theme.status.warning) : theme.text.disabled,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              {level === 'allow' ? <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 7l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                : level === 'ask' ? <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" /><path d="M5.5 5.5a1.5 1.5 0 012.8.8c0 1-1.3 1.3-1.3 2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="7" cy="10.5" r="0.6" fill="currentColor" /></svg>
                                : <svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                              }
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── MCP Servers note ── */}
      <div style={{ padding: '12px 14px', borderRadius: 10, background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}` }}>
        <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted }}>
          MCP server connections are configured below in this same panel. Scroll down to manage connected servers, add new ones, or configure workspace-specific servers.
        </div>
      </div>

      {/* ── Registry Dialog ── */}
      {showRegistry && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 999999, background: theme.mode === 'light' ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowRegistry(false) }}>
          <div style={{
            width: 560, maxHeight: '80vh', background: theme.surface.panel,
            border: `1px solid ${theme.border.strong}`, borderRadius: 12,
            boxShadow: theme.shadow.modal, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Registry header */}
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${theme.border.default}`, display: 'flex', alignItems: 'center', gap: 10 }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="4" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" /><path d="M4 4V2.5A1.5 1.5 0 015.5 1h5A1.5 1.5 0 0112 2.5V4" stroke="currentColor" strokeWidth="1.3" /><path d="M1 8h14" stroke="currentColor" strokeWidth="1.3" /><rect x="6" y="6.5" width="4" height="3" rx="0.5" fill="currentColor" /></svg>
              <span style={{ fontSize: fonts.size, fontWeight: 700, color: theme.text.primary, flex: 1 }}>MCP Registry</span>
              {regTotal > 0 && <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, background: theme.surface.panelMuted, padding: '2px 8px', borderRadius: 4 }}>{regTotal} servers</span>}
              <button onClick={() => setShowRegistry(false)} style={{ width: 24, height: 24, border: 'none', background: 'transparent', color: theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>x</button>
            </div>

            {/* Search */}
            <div style={{ padding: '10px 18px', borderBottom: `1px solid ${theme.border.subtle}` }}>
              <input value={regQuery}
                onChange={e => setRegQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') searchRegistry(regQuery) }}
                placeholder="Search MCP servers..."
                style={{ width: '100%', padding: '7px 10px', fontSize: fonts.secondarySize, borderRadius: 6, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>

            {/* Results */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 18px' }}>
              {regLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: theme.text.disabled, fontSize: fonts.secondarySize }}>Searching registry...</div>
              ) : regResults.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: theme.text.disabled, fontSize: fonts.secondarySize }}>
                  {regQuery ? 'No servers found matching your search' : 'Enter a search term or press Enter to browse'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {regResults.map(srv => (
                    <div key={srv.name} style={{
                      padding: '10px 12px', borderRadius: 8,
                      border: `1px solid ${theme.border.default}`,
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                    }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = theme.border.accent }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border.default }}
                    >
                      <div style={{
                        width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                        background: theme.surface.panelMuted, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: fonts.size, fontWeight: 700, color: theme.text.disabled,
                      }}>
                        {srv.iconUrl ? <img src={srv.iconUrl} width={20} height={20} style={{ borderRadius: 4 }} /> : (srv.name?.[0] ?? 'M').toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.primary, fontFamily: fonts.mono }}>{srv.title ?? srv.name}</div>
                        <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginTop: 2, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{srv.description}</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                          {srv.version && <span style={{ fontSize: fonts.secondarySize - 1, padding: '1px 6px', borderRadius: 3, background: theme.surface.panelMuted, color: theme.text.disabled }}>{srv.version}</span>}
                          {srv.remoteType && <span style={{ fontSize: fonts.secondarySize - 1, padding: '1px 6px', borderRadius: 3, background: theme.surface.panelMuted, color: theme.text.disabled }}>{srv.remoteType}</span>}
                          {srv.source && <span style={{ fontSize: fonts.secondarySize - 1, padding: '1px 6px', borderRadius: 3, background: srv.source === 'google' ? 'rgba(53,104,255,0.1)' : 'rgba(192,123,18,0.1)', color: srv.source === 'google' ? theme.accent.base : theme.status.warning }}>{srv.source}</span>}
                          {srv.stars != null && srv.stars > 0 && <span style={{ fontSize: fonts.secondarySize - 1, padding: '1px 6px', borderRadius: 3, background: theme.surface.panelMuted, color: theme.text.disabled }}>
                            <svg width="8" height="8" viewBox="0 0 14 14" fill="currentColor" style={{ verticalAlign: -1, marginRight: 2 }}><path d="M7 1l1.8 3.6L13 5.2l-3 2.9.7 4.1L7 10.3 3.3 12.2l.7-4.1-3-2.9 4.2-.6L7 1z" /></svg>
                            {srv.stars}
                          </span>}
                        </div>
                      </div>
                      <button onClick={() => {
                        // Install: copy command to clipboard for now
                        const cmd = srv.remoteUrl
                          ? `"${srv.title ?? srv.name}": { "type": "${srv.remoteType ?? 'http'}", "url": "${srv.remoteUrl}" }`
                          : srv.repositoryUrl
                            ? `npx -y github:${srv.repositoryUrl.replace('https://github.com/', '')}`
                            : srv.name
                        navigator.clipboard.writeText(cmd)
                      }} style={{
                        fontSize: fonts.secondarySize, padding: '4px 10px', borderRadius: 5, border: `1px solid ${theme.border.default}`,
                        background: theme.surface.panelElevated, color: theme.text.secondary, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.background = theme.accent.base; e.currentTarget.style.color = theme.text.inverse; e.currentTarget.style.borderColor = theme.accent.base }}
                        onMouseLeave={e => { e.currentTarget.style.background = theme.surface.panelElevated; e.currentTarget.style.color = theme.text.secondary; e.currentTarget.style.borderColor = theme.border.default }}
                      >
                        Copy Config
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Agents section ──────────────────────────────────────────────────────────

const DEFAULT_MODES: AgentMode[] = [
  { id: 'agent', name: 'Agent', description: 'Full autonomous access to all tools', systemPrompt: '', tools: null, icon: 'robot', color: '#3568ff', isBuiltin: true },
  { id: 'ask', name: 'Ask', description: 'Read-only Q&A mode — no file modifications', systemPrompt: 'You are in read-only mode. Do not modify files or run destructive commands.', tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], icon: 'help', color: '#56c288', isBuiltin: true },
  { id: 'plan', name: 'Plan', description: 'Plan without execution — outline steps before acting', systemPrompt: 'Create a detailed plan. Do not execute changes until the user approves.', tools: ['Read', 'Glob', 'Grep', 'WebSearch'], icon: 'map', color: '#f5a623', isBuiltin: true },
]

const AGENT_COLORS = ['#3568ff', '#56c288', '#f5a623', '#e57399', '#b368c9', '#00acd7', '#ff7b72', '#8f96a0']
const AGENT_ICONS: Record<string, JSX.Element> = {
  robot: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="4" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.2" /><circle cx="5" cy="8" r="1" fill="currentColor" /><circle cx="9" cy="8" r="1" fill="currentColor" /><path d="M7 1v3M5 1h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>,
  help: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" /><path d="M5.5 5.5a1.5 1.5 0 012.8.8c0 1-1.3 1.2-1.3 2.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="7" cy="10.5" r="0.5" fill="currentColor" /></svg>,
  map: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 3l4-1.5 4 1.5 4-1.5v9.5l-4 1.5-4-1.5L1 12.5V3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M5 1.5v10M9 3.5v10" stroke="currentColor" strokeWidth="1.2" /></svg>,
  star: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.8 3.6L13 5.2l-3 2.9.7 4.1L7 10.3 3.3 12.2l.7-4.1-3-2.9 4.2-.6L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
  bolt: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7.5 1L3 8h4l-.5 5L11 6H7l.5-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
}

export function AgentsSection({ workspacePath, hideHeaderText = false }: { workspacePath: string; hideHeaderText?: boolean }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [items, setItems] = useState<AgentMode[]>([])
  const [editing, setEditing] = useState<AgentMode | null>(null)
  const [locationsOpen, setLocationsOpen] = useState(false)
  const [locationText, setLocationText] = useState(DEFAULT_AGENT_LOCATIONS)

  const file = `${dataDir(workspacePath)}/agents.json`
  const locFile = `${dataDir(workspacePath)}/locations-agents.json`
  useEffect(() => {
    loadJson<AgentMode[]>(file, []).then(loaded => {
      // Merge with defaults
      const merged = [...DEFAULT_MODES]
      for (const item of loaded) {
        const idx = merged.findIndex(m => m.id === item.id)
        if (idx >= 0) merged[idx] = { ...merged[idx], ...item }
        else merged.push(item)
      }
      setItems(merged)
    })
  }, [file])
  useEffect(() => { loadJson<string>(locFile, DEFAULT_AGENT_LOCATIONS).then(setLocationText) }, [locFile])
  const saveLocations = useCallback((text: string) => { setLocationText(text); saveJson(locFile, text) }, [locFile])

  const save = useCallback((next: AgentMode[]) => {
    setItems(next)
    // Only persist non-default or modified items
    saveJson(file, next.filter(m => !m.isBuiltin || DEFAULT_MODES.find(d => d.id === m.id && JSON.stringify(d) !== JSON.stringify(m))))
  }, [file])

  const handleSave = useCallback((item: AgentMode) => {
    const exists = items.find(i => i.id === item.id)
    save(exists ? items.map(i => i.id === item.id ? item : i) : [...items, item])
    setEditing(null)
  }, [items, save])

  // Auto-discover agents from configured scan locations
  useEffect(() => {
    const scanDirs = async () => {
      const homePath = window.electron.homedir
      const dirs = resolveLocations(locationText, homePath, workspacePath)
      const discovered: AgentMode[] = []
      for (const dir of dirs) {
        const entries: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await window.electron.fs.readDir(dir).catch(() => [])
        for (const f of entries) {
          if (f.isDir || (f.ext !== '.md' && f.ext !== '.txt' && f.ext !== '.json')) continue
          const raw = await readTextIfExists(f.path)
          if (!raw) continue
          if (f.ext === '.json') {
            try {
              const data = JSON.parse(raw) as Partial<AgentMode>
              const name = data.name ?? f.name.replace('.json', '')
              if (!discovered.find(a => a.name === name)) {
                discovered.push({
                  id: `discovered-${f.path}`,
                  name,
                  description: data.description ?? `From ${dir}`,
                  systemPrompt: data.systemPrompt ?? '',
                  tools: data.tools ?? null,
                  icon: data.icon ?? 'robot',
                  color: data.color ?? '#8f96a0',
                  isBuiltin: false,
                  source: data.source,
                })
              }
            } catch { /* invalid json */ }
          } else {
            const nameMatch = raw.match(/^---[\s\S]*?name:\s*(.+?)$/m)
            const name = nameMatch?.[1]?.trim() ?? f.name.replace(/\.(md|txt)$/, '')
            const descMatch = raw.match(/^---[\s\S]*?description:\s*(.+?)$/m)
            if (!discovered.find(a => a.name === name)) {
              discovered.push({
                id: `discovered-${f.path}`,
                name,
                description: descMatch?.[1]?.trim() ?? `From ${dir}`,
                systemPrompt: raw,
                tools: null,
                icon: 'robot',
                color: '#8f96a0',
                isBuiltin: false,
              })
            }
          }
        }
      }
      if (discovered.length > 0) {
        setItems(prev => {
          const existing = new Set(prev.map(a => a.name))
          const newOnes = discovered.filter(a => !existing.has(a.name))
          return newOnes.length > 0 ? [...prev, ...newOnes] : prev
        })
      }
    }
    scanDirs()
  }, [workspacePath, locationText])

  if (editing) return <AgentEditor item={editing} modes={items} onSave={handleSave} onCancel={() => setEditing(null)} />
  if (locationsOpen) return (
    <LocationsPanel
      title="Agent"
      value={locationText}
      onChange={saveLocations}
      onClose={() => setLocationsOpen(false)}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PageHeader
        title="Agent Modes"
        description="Agent personas with system prompts and tool access"
        newLabel="New Mode"
        onNew={() => setEditing({ id: `mode-${Date.now()}`, name: '', description: '', systemPrompt: '', tools: null, icon: 'robot', color: '#3568ff', isBuiltin: false })}
        onLocations={() => setLocationsOpen(true)}
        hideText={hideHeaderText}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
        {items.map(m => (
          <ItemCard key={m.id} title={m.name || 'Untitled'} description={m.description} color={m.color}
            chips={[
              m.tools ? `${m.tools.length} tool${m.tools.length !== 1 ? 's' : ''}` : 'All tools',
              ...(m.isBuiltin ? ['Built-in'] : []),
              ...(m.source ? [m.source] : []),
            ]}
            onEdit={() => setEditing(m)} onDelete={m.isBuiltin ? undefined : () => save(items.filter(i => i.id !== m.id))}
          />
        ))}
      </div>
    </div>
  )
}

function AgentEditor({ item, modes, onSave, onCancel }: { item: AgentMode; modes: AgentMode[]; onSave: (m: AgentMode) => void; onCancel: () => void }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [draft, setDraft] = useState(item)
  const up = (patch: Partial<AgentMode>) => setDraft(prev => ({ ...prev, ...patch }))
  const [restrictTools, setRestrictTools] = useState(item.tools !== null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>{item.name ? 'Edit Mode' : 'New Mode'}</span>
      <Field label="Name"><Input value={draft.name} onChange={v => up({ name: v })} placeholder="Mode name" /></Field>
      <Field label="Description"><Input value={draft.description} onChange={v => up({ description: v })} placeholder="What is this mode for?" /></Field>
      <Field label="System Prompt"><Input value={draft.systemPrompt} onChange={v => up({ systemPrompt: v })} placeholder="Instructions for the agent..." multiline rows={6} /></Field>

      <Field label="Icon & Color">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 3 }}>
            {Object.entries(AGENT_ICONS).map(([key, icon]) => (
              <button key={key} onClick={() => up({ icon: key })} style={{
                width: 28, height: 28, borderRadius: 6, border: `1.5px solid ${draft.icon === key ? draft.color : theme.border.default}`,
                background: draft.icon === key ? theme.accent.soft : 'transparent',
                color: draft.icon === key ? draft.color : theme.text.muted, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{icon}</button>
            ))}
          </div>
          <div style={{ width: 1, height: 20, background: theme.border.default }} />
          <div style={{ display: 'flex', gap: 3 }}>
            {AGENT_COLORS.map(c => (
              <button key={c} onClick={() => up({ color: c })} style={{
                width: 20, height: 20, borderRadius: 10, border: `2px solid ${draft.color === c ? theme.text.primary : 'transparent'}`,
                background: c, cursor: 'pointer', padding: 0,
              }} />
            ))}
          </div>
        </div>
      </Field>

      <Field label="Tools">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: restrictTools ? 8 : 0 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: fonts.secondarySize, color: theme.text.secondary, cursor: 'pointer' }}>
            <input type="checkbox" checked={restrictTools} onChange={e => { setRestrictTools(e.target.checked); if (!e.target.checked) up({ tools: null }) }} />
            Restrict tools
          </label>
        </div>
        {restrictTools && (
          <Input value={(draft.tools ?? []).join(', ')} onChange={v => up({ tools: v.split(',').map(s => s.trim()).filter(Boolean) })} placeholder="Read, Glob, Grep, WebSearch..." />
        )}
      </Field>

      <Field label="Default Next Mode">
        <select value={draft.defaultNextMode ?? ''} onChange={e => up({ defaultNextMode: e.target.value || undefined })}
          style={{ padding: '6px 10px', fontSize: fonts.secondarySize, borderRadius: 6, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, outline: 'none' }}>
          <option value="">None</option>
          {modes.filter(m => m.id !== draft.id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </Field>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 8 }}>
        {item.isBuiltin && (
          <button onClick={() => {
            const d = DEFAULT_MODES.find(m => m.id === item.id)
            if (d) onSave(d)
          }} style={{ padding: '6px 16px', borderRadius: 6, border: `1px solid ${theme.border.default}`, background: 'transparent', color: theme.text.disabled, fontSize: fonts.secondarySize, cursor: 'pointer', marginRight: 'auto' }}>Reset to Default</button>
        )}
        <button onClick={onCancel} style={{ padding: '6px 16px', borderRadius: 6, border: `1px solid ${theme.border.default}`, background: theme.surface.panelElevated, color: theme.text.muted, fontSize: fonts.secondarySize, cursor: 'pointer' }}>Cancel</button>
        <button onClick={() => onSave(draft)} style={{ padding: '6px 16px', borderRadius: 6, border: 'none', background: theme.accent.base, color: theme.text.inverse, fontSize: fonts.secondarySize, fontWeight: 600, cursor: 'pointer' }}>Save</button>
      </div>
    </div>
  )
}

// ─── Tab icons ───────────────────────────────────────────────────────────────

const TAB_ICONS: Record<Tab, JSX.Element> = {
  prompts: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M3 2h8a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" /><path d="M4 5h6M4 7.5h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg>,
  skills: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.8 3.6L13 5.2l-3 2.9.7 4.1L7 10.3 3.3 12.2l.7-4.1-3-2.9 4.2-.6L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
  tools: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M8.5 2.5a3 3 0 00-4.2 4.2L2 9l1 2 2 1 2.3-2.3a3 3 0 004.2-4.2L9.5 7.5 8 7l-.5-1.5L9.5 3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
  agents: <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="4.5" r="2.5" stroke="currentColor" strokeWidth="1.2" /><path d="M2.5 12.5c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>,
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function CustomisationTile({ tileId: _tileId, workspacePath, width: _width, height: _height, initialTab }: Props): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [tab, setTab] = useState<Tab>(initialTab ?? 'prompts')

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 12px 6px', borderBottom: `1px solid ${theme.border.subtle}`, flexShrink: 0 }}>
        {(['prompts', 'skills', 'tools', 'agents'] as Tab[]).map(t => (
          <TabBtn key={t} label={t.charAt(0).toUpperCase() + t.slice(1)} icon={TAB_ICONS[t]} active={tab === t} onClick={() => setTab(t)} />
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16, minHeight: 0 }}>
        {tab === 'prompts' && <PromptsSection workspacePath={workspacePath} />}
        {tab === 'skills' && <SkillsSection workspacePath={workspacePath} />}
        {tab === 'tools' && <ToolsSection />}
        {tab === 'agents' && <AgentsSection workspacePath={workspacePath} />}
      </div>
    </div>
  )
}
