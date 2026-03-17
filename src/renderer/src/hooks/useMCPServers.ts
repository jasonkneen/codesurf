import { useEffect, useState } from 'react'

export interface MCPServerEntry {
  name: string
  url?: string
  cmd?: string
  description?: string
  enabled: boolean
}

let cached: MCPServerEntry[] | null = null
let listeners: Array<(s: MCPServerEntry[]) => void> = []

function notify(servers: MCPServerEntry[]) {
  cached = servers
  listeners.forEach(fn => fn(servers))
}

export async function loadMCPServers(): Promise<MCPServerEntry[]> {
  try {
    const home = (window as any).process?.env?.HOME ?? ''
    const path = `${home}/clawd-collab/mcp-server.json`
    const raw = await window.electron.fs.readFile(path)
    const cfg = JSON.parse(raw)
    const servers: MCPServerEntry[] = Object.entries(cfg.mcpServers ?? {}).map(([name, s]: [string, any]) => ({
      name,
      url: s.url,
      cmd: s.cmd,
      description: s.description,
      enabled: s.enabled !== false
    }))
    notify(servers)
    return servers
  } catch {
    return []
  }
}

export function useMCPServers(): MCPServerEntry[] {
  const [servers, setServers] = useState<MCPServerEntry[]>(cached ?? [])

  useEffect(() => {
    if (cached) { setServers(cached); return }
    loadMCPServers().then(setServers)
    listeners.push(setServers)
    return () => { listeners = listeners.filter(fn => fn !== setServers) }
  }, [])

  return servers.filter(s => s.enabled)
}
