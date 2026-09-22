import React from 'react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Use the muted panel surface instead of the default. */
  muted?: boolean
  /** Emphasize with the accent border. */
  accent?: boolean
  padded?: boolean
}

export function Card({ muted, accent, padded = true, children, style, ...rest }: CardProps): JSX.Element {
  const theme = useTheme()
  return (
    <div
      {...rest}
      style={{
        background: muted ? theme.surface.panelMuted : theme.surface.panel,
        border: `1px solid ${accent ? theme.border.accent : theme.border.default}`,
        borderRadius: 10,
        padding: padded ? 14 : 0,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Elevated surface with shadow. */
  elevated?: boolean
}

export function Panel({ elevated, children, style, ...rest }: PanelProps): JSX.Element {
  const theme = useTheme()
  return (
    <div
      {...rest}
      style={{
        background: theme.surface.panel,
        border: `1px solid ${theme.border.default}`,
        borderRadius: 10,
        boxShadow: elevated ? theme.shadow.panel : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export interface SectionLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string
}

/** Uppercase section label for settings and panels. */
export function SectionLabel({ label, style, ...rest }: SectionLabelProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  return (
    <div
      {...rest}
      style={{
        fontFamily: fonts.secondary,
        fontSize: Math.max(10, fonts.secondarySize - 1),
        fontWeight: 700,
        color: theme.text.disabled,
        letterSpacing: 1.5,
        textTransform: 'uppercase',
        padding: '12px 0 8px',
        ...style,
      }}
    >
      {label}
    </div>
  )
}

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical'
}

export function Separator({ orientation = 'horizontal', style, ...rest }: SeparatorProps): JSX.Element {
  const theme = useTheme()
  return (
    <div
      {...rest}
      style={{
        background: theme.border.subtle,
        width: orientation === 'horizontal' ? '100%' : 1,
        height: orientation === 'horizontal' ? 1 : '100%',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}
