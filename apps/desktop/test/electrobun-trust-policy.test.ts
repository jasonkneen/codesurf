import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  authorizeElectrobunFsPath,
  authorizeElectrobunTerminalPath,
  buildElectrobunClaudeSpawnArgs,
  buildElectrobunCodexSpawnArgs,
  buildElectrobunHermesSpawnArgs,
  buildElectrobunPersonaPrompt,
  canonicalizeElectrobunChatRequest,
  composeElectrobunProviderContext,
  prepareElectrobunChatRequest,
} from '../electrobun/bun/trust-policy.ts'
import { CODESURF_HOME } from '../src/main/paths.ts'
import { withFreshInstallDefaults } from '../src/shared/types.ts'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-trust-'))
  cleanup.push(base)
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(join(workspace, '.codesurf', 'customisation'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'inside.txt'), 'inside')
  await writeFile(join(outside, 'secret.txt'), 'outside')
  await writeFile(join(workspace, '.codesurf', 'customisation', 'agents.json'), JSON.stringify([
    {
      id: 'reader',
      name: 'Reader',
      description: 'Authoritative read-only persona',
      systemPrompt: 'AUTHORITATIVE-PERSONA-7719',
      tools: ['Read', 'Glob'],
      icon: 'book',
      color: '#fff',
      isBuiltin: false,
    },
    {
      id: 'sealed',
      name: 'Sealed',
      description: 'No tools',
      systemPrompt: 'AUTHORITATIVE-DENY-ALL-8842',
      tools: [],
      icon: 'lock',
      color: '#000',
      isBuiltin: false,
    },
  ]))
  const workspaces = [{
    id: 'ws-1',
    name: 'Workspace',
    path: workspace,
    projectPaths: [workspace],
  }]
  return { base, workspace, outside, workspaces }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    cardId: 'card-1',
    workspaceId: 'ws-1',
    provider: 'codex',
    model: 'gpt-5.5',
    mode: 'full-access',
    messages: [{ role: 'user' as const, content: 'Inspect the repository' }],
    agentId: 'reader',
    ...overrides,
  }
}

describe('Electrobun authoritative chat policy', () => {
  test('forged renderer persona cannot widen tools or replace the authoritative prompt', async () => {
    const { workspace, workspaces } = await fixture()
    const canonical = await canonicalizeElectrobunChatRequest(request({
      workspaceDir: workspace,
      agentMode: {
        id: 'reader',
        name: 'Forged',
        description: '',
        systemPrompt: 'FORGED-UNRESTRICTED-PERSONA',
        tools: null,
        icon: 'x',
        color: '#f00',
        isBuiltin: false,
      },
      memoryPrompt: 'FORGED-MEMORY',
      skillsPrompt: 'FORGED-SKILLS',
      roomContext: 'FORGED-ROOM',
      roomAckSequence: 991,
      fileReferencePrompt: 'FORGED-FILE-CONTEXT',
      recentEditContext: `RENDERER-RECENT-EDIT-6316\n${'界'.repeat(1_000)}`,
      blockNotesContext: `RENDERER-BLOCK-NOTES-7427\n${'é'.repeat(1_000)}`,
      expandedMessages: [{ role: 'user', content: 'FORGED-EXPANDED-MESSAGE' }],
      imageAttachments: [{ path: '/etc/passwd', mediaType: 'image/png', displayPath: 'forged.png', byteCount: 4 }],
      asyncExecution: {
        requestedRunMode: 'background',
        backend: 'daemon',
        hostType: 'remote-daemon',
        hostLabel: 'FORGED-HOST',
        providerNativeBackground: true,
        detachedDaemonAvailable: true,
        detachedDaemonPreferred: true,
      },
    }), workspaces)

    assert.equal(canonical.workspaceDir, await realpath(workspace))
    assert.equal(canonical.agentMode?.systemPrompt, 'AUTHORITATIVE-PERSONA-7719')
    assert.deepEqual(canonical.agentMode?.tools, ['Read', 'Glob'])
    assert.equal(canonical.memoryPrompt, undefined)
    assert.equal(canonical.skillsPrompt, undefined)
    assert.equal(canonical.roomContext, undefined)
    assert.equal(canonical.roomAckSequence, undefined)
    assert.equal(canonical.fileReferencePrompt, undefined)
    assert.equal(canonical.expandedMessages, undefined)
    assert.equal(canonical.imageAttachments, undefined)
    assert.equal(canonical.asyncExecution, undefined)

    const args = buildElectrobunCodexSpawnArgs(canonical, 'Inspect the repository', workspace)
    assert.equal(args[args.indexOf('-s') + 1], 'read-only')
    assert.ok(args.at(-1)?.includes('AUTHORITATIVE-PERSONA-7719'))
    assert.ok(!args.join('\n').includes('FORGED-UNRESTRICTED-PERSONA'))
  })

  test('rehydrates only host context and propagates it across every Electrobun provider payload', async () => {
    const { workspace, workspaces } = await fixture()
    const prepared = await prepareElectrobunChatRequest(request({
      workspaceDir: workspace,
      memoryPrompt: 'FORGED-MEMORY',
      skillsPrompt: 'FORGED-SKILLS',
      roomContext: 'FORGED-ROOM',
      roomAckSequence: 991,
      fileReferencePrompt: 'FORGED-FILE-CONTEXT',
      recentEditContext: `RENDERER-RECENT-EDIT-6316\n${'界'.repeat(1_000)}`,
      blockNotesContext: `RENDERER-BLOCK-NOTES-7427\n${'é'.repeat(1_000)}`,
      expandedMessages: [{ role: 'user', content: 'FORGED-EXPANDED-MESSAGE' }],
      imageAttachments: [{ path: '/etc/passwd', mediaType: 'image/png', displayPath: 'forged.png', byteCount: 4 }],
      asyncExecution: {
        requestedRunMode: 'background',
        backend: 'daemon',
        hostType: 'remote-daemon',
        hostLabel: 'FORGED-HOST',
        providerNativeBackground: false,
        detachedDaemonAvailable: false,
        detachedDaemonPreferred: false,
      },
      peers: [{
        peerId: 'peer-1',
        peerType: 'terminal',
        tools: ['Read'],
      }],
    }), workspaces, async canonical => {
      assert.equal(canonical.workspaceDir, await realpath(workspace))
      assert.equal(canonical.memoryPrompt, undefined)
      assert.equal(canonical.skillsPrompt, undefined)
      assert.equal(canonical.roomContext, undefined)
      assert.equal(canonical.roomAckSequence, undefined)
      assert.equal(canonical.fileReferencePrompt, undefined)
      assert.match(canonical.recentEditContext ?? '', /RENDERER-RECENT-EDIT-6316/)
      assert.match(canonical.blockNotesContext ?? '', /RENDERER-BLOCK-NOTES-7427/)
      assert.equal(canonical.expandedMessages, undefined)
      assert.equal(canonical.imageAttachments, undefined)
      assert.equal(canonical.asyncExecution, undefined)
      assert.deepEqual(canonical.peers, [{ peerId: 'peer-1', peerType: 'terminal', tools: [] }])
      assert.match(canonical.untrustedPeerContext ?? '', /peer-1/)
      return {
        memoryPrompt: 'TRUSTED-MEMORY-1041',
        skillsPrompt: 'TRUSTED-SKILLS-2082',
        skillsSummary: 'Trusted skills summary',
        roomContext: 'TRUSTED-ROOM-3123\nHOST-VALIDATED-PEER peer-1',
        roomAckSequence: 47,
        fileReferencePrompt: 'TRUSTED-FILE-CONTEXT-4194',
        expandedMessages: [{ role: 'user', content: 'TRUSTED-EXPANDED-MESSAGE-5205' }],
        imageAttachments: [{
          path: join(workspace, 'screenshot.png'),
          mediaType: 'image/png',
          displayPath: 'screenshot.png',
          byteCount: 4,
          device: '1',
          inode: '2',
        }],
        contextBuckets: { version: 1, includedBuckets: [], buckets: [] },
        asyncExecution: {
          requestedRunMode: 'background',
          backend: 'runtime',
          hostType: 'runtime',
          hostLabel: 'Electrobun Runtime',
          providerNativeBackground: true,
          detachedDaemonAvailable: true,
          detachedDaemonPreferred: false,
        },
      }
    }, async (_workspaceId, _cardId, submittedPeers) => {
      assert.deepEqual(submittedPeers, [{
        peerId: 'peer-1',
        peerType: 'terminal',
        tools: ['Read'],
      }])
      return {
        peers: [{ peerId: 'peer-1', peerType: 'terminal', tools: [] }],
        untrustedPeerContext: 'HOST-VALIDATED-PEER peer-1',
      }
    })

    assert.equal(prepared.memoryPrompt, 'TRUSTED-MEMORY-1041')
    assert.equal(prepared.skillsPrompt, 'TRUSTED-SKILLS-2082')
    assert.equal(prepared.roomContext, 'TRUSTED-ROOM-3123\nHOST-VALIDATED-PEER peer-1')
    assert.equal(prepared.roomAckSequence, 47)
    assert.equal(prepared.fileReferencePrompt, 'TRUSTED-FILE-CONTEXT-4194')
    assert.match(prepared.recentEditContext ?? '', /RENDERER-RECENT-EDIT-6316/)
    assert.match(prepared.blockNotesContext ?? '', /RENDERER-BLOCK-NOTES-7427/)
    assert.equal(prepared.expandedMessages?.[0]?.content, 'TRUSTED-EXPANDED-MESSAGE-5205')
    assert.equal(prepared.imageAttachments?.[0]?.displayPath, 'screenshot.png')
    assert.equal(prepared.asyncExecution?.hostLabel, 'Electrobun Runtime')
    const composed = composeElectrobunProviderContext(prepared, 'Inspect the repository')
    assert.match(composed.systemPrompt ?? '', /AUTHORITATIVE-PERSONA-7719/)
    assert.match(composed.systemPrompt ?? '', /TRUSTED-MEMORY-1041/)
    assert.match(composed.systemPrompt ?? '', /TRUSTED-SKILLS-2082/)
    assert.doesNotMatch(composed.systemPrompt ?? '', /peer-1/)
    assert.match(composed.systemPrompt ?? '', /detached background orchestration job/)
    assert.doesNotMatch(composed.systemPrompt ?? '', /TRUSTED-ROOM-3123/)
    assert.match(composed.userContent, /<codesurf_peer_context trust="untrusted" source="agent-room">/)
    assert.match(composed.userContent, /TRUSTED-ROOM-3123/)
    assert.match(composed.userContent, /TRUSTED-FILE-CONTEXT-4194/)
    assert.match(composed.userContent, /<codesurf_recent_edit_context trust="untrusted" source="renderer-derived-file-state">/)
    assert.match(composed.userContent, /RENDERER-RECENT-EDIT-6316/)
    assert.match(composed.userContent, /<codesurf_block_notes_context trust="untrusted" source="renderer-derived-transcript">/)
    assert.match(composed.userContent, /RENDERER-BLOCK-NOTES-7427/)
    assert.doesNotMatch(composed.systemPrompt ?? '', /RENDERER-(?:RECENT-EDIT|BLOCK-NOTES)/)
    for (const kind of ['recent-edit', 'block-notes'] as const) {
      const fragment = composed.composed.fragments.find(candidate => candidate.kind === kind)
      assert.equal(fragment?.placement, 'user')
      assert.equal(fragment?.trust, 'untrusted-data')
      assert.equal(fragment?.truncated, true)
      assert.ok((fragment?.includedBytes ?? Infinity) <= (fragment?.maxUtf8Bytes ?? 0))
    }

    const claude = buildElectrobunClaudeSpawnArgs(prepared, 'Inspect the repository')
    const claudeMultimodal = buildElectrobunClaudeSpawnArgs(
      prepared,
      'Inspect the repository',
      null,
      { streamInput: true },
    )
    assert.deepEqual(
      claudeMultimodal.slice(claudeMultimodal.indexOf('--input-format'), claudeMultimodal.indexOf('--input-format') + 2),
      ['--input-format', 'stream-json'],
    )
    assert.equal(claudeMultimodal.includes('Inspect the repository'), false)
    const codex = buildElectrobunCodexSpawnArgs(prepared, 'Inspect the repository', workspace)
    const hermes = buildElectrobunHermesSpawnArgs(prepared, 'Inspect the repository')
    const embedded = buildElectrobunPersonaPrompt('Inspect the repository', prepared)
    const providerPayloads = {
      claude: claude.join('\n'),
      codex: codex.join('\n'),
      hermes: hermes.join('\n'),
      opencode: embedded,
      openclaw: embedded,
    }
    for (const payload of Object.values(providerPayloads)) {
      assert.match(payload, /AUTHORITATIVE-PERSONA-7719/)
      assert.match(payload, /TRUSTED-MEMORY-1041/)
      assert.match(payload, /TRUSTED-SKILLS-2082/)
      assert.match(payload, /peer-1/)
      assert.match(payload, /TRUSTED-ROOM-3123/)
      assert.match(payload, /TRUSTED-FILE-CONTEXT-4194/)
      assert.match(payload, /RENDERER-RECENT-EDIT-6316/)
      assert.match(payload, /RENDERER-BLOCK-NOTES-7427/)
      assert.match(payload, /detached background orchestration job/)
      assert.doesNotMatch(payload, /FORGED-(?:MEMORY|SKILLS|ROOM|HOST|FILE|EXPANDED)/)
    }
  })

  test('Codex installs stable context on the first turn and sends only fresh dynamic context when resumed', async () => {
    const { workspace, workspaces } = await fixture()
    const canonical = await canonicalizeElectrobunChatRequest(request({ workspaceDir: workspace }), workspaces)
    const firstRequest = {
      ...canonical,
      memoryPrompt: 'STABLE-MEMORY-8538',
      roomContext: 'FIRST-ROOM-9649',
      fileReferencePrompt: 'FIRST-FILE-0750',
      recentEditContext: 'FIRST-RECENT-1861',
      blockNotesContext: 'FIRST-NOTES-2972',
      asyncExecution: {
        requestedRunMode: 'foreground' as const,
        backend: 'runtime' as const,
        hostType: 'runtime' as const,
        hostLabel: 'FIRST-ELECTROBUN-HOST-6417',
        providerNativeBackground: true,
        detachedDaemonAvailable: true,
        detachedDaemonPreferred: false,
      },
    }
    const resumedRequest = {
      ...firstRequest,
      roomContext: 'SECOND-ROOM-3083',
      fileReferencePrompt: 'SECOND-FILE-4194',
      recentEditContext: 'SECOND-RECENT-5205',
      blockNotesContext: 'SECOND-NOTES-6316',
      asyncExecution: {
        ...firstRequest.asyncExecution,
        hostLabel: 'SECOND-ELECTROBUN-HOST-7528',
      },
    }

    const firstPrompt = buildElectrobunCodexSpawnArgs(
      firstRequest,
      'First user turn',
      workspace,
    ).at(-1) ?? ''
    assert.match(firstPrompt, /AUTHORITATIVE-PERSONA-7719/)
    assert.match(firstPrompt, /STABLE-MEMORY-8538/)
    assert.match(firstPrompt, /FIRST-ROOM-9649/)
    assert.match(firstPrompt, /FIRST-RECENT-1861/)
    assert.match(firstPrompt, /FIRST-ELECTROBUN-HOST-6417/)

    const resumedArgs = buildElectrobunCodexSpawnArgs(
      resumedRequest,
      'Second user turn',
      workspace,
      'thread-7427',
    )
    const resumedPrompt = resumedArgs.at(-1) ?? ''
    assert.equal(resumedArgs[resumedArgs.indexOf('resume') + 1], 'thread-7427')
    assert.doesNotMatch(resumedPrompt, /AUTHORITATIVE-PERSONA-7719|STABLE-MEMORY-8538/)
    assert.match(resumedPrompt, /SECOND-ROOM-3083/)
    assert.match(resumedPrompt, /SECOND-FILE-4194/)
    assert.match(resumedPrompt, /SECOND-RECENT-5205/)
    assert.match(resumedPrompt, /SECOND-NOTES-6316/)
    assert.match(resumedPrompt, /SECOND-ELECTROBUN-HOST-7528/)
    assert.doesNotMatch(resumedPrompt, /FIRST-ELECTROBUN-HOST-6417/)
    assert.doesNotMatch(resumedPrompt, /FIRST-(?:ROOM|FILE|RECENT|NOTES)/)

    const claudeResumed = buildElectrobunClaudeSpawnArgs(
      resumedRequest,
      'Second user turn',
      'claude-session-1',
    ).join('\n')
    const hermesResumed = buildElectrobunHermesSpawnArgs(
      resumedRequest,
      'Second user turn',
      'hermes-session-1',
    ).join('\n')
    for (const payload of [claudeResumed, hermesResumed]) {
      assert.match(payload, /AUTHORITATIVE-PERSONA-7719/)
      assert.match(payload, /STABLE-MEMORY-8538/)
      assert.match(payload, /SECOND-RECENT-5205/)
      assert.match(payload, /SECOND-NOTES-6316/)
    }
  })

  test('unknown workspace, mismatched cwd, and unknown agent fail closed', async () => {
    const { outside, workspace, workspaces } = await fixture()
    await assert.rejects(
      canonicalizeElectrobunChatRequest(request({ workspaceId: 'missing' }), workspaces),
      /Workspace not found: missing/,
    )
    await assert.rejects(
      canonicalizeElectrobunChatRequest(request({ workspaceDir: outside }), workspaces),
      /workspaceDir does not match/,
    )
    await assert.rejects(
      canonicalizeElectrobunChatRequest(request({ workspaceDir: workspace, agentId: 'missing-agent' }), workspaces),
      /selected agent could not be verified/i,
    )
  })

  test('provider payloads enforce restricted and deny-all personas before spawn', async () => {
    const { workspace, workspaces } = await fixture()
    const reader = await canonicalizeElectrobunChatRequest(
      request({ workspaceDir: workspace, provider: 'claude' }),
      workspaces,
    )
    const claudeArgs = buildElectrobunClaudeSpawnArgs(reader, 'Inspect the repository')
    assert.equal(claudeArgs[claudeArgs.indexOf('--tools') + 1], 'Read,Glob')
    const claudeSystemPrompt = claudeArgs[claudeArgs.indexOf('--append-system-prompt') + 1]
    assert.match(claudeSystemPrompt, /AUTHORITATIVE-PERSONA-7719/)
    assert.match(claudeSystemPrompt, /CodeSurf Task-Completion Convention/)

    const sealed = await canonicalizeElectrobunChatRequest(
      request({ workspaceDir: workspace, provider: 'hermes', agentId: 'sealed' }),
      workspaces,
    )
    const hermesArgs = buildElectrobunHermesSpawnArgs(sealed, 'Do nothing')
    assert.equal(hermesArgs.includes('--toolsets'), false)
    assert.ok(hermesArgs.join('\n').includes('AUTHORITATIVE-DENY-ALL-8842'))

    await assert.rejects(
      canonicalizeElectrobunChatRequest(
        request({ workspaceDir: workspace, provider: 'codex', agentId: 'sealed' }),
        workspaces,
      ),
      /cannot enforce persona sealed/,
    )
    await assert.rejects(
      canonicalizeElectrobunChatRequest(
        request({ workspaceDir: workspace, provider: 'opencode' }),
        workspaces,
      ),
      /cannot enforce persona reader/,
    )
  })
})

describe('Electrobun workspace path authority', () => {
  test('allows in-root access and rejects traversal, outside roots, and missing workspace scope', async () => {
    const { workspace, outside, workspaces } = await fixture()
    const authority = { settings: withFreshInstallDefaults(), workspaces }
    const inside = await authorizeElectrobunFsPath({
      ...authority,
      filePath: join(workspace, 'inside.txt'),
      intent: 'read',
      workspaceId: 'ws-1',
    })
    assert.equal(inside.path.operationPath, await realpath(join(workspace, 'inside.txt')))

    for (const attemptedPath of [
      join(workspace, '..', 'outside', 'secret.txt'),
      join(outside, 'secret.txt'),
    ]) {
      await assert.rejects(
        authorizeElectrobunFsPath({
          ...authority,
          filePath: attemptedPath,
          intent: 'read',
          workspaceId: 'ws-1',
        }),
        /outside allowed workspace roots/,
      )
    }
    await assert.rejects(
      authorizeElectrobunFsPath({
        ...authority,
        filePath: join(workspace, 'inside.txt'),
        intent: 'read',
      }),
      /workspaceId is required/,
    )
    await assert.rejects(
      authorizeElectrobunFsPath({
        ...authority,
        filePath: join(workspace, 'inside.txt'),
        intent: 'read',
        workspaceId: 'missing',
      }),
      /workspace not found/,
    )
  })

  test('rejects file and directory symlink escapes for reads, writes, reveal, and watch', async () => {
    const { workspace, outside, workspaces } = await fixture()
    const authority = { settings: withFreshInstallDefaults(), workspaces }
    await symlink(join(outside, 'secret.txt'), join(workspace, 'linked-secret.txt'))
    await symlink(outside, join(workspace, 'linked-directory'))

    for (const attempt of [
      { filePath: join(workspace, 'linked-secret.txt'), intent: 'read' as const },
      { filePath: join(workspace, 'linked-directory'), intent: 'directory' as const },
      { filePath: join(workspace, 'linked-directory', 'created.txt'), intent: 'create' as const },
    ]) {
      await assert.rejects(
        authorizeElectrobunFsPath({
          ...authority,
          ...attempt,
          workspaceId: 'ws-1',
        }),
        /symbolic link|outside allowed workspace roots/,
      )
    }
  })

  test('preserves scoped CodeSurf home access and scopes terminal cwd to registered roots', async () => {
    const { workspace, outside, workspaces } = await fixture()
    const authority = { settings: withFreshInstallDefaults(), workspaces }
    const appState = await authorizeElectrobunFsPath({
      ...authority,
      filePath: join(CODESURF_HOME, 'electrobun-policy-probe.json'),
      intent: 'create',
      workspaceId: 'ws-1',
    })
    assert.ok(appState.path.operationPath.startsWith(CODESURF_HOME))
    const emptyWorkspaceAppState = await authorizeElectrobunFsPath({
      settings: authority.settings,
      workspaces: [{ id: 'ws-empty', name: 'Empty', path: '', projectPaths: [] }],
      filePath: join(CODESURF_HOME, 'electrobun-empty-workspace-probe.json'),
      intent: 'create',
      workspaceId: 'ws-empty',
    })
    assert.ok(emptyWorkspaceAppState.path.operationPath.startsWith(CODESURF_HOME))

    const terminal = await authorizeElectrobunTerminalPath({
      ...authority,
      filePath: workspace,
    })
    assert.equal(terminal.workspaceId, 'ws-1')
    assert.equal(terminal.path.operationPath, await realpath(workspace))
    await assert.rejects(
      authorizeElectrobunTerminalPath({ ...authority, filePath: outside }),
      /outside registered workspace roots/,
    )
  })
})
