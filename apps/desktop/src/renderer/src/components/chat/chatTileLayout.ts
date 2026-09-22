import type React from 'react'
import { DEFAULT_FONTS } from '../../../../shared/types'

// Canonical stacks — same tokens as Settings → Fonts (primary / mono).
export const FONT_SANS = DEFAULT_FONTS.primary.family
export const FONT_MONO = DEFAULT_FONTS.mono.family
export const FONT_SIZE_DEFAULT = 13
export const MONO_SIZE_DEFAULT = 13

export const CHAT_MESSAGE_MAX_WIDTH = 'var(--cs-thread-content-max-width)'
export const CHAT_OFFSCREEN_MESSAGE_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '0 160px',
}

export {
  CHAT_RENDER_PAGE_SIZE,
  CHAT_INITIAL_RENDER_PAGES,
  CHAT_INITIAL_RENDER_WINDOW,
} from './transcriptWindow'

export const LINKED_SESSION_LIVE_TAIL_LIMIT = 40
export const LINKED_SESSION_HISTORY_PAGE_SIZE = 20
export const LINKED_SESSION_HISTORY_LOAD_THRESHOLD = 32

export const CHAT_COMPOSER_MAX_WIDTH = CHAT_MESSAGE_MAX_WIDTH
export const CHAT_COMPOSER_MIN_WIDTH = 'var(--cs-chat-composer-min-width)'
export const CHAT_COMPOSER_SIDE_INSET = 'var(--cs-chat-composer-side-inset)'
export const CHAT_COMPOSER_BOTTOM_INSET = 'var(--cs-chat-composer-bottom-inset)'
export const CHAT_COMPOSER_RADIUS = 'var(--cs-chat-composer-radius)'
export const CHAT_COMPOSER_WIDTH = `min(calc(100% - calc(${CHAT_COMPOSER_SIDE_INSET} * 2)), ${CHAT_COMPOSER_MAX_WIDTH})`
export const CHAT_COMPOSER_MIN_WIDTH_STYLE = `min(${CHAT_COMPOSER_MIN_WIDTH}, calc(100% - calc(${CHAT_COMPOSER_SIDE_INSET} * 2)))`
export const CHAT_COMPOSER_MIN_HEIGHT = 105
export const CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT = 56

export const CHAT_AUTO_SCROLL_THRESHOLD = 48
export const TOOLBAR_ICON_SIZE = 16
export const TOOLBAR_PILL_ICON_SIZE = 14

export const LIVE_TOOL_COLLAPSE_GRACE_MS = 5000

export const CHAT_CHIP_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  columnGap: 6,
  rowGap: 4,
  alignItems: 'flex-start',
  alignContent: 'flex-start',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'visible',
  paddingTop: 1,
}