/**
 * Inline unified-diff renderer.
 *
 * Reads the diff text already produced upstream by session-sources.ts
 * (apply-patch text parsed into `+` / `-` / ` ` / `@@` prefixed lines) and
 * lays it out as a two-column gutter: old-line #, new-line #, then the body.
 *
 * Design choices:
 *   - white-space: pre (not pre-wrap) + horizontal scroll on the body, so
 *     long lines read as code instead of wrapping as prose. The gutter
 *     stays pinned because it lives in its own flex column.
 *   - Hunk headers `@@ -1,3 +1,5 @@` act as muted separators AND reset the
 *     running line counters from their declared coordinates.
 *   - Long diffs auto-collapse above maxLines with a "show all" button so a
 *     single giant patch cannot balloon the chat transcript.
 */
import React, { useMemo, useState } from 'react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'

interface DiffViewProps {
  diff: string
  path?: string
  fontSize?: number
  maxLines?: number
}

interface DiffRow {
  kind: 'context' | 'add' | 'del' | 'hunk' | 'meta'
  oldNo: number | null
  newNo: number | null
  text: string
}

const DEFAULT_MAX_LINES = 300

function parseDiff(diff: string): DiffRow[] {
  if (diff.trim().length === 0) return []

  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false

  const hunkRe = /^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/

  for (const line of lines) {
    if (line.startsWith('*** ')) {
      rows.push({ kind: 'meta', oldNo: null, newNo: null, text: line })
      inHunk = false
      continue
    }
    const hunkMatch = hunkRe.exec(line)
    if (hunkMatch) {
      oldNo = parseInt(hunkMatch[1], 10)
      newNo = parseInt(hunkMatch[2], 10)
      inHunk = true
      rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line })
      continue
    }
    if (!inHunk) {
      oldNo = oldNo || 1
      newNo = newNo || 1
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', oldNo: null, newNo, text: line.slice(1) })
      newNo++
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldNo, newNo: null, text: line.slice(1) })
      oldNo++
      continue
    }
    const body = line.startsWith(' ') ? line.slice(1) : line
    rows.push({ kind: 'context', oldNo, newNo, text: body })
    oldNo++
    newNo++
  }
  return rows
}

export const DiffView = React.memo(function DiffView({
  diff,
  path: _path,
  fontSize = 11,
  maxLines = DEFAULT_MAX_LINES,
}: DiffViewProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [expanded, setExpanded] = useState(false)

  const rows = useMemo(() => parseDiff(diff), [diff])
  const overLimit = rows.length > maxLines
  const visibleRows = expanded || !overLimit ? rows : rows.slice(0, maxLines)

  const gutterDigits = useMemo(() => {
    let max = 0
    for (const r of rows) {
      if (r.oldNo && r.oldNo > max) max = r.oldNo
      if (r.newNo && r.newNo > max) max = r.newNo
    }
    return Math.max(3, String(max || 1).length)
  }, [rows])
  const gutterWidth = `${gutterDigits + 1}ch`

  const rowBg = (kind: DiffRow['kind']): string => {
    switch (kind) {
      // Use the theme's status colors so add/del tints stay within palette
      // and respond to the contrast slider through the text colours that
      // status.success / status.danger derive from in computed shifts.
      case 'add': return `color-mix(in srgb, ${theme.status.success} 18%, transparent)`
      case 'del': return `color-mix(in srgb, ${theme.status.danger} 18%, transparent)`
      case 'hunk': return theme.surface.panelMuted
      case 'meta': return theme.surface.panelMuted
      default: return 'transparent'
    }
  }
  const rowColor = (kind: DiffRow['kind']): string => {
    switch (kind) {
      case 'add': return theme.status.success
      case 'del': return theme.status.danger
      case 'hunk': return theme.accent.base
      case 'meta': return theme.text.disabled
      default: return theme.chat.text
    }
  }
  const prefixChar = (kind: DiffRow['kind']): string => {
    switch (kind) {
      case 'add': return '+'
      case 'del': return '-'
      case 'hunk': return ' '
      case 'meta': return ' '
      default: return ' '
    }
  }

  return (
    <div style={{
      background: theme.chat.background,
      fontFamily: fonts.mono,
      fontSize,
      lineHeight: fonts.monoLineHeight,
      overflowX: 'auto',
      overflowY: 'auto',
      maxHeight: 480,
    }}>
      <div style={{ minWidth: 'max-content' }}>
        {visibleRows.map((row, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'stretch',
              background: rowBg(row.kind),
              color: rowColor(row.kind),
              fontWeight: row.kind === 'hunk' ? 600 : fonts.monoWeight,
              whiteSpace: 'pre',
            }}
          >
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                width: gutterWidth,
                textAlign: 'right',
                padding: '0 6px 0 10px',
                color: theme.chat.muted,
                userSelect: 'none',
                opacity: row.kind === 'hunk' || row.kind === 'meta' ? 0 : 0.6,
              }}
            >
              {row.oldNo ?? ''}
            </span>
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                width: gutterWidth,
                textAlign: 'right',
                padding: '0 8px 0 0',
                color: theme.chat.muted,
                userSelect: 'none',
                opacity: row.kind === 'hunk' || row.kind === 'meta' ? 0 : 0.6,
                borderRight: `1px solid ${theme.border.subtle}`,
              }}
            >
              {row.newNo ?? ''}
            </span>
            <span style={{ padding: '0 10px', flex: '0 0 1ch', userSelect: 'none', opacity: 0.7 }}>
              {prefixChar(row.kind)}
            </span>
            <span style={{ padding: '0 8px 0 0', flex: 1, minWidth: 0 }}>
              {row.text || ' '}
            </span>
          </div>
        ))}
        {overLimit && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            style={{
              width: '100%',
              padding: '6px 10px',
              background: theme.surface.panelMuted,
              border: 'none',
              borderTop: `1px solid ${theme.border.subtle}`,
              color: theme.chat.textSecondary,
              fontFamily: fonts.primary,
              fontSize: 11,
              cursor: 'pointer',
              textAlign: 'center',
            }}
          >
            Show {rows.length - maxLines} more lines
          </button>
        )}
      </div>
    </div>
  )
})
