import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const require = createRequire(import.meta.url)
const daemonDir = dirname(require.resolve('@codesurf/daemon/package.json'))
const daemonSource = (binName) => readFileSync(join(daemonDir, 'bin', binName), 'utf8')
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  buildAmpExecuteArgs,
  buildClineTaskArgs,
  buildCursorAgentPrintArgs,
  buildGeminiPromptArgs,
  buildHermesChatArgs,
  hermesChatHelpSupportsStreamJson,
  buildKiloRunArgs,
  buildOpenClawAgentArgs,
  buildOpenCodeRunArgs,
  parseBoundedOpenClawOutput,
  parseHermesOutput,
  parseOpenClawOutput,
  parseOpenCodeRunOutput,
  sanitizeAgentCliDiagnostic,
} from '../src/main/agents/agent-cli-contracts.ts'
import { buildOpenCodeSessionPermissions } from '../src/main/agents/opencode-permissions.ts'

function expectNoFlags(args: string[], forbidden: string[]): void {
  for (const flag of forbidden) {
    assert.ok(!args.includes(flag), `expected ${args.join(' ')} not to include ${flag}`)
  }
}

describe('agent CLI contract builders', () => {
  test('builds Hermes chat args with CodeSurf-owned context policy boundaries', () => {
    const args = buildHermesChatArgs({
      prompt: 'Summarize this repo',
      model: 'openai-codex/gpt-5.5',
      provider: 'openrouter',
      toolsets: ['terminal', 'file'],
      resumeSessionId: 'hermes-session-1',
      ignoreRules: true,
      bypassPermissions: false,
    })

    expect(args).toEqual([
      'chat',
      '--query', 'Summarize this repo',
      '--quiet',
      '--source', 'tool',
      '--model', 'openai-codex/gpt-5.5',
      '--provider', 'openrouter',
      '--toolsets', 'terminal,file',
      '--resume', 'hermes-session-1',
      '--ignore-rules',
    ])
    expectNoFlags(args, ['--ignore-user-config', '--yolo', '--stream-json'])
  })

  test('only emits --stream-json when the installed Hermes chat help advertises it', () => {
    expect(hermesChatHelpSupportsStreamJson(`
      -Q, --quiet           Quiet mode for programmatic use
      --resume SESSION_ID
    `)).toBe(false)
    expect(hermesChatHelpSupportsStreamJson('unrecognized arguments: --stream-json')).toBe(false)
    expect(hermesChatHelpSupportsStreamJson('  --stream-json     NDJSON events on stdout')).toBe(true)

    const streamed = buildHermesChatArgs({ prompt: 'hi', streamJson: true })
    expect(streamed).toContain('--stream-json')
    expectNoFlags(streamed, ['--quiet'])
  })

  test('captures Hermes session ids while removing them from visible output', () => {
    const parsed = parseHermesOutput('session_id: abc123\nFinal answer\nsession: ignored-second\n')

    expect(parsed.text).toBe('Final answer')
    expect(parsed.sessionId).toBe('abc123')
  })

  test('Hermes args infer provider from CodeSurf provider/model selections', () => {
    const codexArgs = buildHermesChatArgs({
      prompt: 'Use the current model',
      model: 'openai-codex/gpt-5.5',
      toolsets: 'terminal,file',
    })

    expect(codexArgs).toEqual([
      'chat',
      '--query', 'Use the current model',
      '--quiet',
      '--source', 'tool',
      '--model', 'gpt-5.5',
      '--provider', 'openai-codex',
      '--toolsets', 'terminal,file',
    ])

    const openRouterArgs = buildHermesChatArgs({
      prompt: 'Use the aggregator model',
      model: 'openrouter/moonshotai/kimi-k2.6',
    })
    expect(openRouterArgs).toContain('--provider')
    expect(openRouterArgs.slice(openRouterArgs.indexOf('--provider'), openRouterArgs.indexOf('--provider') + 2)).toEqual(['--provider', 'openrouter'])
    expect(openRouterArgs.slice(openRouterArgs.indexOf('--model'), openRouterArgs.indexOf('--model') + 2)).toEqual(['--model', 'moonshotai/kimi-k2.6'])
  })

  test('builds OpenClaw JSON args without stale imaginary flags', () => {
    const args = buildOpenClawAgentArgs({
      prompt: 'Work on this',
      agentId: 'main',
      thinking: 'high',
      timeoutSeconds: 120,
    })

    expect(args).toEqual([
      'agent',
      '--json',
      '--agent', 'main',
      '--message', 'Work on this',
      '--thinking', 'high',
      '--timeout', '120',
    ])
    expectNoFlags(args, ['--output-format', '--approval-mode', '--model', '-p', '--yes'])
  })

  test('builds OpenClaw resume args from session id instead of agent id', () => {
    const args = buildOpenClawAgentArgs({ prompt: 'Continue', sessionId: 'oc-session-1' })

    expect(args).toEqual(['agent', '--json', '--session-id', 'oc-session-1', '--message', 'Continue'])
    expectNoFlags(args, ['--agent'])
  })

  test('parses OpenClaw payload text from JSON envelopes', () => {
    const parsed = parseOpenClawOutput(JSON.stringify({
      sessionId: 'oc-session-2',
      payloads: [
        { text: 'Hello' },
        { parts: [{ text: ' world' }] },
      ],
    }))

    expect(parsed.text).toBe('Hello\n\n world')
    expect(parsed.sessionId).toBe('oc-session-2')
  })

  test('rejects truncated OpenClaw envelopes instead of exposing a malformed JSON suffix', () => {
    const parsed = parseBoundedOpenClawOutput(
      '{"payloads":[{"text":"malformed suffix"}],"sessionId":"lost-session"}',
      true,
    )

    assert.equal(parsed.ok, false)
    if (!parsed.ok) {
      assert.match(parsed.error, /exceeded/i)
    }
    assert.equal('output' in parsed, false)
  })

  test('preserves OpenClaw session metadata for complete bounded envelopes', () => {
    const parsed = parseBoundedOpenClawOutput(JSON.stringify({
      meta: { sessionId: 'oc-session-meta' },
      payloads: [{ text: 'Complete answer' }],
    }), false)

    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.output.text, 'Complete answer')
      assert.equal(parsed.output.sessionId, 'oc-session-meta')
    }
  })

  test('builds OpenCode run args using current json format and explicit bypass only', () => {
    const args = buildOpenCodeRunArgs({
      prompt: 'Make a plan',
      model: 'anthropic/claude-sonnet-4-6',
      agent: 'build',
      cwd: '/tmp/project',
      sessionId: 'opencode-session-1',
      bypassPermissions: true,
    })

    expect(args).toEqual([
      'run',
      '--format', 'json',
      '--model', 'anthropic/claude-sonnet-4-6',
      '--agent', 'build',
      '--session', 'opencode-session-1',
      '--dir', '/tmp/project',
      '--dangerously-skip-permissions',
      'Make a plan',
    ])
    expectNoFlags(args, ['--approval-mode'])
  })

  test('OpenCode SDK sessions ask by default and only allow all in explicit bypass mode', () => {
    expect(buildOpenCodeSessionPermissions('default')).toEqual([
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'list', pattern: '*', action: 'allow' },
      { permission: 'grep', pattern: '*', action: 'allow' },
      { permission: 'glob', pattern: '*', action: 'allow' },
      { permission: 'todoread', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'allow' },
      { permission: 'codesearch', pattern: '*', action: 'allow' },
      { permission: 'lsp', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'task', pattern: '*', action: 'ask' },
      { permission: 'external_directory', pattern: '*', action: 'ask' },
      { permission: 'todowrite', pattern: '*', action: 'ask' },
      { permission: 'webfetch', pattern: '*', action: 'ask' },
      { permission: 'websearch', pattern: '*', action: 'ask' },
      { permission: 'doom_loop', pattern: '*', action: 'ask' },
      { permission: 'skill', pattern: '*', action: 'ask' },
    ])

    expect(buildOpenCodeSessionPermissions('plan').slice(-9).map(rule => rule.action)).toEqual(Array(9).fill('deny'))
    expect(buildOpenCodeSessionPermissions('bypassPermissions').slice(-9).map(rule => rule.action)).toEqual(Array(9).fill('allow'))
    expect(buildOpenCodeSessionPermissions('build').slice(-9).map(rule => rule.action)).toEqual(Array(9).fill('ask'))
  })

  test('parses OpenCode JSONL output line-by-line instead of taking the first object blob', () => {
    const parsed = parseOpenCodeRunOutput([
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello ' }] }),
      JSON.stringify({ type: 'session', sessionID: 'opencode-session-2' }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ].join('\n'))

    expect(parsed.text).toBe('Hello done')
    expect(parsed.sessionId).toBe('opencode-session-2')
  })

  test('builds Cursor Agent headless stream args without using Cursor GUI', () => {
    const command = buildCursorAgentPrintArgs({
      prompt: 'Fix tests',
      cwd: '/tmp/project',
      model: 'gpt-5.5',
      resumeChatId: 'cursor-chat-1',
      mode: 'plan',
      streamPartialOutput: true,
      trustWorkspace: true,
    })

    expect(command.command).toBe('cursor-agent')
    expect(command.args).toEqual([
      '--print',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--workspace', '/tmp/project',
      '--model', 'gpt-5.5',
      '--resume', 'cursor-chat-1',
      '--mode', 'plan',
      '--trust',
      'Fix tests',
    ])
    expectNoFlags(command.args, ['--force', '--yolo'])
  })

  test('builds Gemini headless args without raw output by default', () => {
    const args = buildGeminiPromptArgs({
      prompt: 'Review this file',
      model: 'gemini-2.5-pro',
      outputFormat: 'stream-json',
      resumeSessionId: 'latest',
      approvalMode: 'plan',
      sandbox: true,
      includeDirectories: ['/tmp/project'],
    })

    expect(args).toEqual([
      '--prompt', 'Review this file',
      '--output-format', 'stream-json',
      '--model', 'gemini-2.5-pro',
      '--resume', 'latest',
      '--approval-mode', 'plan',
      '--sandbox',
      '--include-directories', '/tmp/project',
    ])
    expectNoFlags(args, ['--raw-output', '--accept-raw-output-risk', '--yolo'])
  })

  test('builds Cline task args and keeps ACP separate from task mode', () => {
    const args = buildClineTaskArgs({
      prompt: 'Add tests',
      cwd: '/tmp/project',
      model: 'claude-sonnet-4-6',
      mode: 'plan',
      timeoutSeconds: 60,
      json: true,
    })

    expect(args).toEqual([
      'task',
      '--json',
      '--cwd', '/tmp/project',
      '--model', 'claude-sonnet-4-6',
      '--plan',
      '--timeout', '60',
      'Add tests',
    ])
    expectNoFlags(args, ['--acp', '--yolo', '--auto-approve-all'])
  })

  test('builds Amp execute args with IDE context disabled unless requested', () => {
    const args = buildAmpExecuteArgs({
      prompt: 'List files',
      mode: 'smart',
      streamJson: true,
      useIdeContext: false,
    })

    expect(args).toEqual(['--no-ide', '--mode', 'smart', '--execute', 'List files', '--stream-json'])
    expectNoFlags(args, ['--dangerously-allow-all', '--ide'])
  })

  test('builds discovery-first Kilo run args', () => {
    const args = buildKiloRunArgs({ prompt: 'Plan the work' })

    expect(args).toEqual(['run', 'Plan the work'])
  })

  test('daemon chat routing recognizes OpenCode, Hermes, and Omnigent as daemon-capable providers', () => {
    const ipcSource = readFileSync(`${process.cwd()}/src/main/ipc/chat.ts`, 'utf8')
    const chatJobsSource = daemonSource('chat-jobs.mjs')

    expect(ipcSource).toContain("return provider === 'claude' || provider === 'codex' || provider === 'opencode' || provider === 'hermes' || provider === 'omnigent'")
    expect(ipcSource).toContain('Supported daemon providers: Claude, Codex, OpenCode, Hermes, and Omnigent.')
    expect(chatJobsSource).toContain("request.provider === 'hermes'")
    expect(chatJobsSource).toContain("request.provider === 'omnigent'")
    expect(chatJobsSource).toContain('Daemon execution is only implemented for Claude, Codex, OpenCode, Hermes, Omnigent, and AI Gateway right now')
  })

  test('Claude bypass mode passes the SDK dangerous-skip confirmation flag', () => {
    const claudeSource = readFileSync(`${process.cwd()}/src/main/chat/providers/claude.ts`, 'utf8')
    const chatJobsSource = daemonSource('chat-jobs.mjs')
    const relaySource = readFileSync(`${process.cwd()}/src/main/relay/provider-executor.ts`, 'utf8')

    expect(claudeSource).toContain("...(permMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {})")
    expect(chatJobsSource).toContain("...(permMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {})")
    expect(relaySource).toContain("...(claudePermissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {})")
  })

  test('main-process Hermes chat uses shared model/provider contract helpers', () => {
    const source = readFileSync(`${process.cwd()}/src/main/chat/providers/hermes.ts`, 'utf8')

    expect(source).toContain('buildHermesSpawnArgs({')
    expect(source).toContain('hermesBinarySupportsStreamJson(hermesBin)')
    expect(source).toContain('sanitizeAgentCliDiagnostic(stderrBuf.trim())')
    expect(source).not.toContain("args.push('--model', req.model)")
  })

  test('relay provider executor is wired through shared contract helpers and safe failure handling', () => {
    const source = readFileSync(`${process.cwd()}/src/main/relay/provider-executor.ts`, 'utf8')

    expect(source).toContain('buildHermesChatArgs')
    expect(source).toContain('buildOpenClawAgentArgs')
    expect(source).toContain('buildOpenCodeRunArgs')
    expect(source).toContain('runRelayProviderCli({')
    expect(source).toContain('sanitizeAgentCliDiagnostic(result.stderr.trim() || `Codex exited with ${result.code}`)')
    expect(source).toContain('OPENCLAW_AGENT_LIST_TIMEOUT_MS')
    expect(source).toContain('OPENCLAW_AGENT_LIST_MAX_BUFFER_BYTES')
    expect(source).not.toContain("'--approval-mode', approvalMode")
    expect(source).not.toContain('OpenCode approval mode')
    expect(source).not.toContain("bypassPermissions: spawnRequest.mode === 'bypassPermissions' || spawnRequest.mode === 'full-auto'")
  })

  test('redacts credential-looking diagnostics before surfacing CLI errors', () => {
    const pieces = [
      'OPENAI',
      '_API_',
      'KEY = "placeholder secret value"',
      ' AMP',
      '_TOKEN=placeholder-token',
      ' Authorization: Bearer placeholder-bearer-token',
      ' api key: "placeholder api key value"',
    ]
    const sanitized = sanitizeAgentCliDiagnostic(pieces.join(''))

    expect(sanitized).toContain('OPENAI_API_KEY=[REDACTED]')
    expect(sanitized).toContain('AMP_TOKEN=[REDACTED]')
    expect(sanitized).toContain('Authorization: Bearer [REDACTED]')
    expect(sanitized).toContain('api key: [REDACTED]')
    assert.equal(sanitized.includes('placeholder'), false)
  })
})
