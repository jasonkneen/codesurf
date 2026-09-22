import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import { withDefaultSettings } from '../src/shared/types.ts'
import { resolveProviderModeId } from '../src/renderer/src/config/providers.ts'

describe('chat mode preferences', () => {
  test('settings preserve the last selected provider permission mode', () => {
    const settings = withDefaultSettings({
      chatProviderModes: {
        claude: 'bypassPermissions',
        codex: 'full-access',
        blank: '',
        spaced: '  plan  ',
      },
    })

    expect(settings.chatProviderModes.claude).toBe('bypassPermissions')
    expect(settings.chatProviderModes.codex).toBe('full-access')
    expect(settings.chatProviderModes.spaced).toBe('plan')
    expect(settings.chatProviderModes.blank).toBeUndefined()
  })

  test('settings ignore malformed chat mode preference shapes', () => {
    const settings = withDefaultSettings({
      chatProviderModes: ['bypassPermissions'],
    } as never)

    expect(settings.chatProviderModes).toEqual({})
  })

  test('provider mode resolution keeps valid preferences and falls back per provider', () => {
    expect(resolveProviderModeId('claude', 'bypassPermissions')).toBe('bypassPermissions')
    expect(resolveProviderModeId('codex', 'full-access')).toBe('full-access')
    expect(resolveProviderModeId('claude', 'full-access')).toBe('default')
    expect(resolveProviderModeId('opencode', null)).toBe('default')
    expect(resolveProviderModeId('custom-extension', null)).toBe('proxy')
  })
})
