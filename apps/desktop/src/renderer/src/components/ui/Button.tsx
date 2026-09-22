import React, { useState } from 'react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: React.ReactNode
  loading?: boolean
}

const SIZE_STYLE: Record<ButtonSize, { padding: string; fontSize: number | string; height: number; gap: number }> = {
  xs: { padding: '0 8px',  fontSize: 'inherit', height: 20, gap: 4 },
  sm: { padding: '0 10px', fontSize: 'inherit', height: 24, gap: 6 },
  md: { padding: '0 12px', fontSize: 'inherit', height: 28, gap: 8 },
  lg: { padding: '0 16px', fontSize: 'inherit', height: 34, gap: 8 },
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  children,
  disabled,
  style,
  ...rest
}: ButtonProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)

  const isDisabled = disabled || loading
  const sz = SIZE_STYLE[size]

  const palette = {
    primary: {
      bg: theme.accent.base, bgHover: theme.accent.hover, fg: theme.text.inverse, border: theme.accent.base,
    },
    secondary: {
      bg: theme.surface.panelElevated, bgHover: theme.surface.hover, fg: theme.text.secondary, border: theme.border.default,
    },
    ghost: {
      bg: 'transparent', bgHover: theme.surface.hover, fg: theme.text.muted, border: 'transparent',
    },
    danger: {
      bg: theme.surface.panelElevated, bgHover: `${theme.status.danger}22`, fg: theme.status.danger, border: theme.border.default,
    },
    link: {
      bg: 'transparent', bgHover: 'transparent', fg: theme.accent.base, border: 'transparent',
    },
  }[variant]

  return (
    <button
      {...rest}
      disabled={isDisabled}
      onMouseEnter={e => { setHovered(true); rest.onMouseEnter?.(e) }}
      onMouseLeave={e => { setHovered(false); rest.onMouseLeave?.(e) }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: sz.gap,
        padding: sz.padding,
        height: sz.height,
        borderRadius: 6,
        border: `1px solid ${palette.border}`,
        background: hovered && !isDisabled ? palette.bgHover : palette.bg,
        color: palette.fg,
        fontSize: fonts.secondarySize,
        fontWeight: 500,
        fontFamily: fonts.secondary,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.5 : 1,
        transition: 'background 0.12s ease, color 0.12s ease, border-color 0.12s ease',
        textDecoration: variant === 'link' ? (hovered && !isDisabled ? 'underline' : 'none') : 'none',
        outline: 'none',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  )
}

/** Compact square icon-only button. */
export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  size?: number
  variant?: 'ghost' | 'danger' | 'accent'
  active?: boolean
}

export function IconButton({
  size = 22,
  variant = 'ghost',
  active = false,
  children,
  disabled,
  style,
  ...rest
}: IconButtonProps): JSX.Element {
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)

  const color = (() => {
    if (active) return variant === 'danger' ? theme.status.danger : theme.accent.base
    if (hovered && !disabled) {
      if (variant === 'danger') return theme.status.danger
      if (variant === 'accent') return theme.accent.base
      return theme.text.primary
    }
    return theme.text.disabled
  })()

  return (
    <button
      {...rest}
      disabled={disabled}
      onMouseEnter={e => { setHovered(true); rest.onMouseEnter?.(e) }}
      onMouseLeave={e => { setHovered(false); rest.onMouseLeave?.(e) }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 4,
        border: 'none',
        background: active ? theme.surface.hover : 'transparent',
        color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'color 0.12s ease, background 0.12s ease',
        padding: 0,
        outline: 'none',
        ...style,
      }}
    >
      {children}
    </button>
  )
}
