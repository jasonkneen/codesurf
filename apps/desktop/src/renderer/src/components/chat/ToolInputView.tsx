import { normalizeToolName } from '../../../../shared/tool-normalization.ts'
import type { TileTodoItem } from '../../state/tileTodosStore'
import { useTheme } from '../../ThemeContext'
import { PlanCard } from './PlanCard'
import { useFonts } from './chatTileContexts'

function formatToolInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

// Strip the "[CodeSurf memory guard] Older … truncated …" preamble that gets
// prepended to stale tool inputs, returning { notice, rest } so the UI can
// render a small badge instead of dumping the message inline.
function splitMemoryGuard(raw: string): { notice: string | null; body: string } {
  const trimmed = raw.trimStart()
  const m = /^\[CodeSurf memory guard\][^\n]*\n\n?/i.exec(trimmed)
  if (!m) return { notice: null, body: raw }
  return { notice: m[0].trim(), body: trimmed.slice(m[0].length) }
}

function tryParseToolInput(input: string): unknown {
  try { return JSON.parse(input) } catch { return null }
}

function getStr(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

function getNum(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : null
}

function getBool(obj: unknown, key: string): boolean | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'boolean' ? v : null
}

function isPlanToolName(toolName: string): boolean {
  return normalizeToolName(toolName).category === 'plan'
}

function getArray(obj: unknown, keys: string[]): unknown[] {
  if (!obj || typeof obj !== 'object') return []
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function normalizeTodoStatus(status: string | null): TileTodoItem['status'] {
  const value = String(status ?? 'pending').toLowerCase()
  if (value === 'in_progress' || value === 'in-progress' || value === 'active' || value === 'doing') return 'in_progress'
  if (value === 'completed' || value === 'complete' || value === 'done') return 'completed'
  return value || 'pending'
}

function extractPlanTodosFromParsedInput(toolName: string, parsed: unknown): TileTodoItem[] {
  if (!parsed || typeof parsed !== 'object') return []

  const normalizedName = normalizeToolName(toolName).canonicalName

  if (normalizedName === 'update_plan' || normalizedName === 'review_plan') {
    const todosRaw = getArray(parsed, ['todos', 'todo', 'plan', 'steps', 'items', 'tasks'])
    const normalized: TileTodoItem[] = []
    for (const t of todosRaw) {
      const content = getStr(t, 'content') ?? getStr(t, 'step') ?? getStr(t, 'title') ?? getStr(t, 'text') ?? ''
      if (!content) continue
      const status = normalizeTodoStatus(getStr(t, 'status') ?? getStr(t, 'state'))
      const activeForm = getStr(t, 'activeForm') ?? getStr(t, 'active_form') ?? undefined
      normalized.push({ content, status, activeForm })
    }
    return normalized
  }

  return []
}

function isExplicitPlanClear(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false
  const action = getStr(parsed, 'action') ?? getStr(parsed, 'operation') ?? getStr(parsed, 'type')
  return action === 'clear' || action === 'reset'
}

export function parsePlanToolTodos(toolName: string, input: string): { todos: TileTodoItem[]; explicitClear: boolean } | null {
  if (!isPlanToolName(toolName)) return null
  const parsed = tryParseToolInput(input)
  if (!parsed || typeof parsed !== 'object') return null
  return {
    todos: extractPlanTodosFromParsedInput(toolName, parsed),
    explicitClear: isExplicitPlanClear(parsed),
  }
}

export function ToolInputView({ toolName, input, codePanelFontSize }: {
  toolName: string
  input: string
  codePanelFontSize: number
}): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const { notice, body } = splitMemoryGuard(input)
  const parsed = tryParseToolInput(body)

  // Tool-input payloads are often dense — force a tighter font than the
  // general code-panel size so long Edit/Write payloads don't dominate the
  // chat. Cap at 11px to match our Streamdown code-block font; small
  // reductions from the caller's font-size still apply below 11px.
  const toolInputFontSize = Math.min(11, codePanelFontSize)
  const codeStyle: React.CSSProperties = {
    margin: 0, padding: 8, borderRadius: 6,
    background: theme.surface.panelMuted, color: theme.chat.textSecondary,
    fontSize: toolInputFontSize, lineHeight: 1.45,
    fontFamily: fonts.mono, fontWeight: fonts.monoWeight,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: 240, overflowY: 'auto',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
    color: theme.chat.muted, fontFamily: fonts.sans,
    textTransform: 'uppercase', marginBottom: 3,
  }
  const pathStyle: React.CSSProperties = {
    fontSize: toolInputFontSize, fontFamily: fonts.mono,
    color: theme.chat.text, wordBreak: 'break-all', padding: '2px 0',
  }
  const diffBlockStyle = (kind: 'add' | 'del'): React.CSSProperties => ({
    ...codeStyle,
    background: kind === 'add'
      ? `color-mix(in srgb, ${theme.status.success} 12%, ${theme.surface.panelMuted})`
      : `color-mix(in srgb, ${theme.status.danger} 12%, ${theme.surface.panelMuted})`,
    borderLeft: `3px solid ${kind === 'add' ? theme.status.success : theme.status.danger}`,
  })

  const noticeBanner = notice
    ? (
        <div style={{
          fontSize: 10, color: theme.chat.muted, fontFamily: fonts.sans,
          padding: '3px 8px', marginBottom: 6, borderRadius: 4,
          border: `1px dashed ${theme.chat.divider}`,
          background: 'transparent',
        }}>
          Older tool input truncated to save memory
        </div>
      )
    : null

  const renderKeyValue = (label: string, value: string, mono = true) => (
    <div key={label} style={{ marginBottom: 6 }}>
      <div style={labelStyle}>{label}</div>
      <div style={mono ? pathStyle : { ...pathStyle, fontFamily: fonts.sans }}>{value}</div>
    </div>
  )

  // --- Per-tool layouts ----------------------------------------------------
  if (toolName === 'Edit' && parsed) {
    const filePath = getStr(parsed, 'file_path')
    const oldStr = getStr(parsed, 'old_string') ?? ''
    const newStr = getStr(parsed, 'new_string') ?? ''
    const replaceAll = getBool(parsed, 'replace_all')
    return (
      <>
        {noticeBanner}
        {filePath && renderKeyValue('File', filePath)}
        {replaceAll && (
          <div style={{ ...labelStyle, color: theme.status.warning, marginBottom: 4 }}>Replace all occurrences</div>
        )}
        <div style={labelStyle}>Old</div>
        <pre style={diffBlockStyle('del')}>{oldStr}</pre>
        <div style={{ ...labelStyle, marginTop: 6 }}>New</div>
        <pre style={diffBlockStyle('add')}>{newStr}</pre>
      </>
    )
  }

  if (toolName === 'MultiEdit' && parsed) {
    const filePath = getStr(parsed, 'file_path')
    const edits = Array.isArray((parsed as Record<string, unknown>).edits)
      ? ((parsed as Record<string, unknown>).edits as unknown[])
      : []
    return (
      <>
        {noticeBanner}
        {filePath && renderKeyValue('File', filePath)}
        {edits.map((edit, index) => {
          const oldStr = getStr(edit, 'old_string') ?? ''
          const newStr = getStr(edit, 'new_string') ?? ''
          return (
            <div key={index} style={{ marginTop: index > 0 ? 10 : 0 }}>
              <div style={labelStyle}>Edit {index + 1} — Old</div>
              <pre style={diffBlockStyle('del')}>{oldStr}</pre>
              <div style={{ ...labelStyle, marginTop: 4 }}>Edit {index + 1} — New</div>
              <pre style={diffBlockStyle('add')}>{newStr}</pre>
            </div>
          )
        })}
      </>
    )
  }

  if (toolName === 'Write' && parsed) {
    const filePath = getStr(parsed, 'file_path')
    const content = getStr(parsed, 'content') ?? ''
    return (
      <>
        {noticeBanner}
        {filePath && renderKeyValue('File', filePath)}
        <div style={labelStyle}>Content</div>
        <pre style={codeStyle}>{content}</pre>
      </>
    )
  }

  if (toolName === 'Bash' && parsed) {
    const command = getStr(parsed, 'command') ?? ''
    const description = getStr(parsed, 'description')
    const timeout = getNum(parsed, 'timeout')
    return (
      <>
        {noticeBanner}
        {description && renderKeyValue('Description', description, false)}
        <div style={labelStyle}>Command</div>
        <pre style={codeStyle}>{command}</pre>
        {timeout != null && (
          <div style={{ ...labelStyle, marginTop: 4 }}>Timeout: {timeout}ms</div>
        )}
      </>
    )
  }

  if ((toolName === 'Read' || toolName === 'NotebookEdit') && parsed) {
    const filePath = getStr(parsed, 'file_path') ?? getStr(parsed, 'notebook_path')
    const offset = getNum(parsed, 'offset')
    const limit = getNum(parsed, 'limit')
    const pages = getStr(parsed, 'pages')
    const newSource = getStr(parsed, 'new_source')
    return (
      <>
        {noticeBanner}
        {filePath && renderKeyValue('File', filePath)}
        {(offset != null || limit != null) && (
          <div style={pathStyle}>
            {offset != null && <>offset: {offset}</>}
            {offset != null && limit != null && ' · '}
            {limit != null && <>limit: {limit}</>}
          </div>
        )}
        {pages && renderKeyValue('Pages', pages)}
        {newSource != null && (
          <>
            <div style={{ ...labelStyle, marginTop: 6 }}>New source</div>
            <pre style={codeStyle}>{newSource}</pre>
          </>
        )}
      </>
    )
  }

  if ((toolName === 'Grep' || toolName === 'Glob') && parsed) {
    const pattern = getStr(parsed, 'pattern') ?? ''
    const path = getStr(parsed, 'path')
    const glob = getStr(parsed, 'glob')
    const ftype = getStr(parsed, 'type')
    const outputMode = getStr(parsed, 'output_mode')
    return (
      <>
        {noticeBanner}
        <div style={labelStyle}>Pattern</div>
        <pre style={codeStyle}>{pattern}</pre>
        {path && renderKeyValue('Path', path)}
        {glob && renderKeyValue('Glob', glob)}
        {ftype && renderKeyValue('Type', ftype, false)}
        {outputMode && renderKeyValue('Output mode', outputMode, false)}
      </>
    )
  }

  if (toolName === 'WebFetch' && parsed) {
    const url = getStr(parsed, 'url') ?? ''
    const prompt = getStr(parsed, 'prompt')
    return (
      <>
        {noticeBanner}
        {renderKeyValue('URL', url)}
        {prompt && (
          <>
            <div style={labelStyle}>Prompt</div>
            <pre style={codeStyle}>{prompt}</pre>
          </>
        )}
      </>
    )
  }

  if (toolName === 'WebSearch' && parsed) {
    const query = getStr(parsed, 'query') ?? ''
    return (
      <>
        {noticeBanner}
        {renderKeyValue('Query', query, false)}
      </>
    )
  }

  if (parsed && isPlanToolName(toolName)) {
    const normalized = extractPlanTodosFromParsedInput(toolName, parsed)
    if (normalized.length === 0) {
      return (
        <>
          {noticeBanner}
          <pre style={codeStyle}>{formatToolInput(body)}</pre>
        </>
      )
    }
    return (
      <>
        {noticeBanner}
        <PlanCard todos={normalized} variant="inline" />
      </>
    )
  }

  // Shape-based fallback: some providers emit tool calls whose toolName
  // doesn't match our exact whitelist above (e.g. "str_replace_based_edit_tool"
  // instead of "Edit"), but the payload shape is recognisable. Detect by keys
  // so we still render the pretty diff layout instead of a raw JSON dump.
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const looksLikeEdit = typeof obj.old_string === 'string' && typeof obj.new_string === 'string'
    if (looksLikeEdit) {
      const filePath = getStr(parsed, 'file_path')
      const oldStr = getStr(parsed, 'old_string') ?? ''
      const newStr = getStr(parsed, 'new_string') ?? ''
      const replaceAll = getBool(parsed, 'replace_all')
      return (
        <>
          {noticeBanner}
          {filePath && renderKeyValue('File', filePath)}
          {replaceAll && (
            <div style={{ ...labelStyle, color: theme.status.warning, marginBottom: 4 }}>Replace all occurrences</div>
          )}
          <div style={labelStyle}>Old</div>
          <pre style={diffBlockStyle('del')}>{oldStr}</pre>
          <div style={{ ...labelStyle, marginTop: 6 }}>New</div>
          <pre style={diffBlockStyle('add')}>{newStr}</pre>
        </>
      )
    }
  }

  // Fallback: unescape JSON strings so embedded newlines render as actual line
  // breaks instead of literal "\n" sequences, and drop the memory-guard banner.
  // Unescaping is applied EVEN when parsing failed — some providers emit
  // slightly malformed JSON (trailing comma, unquoted key) but the string
  // is still readable once \n / \" / \t are decoded.
  const unescape = (s: string): string => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t')
  const prettyFallback = parsed != null
    ? unescape(JSON.stringify(parsed, null, 2))
    : unescape(body)
  return (
    <>
      {noticeBanner}
      <pre style={codeStyle}>{prettyFallback}</pre>
    </>
  )
}

