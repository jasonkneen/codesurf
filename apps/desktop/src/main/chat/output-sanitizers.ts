/**
 * Pure text sanitizers for agent/tool output, extracted out of
 * `src/main/ipc/chat.ts` (which pulls in Electron main APIs and cannot be
 * unit-tested). `sanitizeToolOutputText` was previously copy-pasted
 * byte-for-byte into `src/main/session-sources.ts` too; this is now the single
 * main-process source of truth for both. See `test/chat-output-sanitizers.test.ts`.
 *
 * Note: the renderer keeps its own `sanitizeToolOutputText` in
 * `messageNormalization.ts` with a different signature (`=> string | undefined`)
 * and is intentionally not consolidated here.
 */

// Strip CodeSurf/host runtime noise lines (chunk markers, wall-time, exit
// codes, memory-guard notices) and collapse blank runs so tool output reads
// cleanly in the chat UI and session previews.
export function sanitizeToolOutputText(text: string | null | undefined): string {
  if (!text) return ''

  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      return !(
        /^Chunk ID:/i.test(trimmed)
        || /^Wall time:/i.test(trimmed)
        || /^Process exited with code /i.test(trimmed)
        || /^Process running with session ID /i.test(trimmed)
        || /^Original token count:/i.test(trimmed)
        || /^Output:$/i.test(trimmed)
        || /^\[CodeSurf memory guard\] Older tool (output|summary) /i.test(trimmed)
      )
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Strip ANSI escape sequences and blank lines from Claude Code CLI stderr.
export function sanitizeClaudeStderrText(text: string | null | undefined): string {
  if (!text) return ''

  return text
    .replace(/\r\n/g, '\n')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .join('\n')
    .trim()
}

// Combine an SDK error message with its (sanitized) stderr, de-duplicating when
// the message is already contained in stderr, and cap the result to ~6000 chars.
export function formatClaudeSdkError(error: unknown, stderrText: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = sanitizeClaudeStderrText(stderrText)
  if (!stderr) return message
  if (message && stderr.includes(message)) return stderr.slice(-6000)
  return `${message}\n\nClaude Code stderr:\n${stderr}`.slice(-6000)
}
