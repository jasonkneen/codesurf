import { useState, useEffect, useMemo, useCallback, type ChangeEvent } from 'react'
import type { SkillDefinition } from '../../../shared/types'
import type { ChatComposerAutocompleteItem } from '../components/chat/ChatComposer'

// ─── Slash commands ───────────────────────────────────────────────────────

export const CHAT_SLASH_COMMANDS = [
  { value: '/compact', description: 'Compact conversation' },
  { value: '/clear', description: 'Clear conversation' },
  { value: '/model', description: 'Switch model' },
  { value: '/mode', description: 'Switch mode (plan, build, etc.)' },
  { value: '/help', description: 'Show help' },
  { value: '/init', description: 'Initialize workspace' },
  { value: '/export-notes', description: 'Copy all attached block notes to the clipboard' },
] as const

// ─── Types ────────────────────────────────────────────────────────────────

export type AutocompleteItem = ChatComposerAutocompleteItem

interface DiscoveryPeer {
  peerId: string
  peerType: string
  capabilities: string[]
  distance: number
  lastSeen: number
  actions?: Array<{ name: string; description: string }>
  filePath?: string
  label?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function getRelativeMentionPath(filePath: string, workspaceDir: string): string {
  const normalizedFilePath = filePath.replace(/\\/g, '/')
  const normalizedWorkspaceDir = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedWorkspaceDir) return basename(normalizedFilePath)
  if (normalizedFilePath === normalizedWorkspaceDir) return basename(normalizedFilePath)
  if (normalizedFilePath.startsWith(`${normalizedWorkspaceDir}/`)) {
    return normalizedFilePath.slice(normalizedWorkspaceDir.length + 1)
  }
  return basename(normalizedFilePath)
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

export function detectAutocompleteTrigger(
  textBeforeCursor: string,
): { type: 'slash' | 'mention', query: string } | null {
  const slashMatch = textBeforeCursor.match(/(^|\s)\/(\w*)$/)
  if (slashMatch) {
    return { type: 'slash', query: slashMatch[2] }
  }

  const mentionMatch = textBeforeCursor.match(/@([\w./]*)$/)
  if (mentionMatch) {
    return { type: 'mention', query: mentionMatch[1] }
  }

  return null
}

// ─── Hook ─────────────────────────────────────────────────────────────────

/** A plugin-contributed command exposed as a chat slash command (point 3). */
export interface PluginSlashCommand {
  slash: string
  title: string
  description?: string
}

export interface UseChatAutocompleteOptions {
  workspaceDir: string
  connectedPeers: DiscoveryPeer[]
  workspaceSkills: SkillDefinition[]
  /** Slash commands contributed by enabled plugins (merged into the slash menu). */
  pluginSlashCommands?: PluginSlashCommand[]
}

export interface UseChatAutocompleteResult {
  acType: 'slash' | 'mention' | null
  setAcType: (type: 'slash' | 'mention' | null) => void
  acQuery: string
  setAcQuery: (query: string) => void
  acIndex: number
  setAcIndex: React.Dispatch<React.SetStateAction<number>>
  acItems: AutocompleteItem[]
  handleComposerInputChange: (
    event: ChangeEvent<HTMLTextAreaElement>,
    onValueChange: (value: string) => void,
    syncComposerHeight: () => void,
  ) => void
}

export function useChatAutocomplete({
  workspaceDir,
  connectedPeers,
  workspaceSkills,
  pluginSlashCommands = [],
}: UseChatAutocompleteOptions): UseChatAutocompleteResult {
  const [acType, setAcType] = useState<'slash' | 'mention' | null>(null)
  const [acQuery, setAcQuery] = useState('')
  const [acIndex, setAcIndex] = useState(0)

  // Workspace file index for `@` mentions. Built once per workspace via a
  // bounded recursive readDir; skips dot-folders and the usual heavy build
  // artifact dirs so a typical repo stays under a few thousand entries.
  const [workspaceFiles, setWorkspaceFiles] = useState<Array<{ path: string; relPath: string; name: string; depth: number }>>([])
  useEffect(() => {
    let cancelled = false
    const root = workspaceDir?.trim() || ''
    if (!root) {
      setWorkspaceFiles([])
      return () => { cancelled = true }
    }

    const SKIP_DIRS = new Set([
      'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
      '.git', '.next', '.turbo', '.cache', '.parcel-cache', '.vercel',
      '.nuxt', '.svelte-kit', '.angular', '.expo', '.terraform',
      'build-electrobun', 'dist-electron', '__pycache__', '.venv', 'venv',
    ])
    const MAX_FILES = 5000
    const MAX_DEPTH = 4

    ;(async () => {
      const collected: Array<{ path: string; relPath: string; name: string; depth: number }> = []
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (cancelled || collected.length >= MAX_FILES || depth > MAX_DEPTH) return
        const entries: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await (window as any).electron.fs.readDir(dir).catch(() => [])
        for (const entry of entries) {
          if (cancelled || collected.length >= MAX_FILES) return
          if (entry.name.startsWith('.') && depth === 0) continue
          if (entry.isDir) {
            if (SKIP_DIRS.has(entry.name)) continue
            if (entry.name.startsWith('.') && entry.name !== '.claude') continue
            await walk(entry.path, depth + 1)
            continue
          }
          const relPath = getRelativeMentionPath(entry.path, root)
          collected.push({ path: entry.path, relPath, name: entry.name, depth })
        }
      }
      await walk(root, 0)
      if (!cancelled) setWorkspaceFiles(collected)
    })().catch(() => { if (!cancelled) setWorkspaceFiles([]) })

    return () => { cancelled = true }
  }, [workspaceDir])

  const mentionItems = useMemo<AutocompleteItem[]>(() => {
    const query = acQuery.trim().toLowerCase()
    const seenPaths = new Set<string>()
    const connectedFileItems: AutocompleteItem[] = []

    for (const peer of connectedPeers) {
      if (!peer.filePath || seenPaths.has(peer.filePath)) continue
      seenPaths.add(peer.filePath)

      const mentionPath = getRelativeMentionPath(peer.filePath, workspaceDir)
      const searchText = [
        mentionPath,
        peer.filePath,
        peer.label ?? '',
        peer.peerType,
      ].join('\n').toLowerCase()

      if (query && !searchText.includes(query)) continue

      connectedFileItems.push({
        key: `connected-file:${peer.peerId}:${peer.filePath}`,
        value: `@${mentionPath}`,
        description: `Connected ${peer.peerType} · ${mentionPath}`,
        attachPath: peer.filePath,
        priority: peer.distance,
      })
    }

    connectedFileItems.sort((a, b) => {
      const priorityDelta = (a.priority ?? 0) - (b.priority ?? 0)
      if (priorityDelta !== 0) return priorityDelta
      return a.value.localeCompare(b.value)
    })

    const existingValues = new Set(connectedFileItems.map(item => item.value.toLowerCase()))

    // Real workspace file results. Rank by: basename-prefix > basename-contains
    // > path-contains, then by directory depth (shallower first), then
    // alphabetical. Cap the dropdown so we never paint thousands of rows.
    const FILE_RESULT_LIMIT = 40
    const fileItems: Array<AutocompleteItem & { rank: number }> = []
    if (workspaceFiles.length > 0) {
      for (const file of workspaceFiles) {
        const value = `@${file.relPath}`
        if (existingValues.has(value.toLowerCase())) continue
        const nameLower = file.name.toLowerCase()
        const relLower = file.relPath.toLowerCase()
        let rank = -1
        if (!query) rank = 2
        else if (nameLower.startsWith(query)) rank = 0
        else if (nameLower.includes(query)) rank = 1
        else if (relLower.includes(query)) rank = 2
        if (rank < 0) continue
        fileItems.push({
          key: `workspace-file:${file.path}`,
          value,
          description: file.relPath,
          attachPath: file.path,
          priority: rank * 100 + file.depth,
          rank,
        })
      }
      fileItems.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank
        if ((a.priority ?? 0) !== (b.priority ?? 0)) return (a.priority ?? 0) - (b.priority ?? 0)
        return a.value.localeCompare(b.value)
      })
    }

    return [...connectedFileItems, ...fileItems.slice(0, FILE_RESULT_LIMIT).map(({ rank: _rank, ...rest }) => rest)]
  }, [acQuery, connectedPeers, workspaceDir, workspaceFiles])

  const slashItems = useMemo<AutocompleteItem[]>(() => {
    const q = acQuery.toLowerCase()
    const seen = new Set<string>()
    const items: AutocompleteItem[] = []

    for (const command of CHAT_SLASH_COMMANDS) {
      if (!command.value.toLowerCase().startsWith('/' + q)) continue
      if (seen.has(command.value)) continue
      seen.add(command.value)
      items.push({ key: `slash:${command.value}`, value: command.value, description: command.description })
    }

    // Discovered skills/commands. Skill `command` is the slash trigger
    // (e.g. `cleanup` → `/cleanup`); fall back to `name` when absent.
    for (const skill of workspaceSkills) {
      const trigger = (skill.command || skill.name || '').trim()
      if (!trigger) continue
      const value = '/' + trigger.replace(/^\/+/, '')
      if (seen.has(value)) continue
      if (!value.toLowerCase().startsWith('/' + q)) continue
      seen.add(value)
      items.push({
        key: `skill:${skill.id || value}`,
        value,
        description: skill.description?.trim() || `Skill · ${skill.name}`,
      })
    }

    // Plugin-contributed slash commands (point 3 — plugins appear in the chat area).
    for (const cmd of pluginSlashCommands) {
      const trigger = (cmd.slash || '').trim()
      if (!trigger) continue
      const value = '/' + trigger.replace(/^\/+/, '')
      if (seen.has(value)) continue
      if (!value.toLowerCase().startsWith('/' + q)) continue
      seen.add(value)
      items.push({
        key: `plugin:${value}`,
        value,
        description: cmd.description?.trim() || cmd.title,
      })
    }

    return items
  }, [acQuery, workspaceSkills, pluginSlashCommands])

  const acItems: AutocompleteItem[] = acType === 'slash'
    ? slashItems
    : acType === 'mention'
      ? mentionItems
      : []

  // Keep index in bounds when items change.
  useEffect(() => {
    setAcIndex(i => Math.min(i, Math.max(0, acItems.length - 1)))
  }, [acItems.length])

  const handleComposerInputChange = useCallback((
    event: ChangeEvent<HTMLTextAreaElement>,
    onValueChange: (value: string) => void,
    syncComposerHeight: () => void,
  ) => {
    const value = event.target.value
    onValueChange(value)
    syncComposerHeight()

    const cursor = event.target.selectionStart ?? value.length
    const trigger = detectAutocompleteTrigger(value.slice(0, cursor))
    if (trigger) {
      setAcType(trigger.type)
      setAcQuery(trigger.query)
      setAcIndex(0)
      return
    }

    setAcType(null)
    setAcQuery('')
  }, [])

  return {
    acType,
    setAcType,
    acQuery,
    setAcQuery,
    acIndex,
    setAcIndex,
    acItems,
    handleComposerInputChange,
  }
}
