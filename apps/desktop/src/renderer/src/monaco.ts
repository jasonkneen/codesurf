import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
// Monaco exposes these worker entrypoints through package exports. Those
// subpaths resolve to the ESM tree while remaining compatible with Vite's
// package resolver; importing `esm/vs/...` directly double-prefixes that path
// under Monaco 0.56 and breaks clean installs.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import type { AppTheme } from './theme'

// Route Monaco's language-service workers to Vite-bundled Worker modules.
// Without this, Monaco falls back to running language services on the renderer's
// main thread — blocking the UI on tokenisation, TS diagnostics, and JSON/CSS
// parsing. `?worker` is Vite's syntax for "bundle this as a Worker module with
// its own URL"; the switch maps Monaco's `label` to the matching bundled worker.
;(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

let configured = false

export function ensureMonacoConfigured(): void {
  if (configured) return
  loader.config({ monaco })
  configured = true
}

export function getMonacoThemeName(theme: AppTheme): string {
  ensureMonacoConfigured()
  const monacoThemeName = `codesurf-${theme.id}`
  monaco.editor.defineTheme(monacoThemeName, {
    base: theme.editor.monacoBase,
    inherit: true,
    rules: [],
    colors: {
      'editor.background': theme.editor.background,
      'editorGutter.background': theme.editor.background,
      'minimap.background': theme.editor.background,
      'editorLineNumber.foreground': theme.text.disabled,
      'editorLineNumber.activeForeground': theme.text.secondary,
      'editorStickyScroll.background': theme.editor.background,
      'editorWidget.background': theme.surface.panelElevated,
      'editorWidget.border': theme.border.default,
      'dropdown.background': theme.surface.panelElevated,
      'dropdown.border': theme.border.default,
      'list.hoverBackground': theme.surface.hover,
      'list.activeSelectionBackground': theme.surface.selection,
      'list.activeSelectionForeground': theme.text.primary,
      'list.inactiveSelectionBackground': theme.surface.selection,
      'list.inactiveSelectionForeground': theme.text.primary,
      'scrollbar.shadow': 'transparent',
    },
  })
  return monacoThemeName
}
