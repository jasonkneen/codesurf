import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useDetectedAgents } from '../hooks/useDetectedAgents'
import { useMCPServers } from '../hooks/useMCPServers'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'


// ─── Types ────────────────────────────────────────────────────────────────────

export interface MCPServer {
  name: string
  url?: string
  cmd?: string
}

export interface KanbanCardData {
  id: string
  title: string
  description: string
  instructions: string
  columnId: string
  color: string
  linkedTileId?: string
  linkedTileType?: string
  linkedGroupId?: string
  linkedTileIds?: string[]
  justMoved?: boolean
  agent: string
  model?: string
  mcpConfig?: string
  mcpServers: MCPServer[]
  tools: string[]
  skillsAndCommands: string[]
  fileRefs: string[]
  cardRefs: string[]
  hooks: string[]
  launched: boolean
  briefPath?: string
  launchPrompt?: string
  comments: Comment[]
  attachments: Attachment[]
}

interface Comment { id: string; text: string; ts: number }
interface Attachment { id: string; name: string; path: string }

export interface DetectedAgent {
  id: string
  label: string
  cmd: string
  path?: string
  version?: string
  available: boolean
}

export const AGENTS: DetectedAgent[] = [
  { id: 'shell',    label: 'Shell',    cmd: 'zsh',      available: true },
  { id: 'claude',   label: 'Claude',   cmd: 'claude',   available: false },
  { id: 'codex',    label: 'Codex',    cmd: 'codex',    available: false },
  { id: 'openclaw', label: 'OpenClaw', cmd: 'openclaw', available: false },
  { id: 'hermes',   label: 'Hermes',   cmd: 'hermes',   available: false },
]

export const MODELS: Record<string, string[]> = {
  claude:   ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-3-5'],
  codex:    ['gpt-4.1', 'o4-mini', 'o3'],
  gemini:   ['gemini-2.5-pro', 'gemini-2.5-flash'],
  opencode: ['claude-sonnet-4-5', 'gpt-4.1'],
  openclaw: ['claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-5.4', 'o4-mini'],
  hermes:   ['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-terra', 'openai-codex/gpt-5.6-luna', 'openai-codex/gpt-5.5', 'anthropic/claude-opus-5', 'openrouter/x-ai/grok-4.6'],
  shell:    []
}

const MCP_CONFIG = '$CODESURF_MCP_CONFIG'
const BUILTIN_TOOLS = ['read', 'write', 'edit', 'bash', 'computer', 'web_search', 'browser']

function resolveMcpConfigPath(input: string): string {
  if (!input.startsWith('~')) return input
  // contextIsolation removes window.process — the bridge exposes homedir instead.
  const home = window.electron?.homedir || (window as any).process?.env?.HOME
  if (!home) return input
  if (input === '~') return home
  if (input.startsWith('~/.codesurf/')) {
    return `${home}/.codesurf/${input.slice('~/.codesurf/'.length)}`
  }
  if (input.startsWith('~\\.codesurf\\')) {
    return `${home}/.codesurf/${input.slice('~\\.codesurf\\'.length)}`
  }
  return `${home}/${input.slice(2)}`
}

// POSIX-safe quoting for values interpolated into a shell command line: wrap
// in single quotes, escaping embedded single quotes as '\''. Inside single
// quotes nothing expands — the previous double-quote wrapping still allowed
// $(...), backticks and ${VAR} from card fields, which are settable via MCP
// (kanban_create_card / kanban_update_card) without a permission prompt.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

type Tab = 'overview' | 'progress' | 'notes'


// ─── Build launch command ─────────────────────────────────────────────────────

export function buildLaunchCmd(card: KanbanCardData, briefPath?: string, agentPath?: string): string {
  if (card.agent === 'shell' || !card.agent) return ''
  const bin = agentPath ?? card.agent
  const parts: string[] = [shQuote(bin)]
  if (card.model) parts.push(`--model ${shQuote(card.model)}`)
  if (card.mcpConfig) {
    parts.push(`--mcp-config ${shQuote(resolveMcpConfigPath(card.mcpConfig))}`)
  } else {
    parts.push('--mcp-config "$CODESURF_MCP_CONFIG"')
  }
  if (briefPath) {
    if (card.agent === 'claude') parts.push(`--print "$(cat ${shQuote(briefPath)})"`)
    else if (card.agent === 'codex') parts.push(`exec "$(cat ${shQuote(briefPath)})"`)
  } else if (card.instructions) {
    if (card.agent === 'claude') parts.push(`--print ${shQuote(card.instructions)}`)
    else if (card.agent === 'codex') parts.push(`exec ${shQuote(card.instructions)}`)
  }
  // Hooks are user-authored shell snippets by design — passed through raw.
  if (card.hooks.length) return card.hooks.join(' && ') + ' && ' + parts.join(' ')
  return parts.join(' ')
}

// ─── KanbanCard ───────────────────────────────────────────────────────────────

function CardAgentRunner({
  termId,
  workspaceId,
  workspaceDir,
  launchCmd,
}: {
  termId: string
  workspaceId: string
  workspaceDir: string
  launchCmd?: string
}): null {
  // `launchCmd` is NOT a dependency, deliberately.
  //
  // It is derived from `agentInfo?.path`, which is undefined on first render and
  // becomes an absolute path (`claude` -> `/opt/homebrew/bin/claude`) when the
  // async `agents:detect` resolves ~100ms later. With launchCmd in the dep array
  // that refinement re-ran the effect, and cleanup calls terminal.destroy —
  // killing the tmux session and pty of an agent that was already running, then
  // re-executing it in a fresh terminal. `card.launched` is persisted, so this
  // fired deterministically on every restart: the first run's work was lost and
  // its side effects ran twice.
  //
  // The command is therefore pinned to the first value that actually launched.
  // A genuinely different agent gets a different `termId`, which IS a dependency
  // and correctly tears the old terminal down.
  const launchedCmdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!launchCmd) return
    if (launchedCmdRef.current === undefined) launchedCmdRef.current = launchCmd
    const commandToRun = launchedCmdRef.current

    let cancelled = false

    // Keep the create promise so cleanup can chain off it. terminal:destroy
    // reads the session map and, when the session is not there yet, skips both
    // tmuxKillSession and pty.kill() — so a cleanup landing during the tens-to-
    // hundreds of ms that create takes (dynamic import, path validation, proxy
    // resolution, spawn) was a no-op, and the create then inserted a live PTY
    // that nothing referenced. Orphaned agent processes accumulated for the life
    // of the app.
    const createPromise = (async () => {
      try {
        await window.electron?.terminal?.create(termId, workspaceId, workspaceDir)
        if (cancelled) return
        await window.electron?.terminal?.write(termId, `${commandToRun}\n`)
      } catch (error) {
        if (!cancelled) {
          console.error('[KanbanCard] CardAgentRunner launch failed:', error)
        }
      }
    })()

    return () => {
      cancelled = true
      // Destroy only once the create has settled, so the session exists to kill.
      void createPromise
        .catch(() => {})
        .then(() => window.electron?.terminal?.destroy(termId, workspaceId))
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, workspaceId, workspaceDir, Boolean(launchCmd)])

  return null
}

interface Props {
  card: KanbanCardData
  workspaceId: string
  workspaceDir: string
  active: boolean
  dragging: boolean
  isRunning: boolean
  allCards: KanbanCardData[]
  onUpdate: (id: string, patch: Partial<KanbanCardData>) => void
  onRemove: (id: string) => void
  onLaunch: (id: string) => void
  onPause: (id: string) => void
  onSave: () => void
  onFocus?: () => void
  onDragStart: () => void
  onDragEnd: () => void
}

function KanbanCardInner({
  card, workspaceId, workspaceDir, active, dragging, isRunning: _isRunning, allCards,
  onUpdate, onRemove, onLaunch, onPause, onSave, onFocus, onDragStart, onDragEnd
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const [advanced, setAdvanced] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [newNote, setNewNote] = useState('')
  const [showColorPicker, setShowColorPicker] = useState(false)

  const detectedAgents = useDetectedAgents()
  const mcpServers = useMCPServers()
  const fonts = useAppFonts()
  const theme = useTheme()
  const availableAgents = detectedAgents.length > 0 ? detectedAgents : AGENTS
  const agentInfo = availableAgents.find(a => a.id === card.agent)
  const termId = `kterm-${card.id}`
  const launchCmd = card.agent !== 'shell' ? buildLaunchCmd(card, card.briefPath, agentInfo?.path) : undefined

  // All available tools = built-ins + every enabled MCP server
  const toolSuggestions = useMemo(
    () => [...BUILTIN_TOOLS, ...mcpServers.map(s => s.name)],
    [mcpServers],
  )
  const cardSuggestions = useMemo(
    () => allCards.filter(c => c.id !== card.id).map(c => c.title),
    [allCards, card.id],
  )
  const cardPalette = useMemo(
    () => theme.mode === 'light'
      ? [
          'rgba(59, 130, 246, 0.22)',
          'rgba(16, 185, 129, 0.22)',
          'rgba(168, 85, 247, 0.20)',
          'rgba(245, 158, 11, 0.22)',
          'rgba(236, 72, 153, 0.20)',
          'rgba(14, 165, 233, 0.20)',
          'rgba(20, 184, 166, 0.20)',
          'rgba(239, 68, 68, 0.18)',
        ]
      : [
          'rgba(88, 166, 255, 0.16)',
          'rgba(52, 211, 153, 0.16)',
          'rgba(192, 132, 252, 0.16)',
          'rgba(251, 191, 36, 0.16)',
          'rgba(244, 114, 182, 0.16)',
          'rgba(96, 165, 250, 0.14)',
          'rgba(45, 212, 191, 0.15)',
          'rgba(248, 113, 113, 0.15)',
        ],
    [theme.mode],
  )
  const instructionPreview = card.instructions.trim() || card.description.trim()
  const headerActionColor = theme.text.primary
  const unresolvedStartAfter = useMemo(
    () => card.cardRefs
      .map(ref => allCards.find(c => c.id === ref || c.title === ref))
      .filter((c): c is KanbanCardData => !!c)
      .filter(c => c.columnId !== 'done'),
    [card.cardRefs, allCards],
  )
  const canStart = card.agent !== 'shell' && unresolvedStartAfter.length === 0

  useEffect(() => {
    if (card.launched) { setExpanded(true); setTab('progress') }
  }, [card.launched])

  const addNote = () => {
    if (!newNote.trim()) return
    onUpdate(card.id, { comments: [...card.comments, { id: `n-${Date.now()}`, text: newNote.trim(), ts: Date.now() }] })
    setNewNote('')
  }

  return (
    <div
      draggable={!expanded}
      onDragStart={e => {
        if (card.linkedTileId) {
          e.dataTransfer.setData('application/tile-id', card.linkedTileId)
          e.dataTransfer.setData('application/tile-type', card.linkedTileType ?? '')
          e.dataTransfer.setData('application/tile-label', card.title)
          e.dataTransfer.effectAllowed = 'link'
        } else {
          e.dataTransfer.setData('application/card-id', card.id)
          e.dataTransfer.setData('application/card-title', card.title)
          e.dataTransfer.effectAllowed = 'copy'
        }
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault(); e.stopPropagation(); setDragOver(false)
        // Group drop
        const groupId = e.dataTransfer.getData('application/group-id')
        if (groupId) {
          let tileIds: string[] = []
          try { tileIds = JSON.parse(e.dataTransfer.getData('application/group-tile-ids') || '[]') } catch { /**/ }
          onUpdate(card.id, {
            linkedGroupId: groupId,
            linkedTileIds: tileIds,
            title: e.dataTransfer.getData('application/group-label') || card.title
          })
          return
        }
        // Tile drop
        const tileId = e.dataTransfer.getData('application/tile-id')
        if (tileId) {
          onUpdate(card.id, { linkedTileId: tileId, linkedTileType: e.dataTransfer.getData('application/tile-type'), title: e.dataTransfer.getData('application/tile-label') || card.title })
          return
        }
        const relatedCardId = e.dataTransfer.getData('application/card-id')
        const relatedCardTitle = e.dataTransfer.getData('application/card-title')
        if (relatedCardId && relatedCardId !== card.id) {
          const label = relatedCardTitle || relatedCardId
          if (!card.cardRefs.includes(label)) onUpdate(card.id, { cardRefs: [...card.cardRefs, label] })
          return
        }
        const filePath = e.dataTransfer.getData('text/plain')
        if (filePath) {
          const name = filePath.split('/').pop() ?? filePath
          if (!card.fileRefs.includes(filePath)) {
            onUpdate(card.id, {
              fileRefs: [...card.fileRefs, filePath],
              attachments: [...card.attachments, { id: `a-${Date.now()}`, name, path: filePath }]
            })
          }
        }
      }}
      style={{
        borderRadius: 10,
        background: theme.surface.panel,
        flexShrink: 0,
        border: `1.5px solid ${dragOver ? theme.accent.base : card.justMoved ? theme.status.success : card.color}`,
        opacity: dragging ? 0.3 : 1,
        boxShadow: (() => {
          // Drop-shadow & hairline derive from theme tokens: dark drop on
          // light themes is anchored on text.primary at low alpha, dark
          // themes use #000 (canonical drop), edge highlight on text.primary
          // mid-alpha. Each branch keeps the same visual structure but
          // tracks the contrast slider through theme.text.primary.
          const drop = (alphaLight: number, alphaDark: number) =>
            theme.mode === 'light'
              ? `color-mix(in srgb, ${theme.text.primary} ${alphaLight}%, transparent)`
              : `color-mix(in srgb, #000 ${alphaDark}%, transparent)`
          const edge = theme.mode === 'light'
            ? `color-mix(in srgb, ${theme.surface.app} 45%, transparent)`
            : `color-mix(in srgb, ${theme.text.primary} 22%, transparent)`
          if (card.justMoved) {
            return `0 10px 24px ${drop(10, 18)}, 0 0 12px ${theme.status.success}66, 0 0 0 0.5px ${edge}`
          }
          if (expanded) {
            return `${theme.shadow.panel}, 0 10px 24px ${drop(8, 14)}, 0 0 0 0.5px ${edge}`
          }
          return `0 6px 16px ${drop(6, 12)}, 0 0 0 0.5px ${edge}`
        })(),
        transition: 'border-color 0.15s, box-shadow 0.15s',
        overflow: 'hidden',
        outline: dragOver ? `1px dashed ${theme.accent.base}44` : 'none',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {card.launched && (
        <CardAgentRunner
          termId={termId}
          workspaceId={workspaceId}
          workspaceDir={workspaceDir}
          launchCmd={launchCmd}
        />
      )}

      {/* ── Collapsed header ── */}
      <div
        style={{
          padding: '4px 10px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          background: card.color,
          borderBottom: `1.5px solid ${card.color}`,
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
        onClick={() => setExpanded(p => !p)}
      >
        {/* Delete + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <Btn onClick={() => onRemove(card.id)} color={headerActionColor}>✕</Btn>
          {card.launched ? (
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: active ? theme.status.success : theme.border.strong,
              boxShadow: active ? `0 0 6px ${theme.status.success}` : 'none',
              transition: 'background 0.3s, box-shadow 0.3s'
            }} />
          ) : (
            <span style={{ fontSize: 9, color: theme.text.disabled, fontFamily: 'inherit', flexShrink: 0 }}>
              {expanded ? 'v' : '>'}
            </span>
          )}
        </div>

        {/* Title */}
        <span style={{
          fontSize: fonts.size, fontWeight: 600, color: theme.text.primary, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}>
          {card.title}
        </span>

        <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
          {showColorPicker ? cardPalette.map(color => (
            <button key={color} onClick={() => { onUpdate(card.id, { color }); setShowColorPicker(false) }} style={{ width: 12, height: 12, borderRadius: 6, background: color, border: `1px solid ${theme.border.default}`, cursor: 'pointer', padding: 0, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }} />
          )) : (
            <button onClick={() => setShowColorPicker(true)} title="Change colour" style={{ width: 12, height: 12, borderRadius: 6, background: card.color, border: `1px solid ${theme.border.default}`, cursor: 'pointer', padding: 0 }} />
          )}
          {onFocus && hovered && <Btn onClick={onFocus} color={theme.accent.base}>go</Btn>}
          {card.agent !== 'shell' && (
            <button
              onClick={() => card.launched ? onPause(card.id) : onLaunch(card.id)}
              title={card.launched ? 'Pause' : (canStart ? 'Start' : `Start after ${unresolvedStartAfter.map(c => c.title).join(', ')}`)}
              style={{
                width: 24, height: 24, borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: canStart || card.launched ? headerActionColor : theme.text.disabled,
                cursor: 'pointer', padding: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'inherit', fontWeight: 800, fontSize: 16,
              }}
            >
              <span style={{ color: theme.text.primary, textShadow: `0 1px 0 ${theme.mode === 'light' ? `color-mix(in srgb, ${theme.surface.app} 35%, transparent)` : `color-mix(in srgb, #000 35%, transparent)`}`, transform: 'translateY(3px)', display: 'inline-block' }}>
                {card.launched ? '❚❚' : '►'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Collapsed summary strip */}
      {!expanded && (
        <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: fonts.size, color: instructionPreview ? theme.text.primary : theme.text.disabled, lineHeight: fonts.lineHeight, minHeight: 40, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', fontWeight: fonts.weight } as React.CSSProperties}>
            {instructionPreview || 'No instructions yet'}
          </div>
          {(card.tools.length > 0 || card.fileRefs.length > 0 || card.cardRefs.length > 0) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {card.tools.map(t => <Chip key={t} label={t} prefix="@" bg={`color-mix(in srgb, ${theme.accent.base} ${theme.mode === 'light' ? 12 : 22}%, transparent)`} fg={theme.accent.base} />)}
              {card.fileRefs.map(f => <Chip key={f} label={f.split('/').pop() ?? f} prefix="@" bg={`color-mix(in srgb, ${theme.status.warning} ${theme.mode === 'light' ? 12 : 22}%, transparent)`} fg={theme.status.warning} title={f} neutral />)}
              {card.cardRefs.map(r => <Chip key={r} label={r} prefix="→" bg={`color-mix(in srgb, ${theme.accent.base} ${theme.mode === 'light' ? 8 : 16}%, transparent)`} fg={theme.accent.hover} neutral />)}
            </div>
          )}
        </div>
      )}

      {/* ── Expanded ── */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${theme.border.subtle}`, position: 'relative' }}>

          {/* Collapse button — always visible when expanded */}
          <div style={{ position: 'absolute', top: 6, right: 8, zIndex: 20 }}>
            <button
              onClick={e => { e.stopPropagation(); setExpanded(false) }}
              style={{ fontSize: 10, color: theme.text.disabled, background: theme.surface.panel, border: `1px solid ${theme.border.subtle}`, borderRadius: 4, padding: '2px 7px', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.4 }}
              onMouseEnter={e => { e.currentTarget.style.color = theme.text.primary; e.currentTarget.style.borderColor = theme.border.default }}
              onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled; e.currentTarget.style.borderColor = theme.border.subtle }}
              title="Collapse"
            >
              ^
            </button>
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', background: theme.surface.panel, borderBottom: `1px solid ${theme.border.subtle}`, alignItems: 'center', gap: 4, padding: '6px 8px' }}>
            {(['overview', ...(card.launched ? ['progress'] : []), 'notes'] as Tab[]).map(t => {
              const isActive = tab === t
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    height: 28,
                    padding: '0 11px',
                    fontSize: fonts.secondarySize,
                    border: `1px solid ${isActive ? theme.border.default : 'transparent'}`,
                    borderRadius: 7,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    background: isActive ? theme.surface.selection : 'transparent',
                    color: isActive ? theme.accent.base : theme.text.muted,
                    textTransform: 'uppercase',
                    transition: 'color 0.15s, background 0.15s, border-color 0.15s',
                    fontWeight: isActive ? 700 : 500,
                    letterSpacing: 0.3,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                  onMouseEnter={e => {
                    if (!isActive) {
                      e.currentTarget.style.background = theme.surface.hover
                      e.currentTarget.style.color = theme.text.secondary
                      e.currentTarget.style.borderColor = theme.border.default
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.color = theme.text.muted
                      e.currentTarget.style.borderColor = 'transparent'
                    }
                  }}
                >
                  {t}{t === 'notes' && card.comments.length ? ` (${card.comments.length})` : ''}
                </button>
              )
            })}
            <div style={{ flex: 1 }} />
            {card.launched && (
              <span style={{ fontSize: 9, color: active ? theme.status.success : theme.text.disabled, padding: '0 8px', fontFamily: 'inherit', transition: 'color 0.3s', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                {active ? 'active' : 'idle'}
              </span>
            )}
          </div>

          {/* ── Overview tab ── */}
          {tab === 'overview' && (
            <div style={{ background: theme.surface.panel, overflowY: 'auto', maxHeight: 480 }}>

              {/* Task summary */}
              <div style={{ padding: '14px 16px', borderBottom: `1px solid ${theme.border.subtle}` }}>
                {/* Editable title */}
                <input
                  value={card.title}
                  onChange={e => onUpdate(card.id, { title: e.target.value })}
                  style={{ ...getTitleInputStyle(theme), marginBottom: 8 }}
                  placeholder="Task title"
                />
                {/* Instructions */}
                <textarea
                  value={card.instructions}
                  onChange={e => onUpdate(card.id, { instructions: e.target.value })}
                  rows={5}
                  placeholder="Instructions…"
                  style={getTextareaStyle(theme)}
                />
              </div>

              {/* Context */}
              <div style={{ padding: '12px 16px', borderBottom: `1px solid ${theme.border.subtle}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Label>Context</Label>
                <ChipInput values={card.tools} onChange={v => onUpdate(card.id, { tools: v })}
                  prefix="@" placeholder="default @all or specify"
                  suggestions={toolSuggestions}
                  suggestionMeta={Object.fromEntries(mcpServers.map(s => [s.name, s.description ?? '']))}
                  sublabel="Tools" />
                <ChipInput values={card.fileRefs} onChange={v => onUpdate(card.id, { fileRefs: v })}
                  prefix="@" placeholder="file paths — or drop from sidebar"
                  sublabel="Files"
                  onDropFile={path => onUpdate(card.id, {
                    fileRefs: [...card.fileRefs, path],
                    attachments: [...card.attachments, { id: `a-${Date.now()}`, name: path.split('/').pop() ?? path, path }]
                  })} />
                <ChipInput values={card.cardRefs} onChange={v => onUpdate(card.id, { cardRefs: v })}
                  prefix="→" placeholder="start after these cards" suggestions={cardSuggestions} sublabel="Start After" />
              </div>

              {/* Agent selector */}
              <div style={{ padding: '12px 16px', borderBottom: `1px solid ${theme.border.subtle}` }}>
                <Label>CLI Agents</Label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {availableAgents.filter(a => a.available || a.id === card.agent).map(a => (
                    <button key={a.id} onClick={() => onUpdate(card.id, { agent: a.id, model: undefined })}
                      style={{
                        padding: '3px 12px', borderRadius: 8, fontSize: fonts.secondarySize, cursor: 'pointer',
                        fontFamily: 'inherit', fontWeight: 500,
                        background: card.agent === a.id ? theme.accent.base : theme.surface.panelMuted,
                        color: card.agent === a.id ? theme.text.inverse : theme.text.muted,
                        border: `1px solid ${card.agent === a.id ? theme.border.accent : theme.border.subtle}`,
                      }}
                    >
                      {a.label}
                      {a.version && <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 5 }}>{a.version}</span>}
                    </button>
                  ))}
                </div>
                {/* Model pills */}
                {card.agent !== 'shell' && MODELS[card.agent]?.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {MODELS[card.agent].map(m => (
                      <button key={m} onClick={() => onUpdate(card.id, { model: card.model === m ? undefined : m })}
                        style={{
                          padding: '2px 10px', borderRadius: 10, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit',
                          background: card.model === m ? theme.surface.selection : 'transparent',
                          color: card.model === m ? theme.accent.base : theme.text.disabled,
                          border: `1px solid ${card.model === m ? theme.border.accent : theme.border.subtle}`
                        }}
                      >{m.split('-').slice(-2).join('-')}</button>
                    ))}
                  </div>
                )}
              </div>

              {/* Advanced section */}
              <div style={{ borderBottom: `1px solid ${theme.border.subtle}` }}>
                <button
                  onClick={() => setAdvanced(p => !p)}
                  style={{
                    width: '100%', padding: '8px 16px', background: 'none', border: 'none',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                    color: theme.text.disabled, fontSize: 10, fontFamily: 'inherit', textAlign: 'left'
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
                  onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}
                >
                  <span style={{ fontSize: 8 }}>{advanced ? 'v' : '>'}</span>
                  Advanced — MCP servers, hooks, config
                  {(card.mcpServers.length > 0 || card.hooks.length > 0) && (
                    <span style={{ marginLeft: 4, color: theme.accent.base }}>
                      {[card.mcpServers.length > 0 && `${card.mcpServers.length} MCP`, card.hooks.length > 0 && `${card.hooks.length} hooks`].filter(Boolean).join(', ')}
                    </span>
                  )}
                </button>

                {advanced && (
                  <div style={{ padding: '4px 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* MCP servers */}
                    <div>
                      <Label>MCP Servers</Label>
                      <div style={{ fontSize: 9, color: theme.status.success, marginBottom: 6, fontFamily: 'inherit' }}>
                        kanban (card_complete, card_update, card_error) always included
                      </div>
                      {card.mcpServers.map((s, i) => (
                        <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                          <input value={s.name}
                            onChange={e => { const u = [...card.mcpServers]; u[i] = { ...s, name: e.target.value }; onUpdate(card.id, { mcpServers: u }) }}
                            placeholder="name" style={{ ...getInputStyle(theme), flex: '0 0 80px' }} />
                          <input value={s.url ?? s.cmd ?? ''}
                            onChange={e => {
                              const v = e.target.value; const u = [...card.mcpServers]
                              u[i] = v.startsWith('http') ? { ...s, url: v, cmd: undefined } : { ...s, cmd: v, url: undefined }
                              onUpdate(card.id, { mcpServers: u })
                            }}
                            placeholder="http://... or npx mcp-name"
                            style={{ ...getInputStyle(theme), flex: 1, fontFamily: fonts.mono, fontSize: 10, color: theme.status.success }} />
                          <Btn onClick={() => onUpdate(card.id, { mcpServers: card.mcpServers.filter((_, j) => j !== i) })} color={theme.status.danger}>x</Btn>
                        </div>
                      ))}
                      <AddBtn onClick={() => onUpdate(card.id, { mcpServers: [...card.mcpServers, { name: '', url: '' }] })}>
                        + MCP server
                      </AddBtn>
                    </div>

                    {/* Hooks */}
                    <div>
                      <Label>Hooks (before launch)</Label>
                      <ChipInput values={card.hooks} onChange={v => onUpdate(card.id, { hooks: v })}
                        prefix="$" placeholder="source .env, nvm use 20…" />
                    </div>

                    {/* MCP config override */}
                    <div>
                      <Label>MCP Config Path</Label>
                      <input value={card.mcpConfig ?? ''}
                        onChange={e => onUpdate(card.id, { mcpConfig: e.target.value || undefined })}
                        placeholder={MCP_CONFIG}
                        style={{ ...getInputStyle(theme), fontFamily: fonts.mono, color: theme.status.success, fontSize: 10 }} />
                    </div>

                    {/* Launch command preview */}
                    {card.agent !== 'shell' && launchCmd && (
                      <div>
                        <Label>Launch command</Label>
                        <div style={{
                          fontSize: 9, color: theme.accent.base, background: theme.surface.input,
                          border: `1px solid ${theme.border.subtle}`, borderRadius: 4, padding: '6px 10px',
                          fontFamily: fonts.mono, wordBreak: 'break-all', lineHeight: 1.6
                        }}>
                          <span style={{ color: theme.text.disabled }}>$ </span>{launchCmd}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Save / start controls */}
              <div style={{ padding: '12px 16px' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={onSave}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 8, fontSize: fonts.size, fontWeight: 700,
                      background: theme.surface.panelMuted,
                      color: theme.text.secondary,
                      border: `1px solid ${theme.border.default}`, cursor: 'pointer', fontFamily: 'inherit',
                      letterSpacing: 0.3
                    }}
                  >
                    Save
                  </button>
                  <button onClick={() => card.launched ? onPause(card.id) : onLaunch(card.id)} disabled={card.agent === 'shell' || (!card.launched && !canStart)}
                    title={!card.launched && !canStart ? `Start after ${unresolvedStartAfter.map(c => c.title).join(', ')}` : undefined}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 8, fontSize: fonts.size, fontWeight: 700,
                      background: card.agent === 'shell' ? theme.surface.panelMuted : (card.launched ? theme.status.warning : (canStart ? theme.accent.base : theme.surface.panelMuted)),
                      color: card.agent === 'shell' ? theme.text.disabled : (card.launched ? theme.text.inverse : (canStart ? theme.text.inverse : theme.text.disabled)),
                      border: 'none', cursor: card.agent === 'shell' || (!card.launched && !canStart) ? 'default' : 'pointer', fontFamily: 'inherit',
                      letterSpacing: 0.3
                    }}
                  >
                    {card.agent === 'shell' ? 'Select CLI Agent' : (card.launched ? 'Pause' : (!canStart ? 'Start After' : 'Start'))}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Progress tab ── */}
          {tab === 'progress' && card.launched && (
            <div style={{ background: theme.surface.panel, display: 'flex', flexDirection: 'column', height: 260 }}>
              <div style={{ padding: '10px 12px', borderBottom: `1px solid ${theme.border.subtle}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: active ? theme.status.success : theme.text.disabled, boxShadow: active ? `0 0 8px ${theme.status.success}` : 'none' }} />
                  <span style={{ fontSize: fonts.secondarySize, fontWeight: 700, color: theme.text.primary, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    {active ? 'In Progress' : 'Running'}
                  </span>
                </div>
                {card.briefPath && (
                  <span style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}>
                    {card.briefPath.split('/').slice(-2).join('/')}
                  </span>
                )}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {card.comments.length === 0 && (
                  <div style={{ alignSelf: 'flex-start', maxWidth: '90%', background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`, borderRadius: 12, padding: '10px 12px', fontSize: fonts.secondarySize, lineHeight: 1.5, color: theme.text.muted }}>
                    Waiting for progress updates…
                  </div>
                )}
                {card.comments.map(c => (
                  <div key={c.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                    <div style={{ maxWidth: '92%', background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`, borderRadius: 14, padding: '10px 12px', boxShadow: theme.shadow.panel }}>
                      <div style={{ fontSize: fonts.secondarySize, color: theme.text.primary, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{c.text}</div>
                    </div>
                    <div style={{ fontSize: 10, color: theme.text.disabled, paddingLeft: 4 }}>
                      {new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Notes tab ── */}
          {tab === 'notes' && (
            <div style={{ background: theme.surface.panel, display: 'flex', flexDirection: 'column', height: 220 }}>
              <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                {card.comments.length === 0 && (
                  <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, textAlign: 'center', paddingTop: 16 }}>No notes</div>
                )}
                {card.comments.map(c => (
                  <div key={c.id} style={{ background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`, borderRadius: 5, padding: '6px 10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                      <span style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, flex: 1, lineHeight: 1.5 }}>{c.text}</span>
                      <Btn onClick={() => onUpdate(card.id, { comments: card.comments.filter(n => n.id !== c.id) })} color={theme.status.danger}>x</Btn>
                    </div>
                    <span style={{ fontSize: 9, color: theme.text.disabled }}>{new Date(c.ts).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: '8px 10px', borderTop: `1px solid ${theme.border.subtle}`, display: 'flex', gap: 6 }}>
                <input value={newNote} onChange={e => setNewNote(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addNote() }}
                  placeholder="Add a note…" style={{ ...getInputStyle(theme), flex: 1 }} />
                <button onClick={addNote} style={{ padding: '4px 12px', borderRadius: 5, background: theme.accent.base, color: theme.text.inverse, border: 'none', fontSize: fonts.secondarySize, cursor: 'pointer', fontFamily: 'inherit' }}>+</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const KanbanCard = React.memo(KanbanCardInner)

// ─── Chip input ───────────────────────────────────────────────────────────────

interface ChipInputProps {
  values: string[]
  onChange: (v: string[]) => void
  prefix: string
  placeholder?: string
  sublabel?: string
  suggestions?: string[]
  suggestionMeta?: Record<string, string>   // name → description
  onDropFile?: (path: string) => void
}

function ChipInput({ values, onChange, prefix, placeholder, sublabel, suggestions = [], suggestionMeta = {}, onDropFile }: ChipInputProps): JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const [input, setInput] = useState('')
  const [showSugg, setShowSugg] = useState(false)
  const filtered = suggestions.filter(s => s.toLowerCase().includes(input.toLowerCase()) && !values.includes(s))

  const add = (val: string) => {
    const v = val.trim().replace(/^[@/$]/, '')
    if (!v || values.includes(v)) return
    onChange([...values, v])
    setInput(''); setShowSugg(false)
  }

  // Chip prefix categorical palette: @ (mention) → accent, / (command) →
  // success, default ($, others) → warning. Sourced from theme so the
  // distinct hue per category survives palette/contrast changes.
  const chipBaseColor = prefix === '@'
    ? theme.accent.base
    : prefix === '/'
      ? theme.status.success
      : theme.status.warning
  const prefixColor = chipBaseColor
  const chipBg = `color-mix(in srgb, ${chipBaseColor} ${theme.mode === 'light' ? 12 : 22}%, transparent)`

  return (
    <div>
      {sublabel && <div style={{ fontSize: 9, color: theme.text.disabled, fontFamily: 'inherit', marginBottom: 4, letterSpacing: 0.5 }}>{sublabel}</div>}
      <div
        style={{ background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`, borderRadius: 6, padding: '5px 8px', position: 'relative', cursor: 'text' }}
        onDragOver={onDropFile ? e => e.preventDefault() : undefined}
        onDrop={onDropFile ? e => { e.preventDefault(); const p = e.dataTransfer.getData('text/plain'); if (p) onDropFile(p) } : undefined}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          {values.map((v, i) => {
            const display = prefix === '@' && (v.includes('/') || v.includes('\\')) ? (v.split(/[\\/]/).pop() ?? v) : v
            return (
            <span key={i} title={display !== v ? v : undefined} style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              background: chipBg, borderRadius: 4, padding: '2px 7px',
              fontSize: 10, color: prefixColor, fontFamily: fonts.mono,
              border: `1px solid ${prefixColor}22`
            }}>
              <span style={{ opacity: 0.4 }}>{prefix}</span>{display}
              <button onClick={() => onChange(values.filter((_, j) => j !== i))}
                style={{ fontSize: 9, color: 'inherit', opacity: 0.3, background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '0.3')}>x</button>
            </span>
          )})}
          <input value={input}
            onChange={e => { setInput(e.target.value); setShowSugg(true) }}
            onFocus={() => setShowSugg(true)}
            onBlur={() => setTimeout(() => setShowSugg(false), 150)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input) }
              if (e.key === 'Backspace' && !input && values.length) onChange(values.slice(0, -1))
              if (e.key === 'Escape') setShowSugg(false)
            }}
            placeholder={values.length === 0 ? `${prefix} ${placeholder}` : ''}
            style={{ background: 'none', border: 'none', outline: 'none', color: theme.text.secondary, fontSize: fonts.secondarySize, fontFamily: fonts.mono, minWidth: 60, flex: 1, padding: '1px 0' }}
          />
        </div>
        {showSugg && filtered.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: theme.surface.panelElevated, border: `1px solid ${theme.border.default}`, borderRadius: 6, boxShadow: theme.shadow.panel, marginTop: 2, overflow: 'hidden' }}>
            {filtered.slice(0, 8).map(s => (
              <div key={s}
                style={{ padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 8 }}
                onMouseEnter={e => (e.currentTarget.style.background = theme.surface.hover)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onMouseDown={() => add(s)}
              >
                <span style={{ fontSize: 10, color: theme.text.secondary, fontFamily: fonts.mono, flexShrink: 0 }}>
                  <span style={{ color: prefixColor, opacity: 0.5 }}>{prefix}</span>{s}
                </span>
                {suggestionMeta[s] && (
                  <span style={{ fontSize: 9, color: theme.text.disabled, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {suggestionMeta[s]}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTitleInputStyle(theme: ReturnType<typeof useTheme>): React.CSSProperties {
  return {
    width: '100%', fontSize: 15, fontWeight: 700, padding: '4px 0', background: 'none',
    color: theme.text.primary, border: 'none', borderBottom: `1px solid ${theme.border.subtle}`,
    outline: 'none', fontFamily: 'inherit'
  }
}

function getTextareaStyle(theme: ReturnType<typeof useTheme>): React.CSSProperties {
  return {
    width: '100%', fontSize: 'inherit', padding: '6px 8px', borderRadius: 5, resize: 'vertical',
    background: theme.surface.panelMuted, color: theme.text.secondary, border: `1px solid ${theme.border.subtle}`,
    outline: 'none', fontFamily: 'inherit', lineHeight: 'inherit'
  }
}

function getInputStyle(theme: ReturnType<typeof useTheme>): React.CSSProperties {
  return {
    width: '100%', fontSize: 'inherit', padding: '5px 8px', borderRadius: 5,
    background: theme.surface.panelMuted, color: theme.text.secondary, border: `1px solid ${theme.border.subtle}`,
    outline: 'none', fontFamily: 'inherit'
  }
}

function Label({ children }: { children: React.ReactNode }): JSX.Element {
  const theme = useTheme()
  return <div style={{ fontSize: 10, color: theme.text.disabled, fontFamily: 'inherit', letterSpacing: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>{children}</div>
}

function Chip({ label, prefix, bg, fg, title, neutral = false }: { label: string; prefix: string; bg: string; fg: string; title?: string; neutral?: boolean }): JSX.Element {
  const theme = useTheme()
  // Neutral chip = high-contrast inverted pair: dark plate in light theme,
  // light plate in dark theme. Anchored on text.primary and text.inverse so
  // both shift with the contrast slider.
  const neutralBg = theme.text.primary
  const neutralFg = theme.text.inverse
  const neutralBorder = theme.mode === 'light' ? '#ffffff22' : '#00000022'
  return (
    <span title={title} style={{
      fontSize: neutral ? 12 : 11,
      background: neutral ? neutralBg : bg,
      color: neutral ? neutralFg : fg,
      borderRadius: 5,
      padding: neutral ? '3px 9px' : '2px 8px',
      fontFamily: 'inherit',
      border: `1px solid ${neutral ? neutralBorder : `${fg}22`}`,
      lineHeight: 1.35,
      textTransform: neutral ? 'uppercase' : 'none',
      fontWeight: neutral ? 700 : 500,
      letterSpacing: neutral ? 0.3 : 0,
    }}>
      {prefix ? <span style={{ opacity: neutral ? 1 : 0.4, color: neutral ? neutralFg : 'inherit' }}>{prefix}</span> : null}{label}
    </span>
  )
}

function AddBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }): JSX.Element {
  const theme = useTheme()
  const [h, setH] = useState(false)
  return (
    <button onClick={onClick}
      style={{ width: '100%', fontSize: 10, color: h ? theme.accent.base : theme.text.disabled, background: 'none', border: `1px dashed ${h ? `${theme.accent.base}44` : theme.border.subtle}`, borderRadius: 5, padding: '4px 0', cursor: 'pointer', fontFamily: 'inherit', marginTop: 3, transition: 'color 0.1s' }}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}>
      {children}
    </button>
  )
}

function Btn({ onClick, color, children, title }: { onClick: () => void; color: string; children: React.ReactNode; title?: string }): JSX.Element {
  const [h, setH] = useState(false)
  return (
    <button onClick={e => { e.stopPropagation(); onClick() }} title={title}
      style={{ fontSize: 'inherit', fontWeight: 800, color, opacity: h ? 0.72 : 1, background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px', lineHeight: 1, transition: 'opacity 0.1s', fontFamily: 'inherit' }}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}>
      {children}
    </button>
  )
}
