import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getExternalSessionChatState, isExternalSessionImportableInChat } from '../src/main/session-sources.ts'
import { getSessionOpenIntent } from '../src/renderer/src/components/sidebar/session-open.ts'

describe('external session chat openability', () => {
  test('treats hook-only/title-only external sessions as not chat-loadable', () => {
    expect(isExternalSessionImportableInChat(0, null)).toBe(false)
    expect(isExternalSessionImportableInChat(0, '')).toBe(false)
    expect(isExternalSessionImportableInChat(0, '   ')).toBe(false)

    expect(isExternalSessionImportableInChat(1, null)).toBe(true)
    expect(isExternalSessionImportableInChat(0, 'A real parsed transcript preview')).toBe(true)
  })

  test('sidebar does not route non-chat sessions into a blank chat tile', () => {
    expect(getSessionOpenIntent({ canOpenInChat: false, canOpenInApp: true, filePath: '/tmp/session.jsonl' })).toEqual({ kind: 'app' })
    expect(getSessionOpenIntent({ canOpenInChat: true, canOpenInApp: true, filePath: '/tmp/session.jsonl', messageCount: 0, lastMessage: null })).toEqual({ kind: 'app' })
    expect(getSessionOpenIntent({ canOpenInChat: false, canOpenInApp: false, filePath: '/tmp/session.jsonl' })).toEqual({ kind: 'file', persist: false })
    expect(getSessionOpenIntent({ canOpenInChat: true, canOpenInApp: true, filePath: '/tmp/session.jsonl' }, { persist: true })).toEqual({ kind: 'chat', persist: true })
  })

  test('loads modern Claude JSONL messages from message.content blocks', async () => {
    // Renderer-supplied entry hints are confined to real session roots, so
    // the fixture must live under a (temp) ~/.claude/projects dir — point
    // $HOME at a throwaway dir; os.homedir() honors it on POSIX.
    const home = await mkdtemp(join(tmpdir(), 'codesurf-claude-home-'))
    const projectDir = join(home, '.claude', 'projects', 'demo')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'session.jsonl')
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-23T15:00:00.000Z',
          sessionId: 'session',
          message: { role: 'user', content: [{ type: 'text', text: 'Why is this blank?' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-23T15:00:01.000Z',
          sessionId: 'session',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Because the parser missed nested content.' }] },
        }),
      ].join('\n'))

      const state = await getExternalSessionChatState('/tmp/workspace', `claude:${filePath}`, {
        entryHint: {
          id: `claude:${filePath}`,
          source: 'claude',
          filePath,
          sessionId: 'session',
          provider: 'claude',
          model: '',
          messageCount: 2,
          title: 'Claude session',
          projectPath: '/tmp/workspace',
        },
      })

      expect(state?.messages.map(message => message.content)).toEqual([
        'Why is this blank?',
        'Because the parser missed nested content.',
      ])
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })
})
