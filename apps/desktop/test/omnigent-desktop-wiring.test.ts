import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { expect } from './node-expect.ts'
import {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  PROVIDER_MODES,
  isBuiltinProvider,
} from '../src/renderer/src/config/providers.ts'
import {
  DEFAULT_SETTINGS,
  withDefaultSettings,
  type AppSettings,
} from '../src/shared/types.ts'

describe('Omnigent desktop provider wiring', () => {
  test('exposes Omnigent as a built-in provider with a default agent option', () => {
    expect(isBuiltinProvider('omnigent')).toBe(true)
    expect(PROVIDER_LABELS.omnigent).toBe('Omnigent')
    expect(DEFAULT_MODELS.omnigent[0]).toEqual({
      id: 'omnigent:default',
      label: 'Default agent',
      description: 'Configured/default Omnigent agent',
    })
    expect(PROVIDER_MODES.omnigent[0].id).toBe('default')
  })

  test('normalizes AppSettings.omnigent with daemon-compatible defaults', () => {
    expect(DEFAULT_SETTINGS.omnigent).toEqual({
      enabled: true,
      baseUrl: 'http://127.0.0.1:6767',
      apiKey: '',
      agentId: '',
      autoStart: true,
    })

    const settings = withDefaultSettings({
      omnigent: {
        enabled: false,
        apiKey: 'token',
      },
    } as unknown as Partial<AppSettings>)

    expect(settings.omnigent).toEqual({
      enabled: false,
      baseUrl: 'http://127.0.0.1:6767',
      apiKey: 'token',
      agentId: '',
      autoStart: true,
    })
  })

  test('main process forwards Omnigent settings in daemon job-start payloads', () => {
    const source = readFileSync(`${process.cwd()}/src/main/ipc/chat.ts`, 'utf8')

    expect(source).toContain("provider === 'omnigent'")
    expect(source).toContain('readSettingsSync().omnigent')
    expect(source).toContain('requestWithProviderSettings')
  })
})
