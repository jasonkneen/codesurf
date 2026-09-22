import { useEffect, useMemo } from 'react'
import { stripCapabilityPrefix, getAllNodeTools } from '../../../shared/nodeTools'
import { useMCPServers } from './useMCPServers'
import { CHAT_SLASH_COMMANDS } from './useChatAutocomplete'
import type { SkillDefinition } from '../../../shared/types'
import type { DiscoveryPeer } from '../components/chat/chatTileUtils'

export function useChatTileInventories(options: {
  tileId: string
  provider: string
  model: string
  mcpEnabled: boolean
  connectedPeers: DiscoveryPeer[]
  workspaceSkills: SkillDefinition[]
}) {
  const { tileId, provider, model, mcpEnabled, connectedPeers, workspaceSkills } = options
  const mcpServers = useMCPServers()

  const peerToolNames = useMemo(() => {
    const discovered = new Set<string>()
    const validTool = new Set(getAllNodeTools().map(tool => tool.name))

    for (const peer of connectedPeers) {
      for (const cap of peer.capabilities) {
        if (!cap.startsWith('tool:')) continue
        const toolName = stripCapabilityPrefix(cap)
        if (toolName && validTool.has(toolName)) {
          discovered.add(toolName)
        }
      }
      if (peer.actions) {
        for (const action of peer.actions) {
          if (action.name) discovered.add(action.name)
        }
      }
    }

    return Array.from(discovered).sort()
  }, [connectedPeers])

  const availableToolInventory = useMemo(() => {
    const items: Array<{ id: string; label: string; source: 'builtin' | 'peer' | 'mcp-server'; detail?: string }> = []
    const seen = new Set<string>()

    for (const tool of getAllNodeTools()) {
      if (seen.has(`builtin:${tool.name}`)) continue
      seen.add(`builtin:${tool.name}`)
      items.push({
        id: `builtin:${tool.name}`,
        label: tool.name,
        source: 'builtin',
        detail: tool.description,
      })
    }

    if (mcpEnabled) {
      for (const server of mcpServers) {
        const key = `mcp-server:${server.name}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          id: key,
          label: server.name,
          source: 'mcp-server',
          detail: server.url ? 'http server' : 'stdio server',
        })
      }

      for (const toolName of peerToolNames) {
        const key = `peer:${toolName}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          id: key,
          label: toolName,
          source: 'peer',
          detail: 'Connected peer tool',
        })
      }
    }

    return items.sort((a, b) => {
      const sourceOrder = { builtin: 0, peer: 1, 'mcp-server': 2 }
      const sourceDelta = sourceOrder[a.source] - sourceOrder[b.source]
      if (sourceDelta !== 0) return sourceDelta
      return a.label.localeCompare(b.label)
    })
  }, [mcpEnabled, mcpServers, peerToolNames])

  const availableSkillInventory = useMemo(() => {
    const items: Array<{ id: string; name: string; enabled: boolean; source: 'workspace' | 'command'; description?: string }> = []
    const seen = new Set<string>()

    for (const skill of workspaceSkills) {
      const key = `workspace:${skill.name}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        id: skill.id || key,
        name: skill.name,
        enabled: true,
        source: 'workspace',
        description: skill.description,
      })
    }

    for (const command of CHAT_SLASH_COMMANDS) {
      const key = `command:${command.value}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        id: key,
        name: command.value,
        enabled: true,
        source: 'command',
        description: command.description,
      })
    }

    return items.sort((a, b) => {
      const sourceOrder = { workspace: 0, command: 1 }
      const sourceDelta = sourceOrder[a.source] - sourceOrder[b.source]
      if (sourceDelta !== 0) return sourceDelta
      return a.name.localeCompare(b.name)
    })
  }, [workspaceSkills])

  useEffect(() => {
    window.electron?.bus?.publish(`tile:${tileId}`, 'tool_inventory', `chat:${tileId}`, {
      provider,
      model,
      mcpEnabled,
      tools: availableToolInventory,
      updatedAt: Date.now(),
    })
  }, [tileId, provider, model, mcpEnabled, availableToolInventory])

  useEffect(() => {
    window.electron?.bus?.publish(`tile:${tileId}`, 'skill_inventory', `chat:${tileId}`, {
      provider,
      model,
      skills: availableSkillInventory,
      updatedAt: Date.now(),
    })
  }, [tileId, provider, model, availableSkillInventory])

  return {
    mcpServers,
    peerToolNames,
    availableToolInventory,
    availableSkillInventory,
  }
}