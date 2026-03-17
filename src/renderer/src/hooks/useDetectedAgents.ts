import { useEffect, useState } from 'react'
import type { DetectedAgent } from '../components/KanbanCard'

let cached: DetectedAgent[] | null = null

export function useDetectedAgents(): DetectedAgent[] {
  const [agents, setAgents] = useState<DetectedAgent[]>(cached ?? [])

  useEffect(() => {
    if (cached) { setAgents(cached); return }
    window.electron?.agents?.detect?.().then((detected: DetectedAgent[]) => {
      // Always include Shell, then available agents, then unavailable (greyed)
      const sorted = [
        ...detected.filter(a => a.id === 'shell'),
        ...detected.filter(a => a.id !== 'shell' && a.available),
        ...detected.filter(a => a.id !== 'shell' && !a.available)
      ]
      cached = sorted
      setAgents(sorted)
    }).catch(() => {
      // fallback — show common ones
      setAgents([
        { id: 'shell',  label: 'Shell',  cmd: 'zsh',    available: true },
        { id: 'claude', label: 'Claude', cmd: 'claude', available: true },
        { id: 'codex',  label: 'Codex',  cmd: 'codex',  available: true },
      ])
    })
  }, [])

  return agents
}
