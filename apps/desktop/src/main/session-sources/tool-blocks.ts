import type { ImportedToolBlock, ImportedToolFileChange, ImportedToolCommandEntry } from './shared.ts'
import { parseJsonObject } from './shared.ts'
import { sanitizeToolOutputText } from '../chat/output-sanitizers.ts'

export function truncateToolPreview(text: string | null | undefined, length = 800): string {
  if (!text) return ''
  return text.length > length ? `${text.slice(0, length)}\n…` : text
}

export function extractReasoningSummary(payload: any): string {
  if (!Array.isArray(payload?.summary)) return ''
  return payload.summary
    .map((entry: { text?: string }) => typeof entry?.text === 'string' ? entry.text.trim() : '')
    .filter(Boolean)
    .join('\n\n')
}

export function extractCommandFromToolCall(name: string, rawInput: string): string {
  const parsed = parseJsonObject(rawInput)
  if (name === 'exec_command') return typeof parsed?.cmd === 'string' ? parsed.cmd : rawInput
  if (name === 'shell_command') return typeof parsed?.command === 'string' ? parsed.command : rawInput
  if (name === 'shell') {
    if (Array.isArray(parsed?.command)) return parsed.command.map((part: unknown) => String(part)).join(' ')
    if (typeof parsed?.command === 'string') return parsed.command
  }
  return rawInput
}

export function extractApplyPatchText(rawInput: string): string | null {
  const beginIndex = rawInput.indexOf('*** Begin Patch')
  const endIndex = rawInput.lastIndexOf('*** End Patch')
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) return null
  return rawInput.slice(beginIndex, endIndex + '*** End Patch'.length)
}

export function parseApplyPatchFileChanges(patchText: string): ImportedToolFileChange[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  const changes: ImportedToolFileChange[] = []
  let current: (ImportedToolFileChange & { lines: string[] }) | null = null

  const flush = () => {
    if (!current) return
    current.diff = current.lines.join('\n').trim()
    current.additions = current.lines.filter(line => line.startsWith('+')).length
    current.deletions = current.lines.filter(line => line.startsWith('-')).length
    changes.push({
      path: current.path,
      previousPath: current.previousPath,
      changeType: current.changeType,
      additions: current.additions,
      deletions: current.deletions,
      diff: current.diff,
    })
    current = null
  }

  for (const line of lines) {
    if (line.startsWith('*** Add File: ')) {
      flush()
      current = {
        path: line.slice('*** Add File: '.length).trim(),
        changeType: 'add',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      flush()
      current = {
        path: line.slice('*** Update File: '.length).trim(),
        changeType: 'update',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      flush()
      current = {
        path: line.slice('*** Delete File: '.length).trim(),
        changeType: 'delete',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Move to: ')) {
      if (current) {
        current.previousPath = current.path
        current.path = line.slice('*** Move to: '.length).trim()
        current.changeType = 'move'
        current.lines.push(line)
      }
      continue
    }
    if (line === '*** End Patch') {
      if (current) current.lines.push(line)
      flush()
      continue
    }
    if (current) current.lines.push(line)
  }

  flush()
  return changes
}

export type ImportedCommandKind = 'search' | 'read' | 'command'

export function classifyCommand(command: string): ImportedCommandKind {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat)\b/.test(normalized)) return 'read'
  if (/(^|\s)ls\b/.test(normalized)) return 'read'
  return 'command'
}

export interface PendingImportedToolCall {
  id: string
  name: string
  input: string
  output?: string
  status: 'done' | 'error'
  fileChanges?: ImportedToolFileChange[]
  commandEntry?: ImportedToolCommandEntry
}

export function isImportedPlanToolName(name: string | null | undefined): boolean {
  return name === 'TodoWrite' || name === 'update_plan'
}

export function buildImportedToolBlocks(calls: PendingImportedToolCall[]): ImportedToolBlock[] {
  const blocks: ImportedToolBlock[] = []
  const handledIds = new Set<string>()

  const fileChangeMap = new Map<string, ImportedToolFileChange>()
  for (const change of calls.flatMap(call => call.fileChanges ?? [])) {
    const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
    const existing = fileChangeMap.get(key)
    if (!existing) {
      fileChangeMap.set(key, { ...change })
      continue
    }
    existing.additions += change.additions
    existing.deletions += change.deletions
    existing.diff = `${existing.diff}\n\n${change.diff}`.trim()
  }
  const fileChanges = Array.from(fileChangeMap.values())
  if (fileChanges.length > 0) {
    blocks.push({
      id: 'tool-edits',
      name: `Edited ${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'}`,
      input: calls.filter(call => (call.fileChanges?.length ?? 0) > 0).map(call => call.input).join('\n\n'),
      status: 'done',
      fileChanges,
    })
    for (const call of calls) {
      if ((call.fileChanges?.length ?? 0) > 0) handledIds.add(call.id)
    }
  }

  const exploreEntries = calls
    .filter(call => call.commandEntry && (call.commandEntry.kind === 'search' || call.commandEntry.kind === 'read'))
    .map(call => call.commandEntry!)

  if (exploreEntries.length > 0) {
    const readCount = exploreEntries.filter(entry => entry.kind === 'read').length
    const searchCount = exploreEntries.filter(entry => entry.kind === 'search').length
    const labelParts: string[] = []
    if (readCount > 0) labelParts.push(`${readCount} file${readCount === 1 ? '' : 's'}`)
    if (searchCount > 0) labelParts.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`)

    blocks.push({
      id: 'tool-explore',
      name: `Explored ${labelParts.join(', ')}`,
      input: exploreEntries.map(entry => entry.command ?? entry.label).join('\n'),
      status: 'done',
      commandEntries: exploreEntries,
    })
    for (const call of calls) {
      if (call.commandEntry && (call.commandEntry.kind === 'search' || call.commandEntry.kind === 'read')) handledIds.add(call.id)
    }
  }

  for (const call of calls) {
    if (handledIds.has(call.id)) continue
    blocks.push({
      id: call.id,
      name: call.name,
      input: call.input,
      summary: truncateToolPreview(sanitizeToolOutputText(call.output), 240) || undefined,
      status: call.status,
      commandEntries: call.commandEntry ? [call.commandEntry] : undefined,
    })
  }

  return blocks
}
