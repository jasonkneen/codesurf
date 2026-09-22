import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = new URL('..', import.meta.url).pathname
const chatStreamsUrl = pathToFileURL(join(repoRoot, 'electrobun/bun/chat-streams.ts')).href

function runParserSmoke(exportName, sample) {
  const script = `
    import { ${exportName} } from ${JSON.stringify(chatStreamsUrl)};
    const sample = ${JSON.stringify(sample)};
    console.log(JSON.stringify(${exportName}(sample)));
  `
  const result = spawnSync('bun', ['--eval', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

function runClaudeParserSmoke(sample) {
  return runParserSmoke('parseClaudeStreamJsonLine', sample)
}

function runClaudeParserSequence(samples) {
  const script = `
    import { createClaudeStreamParser } from ${JSON.stringify(chatStreamsUrl)};
    const parser = createClaudeStreamParser();
    const samples = ${JSON.stringify(samples)};
    console.log(JSON.stringify(samples.flatMap(sample => parser.parseLine(sample))));
  `
  const result = spawnSync('bun', ['--eval', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

function runCodexParserSequence(samples) {
  const script = `
    import {
      createCodexStreamParser,
      MAX_ELECTROBUN_CODEX_COMMAND_BYTES,
      MAX_ELECTROBUN_CODEX_COMMAND_OUTPUT_BYTES,
    } from ${JSON.stringify(chatStreamsUrl)};
    const parser = createCodexStreamParser();
    const samples = ${JSON.stringify(samples)};
    console.log(JSON.stringify({
      events: samples.flatMap(sample => parser.parseLine(sample)),
      commandLimit: MAX_ELECTROBUN_CODEX_COMMAND_BYTES,
      outputLimit: MAX_ELECTROBUN_CODEX_COMMAND_OUTPUT_BYTES,
    }));
  `
  const result = spawnSync('bun', ['--eval', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

describe('Electrobun chat stream parsers', () => {
  test('extracts Claude session ids without leaking hook/system payload text', () => {
    const events = runClaudeParserSmoke(JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      session_id: 'claude-session-1',
      output: 'huge hook payload that must not become chat text',
    }))

    assert.deepEqual(events, [{ type: 'session', sessionId: 'claude-session-1' }])
  })

  test('extracts only assistant text deltas from Claude stream-json', () => {
    const events = runClaudeParserSmoke(JSON.stringify({
      type: 'stream_event',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    }))

    assert.deepEqual(events, [
      { type: 'session', sessionId: 'claude-session-1' },
      { type: 'text', text: 'hello' },
    ])
  })

  test('ignores Claude thinking deltas so private reasoning never hits ChatTile', () => {
    const events = runClaudeParserSmoke(JSON.stringify({
      type: 'stream_event',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'hidden chain of thought' },
      },
    }))

    assert.deepEqual(events, [{ type: 'session', sessionId: 'claude-session-1' }])
  })

  test('does not repeat Claude result text after streamed deltas', () => {
    const events = runClaudeParserSequence([
      JSON.stringify({
        type: 'stream_event',
        session_id: 'claude-session-1',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' },
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'claude-session-1',
        is_error: false,
        result: 'hello',
      }),
    ])

    assert.deepEqual(events, [
      { type: 'session', sessionId: 'claude-session-1' },
      { type: 'text', text: 'hello' },
      { type: 'session', sessionId: 'claude-session-1' },
    ])
  })

  test('emits result-only Claude success once and classifies result errors before text', () => {
    assert.deepEqual(runClaudeParserSequence([JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'fallback answer',
    })]), [{ type: 'text', text: 'fallback answer' }])

    assert.deepEqual(runClaudeParserSequence([JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'must not be delivered as assistant text',
      errors: ['provider failed'],
    })]), [{ type: 'error', error: 'provider failed' }])

    assert.deepEqual(runClaudeParserSequence([JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
    })]), [{
      type: 'error',
      error: 'Claude finished without assistant output. Please resend the message.',
    }])
  })

  test('seals Claude parsing at the first result packet', () => {
    const events = runClaudeParserSequence([
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'final' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late text' } },
      }),
      JSON.stringify({ type: 'error', message: 'late error' }),
      'late non-json output',
    ])

    assert.deepEqual(events, [{ type: 'text', text: 'final' }])
  })

  test('surfaces fatal Codex events and ignores output after failure', () => {
    const failed = runCodexParserSequence([
      JSON.stringify({ type: 'turn.failed', error: { message: 'turn broke' } }),
      JSON.stringify({ delta: 'must not render' }),
    ])
    assert.deepEqual(failed.events, [{ type: 'error', error: 'turn broke' }])

    const topLevel = runCodexParserSequence([
      JSON.stringify({ type: 'error', error: 'transport broke' }),
    ])
    assert.deepEqual(topLevel.events, [{ type: 'error', error: 'transport broke' }])
  })

  test('emits collision-free Codex tool starts before bounded command summaries', () => {
    const oversizedCommand = `printf '${'x'.repeat(80_000)}'`
    const oversizedOutput = 'y'.repeat(100_000)
    const parsed = runCodexParserSequence([
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: oversizedCommand, aggregated_output: oversizedOutput },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: oversizedCommand, aggregated_output: oversizedOutput },
      }),
    ])

    assert.equal(parsed.events.length, 4)
    for (let index = 0; index < parsed.events.length; index += 2) {
      const start = parsed.events[index]
      const summary = parsed.events[index + 1]
      assert.equal(start.type, 'tool_start')
      assert.equal(summary.type, 'tool_summary')
      assert.equal(start.toolId, summary.toolId)
      assert.ok(Buffer.byteLength(summary.commandEntries[0].command) <= parsed.commandLimit)
      assert.ok(Buffer.byteLength(summary.commandEntries[0].output) <= parsed.outputLimit)
    }
    assert.notEqual(parsed.events[0].toolId, parsed.events[2].toolId)
  })

  test('extracts OpenCode assistant text and session ids from JSONL events', () => {
    const events = runParserSmoke('parseOpenCodeJsonLine', JSON.stringify({
      type: 'message',
      role: 'assistant',
      sessionId: 'opencode-session-1',
      content: [{ type: 'text', text: 'open-code-ok' }],
    }))

    assert.deepEqual(events, [
      { type: 'session', sessionId: 'opencode-session-1' },
      { type: 'text', text: 'open-code-ok' },
    ])
  })

  test('extracts OpenClaw session ids and payload text from JSON output', () => {
    const events = runParserSmoke('parseOpenClawOutput', JSON.stringify({
      meta: { sessionId: 'openclaw-session-1' },
      payloads: [
        { text: 'first' },
        { parts: [{ text: 'second' }] },
      ],
    }))

    assert.deepEqual(events, [
      { type: 'session', sessionId: 'openclaw-session-1' },
      { type: 'text', text: 'first\n\nsecond' },
    ])
  })
})
