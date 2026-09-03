import type { AutoDreamSettings } from './dreaming-types.ts'
import type { ExecutionPreference } from './execution-types.ts'
import type { BuiltinTileType } from './types.ts'

// ─── Font Token System ──────────────────────────────────────────────────────
// VS Code-style granular font settings. Every token has family, size, lineHeight,
// weight, and letterSpacing. Users override only what they want in config.json.

export interface FontToken {
  family: string
  size: number
  lineHeight: number
  weight?: number
  letterSpacing?: number
}

/** Backward-compat alias */
export type FontConfig = FontToken

export interface FontSettings {
  /** Primary sans-serif — main UI text, headings, labels, chat messages */
  primary: FontToken
  /** Secondary sans-serif — metadata, subtitles, hints, smaller UI text */
  secondary: FontToken
  /** Monospace — terminal, code editor, inline code, data display */
  mono: FontToken

  // ── Legacy aliases (kept for backward compat with saved configs) ──
  /** @deprecated use primary */
  sans?: FontToken
  /** @deprecated use primary */
  title?: FontToken
  /** @deprecated use secondary */
  sectionLabel?: FontToken
  /** @deprecated use secondary */
  subtitle?: FontToken
  /** @deprecated use mono */
  terminal?: FontToken
  /** @deprecated use mono */
  codeEditor?: FontToken
  /** @deprecated use mono */
  inlineCode?: FontToken
  /** @deprecated use mono */
  commandPreview?: FontToken
  /** @deprecated use primary */
  chatMessage?: FontToken
  /** @deprecated use primary */
  chatInput?: FontToken
  /** @deprecated use secondary */
  chatToolbar?: FontToken
  /** @deprecated use mono */
  chatMeta?: FontToken
  /** @deprecated use mono */
  chatThinking?: FontToken
  /** @deprecated use primary */
  kanbanCardTitle?: FontToken
  /** @deprecated use secondary */
  kanbanBadge?: FontToken
  /** @deprecated use secondary */
  kanbanTab?: FontToken
  /** @deprecated use mono */
  dataUrl?: FontToken
  /** @deprecated use mono */
  dataPath?: FontToken
  /** @deprecated use mono */
  dataKeyValue?: FontToken
  /** @deprecated use mono */
  dataTimestamp?: FontToken
  /** @deprecated use mono */
  dataNumeric?: FontToken
  /** @deprecated use secondary */
  dataBadge?: FontToken
  /** @deprecated use secondary */
  button?: FontToken
  /** @deprecated use secondary */
  formLabel?: FontToken
  /** @deprecated use primary */
  formInput?: FontToken
  /** @deprecated use secondary */
  settingsHeader?: FontToken
  /** @deprecated use secondary */
  settingsLabel?: FontToken
}

// ── System font stacks ──────────────────────────────────────────────────────

// Bricolage Grotesque is the product's primary and secondary UI face. It ships
// bundled (src/renderer/src/assets/fonts) with an @font-face in index.css, so
// the rest of the stack is fallback-only and should not be reached.
const SANS_STACK = '"Bricolage Grotesque", "SF Pro Rounded", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
// Geist Mono is the default UI monospace; Nerd Font remains in the fallback
// stack so terminal tiles can still render PUA icon glyphs when installed.
const MONO_STACK = '"Geist Mono", "FiraCode Nerd Font Mono", ui-monospace, "SF Mono", "Menlo", "Monaco", "JetBrains Mono", "Fira Code", monospace'

// ── Default font tokens ─────────────────────────────────────────────────────

export const DEFAULT_FONTS: FontSettings = {
  primary:   { family: SANS_STACK, size: 13, lineHeight: 1.15, weight: 400 },
  secondary: { family: SANS_STACK, size: 13, lineHeight: 1.00, weight: 400 },
  mono:      { family: MONO_STACK, size: 13, lineHeight: 1.25, weight: 600 },
}

/** Migrate old granular FontSettings to the simplified 3-token shape */
export function normalizeFontSettings(raw: Partial<FontSettings> | undefined): FontSettings {
  if (!raw) return { ...DEFAULT_FONTS }
  return {
    primary:   raw.primary ?? raw.sans ?? raw.chatMessage ?? DEFAULT_FONTS.primary,
    secondary: raw.secondary ?? raw.subtitle ?? raw.sectionLabel ?? DEFAULT_FONTS.secondary,
    mono:      raw.mono ?? raw.terminal ?? raw.codeEditor ?? DEFAULT_FONTS.mono,
  }
}

// ── AppSettings ─────────────────────────────────────────────────────────────

export type GenerationProviderCapability = 'text' | 'image' | 'video'

export interface GenerationProviderSettings {
  id: string
  label: string
  enabled: boolean
  capabilities: GenerationProviderCapability[]
  apiKey?: string
  baseUrl?: string
  textModel?: string
  imageModel?: string
  videoModel?: string
  videoAspectRatio?: '16:9' | '9:16' | string
  videoResolution?: '720p' | '1080p' | '4k' | string
}

export interface CodexExecutionSettings {
  // `cli` is the config-isolated default. `sdk` opts daemon Codex jobs into
  // @openai/codex-sdk, which currently has no --ignore-user-config equivalent.
  executionProvider: 'cli' | 'sdk'
}

export interface OmnigentSettings {
  enabled: boolean
  baseUrl: string
  apiKey: string
  agentId: string
  autoStart: boolean
}

export interface AppSettings {
  // The three font tokens
  fonts: FontSettings
  // Legacy compat — mapped into fonts.* on load
  /** @deprecated use fonts.primary */
  primaryFont?: FontToken
  /** @deprecated use fonts.secondary */
  secondaryFont?: FontToken
  /** @deprecated use fonts.mono */
  monoFont?: FontToken
  // Theme / appearance
  /** UI chrome: dark palette, light palette, or follow OS (uses dark theme preset when OS is dark). */
  appearance: 'dark' | 'light' | 'system'
  themeId: string
  /** Global contrast offset applied on top of the resolved theme palette.
   *  Range -1..1 (clamped on apply); 0 = preset's natural contrast.
   *  Positive = surfaces shift away from text and vice versa; negative =
   *  everything compresses toward mid-grey. */
  themeContrast: number
  // Canvas
  canvasBackground: string
  canvasGlowEnabled: boolean
  canvasGlowRadius: number
  gridColorSmall: string
  gridColorLarge: string
  gridSpacingSmall: number
  gridSpacingLarge: number
  snapToGrid: boolean
  gridSize: number
  // Terminal (legacy — prefer fonts.mono)
  terminalFontSize: number
  terminalFontFamily: string
  // Appearance (legacy — prefer fonts.primary.size)
  uiFontSize: number
  /** @deprecated — translucency is always enabled at the Electron level now */
  translucentBackground: boolean
  /** Canvas background opacity: 1 = fully opaque, lower = more see-through vibrancy */
  translucentBackgroundOpacity: number
  // Behaviour
  autoSaveIntervalMs: number
  defaultTileSizes: Record<BuiltinTileType, { w: number; h: number }> & Record<string, { w: number; h: number }>
  // Chrome sync
  chromeSyncEnabled: boolean
  chromeSyncProfileDir: string | null
  // risk-06: when non-empty, cookie injection into browser-tile partitions is
  // scoped to these domains (and their subdomains). Empty = inject all (the
  // pre-scoping behavior) with a warning until the approval UI populates it.
  chromeSyncApprovedDomains: string[]
  // Where rendered links should open by default.
  linkOpenMode: 'browser-block' | 'external-browser'
  // Host-selection policy for chat and background execution.
  execution: ExecutionPreference
  // Codex execution backend for daemon-backed jobs.
  codex: CodexExecutionSettings
  // Omnigent daemon provider configuration.
  omnigent: OmnigentSettings
  // Last selected chat execution / permission mode by provider.
  chatProviderModes: Partial<Record<string, string>>
  // Daemon-owned background memory consolidation.
  autoDream: AutoDreamSettings
  // Local OpenAI-compat proxy endpoint remapping
  localProxyEnabled: boolean
  localProxyPort: number
  // Image/video generation and editing providers.
  generationProviders: Record<string, GenerationProviderSettings>
  // Pinned extension entries used by the sidebar and canvas menu.
  // Values may be whole extension ids (pin all contributed blocks) or
  // specific extension tile types such as `ext:hq-email-list`.
  pinnedExtensionIds: string[]
  // Extensions hidden from the sidebar Extensions list (hidden = not in list)
  hiddenFromSidebarExtIds: string[]
  // Extensions shown as panels inside Settings
  settingsPanelExtIds: string[]
  // Master kill-switch: hide all extensions from sidebar and footer
  extensionsDisabled: boolean
  // First-run onboarding: true once the user has dismissed the welcome flow.
  onboardingComplete?: boolean
  // Status bar health readout: 'compact' (default) shows a dot + HEALTH label
  // with hover detail; 'verbose' shows the full heap bar and numbers inline.
  statusBarHealth: 'compact' | 'verbose'
  // When true, the sidebar footer shows a prominent "Get Extensions" button
  // that opens the gallery modal, and legacy extension entry points (sidebar
  // flyout, Settings > Extensions nav) are hidden. Flip to false to restore.
  extensionsGalleryEnabled: boolean
  // Local-first storage feature flags. Phase 2 uses `threadIndex` to read
  // aggregated sessions from the SQLite `threads` table instead of walking
  // five filesystem trees on every sidebar refresh.
  storage: {
    threadIndex: boolean
  }
  // Voice — STT (input) + TTS (output) configuration. API keys are stored
  // separately in the encrypted secrets store; this struct holds only the
  // non-secret configuration (provider choice, voice id, lang, etc.).
  voice?: VoiceSettings
  // Ambient pet mascot — shares the codex-rs / grok-cli / hermes pet bundle
  // format. `enabled` is the master on/off; `slug` selects the active pet;
  // `scale` resizes the floating sprite (0.1–3.0, default 0.33).
  pet: {
    enabled: boolean
    slug: string
    scale: number
  }
  security: {
    /** When true, fs IPC paths must fall under a workspace project root or CODESURF_HOME. */
    restrictFsToWorkspaceRoots: boolean
    /** One-time marker after legacy default-off installs are migrated to scoping-on. */
    fsScopingMigrated?: boolean
    /** Set when the user explicitly disables scoping in Settings. */
    fsScopingUserOptedOut?: boolean
  }
}

export interface VoiceSettings {
  // STT (input) — used by chat-tile mic button and push-to-talk
  sttProvider: 'openai' | 'deepgram' | 'assemblyai' | 'local'
  sttLang: string                          // BCP-47 e.g. 'en'
  sttLocalBaseUrl?: string                 // for 'local' provider
  // TTS (output) — used by auto-speak and per-message Speak buttons
  ttsProvider: 'cartesia' | 'deepgram' | 'elevenlabs' | 'voicelab' | 'say'
  ttsVoice?: string                        // provider-specific voice id
  ttsVoiceLabBaseUrl?: string              // for 'voicelab' provider
  // Spokify rewrite (LLM that turns written text into natural narration)
  spokifyModel: string                     // default 'claude-haiku-4-5-20251001'
  // Behavior
  autoSpeak: 'off' | 'last-message'        // when to auto-speak the agent
  bargeIn: boolean                         // mic activation stops TTS playback
}

export const DEFAULT_SETTINGS: AppSettings = {
  fonts: { ...DEFAULT_FONTS },
  appearance: 'light',
  themeId: 'paper-light',
  themeContrast: 0,
  canvasBackground: '#f3f5f8',
  canvasGlowEnabled: true,
  canvasGlowRadius: 120,
  gridColorSmall: '#d8dde6',
  gridColorLarge: '#c5ccd8',
  gridSpacingSmall: 20,
  gridSpacingLarge: 100,
  snapToGrid: true,
  gridSize: 20,
  terminalFontSize: 13,
  terminalFontFamily: MONO_STACK,
  uiFontSize: 12,
  translucentBackground: true,
  translucentBackgroundOpacity: 1,
  autoSaveIntervalMs: 500,
  defaultTileSizes: {
    terminal: { w: 600, h: 400 },
    code:     { w: 680, h: 500 },
    note:     { w: 500, h: 400 },
    image:    { w: 440, h: 360 },
    media:    { w: 640, h: 360 },
    kanban:   { w: 900, h: 560 },
    browser:  { w: 1000, h: 700 },
    chat:     { w: 420, h: 600 },
    file:     { w: 240, h: 240 },
    files:    { w: 280, h: 500 },
    customisation: { w: 720, h: 560 },
  },
  chromeSyncEnabled: false,
  chromeSyncProfileDir: null,
  chromeSyncApprovedDomains: [],
  linkOpenMode: 'browser-block',
  execution: {
    mode: 'auto',
    hostId: null,
  },
  codex: {
    executionProvider: 'cli',
  },
  omnigent: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:6767',
    apiKey: '',
    agentId: '',
    autoStart: true,
  },
  chatProviderModes: {},
  autoDream: {
    enabled: true,
    minSessions: 3,
    minIntervalMs: 30 * 60 * 1000,
    debounceMs: 5_000,
    sweepMs: 5 * 60 * 1000,
  },
  localProxyEnabled: false,
  localProxyPort: 1337,
  generationProviders: {
    gemini: {
      id: 'gemini',
      label: 'Gemini / Nano Banana',
      enabled: false,
      capabilities: ['image', 'video'],
      apiKey: '',
      imageModel: 'gemini-2.5-flash-image',
      videoModel: 'veo-3.1-generate-preview',
      videoAspectRatio: '16:9',
      videoResolution: '720p',
    },
    openai: {
      id: 'openai',
      label: 'OpenAI',
      enabled: false,
      capabilities: ['text', 'image', 'video'],
      apiKey: '',
      textModel: '',
      imageModel: '',
      videoModel: '',
    },
    anthropic: {
      id: 'anthropic',
      label: 'Anthropic',
      enabled: false,
      capabilities: ['text'],
      apiKey: '',
      textModel: 'claude-sonnet-4-20250514',
    },
    openrouter: {
      id: 'openrouter',
      label: 'OpenRouter',
      enabled: false,
      capabilities: ['text', 'image'],
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      textModel: 'openrouter/auto',
      imageModel: '',
    },
    replicate: {
      id: 'replicate',
      label: 'Replicate',
      enabled: false,
      capabilities: ['image', 'video'],
      apiKey: '',
      imageModel: '',
      videoModel: '',
    },
    runway: {
      id: 'runway',
      label: 'Runway',
      enabled: false,
      capabilities: ['video'],
      apiKey: '',
      videoModel: '',
    },
    luma: {
      id: 'luma',
      label: 'Luma',
      enabled: false,
      capabilities: ['video'],
      apiKey: '',
      videoModel: '',
    },
    stability: {
      id: 'stability',
      label: 'Stability AI',
      enabled: false,
      capabilities: ['image'],
      apiKey: '',
      imageModel: '',
    },
    local: {
      id: 'local',
      label: 'Local / custom',
      enabled: false,
      capabilities: ['text', 'image', 'video'],
      apiKey: '',
      baseUrl: '',
      textModel: '',
      imageModel: '',
      videoModel: '',
    },
  },
  pinnedExtensionIds: [],
  hiddenFromSidebarExtIds: [],
  settingsPanelExtIds: [],
  extensionsDisabled: false,
  onboardingComplete: false,
  statusBarHealth: 'compact',
  extensionsGalleryEnabled: true,
  storage: {
    threadIndex: true,
  },
  voice: {
    // Deepgram Nova-2 is ~5x faster than Whisper REST for short clips
    // (~600ms vs ~3s end-to-end). Both keys are required for the full
    // Deepgram-based stack (STT + TTS Aura) so this default lines up.
    sttProvider: 'deepgram',
    sttLang: 'en',
    ttsProvider: 'cartesia',
    spokifyModel: 'claude-haiku-4-5-20251001',
    autoSpeak: 'off',
    bargeIn: true,
  },
  pet: {
    enabled: false,
    slug: '',
    scale: 0.33,
  },
  security: {
    restrictFsToWorkspaceRoots: false,
  },
}

/** Deep-merge a single font token with its default */
function mergeToken(base: FontToken, override?: Partial<FontToken>): FontToken {
  if (!override) return { ...base }
  return { ...base, ...override }
}

/** Deep-merge all font tokens, falling back to defaults for any missing */
/** Merge saved font settings with defaults, handling legacy config migration */
function resolveFonts(saved?: Partial<FontSettings>, legacyPrimary?: Partial<FontToken>, legacySecondary?: Partial<FontToken>, legacyMono?: Partial<FontToken>): FontSettings {
  // Start with defaults
  const result: FontSettings = { ...DEFAULT_FONTS }

  // Apply legacy settings first (old configs had primaryFont/secondaryFont/monoFont)
  if (legacyPrimary) result.primary = mergeToken(result.primary, legacyPrimary)
  if (legacySecondary) result.secondary = mergeToken(result.secondary, legacySecondary)
  if (legacyMono) result.mono = mergeToken(result.mono, legacyMono)

  if (!saved) return result

  // Migrate old granular tokens: sans → primary, subtitle → secondary
  const s = saved as Record<string, Partial<FontToken> | undefined>
  const legacySans = s.sans ?? s.chatMessage ?? s.title
  const legacySub = s.subtitle ?? s.sectionLabel
  const legacyMonoToken = s.terminal ?? s.codeEditor

  if (legacySans && !saved.primary) result.primary = mergeToken(result.primary, legacySans)
  if (legacySub && !saved.secondary) result.secondary = mergeToken(result.secondary, legacySub)
  if (legacyMonoToken && !saved.mono) result.mono = mergeToken(result.mono, legacyMonoToken)

  // Apply new-style tokens (these win over everything)
  if (saved.primary) result.primary = mergeToken(result.primary, saved.primary)
  if (saved.secondary) result.secondary = mergeToken(result.secondary, saved.secondary)
  if (saved.mono) result.mono = mergeToken(result.mono, saved.mono)

  return result
}

export function withDefaultSettings(input: Partial<AppSettings> | null | undefined): AppSettings {
  const settings = input ?? {}
  const rawChatProviderModes = settings.chatProviderModes
    && typeof settings.chatProviderModes === 'object'
    && !Array.isArray(settings.chatProviderModes)
    ? settings.chatProviderModes
    : {}
  const chatProviderModes = Object.fromEntries(
    Object.entries(rawChatProviderModes)
      .filter((entry): entry is [string, string] => (
        typeof entry[0] === 'string'
        && entry[0].trim().length > 0
        && typeof entry[1] === 'string'
        && entry[1].trim().length > 0
      ))
      .map(([providerId, modeId]) => [providerId.trim(), modeId.trim()]),
  ) as Partial<Record<string, string>>
  const generationProviders = Object.fromEntries(
    Object.entries({
      ...DEFAULT_SETTINGS.generationProviders,
      ...(settings.generationProviders ?? {}),
    }).map(([id, provider]) => {
      const defaults = DEFAULT_SETTINGS.generationProviders[id]
      return [id, {
        ...(defaults ?? { id, label: id, enabled: false, capabilities: [] as GenerationProviderCapability[] }),
        ...provider,
        id: provider.id || id,
        capabilities: Array.isArray(provider.capabilities)
          ? Array.from(new Set([...(defaults?.capabilities ?? []), ...provider.capabilities]))
              .filter(capability => capability === 'text' || capability === 'image' || capability === 'video')
          : (defaults?.capabilities ?? []),
      }]
    }),
  ) as Record<string, GenerationProviderSettings>
  const base: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    execution: {
      ...DEFAULT_SETTINGS.execution,
      ...(settings.execution ?? {}),
    },
    codex: {
      ...DEFAULT_SETTINGS.codex,
      ...(settings.codex ?? {}),
    },
    omnigent: {
      ...DEFAULT_SETTINGS.omnigent,
      ...(settings.omnigent ?? {}),
    },
    chatProviderModes,
    autoDream: {
      ...DEFAULT_SETTINGS.autoDream,
      ...(settings.autoDream ?? {}),
    },
    defaultTileSizes: {
      ...DEFAULT_SETTINGS.defaultTileSizes,
      ...(settings.defaultTileSizes ?? {})
    },
    storage: {
      ...DEFAULT_SETTINGS.storage,
      ...(settings.storage ?? {}),
    },
    pet: {
      ...DEFAULT_SETTINGS.pet,
      ...(settings.pet ?? {}),
    },
    security: {
      ...DEFAULT_SETTINGS.security,
      ...(settings.security ?? {}),
    },
    generationProviders,
    // Resolve fonts: new 3-token system, with legacy migration
    fonts: resolveFonts(
      settings.fonts as Partial<FontSettings>,
      settings.primaryFont as Partial<FontToken>,
      settings.secondaryFont as Partial<FontToken>,
      settings.monoFont as Partial<FontToken>,
    ),
  }
  base.canvasGlowRadius = Math.max(50, Math.min(200, base.canvasGlowRadius ?? DEFAULT_SETTINGS.canvasGlowRadius))
  base.themeContrast = Math.max(-1, Math.min(1, Number.isFinite(base.themeContrast) ? base.themeContrast : 0))
  return base
}

/** Defaults for first launch when no settings.json exists yet. */
export function withFreshInstallDefaults(): AppSettings {
  return withDefaultSettings({
    security: {
      restrictFsToWorkspaceRoots: true,
      fsScopingMigrated: true,
    },
  })
}

/** Turn on workspace FS scoping during first-run before onboarding completes. */
export function applyNewInstallSecurityDefaults(settings: AppSettings): AppSettings {
  if (settings.security.restrictFsToWorkspaceRoots) return settings
  if (settings.onboardingComplete !== false) return settings
  return {
    ...settings,
    security: {
      ...settings.security,
      restrictFsToWorkspaceRoots: true,
    },
  }
}

/** One-time migration: legacy installs that never opted out get workspace scoping enabled. */
export function applyFsScopingMigration(settings: AppSettings): AppSettings {
  if (settings.security.fsScopingMigrated) return settings
  if (settings.security.fsScopingUserOptedOut) {
    return {
      ...settings,
      security: {
        ...settings.security,
        fsScopingMigrated: true,
      },
    }
  }
  if (settings.security.restrictFsToWorkspaceRoots) {
    return {
      ...settings,
      security: {
        ...settings.security,
        fsScopingMigrated: true,
      },
    }
  }
  return {
    ...settings,
    security: {
      ...settings.security,
      restrictFsToWorkspaceRoots: true,
      fsScopingMigrated: true,
    },
  }
}

export function normalizeLoadedSettings(settings: AppSettings): AppSettings {
  return applyFsScopingMigration(applyNewInstallSecurityDefaults(settings))
}
