import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const SESSION_HOOK_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useAppSessionOrchestration.ts'), 'utf8')
const SESSION_CHAT_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/lib/sessionChatState.ts'), 'utf8')
const SESSION_HELPERS_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/lib/sessionEntryHelpers.ts'), 'utf8')

describe('wave 30 session orchestration extraction', () => {
  test('App delegates session and file open flows to modules', () => {
    expect(APP_SOURCE).toContain("from './hooks/useAppSessionOrchestration'")
    expect(APP_SOURCE).toContain('useAppSessionOrchestration(')
    expect(APP_SOURCE).toContain('openSessionInChat')
    expect(APP_SOURCE).toContain('handleOpenFile')
    expect(APP_SOURCE).not.toContain('const openSessionInChat = useCallback')
    expect(APP_SOURCE).not.toContain('const handleOpenFile = useCallback')
    expect(APP_SOURCE).not.toContain('const resolveWorkspaceForSession = useCallback')
    expect(APP_SOURCE).not.toContain('pendingSessionOpen')
    expect(APP_SOURCE).not.toContain('INITIAL_EXTERNAL_SESSION_TAIL_LOAD')
  })

  test('extracted modules own session orchestration logic', () => {
    expect(SESSION_HOOK_SOURCE).toContain('export function useAppSessionOrchestration')
    expect(SESSION_HOOK_SOURCE).toContain('openSessionInChatCurrentWorkspace')
    expect(SESSION_HOOK_SOURCE).toContain('openDaemonTask')
    expect(SESSION_HOOK_SOURCE).toContain('pendingSessionOpen')
    expect(SESSION_CHAT_SOURCE).toContain('export function buildNextChatTileRuntimeState')
    expect(SESSION_HELPERS_SOURCE).toContain('export function findMatchingChatTileIdForSession')
  })
})