export type ToolCategory =
  | 'activity'
  | 'agent'
  | 'browser'
  | 'command'
  | 'context'
  | 'edit'
  | 'plan'
  | 'read'
  | 'search'
  | 'web'
  | 'other'

export interface NormalizedToolName {
  rawName: string
  provider?: string
  namespace?: string
  canonicalName: string
  displayName: string
  groupKey: string
  category: ToolCategory
}

const PROVIDER_PREFIXES = new Set([
  'claude',
  'codex',
  'codesurf',
  'csagent',
  'hermes',
  'omnigent',
  'opencode',
  'openclaw',
  'pi',
])

function titleCaseTool(raw: string): string {
  const words = raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_:/.-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return 'Tool'
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function normalizeToken(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function stripProviderPrefix(name: string): { provider?: string; name: string } {
  const match = /^([a-z][a-z0-9_-]{1,24})\s*:\s*(.+)$/i.exec(name)
  if (!match) return { name }
  const provider = normalizeToken(match[1])
  if (!PROVIDER_PREFIXES.has(provider)) return { name }
  return { provider, name: match[2].trim() || name }
}

function stripMcpPrefix(name: string): { namespace?: string; name: string } {
  if (!name.startsWith('mcp__')) return { name }
  const parts = name.split('__')
  if (parts.length < 3) return { name }
  const namespace = parts[1]
  const tool = parts.slice(2).join('__').trim()
  return { namespace, name: tool || name }
}

function matchEditedFiles(raw: string): NormalizedToolName | null {
  if (!/^edited\s+\d+\s+files?$/i.test(raw.trim())) return null
  return {
    rawName: raw,
    canonicalName: 'edit_file',
    displayName: 'Edit file',
    groupKey: 'edit_file',
    category: 'edit',
  }
}

export function normalizeToolName(name: string | null | undefined, fallbackProvider?: string): NormalizedToolName {
  const rawName = String(name ?? '').trim() || 'tool'
  const edited = matchEditedFiles(rawName)
  if (edited) return { ...edited, provider: fallbackProvider }

  const providerStripped = stripProviderPrefix(rawName)
  const mcpStripped = stripMcpPrefix(providerStripped.name)
  const provider = providerStripped.provider ?? fallbackProvider
  const namespace = mcpStripped.namespace
  const baseName = mcpStripped.name.trim() || rawName
  const token = normalizeToken(baseName)

  const mapped = (() => {
    if (
      token === 'workspace_instructions'
      || token === 'context_instructions'
      || token === 'instructions'
    ) return ['load_instructions', 'Load instructions', 'context'] as const

    if (token === 'included_skills' || token === 'skills') {
      return ['load_skills', 'Load skills', 'context'] as const
    }

    if (
      token === 'workspace_file_references'
      || token === 'file_references'
      || token === 'resolve_file_references'
    ) return ['resolve_file_refs', 'Resolve file refs', 'context'] as const

    if (
      token === 'todowrite'
      || token === 'todo_write'
      || token === 'update_plan'
      || token === 'plan_update'
      || token === 'task_update'
      || token === 'todos'
    ) return ['update_plan', 'Update plan', 'plan'] as const

    if (token === 'exitplanmode' || token === 'exit_plan_mode') {
      return ['review_plan', 'Review plan', 'plan'] as const
    }

    if (
      token === 'read'
      || token === 'read_file'
      || token === 'file_read'
      || token === 'open_file'
      || token === 'view_file'
      || token === 'notebook_read'
    ) return ['read_file', 'Read file', 'read'] as const

    if (
      token === 'grep'
      || token === 'rg'
      || token === 'ripgrep'
      || token === 'search'
      || token === 'search_files'
      || token === 'search_file'
      || token === 'find_in_files'
    ) return ['search_files', 'Search files', 'search'] as const

    if (token === 'glob' || token === 'ls' || token === 'list' || token === 'list_files') {
      return ['list_files', 'List files', 'search'] as const
    }

    if (
      token === 'edit'
      || token === 'multi_edit'
      || token === 'multiedit'
      || token === 'write'
      || token === 'write_file'
      || token === 'apply_patch'
      || token === 'patch'
      || token === 'notebook_edit'
      || token === 'create_file'
      || token === 'update_file'
      || token === 'delete_file'
      || token === 'move_file'
    ) return ['edit_file', 'Edit file', 'edit'] as const

    if (
      token === 'bash'
      || token === 'shell'
      || token === 'exec'
      || token === 'exec_command'
      || token === 'run_command'
      || token === 'command'
      || token === 'local_shell_call'
    ) return ['run_command', 'Run command', 'command'] as const

    if (token === 'webfetch' || token === 'web_fetch' || token === 'fetch' || token === 'fetch_url') {
      return ['fetch_url', 'Fetch URL', 'web'] as const
    }

    if (token === 'websearch' || token === 'web_search' || token === 'search_web') {
      return ['search_web', 'Search web', 'web'] as const
    }

    if (token === 'browser' || token.startsWith('browser_') || token === 'computer_call') {
      return ['use_browser', 'Use browser', 'browser'] as const
    }

    if (token === 'askuserquestion' || token === 'ask_user_question') {
      return ['ask_user', 'Ask user', 'agent'] as const
    }

    if (token === 'checkpoint_saved' || token === 'save_checkpoint') {
      return ['save_checkpoint', 'Save checkpoint', 'activity'] as const
    }

    if (token === 'workspace_updated') {
      return ['workspace_updated', 'Workspace updated', 'activity'] as const
    }

    if (token === 'exploring_workspace' || token === 'explore_workspace') {
      return ['explore_workspace', 'Explore workspace', 'activity'] as const
    }

    if (token === 'compacting_context' || token === 'context_compaction' || token === 'compaction') {
      return ['compact_context', 'Compact context', 'activity'] as const
    }

    if (token === 'background_job' || token === 'detached_job') {
      return ['background_job', 'Background job', 'activity'] as const
    }

    const canonical = token || 'tool'
    return [canonical, titleCaseTool(baseName), 'other'] as const
  })()

  const [canonicalName, displayName, category] = mapped
  return {
    rawName,
    ...(provider ? { provider } : {}),
    ...(namespace ? { namespace } : {}),
    canonicalName,
    displayName,
    groupKey: category === 'other' && namespace
      ? `${namespace}:${canonicalName}`
      : canonicalName,
    category,
  }
}

export function toolMetadataForName(name: string | null | undefined, fallbackProvider?: string): Pick<
  NormalizedToolName,
  'rawName' | 'canonicalName' | 'displayName' | 'groupKey' | 'category' | 'provider' | 'namespace'
> {
  return normalizeToolName(name, fallbackProvider)
}
