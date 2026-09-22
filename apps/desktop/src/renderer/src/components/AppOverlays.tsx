import React, { Suspense } from 'react'
import type { AppSettings, Workspace } from '../../../shared/types'
import { withDefaultSettings } from '../../../shared/types'
import type { MenuItem } from './ContextMenu'
import { DevSandboxFrame } from './DevSandboxFrame'
import { OnboardingOverlay } from './OnboardingOverlay'

const LazyMCPPanel = React.lazy(() => import('./MCPPanel').then(m => ({ default: m.MCPPanel })))
const LazySettingsPanel = React.lazy(() => import('./SettingsPanel').then(m => ({ default: m.SettingsPanel })))
const LazyExtensionsGallery = React.lazy(() => import('./ExtensionsGallery').then(m => ({ default: m.ExtensionsGallery })))
const LazyContextMenu = React.lazy(() => import('./ContextMenu').then(m => ({ default: m.ContextMenu })))
const LazyClusoWidgetMount = React.lazy(() =>
  import('./ClusoWidgetMount')
    .then(m => ({ default: m.ClusoWidgetMount }))
    .catch(() => ({ default: () => null }))
)
const LazyAgentSetup = React.lazy(() => import('./AgentSetup').then(m => ({ default: m.AgentSetup })))
const LazySkillInstallModal = React.lazy(() => import('./SkillInstallModal').then(m => ({ default: m.SkillInstallModal })))
const LazyCommandPalette = React.lazy(() => import('./CommandPalette').then(m => ({ default: m.CommandPalette })))
const LazyPetOverlay = React.lazy(() => import('./PetOverlay').then(m => ({ default: m.PetOverlay })))
const LazyPetPicker = React.lazy(() => import('./PetPicker').then(m => ({ default: m.PetPicker })))

export type AppOverlaysProps = {
  showMCP: boolean
  setShowMCP: (open: boolean) => void
  showSettings: boolean | string
  setShowSettings: React.Dispatch<React.SetStateAction<string | false>>
  showExtensionsGallery: boolean
  setShowExtensionsGallery: (open: boolean) => void
  settingsLoaded: boolean
  settings: AppSettings
  updateAppSettings: (patch: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>)) => void
  setSettings: (settings: AppSettings) => void
  workspaces: Workspace[]
  workspacePath: string | undefined
  systemPrefersDark: boolean
  ctxMenu: { x: number, y: number, items: MenuItem[] } | null
  closeCtx: () => void
  showAgentSetup: boolean
  setShowAgentSetup: (open: boolean) => void
  skillInstallPath: string | null
  setSkillInstallPath: (path: string | null) => void
  commandPaletteOpen: boolean
  setCommandPaletteOpen: (open: boolean) => void
  showPetPicker: boolean
  setShowPetPicker: (open: boolean) => void
}

export function AppOverlays(props: AppOverlaysProps): JSX.Element {
  const {
    showMCP,
    setShowMCP,
    showSettings,
    setShowSettings,
    showExtensionsGallery,
    setShowExtensionsGallery,
    settingsLoaded,
    settings,
    updateAppSettings,
    setSettings,
    workspaces,
    workspacePath,
    systemPrefersDark,
    ctxMenu,
    closeCtx,
    showAgentSetup,
    setShowAgentSetup,
    skillInstallPath,
    setSkillInstallPath,
    commandPaletteOpen,
    setCommandPaletteOpen,
    showPetPicker,
    setShowPetPicker,
  } = props

  return (
    <>
      {showMCP && (
        <Suspense fallback={null}>
          <LazyMCPPanel onClose={() => setShowMCP(false)} />
        </Suspense>
      )}
      {showSettings && (
        <Suspense fallback={null}>
          <LazySettingsPanel
            settings={settings}
            onClose={() => setShowSettings(false)}
            onSettingsChange={s => setSettings(withDefaultSettings(s))}
            workspaces={workspaces}
            workspacePath={workspacePath}
            initialSection={typeof showSettings === 'string' ? showSettings as never : undefined}
            systemPrefersDark={systemPrefersDark}
          />
        </Suspense>
      )}
      {showExtensionsGallery && (
        <Suspense fallback={null}>
          <LazyExtensionsGallery
            onClose={() => setShowExtensionsGallery(false)}
            workspacePath={workspacePath ?? null}
            onSettingsChange={s => setSettings(withDefaultSettings(s))}
          />
        </Suspense>
      )}
      {settingsLoaded && !settings.onboardingComplete && (
        <OnboardingOverlay
          onComplete={() => updateAppSettings({ onboardingComplete: true })}
          onOpenPlugins={() => setShowExtensionsGallery(true)}
        />
      )}
      {ctxMenu && (
        <Suspense fallback={null}>
          <LazyContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={closeCtx} />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <LazyClusoWidgetMount />
      </Suspense>
      {showAgentSetup && (
        <Suspense fallback={null}>
          <LazyAgentSetup
            onComplete={() => setShowAgentSetup(false)}
            onDismiss={() => setShowAgentSetup(false)}
          />
        </Suspense>
      )}
      {skillInstallPath && (
        <Suspense fallback={null}>
          <LazySkillInstallModal
            zipPath={skillInstallPath}
            onClose={() => setSkillInstallPath(null)}
          />
        </Suspense>
      )}
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <LazyCommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
          />
        </Suspense>
      )}
      {/* Ambient pet mascot — floats above the canvas when enabled */}
      {settingsLoaded && settings.pet?.enabled && settings.pet?.slug && (
        <Suspense fallback={null}>
          <LazyPetOverlay
            slug={settings.pet.slug}
            scale={settings.pet.scale}
            onOpenPicker={() => setShowPetPicker(true)}
          />
        </Suspense>
      )}
      {showPetPicker && (
        <Suspense fallback={null}>
          <LazyPetPicker
            onClose={() => setShowPetPicker(false)}
            currentSlug={settings.pet?.slug ?? ''}
            scale={settings.pet?.scale ?? 0.33}
            onSelect={(slug) => {
              updateAppSettings((current) => ({
                pet: { ...current.pet, enabled: true, slug },
              }))
            }}
            onScaleChange={(newScale) => {
              updateAppSettings((current) => ({
                pet: { ...current.pet, scale: newScale },
              }))
            }}
          />
        </Suspense>
      )}
      <DevSandboxFrame />
    </>
  )
}