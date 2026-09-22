import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const SHELL_CHROME_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useAppShellChrome.ts'), 'utf8')
const BRAND_HOOK_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useBrandWordmarkPrefs.ts'), 'utf8')
const BRAND_WORDMARKS_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/lib/brandWordmarks.ts'), 'utf8')
const MINI_CHAT_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/MiniChatWindow.tsx'), 'utf8')

describe('wave 21 brand and mini-chat extractions', () => {
  test('App delegates brand wordmark prefs to hook and asset modules', () => {
    expect(APP_SOURCE).toContain("from './hooks/useAppShellChrome'")
    expect(SHELL_CHROME_SOURCE).toContain("from './useBrandWordmarkPrefs'")
    expect(SHELL_CHROME_SOURCE).toContain('useBrandWordmarkPrefs(effectiveThemeId, theme.mode)')
    expect(APP_SOURCE).not.toContain('BRAND_WORDMARK_CACHE_KEY')
    expect(APP_SOURCE).not.toContain('const brandWordmarks = React.useMemo')
    expect(BRAND_WORDMARKS_SOURCE).toContain('export const BRAND_WORDMARKS')
    expect(BRAND_HOOK_SOURCE).toContain('BRAND_WORDMARKS')
    expect(BRAND_HOOK_SOURCE).toContain('getBrandPalettes')
  })

  test('App delegates mini chat window rendering to MiniChatWindow', () => {
    expect(APP_SOURCE).toContain("from './lib/miniChatWindow'")
    expect(APP_SOURCE).toContain("from './components/MiniChatWindow'")
    expect(APP_SOURCE).toContain('<MiniChatWindow')
    expect(APP_SOURCE).not.toContain('cs-mini-chat-window')
    expect(APP_SOURCE).not.toContain('function readMiniChatOptions')
    expect(MINI_CHAT_SOURCE).toContain('cs-mini-chat-window')
    expect(MINI_CHAT_SOURCE).toContain('LazyChatTile')
  })
})
