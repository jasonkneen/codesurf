/**
 * Generation-providers settings section — extracted from SettingsPanel's
 * `case 'providers'` render closure (A1 god-object split). theme/fonts come
 * from context; provider state + callbacks arrive via props. Types live here
 * (the leaf) and are re-imported by SettingsPanel.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Type, RefreshCw, Eye, EyeOff, Image as ImageIcon, Video, Bot } from 'lucide-react'
import { DEFAULT_SETTINGS } from '../../../../shared/types'
import type { GenerationProviderSettings } from '../../../../shared/types'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { SectionLabel, SettingRow, Toggle } from './controls'

export type ProviderModelOption = {
  id: string
  name: string
  label: string
  methods: string[]
  capabilities: Array<'image' | 'video' | 'text'>
}

export type ProviderValidationResult = {
  ok: boolean
  providerId: string
  message: string
  models: ProviderModelOption[]
  textModels: ProviderModelOption[]
  imageModels: ProviderModelOption[]
  videoModels: ProviderModelOption[]
}

export interface ProvidersSectionProps {
  settings: import('../../../../shared/types').AppSettings
  updateGenerationProvider: (providerId: string, patch: Partial<GenerationProviderSettings>) => void
  updateSettingsPatch: (patch: Partial<import('../../../../shared/types').AppSettings>) => void
  visibleProviderKeys: Record<string, boolean>
  setVisibleProviderKeys: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  providerValidation: Record<string, ProviderValidationResult | { loading: true }>
  validateProvider: (provider: GenerationProviderSettings) => void | Promise<void>
}

const GATEWAY_SECRET_NAME = 'ai-gateway'

/**
 * API key card for the AI Gateway chat provider. The key persists in the
 * encrypted secrets store (never settings.json); the renderer only ever
 * learns whether a key is set, never its value.
 */
function GatewayKeyCard({ inputStyle, labelStyle }: {
  inputStyle: React.CSSProperties
  labelStyle: React.CSSProperties
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hasKey, setHasKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  useEffect(() => {
    // Guard `.has` too, not just `secrets`: on the web/Native bridge `secrets`
    // is a synthesized Proxy that is truthy but has no real methods.
    const sec = window.electron?.secrets
    if (!sec?.has) return
    void Promise.resolve(sec.has(GATEWAY_SECRET_NAME))
      .then(r => setHasKey(Boolean(r?.has)))
      .catch(() => setHasKey(false))
  }, [])

  // Keep the handle so a second flash cannot be blanked early by the first
  // one's timer, and so nothing fires after unmount (switching settings
  // section unmounts this card).
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
  }, [])

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => setStatusMsg(null), 2200)
  }

  /**
   * Secure storage is Electron-only. The web/Native bridge synthesizes a
   * truthy `secrets` Proxy whose methods resolve `undefined`, so a bare
   * `if (!sec) return` passes and `r.ok` then throws a TypeError into an
   * unhandled rejection — the user saw no error and no saved key, while the
   * card claimed the key was stored encrypted. Report it instead.
   */
  const secretsUnavailable = 'Secure storage is unavailable on this platform — set AI_GATEWAY_API_KEY in the environment instead.'

  const saveKey = async (): Promise<void> => {
    const sec = window.electron?.secrets
    if (!sec?.set) { flashStatus(secretsUnavailable); return }
    setBusy(true)
    try {
      const value = keyInput.trim()
      const r = await sec.set(GATEWAY_SECRET_NAME, value)
      if (r?.ok) {
        setKeyInput('')
        setHasKey(value.length > 0)
        flashStatus(value ? 'AI Gateway key saved' : 'AI Gateway key cleared')
      } else {
        flashStatus(`Save failed: ${r?.error || secretsUnavailable}`)
      }
    } catch (err) {
      flashStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    const sec = window.electron?.secrets
    if (!sec?.delete) { flashStatus(secretsUnavailable); return }
    setBusy(true)
    try {
      await sec.delete(GATEWAY_SECRET_NAME)
      setHasKey(false)
      flashStatus('AI Gateway key cleared')
    } catch (err) {
      flashStatus(`Clear failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const buttonStyle: React.CSSProperties = {
    padding: '7px 12px',
    borderRadius: 8,
    fontSize: fonts.secondarySize,
    fontWeight: 600,
    border: `1px solid ${theme.border.default}`,
    background: theme.surface.input,
    color: theme.text.secondary,
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.7 : 1,
    flexShrink: 0,
  }

  return (
    <div
      style={{
        background: theme.surface.panelMuted,
        border: `1px solid ${hasKey ? theme.accent.base : theme.border.subtle}`,
        borderRadius: 10,
        padding: 14,
        marginBottom: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Bot size={14} />
        <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 700 }}>AI Gateway</span>
        <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: hasKey ? theme.accent.base : theme.text.disabled }}>
          {hasKey ? 'Key configured' : 'No key set'}
        </span>
      </div>
      <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, lineHeight: 1.4 }}>
        One key unlocks every gateway model (Anthropic, OpenAI, Google, xAI, …) for AI Gateway chat blocks. Get a key at vercel.com → AI Gateway. Stored encrypted on this machine.
      </div>
      <div>
        <div style={labelStyle}>API key</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            placeholder={hasKey ? 'Enter a new key to replace the saved one' : 'vck_…'}
            autoComplete="off"
            spellCheck={false}
            style={inputStyle}
          />
          <button
            type="button"
            onClick={() => setShowKey(prev => !prev)}
            title={showKey ? 'Hide key' : 'Show key'}
            style={{ ...buttonStyle, width: 34, height: 34, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button type="button" disabled={busy || !keyInput.trim()} onClick={() => void saveKey()} style={buttonStyle}>
            Save
          </button>
          {hasKey && (
            <button type="button" disabled={busy} onClick={() => void clearKey()} style={buttonStyle}>
              Clear
            </button>
          )}
        </div>
        {statusMsg && (
          <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.accent.base, marginTop: 6 }}>
            {statusMsg}
          </div>
        )}
      </div>
    </div>
  )
}

export function ProvidersSection(props: ProvidersSectionProps): React.JSX.Element {
  const {
    settings,
    updateGenerationProvider,
    updateSettingsPatch,
    visibleProviderKeys,
    setVisibleProviderKeys,
    providerValidation,
    validateProvider,
  } = props
  const theme = useTheme()
  const fonts = useAppFonts()

        const generationProviders = Object.values(settings.generationProviders ?? {})
        const providerOrder = ['gemini', 'anthropic', 'openrouter', 'openai', 'replicate', 'runway', 'luma', 'stability', 'local']
        const sortedProviders = generationProviders.sort((a, b) => {
          const ai = providerOrder.indexOf(a.id)
          const bi = providerOrder.indexOf(b.id)
          if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
          return a.label.localeCompare(b.label)
        })
        const inputStyle: React.CSSProperties = {
          width: '100%',
          minWidth: 0,
          padding: '7px 9px',
          fontSize: fonts.secondarySize,
          background: theme.surface.input,
          color: theme.text.secondary,
          border: `1px solid ${theme.border.default}`,
          borderRadius: 8,
          outline: 'none',
          fontFamily: fonts.mono,
        }
        const labelStyle: React.CSSProperties = {
          fontSize: Math.max(10, fonts.secondarySize - 1),
          color: theme.text.disabled,
          marginBottom: 5,
        }
        return (
          <>
            <SectionLabel label="Chat Providers" />
            <GatewayKeyCard inputStyle={inputStyle} labelStyle={labelStyle} />
            <SectionLabel label="Generation Providers" />
            <div style={{ background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`, borderRadius: 10, padding: '12px 16px', marginBottom: 10 }}>
              <div style={{ fontSize: fonts.size, color: theme.text.secondary, lineHeight: 1.45 }}>
                These keys are for canvas image and video tools. Connected blocks can request edits or generations against an enabled provider, then replace the image or media source when the file is ready.
              </div>
              <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, marginTop: 6 }}>
                Keys are stored in the local CodeSurf settings file on this machine.
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
              {sortedProviders.map(provider => {
                const capabilities = new Set(provider.capabilities ?? [])
                const showKey = visibleProviderKeys[provider.id] ?? false
                const validation = providerValidation[provider.id]
                const validationLoading = validation && 'loading' in validation
                const validationResult = validation && !('loading' in validation) ? validation : null
                const textModelOptions = validationResult?.textModels ?? []
                const imageModelOptions = validationResult?.imageModels ?? []
                const videoModelOptions = validationResult?.videoModels ?? []
                const allModelOptions = validationResult?.models ?? []
                const textListId = `provider-${provider.id}-text-models`
                const imageListId = `provider-${provider.id}-image-models`
                const videoListId = `provider-${provider.id}-video-models`
                return (
                  <div
                    key={provider.id}
                    style={{
                      background: theme.surface.panelMuted,
                      border: `1px solid ${provider.enabled ? theme.accent.base : theme.border.subtle}`,
                      borderRadius: 10,
                      padding: 14,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 700 }}>{provider.label}</span>
                          {capabilities.has('image') && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: theme.text.muted, background: theme.surface.input, borderRadius: 999, padding: '3px 7px' }}>
                              <ImageIcon size={11} />
                              image
                            </span>
                          )}
                          {capabilities.has('text') && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: theme.text.muted, background: theme.surface.input, borderRadius: 999, padding: '3px 7px' }}>
                              <Type size={11} />
                              text
                            </span>
                          )}
                          {capabilities.has('video') && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: theme.text.muted, background: theme.surface.input, borderRadius: 999, padding: '3px 7px' }}>
                              <Video size={11} />
                              video
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 4 }}>
                          {provider.id}
                        </div>
                      </div>
                      <Toggle value={provider.enabled} onChange={enabled => updateGenerationProvider(provider.id, { enabled })} />
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => validateProvider(provider)}
                        disabled={Boolean(validationLoading)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 10px',
                          borderRadius: 8,
                          fontSize: fonts.secondarySize,
                          fontWeight: 600,
                          border: `1px solid ${theme.border.default}`,
                          background: theme.surface.input,
                          color: theme.text.secondary,
                          cursor: validationLoading ? 'default' : 'pointer',
                          opacity: validationLoading ? 0.7 : 1,
                        }}
                      >
                        <RefreshCw size={13} />
                        {validationLoading ? 'Checking...' : 'Validate key'}
                      </button>
                      {validationResult ? (
                        <div
                          style={{
                            flex: 1,
                            minWidth: 180,
                            fontSize: Math.max(10, fonts.secondarySize - 1),
                            color: validationResult.ok ? theme.accent.base : '#ff9b8b',
                            lineHeight: 1.35,
                          }}
                        >
                          {validationResult.message}
                        </div>
                      ) : null}
                    </div>

                    {provider.id !== 'local' && (
                      <div>
                        <div style={labelStyle}>API key</div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input
                            type={showKey ? 'text' : 'password'}
                            value={provider.apiKey ?? ''}
                            onChange={e => updateGenerationProvider(provider.id, { apiKey: e.target.value })}
                            placeholder={`${provider.label} API key`}
                            autoComplete="off"
                            spellCheck={false}
                            style={inputStyle}
                          />
                          <button
                            type="button"
                            onClick={() => setVisibleProviderKeys(prev => ({ ...prev, [provider.id]: !showKey }))}
                            title={showKey ? 'Hide key' : 'Show key'}
                            style={{
                              width: 34,
                              height: 34,
                              borderRadius: 8,
                              border: `1px solid ${theme.border.default}`,
                              background: theme.surface.input,
                              color: theme.text.secondary,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              flexShrink: 0,
                            }}
                          >
                            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      </div>
                    )}

                    {capabilities.has('text') && (
                      <div>
                        <div style={labelStyle}>Default text model</div>
                        <input
                          type="text"
                          value={provider.textModel ?? ''}
                          onChange={e => updateGenerationProvider(provider.id, { textModel: e.target.value })}
                          placeholder={provider.id === 'anthropic' ? 'claude-sonnet-4-20250514' : provider.id === 'openrouter' ? 'openrouter/auto' : 'Provider model id'}
                          list={textModelOptions.length ? textListId : undefined}
                          spellCheck={false}
                          style={inputStyle}
                        />
                        {textModelOptions.length ? (
                          <datalist id={textListId}>
                            {textModelOptions.map(model => <option key={model.name || model.id} value={model.id}>{model.label}</option>)}
                          </datalist>
                        ) : null}
                      </div>
                    )}

                    {capabilities.has('image') && (
                      <div>
                        <div style={labelStyle}>Default image model</div>
                        <input
                          type="text"
                          value={provider.imageModel ?? ''}
                          onChange={e => updateGenerationProvider(provider.id, { imageModel: e.target.value })}
                          placeholder={provider.id === 'gemini' ? 'gemini-2.5-flash-image' : 'Provider model id'}
                          list={imageModelOptions.length ? imageListId : undefined}
                          spellCheck={false}
                          style={inputStyle}
                        />
                        {imageModelOptions.length ? (
                          <datalist id={imageListId}>
                            {imageModelOptions.map(model => <option key={model.name || model.id} value={model.id}>{model.label}</option>)}
                          </datalist>
                        ) : null}
                      </div>
                    )}

                    {capabilities.has('video') && (
                      <div>
                        <div style={labelStyle}>Default video model</div>
                        <input
                          type="text"
                          value={provider.videoModel ?? ''}
                          onChange={e => updateGenerationProvider(provider.id, { videoModel: e.target.value })}
                          placeholder={provider.id === 'gemini' ? 'veo-3.1-generate-preview' : 'Provider model id'}
                          list={videoModelOptions.length ? videoListId : undefined}
                          spellCheck={false}
                          style={inputStyle}
                        />
                        {videoModelOptions.length ? (
                          <datalist id={videoListId}>
                            {videoModelOptions.map(model => <option key={model.name || model.id} value={model.id}>{model.label}</option>)}
                          </datalist>
                        ) : null}
                      </div>
                    )}

                    {provider.id === 'gemini' && capabilities.has('video') && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <div>
                          <div style={labelStyle}>Video aspect</div>
                          <select
                            value={provider.videoAspectRatio ?? '16:9'}
                            onChange={e => updateGenerationProvider(provider.id, { videoAspectRatio: e.target.value })}
                            style={inputStyle}
                          >
                            <option value="16:9">16:9 landscape</option>
                            <option value="9:16">9:16 portrait</option>
                          </select>
                        </div>
                        <div>
                          <div style={labelStyle}>Video resolution</div>
                          <select
                            value={provider.videoResolution ?? '720p'}
                            onChange={e => updateGenerationProvider(provider.id, { videoResolution: e.target.value })}
                            style={inputStyle}
                          >
                            <option value="720p">720p</option>
                            <option value="1080p">1080p</option>
                            <option value="4k">4k</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {validationResult?.ok && allModelOptions.length ? (
                      <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, lineHeight: 1.35 }}>
                        {allModelOptions.length} accessible models listed. Image and video fields above will autocomplete with compatible models where the API exposes that metadata.
                      </div>
                    ) : null}

                    {(provider.id === 'local' || provider.baseUrl !== undefined) && (
                      <div>
                        <div style={labelStyle}>Base URL</div>
                        <input
                          type="text"
                          value={provider.baseUrl ?? ''}
                          onChange={e => updateGenerationProvider(provider.id, { baseUrl: e.target.value })}
                          placeholder="http://localhost:8188 or compatible endpoint"
                          spellCheck={false}
                          style={inputStyle}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <SettingRow label="Reset providers" description="Restore the built-in provider list while keeping unrelated settings untouched.">
              <button
                type="button"
                onClick={() => updateSettingsPatch({ generationProviders: DEFAULT_SETTINGS.generationProviders })}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  fontSize: fonts.secondarySize,
                  fontWeight: 600,
                  border: `1px solid ${theme.border.default}`,
                  background: theme.surface.input,
                  color: theme.text.secondary,
                  cursor: 'pointer',
                }}
              >
                Reset list
              </button>
            </SettingRow>
          </>
        )
}
