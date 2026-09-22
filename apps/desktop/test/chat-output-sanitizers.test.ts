import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  sanitizeToolOutputText,
  sanitizeClaudeStderrText,
  formatClaudeSdkError,
} from '../src/main/chat/output-sanitizers.ts'

describe('sanitizeToolOutputText', () => {
  test('returns empty string for nullish/empty input', () => {
    assert.equal(sanitizeToolOutputText(null), '')
    assert.equal(sanitizeToolOutputText(undefined), '')
    assert.equal(sanitizeToolOutputText(''), '')
  })

  test('strips host runtime noise lines', () => {
    const raw = [
      'Chunk ID: abc123',
      'real output line',
      'Wall time: 1.2s',
      'Process exited with code 0',
      'Process running with session ID xyz',
      'Original token count: 42',
      'Output:',
      '[CodeSurf memory guard] Older tool output was trimmed',
      'second real line',
    ].join('\n')
    assert.equal(sanitizeToolOutputText(raw), 'real output line\nsecond real line')
  })

  test('normalizes CRLF and collapses 3+ blank lines to one gap', () => {
    assert.equal(sanitizeToolOutputText('a\r\n\r\n\r\n\r\nb'), 'a\n\nb')
  })

  test('keeps lines that merely contain a noise word but do not start with it', () => {
    assert.equal(sanitizeToolOutputText('see Wall time: below'), 'see Wall time: below')
  })
})

describe('sanitizeClaudeStderrText', () => {
  test('strips ANSI escape sequences', () => {
    assert.equal(sanitizeClaudeStderrText('\x1B[31merror\x1B[0m here'), 'error here')
  })

  test('drops blank lines and trims trailing whitespace', () => {
    assert.equal(sanitizeClaudeStderrText('line one   \n\n\n   line two'), 'line one\n   line two')
  })

  test('returns empty for nullish input', () => {
    assert.equal(sanitizeClaudeStderrText(null), '')
    assert.equal(sanitizeClaudeStderrText(undefined), '')
  })
})

describe('formatClaudeSdkError', () => {
  test('returns just the message when there is no stderr', () => {
    assert.equal(formatClaudeSdkError(new Error('boom'), ''), 'boom')
  })

  test('coerces non-Error values to string', () => {
    assert.equal(formatClaudeSdkError('plain failure', ''), 'plain failure')
  })

  test('returns stderr alone when it already contains the message', () => {
    const out = formatClaudeSdkError(new Error('rate limited'), 'prefix\nrate limited\nsuffix')
    assert.equal(out, 'prefix\nrate limited\nsuffix')
  })

  test('combines message and stderr when distinct', () => {
    const out = formatClaudeSdkError(new Error('boom'), 'some stderr detail')
    assert.equal(out, 'boom\n\nClaude Code stderr:\nsome stderr detail')
  })

  test('caps combined output at 6000 chars', () => {
    const out = formatClaudeSdkError(new Error('x'), 'y'.repeat(8000))
    assert.equal(out.length, 6000)
  })
})
