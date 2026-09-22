import React from 'react'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md'
  error?: boolean
  fullWidth?: boolean
}

/** Base themed input — used by TextInput and NumInput. */
export function Input({ size = 'md', error, fullWidth, style, ...rest }: InputProps): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()

  const height = size === 'sm' ? 24 : 28
  const padding = size === 'sm' ? '0 8px' : '0 10px'
  const borderColor = error ? theme.status.danger : theme.border.default

  return (
    <input
      {...rest}
      style={{
        height,
        padding,
        borderRadius: 6,
        border: `1px solid ${borderColor}`,
        background: theme.surface.input,
        color: theme.text.primary,
        fontSize: fonts.secondarySize,
        fontFamily: fonts.secondary,
        outline: 'none',
        width: fullWidth ? '100%' : undefined,
        minWidth: 0,
        boxSizing: 'border-box',
        ...style,
      }}
    />
  )
}

export function TextInput(props: InputProps): JSX.Element {
  return <Input type="text" {...props} />
}

export interface NumInputProps extends Omit<InputProps, 'type'> {
  value: number
  min?: number
  max?: number
  step?: number
  onChange?: React.ChangeEventHandler<HTMLInputElement>
}

export function NumInput({ value, min, max, step = 1, ...rest }: NumInputProps): JSX.Element {
  return (
    <Input
      {...rest}
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      style={{ textAlign: 'right', ...rest.style }}
    />
  )
}
