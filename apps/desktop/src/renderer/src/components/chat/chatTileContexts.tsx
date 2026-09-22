import React from 'react'
import type { CheckpointRestoreContextValue } from './chatTileTypes'
import {
  FONT_SANS,
  FONT_MONO,
  FONT_SIZE_DEFAULT,
  MONO_SIZE_DEFAULT,
} from './chatTileLayout'

export const TOOL_BLOCK_MAX_WIDTH = 420

export const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}

export const CheckpointRestoreContext = React.createContext<CheckpointRestoreContextValue | null>(null)

export type ChatDispatchValue = {
  sendAnswer: (text: string) => void | Promise<void>
}

const ChatDispatchCtx = React.createContext<ChatDispatchValue | null>(null)

export function ChatDispatchProvider({ value, children }: { value: ChatDispatchValue; children: React.ReactNode }) {
  return <ChatDispatchCtx.Provider value={value}>{children}</ChatDispatchCtx.Provider>
}

// Font context so sub-components can read settings-derived fonts without prop drilling
export const FontCtx = React.createContext({
  sans: FONT_SANS,
  secondary: FONT_SANS,
  mono: FONT_MONO,
  size: FONT_SIZE_DEFAULT,
  monoSize: MONO_SIZE_DEFAULT,
  lineHeight: 1.5,
  weight: 400,
  monoLineHeight: 1.5,
  monoWeight: 400,
  secondarySize: 11,
  secondaryLineHeight: 1.4,
  secondaryWeight: 400,
})

export function useFonts() {
  return React.useContext(FontCtx)
}