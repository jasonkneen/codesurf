import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { readFileSync } from 'node:fs'
import {
  buildSessionTitlePrompt,
  cleanSessionTitleCandidate,
  createSessionTitleGenerationGate,
  deriveFallbackSessionTitle,
  hasSessionTitleChangedDuringGeneration,
  resolveSessionTitleModelCandidates,
  sanitizeGeneratedSessionTitle,
} from '../src/main/ipc/session-title-generation.ts'
import {
  getSessionTitleGenerationIndicator,
  getSessionTitleGenerationKey,
  updateSessionTitleGenerationState,
} from '../src/renderer/src/components/sidebar/session-title-generation.ts'

describe('session title generation prompt and sanitizer', () => {
  test('prompt is explicitly title-generation-only and asks for a 3-4 word thread title', () => {
    const prompt = buildSessionTitlePrompt({
      currentTitle: 'Long old thread title',
      provider: 'claude',
      model: 'sonnet',
      messageCount: 2,
      transcript: '1. user: The right-click title generator returns verbose summaries.\n2. assistant: I will fix it.',
    })

    expect(prompt).toContain('Generate a title for this thread')
    expect(prompt).toContain('3 to 4 words')
    expect(prompt).toContain('title generation only')
    expect(prompt).toContain('Do not answer the transcript')
  })

  test('sanitizer collapses verbose model output into a 3-4 word title', () => {
    expect(sanitizeGeneratedSessionTitle(
      'This thread is about fixing the right click generate title race and verbose output issues.',
      'Old fallback title',
    )).toBe('Fixing Right Click Generate')

    expect(sanitizeGeneratedSessionTitle(
      '{"title":"Thread Title Race Fix"}',
      'Old fallback title',
    )).toBe('Title Race Fix')

    expect(sanitizeGeneratedSessionTitle(
      'Here is a concise title: "Sidebar Title Generation"',
      'Old fallback title',
    )).toBe('Sidebar Title Generation')
  })

  test('sanitizer ignores Codex CLI crash banners and keeps the concrete fallback title', () => {
    const codexCrash = [
      'Reading additional input from stdin...',
      'OpenAI Codex v0.123.0 (research preview)',
      'workdir: /Users/jkneen/clawd/collaborator-clone',
      'model: gpt-5.1-codex-mini',
      'provider: openai',
    ].join('\n')

    expect(sanitizeGeneratedSessionTitle(codexCrash, 'Bypass Codex MCP config,')).toBe('Bypass Codex MCP Config')
  })

  test('title cleaner skips injected workspace instructions and uses the actual request', () => {
    expect(cleanSessionTitleCandidate([
      '# AGENTS.md instructions for /Users/jkneen/clawd/collaborator-clone',
      '<INSTRUCTIONS>',
      '## Non-Negotiable Rules',
      'Do not use emoji.',
      '</INSTRUCTIONS>',
      '# Files mentioned by the user:',
      '## Screenshot.png',
      '## My request for Codex:',
      'Can you explain why these chats open blank?',
    ].join('\n'))).toBe('Can you explain why these chats open blank')

    expect(cleanSessionTitleCandidate(
      'Workspace: collaborator-clone Primary path: /Users/jkneen/clawd/collaborator-clone Update the generated workspace memory file for CodeSurf.',
    )).toBe('Update the generated workspace memory file for CodeSurf')
  })

  test('local fallback derives a concise title without launching an agent when external generation fails', () => {
    const transcript = [
      '1. user: why is Codex trying to use a stale MCP server on 127.0.0.1?',
      '2. assistant: Codex is loading inspector-gateway from config.',
      '3. user: ok can we make sure we have a bypass / ignore and remove this from codex config',
    ].join('\n')

    expect(deriveFallbackSessionTitle(transcript, 'Untitled Chat Thread')).toBe('Bypass Codex MCP Config')
    expect(deriveFallbackSessionTitle(transcript, 'Bypass Codex MCP config,')).toBe('Bypass Codex MCP Config')
  })

  test('title IPC does not fall back to spawning Codex for title-only requests', () => {
    const canvasSource = readFileSync(`${process.cwd()}/src/main/ipc/canvas.ts`, 'utf8')

    expect(canvasSource).not.toContain('generateTitleWithCodex')
    expect(canvasSource).not.toContain('buildCodexTitleExecArgs')
    expect(canvasSource).not.toContain('falling back to Codex')
    expect(canvasSource).not.toContain('spawn(codexBin')
  })

  test('provider selection uses a fast current OpenAI/Codex model before any Claude title call', () => {
    const candidates = resolveSessionTitleModelCandidates(
      { provider: 'codex', model: 'gpt-5.4' },
      { OPENAI_API_KEY: 'sk-test-openai' },
    )

    expect(candidates[0]).toMatchObject({
      kind: 'openai-compatible',
      provider: 'openai',
      model: 'gpt-5.1-codex-mini',
      source: 'current-provider',
    })
    expect(candidates.findIndex(candidate => candidate.kind === 'claude-sdk')).toBe(-1)
  })

  test('provider selection uses an OpenRouter free model before Claude when Claude credits may be unavailable', () => {
    const candidates = resolveSessionTitleModelCandidates(
      { provider: 'claude', model: 'claude-sonnet-4-6' },
      { OPENROUTER_API_KEY: 'sk-or-test' },
    )

    expect(candidates[0]).toMatchObject({
      kind: 'openai-compatible',
      provider: 'openrouter',
      source: 'free-fallback',
    })
    expect(candidates[0]?.model).toContain(':free')
    expect(candidates.findIndex(candidate => candidate.kind === 'claude-sdk')).toBeGreaterThan(0)
  })

  test('provider selection falls through to local fallback instead of Claude for non-Claude sessions without provider keys', () => {
    const candidates = resolveSessionTitleModelCandidates(
      { provider: 'codex', model: 'gpt-5.4' },
      {},
    )

    expect(candidates).toEqual([])
  })

  test('same-session title generation dedupes while different sessions are not globally blocked', async () => {
    const gate = createSessionTitleGenerationGate<number>()
    let calls = 0
    let releaseFirst!: (value: number) => void

    const first = gate.run('ws::thread-a', () => new Promise<number>(resolve => {
      calls += 1
      releaseFirst = resolve
    }))
    const duplicate = gate.run('ws::thread-a', () => {
      calls += 100
      return Promise.resolve(100)
    })
    const secondSession = gate.run('ws::thread-b', async () => {
      calls += 1
      return 2
    })

    expect(first).toBe(duplicate)
    expect(await secondSession).toBe(2)
    expect(calls).toBe(2)
    expect(gate.isRunning('ws::thread-a')).toBe(true)
    releaseFirst(1)
    expect(await first).toBe(1)
    expect(gate.isRunning('ws::thread-a')).toBe(false)
  })
  test('detects stale title races before applying a generated title', () => {
    expect(hasSessionTitleChangedDuringGeneration('Old Sidebar Title', 'Old Sidebar Title')).toBe(false)
    expect(hasSessionTitleChangedDuringGeneration('Old Sidebar Title', 'old sidebar title.')).toBe(false)
    expect(hasSessionTitleChangedDuringGeneration('Old Sidebar Title', 'Manual User Rename')).toBe(true)
    expect(hasSessionTitleChangedDuringGeneration('', 'Manual User Rename')).toBe(true)
    expect(hasSessionTitleChangedDuringGeneration('Old Sidebar Title', null)).toBe(false)
  })
})

describe('session title generation UI state helpers', () => {
  test('tracks multiple generating sessions and exposes clear visible row/menu copy', () => {
    const keyA = getSessionTitleGenerationKey('ws', 'thread-a')
    const keyB = getSessionTitleGenerationKey('ws', 'thread-b')

    let state = updateSessionTitleGenerationState({}, keyA, true)
    state = updateSessionTitleGenerationState(state, keyB, true)

    expect(state[keyA]).toBe(true)
    expect(state[keyB]).toBe(true)

    const generating = getSessionTitleGenerationIndicator(true, '5m • claude')
    expect(generating.menuLabel).toBe('Generating Title…')
    expect(generating.rowMeta).toBe('Generating title… • 5m • claude')
    expect(generating.rowTitleSuffix).toBe('\nGenerating title…')

    const idle = getSessionTitleGenerationIndicator(false, '5m • claude')
    expect(idle.menuLabel).toBe('Generate Title')
    expect(idle.rowMeta).toBe('5m • claude')

    state = updateSessionTitleGenerationState(state, keyA, false)
    expect(state[keyA]).toBeUndefined()
    expect(state[keyB]).toBe(true)
  })
})
