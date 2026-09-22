import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  CODESURF_OUTPUT_CONVENTION,
  CODESURF_INSIGHT_CONVENTION,
  CODESURF_ACTIVITY_CONVENTION,
  buildCodeSurfOutputConvention,
  buildCodeSurfInsightConvention,
  buildCodeSurfActivityConvention,
  joinPromptSections,
} from '../src/main/chat/prompt-conventions.ts'
import { buildPeerAwareTurnPrompt } from '../src/main/chat/prompt-builders.ts'
import { composeChatContext } from '../src/main/chat/context-composer.ts'

/**
 * Contract tests for the CodeSurf prompt conventions injected into every chat
 * provider (Claude, Codex, OpenCode, OpenClaw, Hermes).
 *
 * The conventions themselves now live in the pure `prompt-conventions` module,
 * so we import and assert on the real values. The provider *wiring* still lives
 * in `chat.ts` / provider modules (which pull in Electron main APIs and can't
 * be imported), so those checks remain source-text assertions.
 */

const CHAT_SOURCE = readFileSync(resolve(process.cwd(), 'src/main/ipc/chat.ts'), 'utf8')
const CLAUDE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/main/chat/providers/claude.ts'),
  'utf8',
)
const CODEX_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/main/chat/providers/agent-mode-payloads.ts'),
  'utf8',
)
const HERMES_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/main/chat/providers/hermes.ts'),
  'utf8',
)
const PI_RUNTIME_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/main/chat/pi-runtime.ts'),
  'utf8',
)
const OPENCLAW_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/main/chat/providers/openclaw.ts'),
  'utf8',
)
const OPENCODE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/main/chat/providers/opencode.ts'),
  'utf8',
)

describe('CodeSurf prompt conventions — values', () => {
  test('CODESURF_OUTPUT_CONVENTION contains all three required sections', () => {
    expect(CODESURF_OUTPUT_CONVENTION).toContain('Default to a short natural-language completion')
    expect(CODESURF_OUTPUT_CONVENTION).toContain(
      'Do NOT use the structured card for trivial changes',
    )
    expect(CODESURF_OUTPUT_CONVENTION).toContain('CHANGES MADE:')
    expect(CODESURF_OUTPUT_CONVENTION).toContain("DIDN'T TOUCH:")
    expect(CODESURF_OUTPUT_CONVENTION).toContain('CONCERNS:')
  })

  test('CODESURF_INSIGHT_CONVENTION is provider-ready and keeps the literal star-framed container', () => {
    expect(CODESURF_INSIGHT_CONVENTION).toContain(
      'Use an Insight block when you notice a non-obvious constraint',
    )
    // The exact framing must survive — the chat renderer matches on these
    // characters. Changing the framing means updating the renderer too.
    expect(CODESURF_INSIGHT_CONVENTION).toContain('★ Insight ─────────────────────────────────────')
    expect(CODESURF_INSIGHT_CONVENTION).toContain(
      '─────────────────────────────────────────────────',
    )
  })

  test('builder helpers return their respective constants', () => {
    assert.equal(buildCodeSurfOutputConvention(), CODESURF_OUTPUT_CONVENTION)
    assert.equal(buildCodeSurfInsightConvention(), CODESURF_INSIGHT_CONVENTION)
    assert.equal(buildCodeSurfActivityConvention(), CODESURF_ACTIVITY_CONVENTION)
  })

  test('CODESURF_ACTIVITY_CONVENTION preserves native agent behavior while standardizing UI activity', () => {
    expect(CODESURF_ACTIVITY_CONVENTION).toContain(
      'Keep your native agent instructions, tools, and strengths',
    )
    expect(CODESURF_ACTIVITY_CONVENTION).toContain('keep a visible task plan current')
    expect(CODESURF_ACTIVITY_CONVENTION).toContain('does not expose a todo/plan tool')
  })

  test('joinPromptSections joins trimmed non-empty sections and drops blanks/nullish', () => {
    assert.equal(joinPromptSections('a', '', null, undefined, '  b  '), 'a\n\nb')
    assert.equal(joinPromptSections('', null, undefined), undefined)
    assert.equal(joinPromptSections('only'), 'only')
  })
})

describe('CodeSurf prompt conventions — provider wiring', () => {
  test('central composition owns all three conventions in stable order', () => {
    const context = composeChatContext({
      outputConvention: buildCodeSurfOutputConvention(),
      insightConvention: buildCodeSurfInsightConvention(),
      activityConvention: buildCodeSurfActivityConvention(),
    })
    assert.deepEqual(context.fragments.map(fragment => fragment.kind), [
      'output-convention',
      'insight-convention',
      'activity-convention',
    ])
    assert.match(context.systemPrompt ?? '', /Task-Completion[\s\S]*Insight[\s\S]*Activity/)
  })

  test('every Electron provider consumes the one host-composed context', () => {
    expect(CHAT_SOURCE).toContain('composeHostChatContext(req)')
    expect(CLAUDE_SOURCE).toContain('req.contextPrompt?.trim()')
    expect(CODEX_SOURCE).toContain('input.contextPrompt')
    expect(OPENCODE_SOURCE).toContain('req.contextPrompt')
    expect(OPENCLAW_SOURCE).toContain('contextPrompt: req.contextPrompt')
    expect(HERMES_SOURCE).toContain('contextPrompt: req.contextPrompt')
    expect(PI_RUNTIME_SOURCE).toContain('req.contextPrompt?.trim()')
  })

  test('turn transport prepends a composed context once', () => {
    const turn = buildPeerAwareTurnPrompt('user request', 'composed context')
    assert.equal(turn, 'composed context\n\n---\n\nuser request')
  })
})

describe('CodeSurf prompt conventions — token budget guardrails', () => {
  test('combined conventions stay within a reasonable size budget', () => {
    // Rough budget: the two convention strings together should stay under
    // ~6000 chars (~1500 tokens). Going above hints at prompt bloat that will
    // hurt every turn across every provider.
    const combined =
      CODESURF_OUTPUT_CONVENTION.length +
      CODESURF_INSIGHT_CONVENTION.length +
      CODESURF_ACTIVITY_CONVENTION.length
    assert.ok(
      combined < 6000,
      `combined convention text is ${combined} chars — over the 6000 soft ceiling`,
    )
  })
})
