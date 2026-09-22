import { useEffect, useState } from 'react'
import type { SkillDefinition } from '../../../shared/types'
import { CUSTOMISATION_LOCATIONS_CHANGED_EVENT, type CustomisationLocationsChangedDetail } from '../components/CustomisationTile'
import {
  CHAT_DEFAULT_SKILL_LOCATIONS,
  resolveChatSkillLocations,
} from '../components/chat/chatTileUtils'

export function useChatTileWorkspaceSkills(workspaceDir: string) {
  const [workspaceSkills, setWorkspaceSkills] = useState<SkillDefinition[]>([])
  const [skillLocationsVersion, setSkillLocationsVersion] = useState(0)

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<CustomisationLocationsChangedDetail>).detail
      if (!detail) return
      if (detail.kind !== 'skills' && detail.kind !== 'prompts') return
      const currentWorkspace = workspaceDir?.trim() || null
      if (currentWorkspace && detail.workspacePath && detail.workspacePath !== currentWorkspace) return
      setSkillLocationsVersion(v => v + 1)
    }
    window.addEventListener(CUSTOMISATION_LOCATIONS_CHANGED_EVENT, handler as EventListener)
    return () => window.removeEventListener(CUSTOMISATION_LOCATIONS_CHANGED_EVENT, handler as EventListener)
  }, [workspaceDir])

  useEffect(() => {
    let cancelled = false
    const workspacePath = workspaceDir?.trim() || null
    const homePath = window.electron.homedir ?? ''
    const skillsPath = workspacePath ? `${workspacePath}/.codesurf/customisation/skills.json` : null
    const locationsPath = workspacePath ? `${workspacePath}/.codesurf/customisation/locations-skills.json` : null
    const promptLocationsPath = workspacePath ? `${workspacePath}/.codesurf/customisation/locations-prompts.json` : null

    ;(async () => {
      const discovered = new Map<string, SkillDefinition>()

      const registerSkill = (skill: SkillDefinition) => {
        const key = skill.name.trim().toLowerCase()
        if (!key || discovered.has(key)) return
        discovered.set(key, skill)
      }

      if (skillsPath) {
        const savedRaw = await window.electron.fs.readFile(skillsPath).catch(() => '')
        if (savedRaw) {
          try {
            const parsed = JSON.parse(savedRaw)
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (
                  typeof item === 'object'
                  && item !== null
                  && typeof (item as { id?: unknown }).id === 'string'
                  && typeof (item as { name?: unknown }).name === 'string'
                  && typeof (item as { content?: unknown }).content === 'string'
                ) {
                  registerSkill(item as SkillDefinition)
                }
              }
            }
          } catch {
            // Ignore invalid JSON and continue with discovery.
          }
        }
      }

      const readLocationsFile = async (path: string | null): Promise<string> => {
        if (!path) return ''
        const raw = await window.electron.fs.readFile(path).catch(() => '')
        if (!raw) return ''
        try {
          const parsed = JSON.parse(raw)
          if (typeof parsed === 'string') return parsed
        } catch {
          return raw
        }
        return ''
      }

      const skillsLocationsText = await readLocationsFile(locationsPath)
      const promptsLocationsText = await readLocationsFile(promptLocationsPath)
      const mergedSources = [skillsLocationsText, promptsLocationsText].filter(s => s && s.trim()).join('\n')
      const rawLocations = mergedSources.trim() ? mergedSources : CHAT_DEFAULT_SKILL_LOCATIONS

      const seenDirs = new Set<string>()
      const dirs = resolveChatSkillLocations(rawLocations, homePath, workspacePath).filter(d => {
        if (seenDirs.has(d)) return false
        seenDirs.add(d)
        return true
      })

      const registerDiscoveredSkill = (filePath: string, fallbackName: string, content: string, dir: string): void => {
        const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
        const name = frontmatter.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim() ?? fallbackName
        const description = frontmatter.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim() ?? `From ${dir}`
        // P1b-2: an optional `model:`/`provider:` frontmatter key declares a HARD
        // model lock for any persona that links this skill (see resolveSkillModelLock).
        // Parse them ONLY from the leading `---`-fenced frontmatter block, line-anchored,
        // so prose like "pick the best model: fast" in the body never trips a spurious lock.
        const requiredModel = frontmatter.match(/^model:\s*(.+?)\s*$/m)?.[1]?.trim() || undefined
        const requiredProvider = frontmatter.match(/^provider:\s*(.+?)\s*$/m)?.[1]?.trim() || undefined
        registerSkill({
          id: `discovered-${filePath}`,
          name,
          description,
          content,
          command: name,
          ...(requiredModel ? { requiredModel } : {}),
          ...(requiredProvider ? { requiredProvider } : {}),
        })
      }

      for (const dir of dirs) {
        const entries: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await window.electron.fs.readDir(dir).catch(() => [])
        for (const entry of entries) {
          if (entry.isDir) {
            const sub: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await window.electron.fs.readDir(entry.path).catch(() => [])
            const skillFile = sub.find(e => !e.isDir && /^skill\.md$/i.test(e.name))
              ?? sub.find(e => !e.isDir && /^skill\.(txt|mdc)$/i.test(e.name))
            if (!skillFile) continue
            const content = await window.electron.fs.readFile(skillFile.path).catch(() => '')
            if (!content) continue
            registerDiscoveredSkill(skillFile.path, entry.name, content, dir)
            continue
          }
          if (entry.ext !== '.md' && entry.ext !== '.txt' && entry.ext !== '.mdc') continue
          const content = await window.electron.fs.readFile(entry.path).catch(() => '')
          if (!content) continue
          registerDiscoveredSkill(entry.path, entry.name.replace(/\.(md|txt|mdc)$/i, ''), content, dir)
        }
      }

      if (cancelled) return
      setWorkspaceSkills(Array.from(discovered.values()).sort((a, b) => a.name.localeCompare(b.name)))
    })().catch(() => {
      if (!cancelled) setWorkspaceSkills([])
    })

    return () => { cancelled = true }
  }, [workspaceDir, skillLocationsVersion])

  return { workspaceSkills }
}