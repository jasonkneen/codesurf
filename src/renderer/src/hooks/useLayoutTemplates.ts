import { useState, useEffect, useCallback } from 'react'
import type { LayoutTemplate } from '../../../shared/types'

const TEMPLATES_PATH = '~/.contex/layout-templates.json'

interface LayoutTemplatesFile {
  templates: LayoutTemplate[]
}

const DEFAULT_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'default-codex',
    name: 'Codex',
    created_at: '2026-04-16T16:17:35.317Z',
    tree: { type: 'split', direction: 'horizontal', children: [{ type: 'leaf', slots: [{ tileType: 'chat' }] }, { type: 'leaf', slots: [{ tileType: 'files' }] }], sizes: [85, 15] },
  },
  {
    id: 'default-conductor',
    name: 'Conductor',
    created_at: '2026-04-16T16:20:03.956Z',
    tree: { type: 'split', direction: 'horizontal', children: [{ type: 'leaf', slots: [{ tileType: 'chat' }] }, { type: 'split', direction: 'vertical', children: [{ type: 'leaf', slots: [{ tileType: 'files' }] }, { type: 'leaf', slots: [{ tileType: 'terminal' }] }], sizes: [78, 22] }], sizes: [81, 19] },
  },
  {
    id: 'default-bolt',
    name: 'Bolt',
    created_at: '2026-04-16T16:21:24.532Z',
    tree: { type: 'split', direction: 'horizontal', children: [{ type: 'split', direction: 'horizontal', children: [{ type: 'leaf', slots: [{ tileType: 'chat' }] }, { type: 'leaf', slots: [{ tileType: 'files' }] }], sizes: [50, 50] }, { type: 'split', direction: 'vertical', children: [{ type: 'leaf', slots: [{ tileType: 'browser' }] }, { type: 'leaf', slots: [{ tileType: 'terminal' }] }], sizes: [80, 20] }], sizes: [37, 63] },
  },
  {
    id: 'default-vscode',
    name: 'VSCode',
    created_at: '2026-04-16T16:22:32.386Z',
    tree: { type: 'split', direction: 'horizontal', children: [{ type: 'leaf', slots: [{ tileType: 'files' }] }, { type: 'split', direction: 'vertical', children: [{ type: 'leaf', slots: [{ tileType: 'code' }] }, { type: 'leaf', slots: [{ tileType: 'terminal' }] }], sizes: [76, 24] }], sizes: [15, 85] },
  },
]

export function useLayoutTemplates() {
  const [templates, setTemplates] = useState<LayoutTemplate[]>([])
  const [loading, setLoading] = useState(true)

  // Load — seed defaults if no file exists
  useEffect(() => {
    const load = async () => {
      try {
        const stat = await window.electron.fs.stat(TEMPLATES_PATH).catch(() => null)
        if (!stat) {
          // First run — seed with defaults
          const data: LayoutTemplatesFile = { templates: DEFAULT_TEMPLATES }
          await window.electron.fs.writeFile(TEMPLATES_PATH, JSON.stringify(data, null, 2))
          setTemplates(DEFAULT_TEMPLATES)
          setLoading(false)
          return
        }
        const raw = await window.electron.fs.readFile(TEMPLATES_PATH)
        const data = JSON.parse(raw) as LayoutTemplatesFile
        setTemplates(data.templates ?? [])
      } catch { /* first run, no file */ }
      setLoading(false)
    }
    load()
  }, [])

  const persist = useCallback(async (next: LayoutTemplate[]) => {
    setTemplates(next)
    const data: LayoutTemplatesFile = { templates: next }
    await window.electron.fs.writeFile(TEMPLATES_PATH, JSON.stringify(data, null, 2))
  }, [])

  const addTemplate = useCallback(async (t: LayoutTemplate) => {
    const next = [...templates, t]
    await persist(next)
    return t
  }, [templates, persist])

  const updateTemplate = useCallback(async (id: string, patch: Partial<LayoutTemplate>) => {
    const next = templates.map(t => t.id === id ? { ...t, ...patch } : t)
    await persist(next)
  }, [templates, persist])

  const deleteTemplate = useCallback(async (id: string) => {
    const next = templates.filter(t => t.id !== id)
    await persist(next)
  }, [templates, persist])

  return { templates, loading, addTemplate, updateTemplate, deleteTemplate }
}
