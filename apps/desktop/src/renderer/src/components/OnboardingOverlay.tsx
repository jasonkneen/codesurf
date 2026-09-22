/**
 * First-run onboarding (P9). A themed welcome shown once, gated on
 * settings.onboardingComplete. Introduces the core mental model — an infinite
 * canvas of tiles, plugins that extend it, the Pi agent, and Plugin Studio for
 * authoring — then dismisses by persisting the flag. Self-contained: the only
 * host coupling is the onComplete callback (and an optional onOpenPlugins).
 */
import React, { useEffect, useState } from 'react'
import { Layers, Puzzle, Bot, Wrench, ArrowRight } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'

interface Props {
  onComplete: () => void
  /** Optional: open the Plugins gallery straight from onboarding. */
  onOpenPlugins?: () => void
}

const FEATURES: Array<{ icon: React.ReactNode; title: string; body: string }> = [
  { icon: <Layers size={18} />, title: 'An infinite canvas', body: 'Pan and zoom a 2D workspace. Every tool — terminal, editor, browser, chat — is a tile you place, group, and arrange into layouts.' },
  { icon: <Puzzle size={18} />, title: 'Plugins extend everything', body: 'Add commands, panels, footer items and views. Open the Command Palette with ⌘⇧P to run any plugin command.' },
  { icon: <Bot size={18} />, title: 'Agents collaborate', body: 'Chat with Pi, Claude, Codex and more in a chat tile. Agents and humans share the same canvas and kanban state.' },
  { icon: <Wrench size={18} />, title: 'Build your own', body: 'Plugin Studio scaffolds a plugin and opens a dev workspace. Launch a Dev Sandbox to test it in isolation.' },
]

export function OnboardingOverlay({ onComplete, onOpenPlugins }: Props): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 10)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      role="dialog"
      aria-label="Welcome to CodeSurf"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'color-mix(in srgb, #000 55%, transparent)',
        padding: 40,
        opacity: ready ? 1 : 0,
        transition: 'opacity 160ms ease-out',
        fontFamily: fonts.primary,
      }}
    >
      <div
        style={{
          width: 'min(640px, 100%)',
          maxHeight: '88vh',
          overflow: 'auto',
          background: theme.surface.panel,
          border: `1px solid ${theme.border.default}`,
          borderRadius: 16,
          boxShadow: theme.shadow.panel,
          color: theme.text.primary,
          transform: ready ? 'scale(1)' : 'scale(0.98)',
          transition: 'transform 160ms ease-out',
        }}
      >
        <div style={{ padding: '28px 28px 8px' }}>
          <div style={{ fontSize: fonts.size + 8, fontWeight: 700 }}>Welcome to CodeSurf</div>
          <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, marginTop: 6, lineHeight: 1.5 }}>
            A canvas workspace where you and AI agents build together. A quick tour of the essentials.
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '16px 28px' }}>
          {FEATURES.map(f => (
            <div
              key={f.title}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: 14,
                background: theme.surface.panelMuted,
                border: `1px solid ${theme.border.subtle}`,
                borderRadius: 10,
              }}
            >
              <div style={{ color: theme.accent.base, display: 'flex', alignItems: 'center', gap: 8 }}>
                {f.icon}
                <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>{f.title}</span>
              </div>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, lineHeight: 1.5 }}>{f.body}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '12px 28px 24px' }}>
          {onOpenPlugins && (
            <button
              onClick={() => { onOpenPlugins(); onComplete() }}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: `1px solid ${theme.border.default}`,
                background: 'transparent',
                color: theme.text.secondary,
                fontSize: fonts.size,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Browse plugins
            </button>
          )}
          <button
            onClick={onComplete}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 16px',
              borderRadius: 8,
              border: `1px solid ${theme.accent.base}`,
              background: theme.accent.base,
              color: theme.text.inverse,
              fontSize: fonts.size,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Get started
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
