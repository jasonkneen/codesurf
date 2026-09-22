export const LARGE_MESSAGE_CHAR_LIMIT = 40_000
export const LARGE_MESSAGE_LINE_LIMIT = 900
export const LARGE_ARTIFACT_CHAR_LIMIT = 24_000
export const LARGE_ARTIFACT_LINE_LIMIT = 260
export const LARGE_CONTENT_PREVIEW_CHAR_LIMIT = 18_000
export const LARGE_CONTENT_PREVIEW_LINE_LIMIT = 180
export const CHAT_STREAM_FLUSH_INTERVAL_MS = 50

export interface TextMeasure {
  chars: number
  lines: number
}

export interface RawDiffFile {
  path: string
  previousPath?: string
  additions: number
  deletions: number
  diff: string
}

export interface RawDiffSplit {
  prefix: string
  files: RawDiffFile[]
}

export function measureText(text: string): TextMeasure {
  let lines = text.length > 0 ? 1 : 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return { chars: text.length, lines }
}

export function isLargeMessage(text: string): boolean {
  const measure = measureText(text)
  return measure.chars > LARGE_MESSAGE_CHAR_LIMIT || measure.lines > LARGE_MESSAGE_LINE_LIMIT
}

export function isLargeArtifact(text: string): boolean {
  const measure = measureText(text)
  return measure.chars > LARGE_ARTIFACT_CHAR_LIMIT || measure.lines > LARGE_ARTIFACT_LINE_LIMIT
}

export function previewText(text: string): string {
  if (text.length <= LARGE_CONTENT_PREVIEW_CHAR_LIMIT) {
    const measure = measureText(text)
    if (measure.lines <= LARGE_CONTENT_PREVIEW_LINE_LIMIT) return text
  }

  let lineCount = 0
  let end = 0
  while (end < text.length && end < LARGE_CONTENT_PREVIEW_CHAR_LIMIT) {
    if (text.charCodeAt(end) === 10) {
      lineCount += 1
      if (lineCount >= LARGE_CONTENT_PREVIEW_LINE_LIMIT) break
    }
    end += 1
  }

  return `${text.slice(0, end).trimEnd()}\n\n[Preview truncated. Expand to render the full content.]`
}

export function splitRawDiffText(text: string): RawDiffSplit | null {
  const firstDiff = text.search(/^diff --git /m)
  if (firstDiff < 0) return null

  const prefix = text.slice(0, firstDiff).trim()
  const diffText = text.slice(firstDiff)
  const starts: number[] = []
  const re = /^diff --git /gm
  let match: RegExpExecArray | null
  while ((match = re.exec(diffText)) !== null) {
    starts.push(match.index)
  }
  if (starts.length === 0) return null

  const files = starts.map((start, index) => {
    const end = starts[index + 1] ?? diffText.length
    return parseRawDiffFile(diffText.slice(start, end).trimEnd())
  }).filter((file): file is RawDiffFile => file !== null)

  if (files.length === 0) return null
  return { prefix, files }
}

function parseRawDiffFile(diff: string): RawDiffFile | null {
  const header = diff.match(/^diff --git\s+a\/(.+?)\s+b\/(.+?)$/m)
  if (!header) return null

  const previousPath = header[1]
  const path = header[2]
  let additions = 0
  let deletions = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }

  return {
    path,
    previousPath: previousPath === path ? undefined : previousPath,
    additions,
    deletions,
    diff,
  }
}
