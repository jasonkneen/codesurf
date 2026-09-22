/**
 * Workspace agent personas (built-ins + agents.json) for the composer agent menu.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Persona } from '../../../shared/types'
import { loadPersonas, DEFAULT_PERSONAS } from '../config/agentModes'
import { resolveSkillModelLock } from './personaModelBinding'
import type { SkillDefinition } from '../../../shared/types'

export function useChatTileAgentModes(options: {
  workspaceDir: string
  agentId: string | null
  showAgentMenu: boolean
  workspaceSkills: SkillDefinition[]
  setProvider: (provider: string) => void
  setModel: (model: string) => void
}) {
  const {
    workspaceDir,
    agentId,
    showAgentMenu,
    workspaceSkills,
    setProvider,
    setModel,
  } = options

  const [agentModes, setAgentModes] = useState<Persona[]>(DEFAULT_PERSONAS)
  const [agentModesLoaded, setAgentModesLoaded] = useState(false)

  useEffect(() => { setAgentModesLoaded(false) }, [workspaceDir])
  useEffect(() => {
    let cancelled = false
    void loadPersonas(workspaceDir).then(list => {
      if (!cancelled) {
        setAgentModes(list)
        setAgentModesLoaded(true)
      }
    })
    return () => { cancelled = true }
  }, [workspaceDir, showAgentMenu])

  const resolvedAgentMode = useMemo(
    () => agentModes.find(a => a.id === agentId) ?? null,
    [agentModes, agentId],
  )

  const modelLock = useMemo(
    () => resolveSkillModelLock(resolvedAgentMode, workspaceSkills),
    [resolvedAgentMode, workspaceSkills],
  )

  useEffect(() => {
    if (!modelLock) return
    if (modelLock.provider) setProvider(modelLock.provider)
    if (modelLock.model) setModel(modelLock.model)
  }, [modelLock?.provider, modelLock?.model, setProvider, setModel])

  return {
    agentModes,
    setAgentModes,
    agentModesLoaded,
    resolvedAgentMode,
    modelLock,
  }
}
