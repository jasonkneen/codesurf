import React from 'react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md'
  fullWidth?: boolean
}

export function Select({ size = 'md', fullWidth, children, style, ...rest }: SelectProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()

  const height = size === 'sm' ? 24 : 28
  const padding = size === 'sm' ? '0 8px' : '0 10px'

  return (
    <select
      {...rest}
      style={{
        height,
        padding,
        borderRadius: 6,
        border: `1px solid ${theme.border.default}`,
        background: theme.surface.input,
        color: theme.text.primary,
        fontSize: fonts.secondarySize,
        fontFamily: fonts.secondary,
        outline: 'none',
        width: fullWidth ? '100%' : undefined,
        minWidth: 0,
        boxSizing: 'border-box',
        cursor: 'pointer',
        ...style,
      }}
    >
      {children}
    </select>
  )
}
