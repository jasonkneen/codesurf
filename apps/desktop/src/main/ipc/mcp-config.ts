import { ipcMain } from 'electron'
import { join } from 'path'
import { promises as fsP } from 'fs'
import { getMCPPort, getMCPToken, buildContexHttpMcpServerEntry } from '../mcp-server'
import { CODESURF_HOME } from '../paths'
import { assertSafePathSegment } from '../security/pathSegments'

const mcpConfigPath = join(CODESURF_HOME, 'mcp-server.json')

// workspaceId is renderer-supplied and interpolated into paths below —
// reject segments that could escape the workspaces dir ('../../tmp/x').
function safeWorkspaceDir(workspaceId: string): string {
  return join(CODESURF_HOME, 'workspaces', assertSafePathSegment(workspaceId, 'workspaceId'))
}

function getRuntimeContexBase(): string | undefined {
  const port = getMCPPort()
  return port ? `http://127.0.0.1:${port}/mcp` : undefined
}

function normalizeMcpServer(entry: unknown, fallbackUrl?: string): Record<string, unknown> {
  if (!entry || typeof entry !== 'object') return fallbackUrl ? { type: 'http', url: fallbackUrl } : {}

  const server = { ...(entry as Record<string, unknown>) }

  if (server.url && typeof server.url === 'string') {
    server.url = server.url.replace(/\/$/, '')
  }

  // Support legacy "cmd" for command-based servers.
  if (!server.command && server.cmd && typeof server.cmd === 'string') {
    const parts = String(server.cmd).trim().split(/\s+/)
    server.command = parts[0]
    if (parts.length > 1) server.args = parts.slice(1)
  }

  if (!server.type) {
    if (server.command) {
      server.type = 'stdio'
    } else if (server.url || fallbackUrl) {
      server.type = 'http'
    }
  }

  if (!server.url && fallbackUrl) {
    server.url = fallbackUrl
  }

  return server
}

function normalizeMcpServers(
  servers: Record<string, unknown>,
  fallbackUrlFn?: (name: string) => string | undefined,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, server] of Object.entries(servers ?? {})) {
    const fallbackUrl = fallbackUrlFn?.(name)
    const normalized = normalizeMcpServer(server, fallbackUrl)
    out[name] = normalized
  }
  return out
}

export function registerMcpConfigIPC(): void {
  ipcMain.handle('mcp:getPort', () => getMCPPort())
  ipcMain.handle('mcp:getToken', () => getMCPToken())

  ipcMain.handle('mcp:getConfig', async () => {
    try {
      const raw = await fsP.readFile(mcpConfigPath, 'utf8')
      const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown>, url?: string, updatedAt?: string }
      const contexBase = (typeof cfg.url === 'string' ? `${cfg.url.replace(/\/$/, '')}/mcp` : undefined) ?? getRuntimeContexBase()
      const globalServers = cfg.mcpServers ?? {}
      const normalizedServers = normalizeMcpServers(globalServers, (name) => {
        if ((name === 'codesurf' || name === 'contex') && contexBase) return contexBase
        return undefined
      })
      if (contexBase) {
        normalizedServers['codesurf'] = {
          ...(normalizedServers['codesurf'] ?? {}),
          ...buildContexHttpMcpServerEntry(contexBase),
        }
      }
      return { ...cfg, mcpServers: normalizedServers }
    } catch { return null }
  })

  ipcMain.handle('mcp:saveServers', async (_, servers: Record<string, unknown>) => {
    try {
      const raw = await fsP.readFile(mcpConfigPath, 'utf8')
      const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown>, url?: string, updatedAt?: string }
      const contexBase = (typeof cfg.url === 'string' ? `${cfg.url.replace(/\/$/, '')}/mcp` : undefined) ?? getRuntimeContexBase()
      const contexServer = normalizeMcpServer(cfg.mcpServers?.codesurf ?? cfg.mcpServers?.contex ?? { url: contexBase }, contexBase)
      delete contexServer.headers
      delete contexServer.token
      const customServers = normalizeMcpServers(servers)
      delete customServers.codesurf
      delete customServers.contex
      delete (cfg as Record<string, unknown>).token
      cfg.mcpServers = {
        codesurf: contexServer,
        ...customServers
      }
      cfg.updatedAt = new Date().toISOString()
      await fsP.writeFile(mcpConfigPath, JSON.stringify(cfg, null, 2), { mode: 0o600 })
      await fsP.chmod(mcpConfigPath, 0o600).catch(() => {})
      return cfg
    } catch (e) { return null }
  })

  // Per-workspace MCP servers
  ipcMain.handle('mcp:getWorkspaceServers', async (_, workspaceId: string) => {
    try {
      const p = join(safeWorkspaceDir(workspaceId), 'mcp-servers.json')
      const raw = await fsP.readFile(p, 'utf8')
      return JSON.parse(raw)
    } catch { return {} }
  })

  ipcMain.handle('mcp:saveWorkspaceServers', async (_, workspaceId: string, servers: Record<string, unknown>) => {
    try {
      const dir = safeWorkspaceDir(workspaceId)
      await fsP.mkdir(dir, { recursive: true })
      const p = join(dir, 'mcp-servers.json')
      const normalized = normalizeMcpServers(servers)
      delete normalized.codesurf
      delete normalized.contex
      await fsP.writeFile(p, JSON.stringify(normalized, null, 2))
      return normalized
    } catch (e) { return null }
  })

  // Merged third-party config for trusted UI inspection. CodeSurf itself is
  // omitted because agents must receive a per-tile credential, never the
  // renderer's global bearer.
  ipcMain.handle('mcp:getMergedConfig', async (_, workspaceId: string) => {
    try {
      // Global config
      let globalCfg: Record<string, unknown> = {}
      try {
        const raw = await fsP.readFile(mcpConfigPath, 'utf8')
        globalCfg = JSON.parse(raw)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[mcp-config] Failed to read global MCP config:', err)
        }
      }

      // Workspace servers
      let wsServers: Record<string, unknown> = {}
      try {
        const wsPath = join(safeWorkspaceDir(workspaceId), 'mcp-servers.json')
        const raw = await fsP.readFile(wsPath, 'utf8')
        wsServers = JSON.parse(raw)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[mcp-config] Failed to read workspace MCP config:', err)
        }
      }

      // Merge: global mcpServers + workspace servers
      const globalServers = (globalCfg as Record<string, Record<string, unknown>>).mcpServers ?? {}
      const normalizedGlobal = normalizeMcpServers(globalServers)
      const normalizedWorkspace = normalizeMcpServers(wsServers)
      delete normalizedGlobal.codesurf
      delete normalizedGlobal.contex
      delete normalizedWorkspace.codesurf
      delete normalizedWorkspace.contex
      const safeGlobalCfg = { ...globalCfg }
      delete safeGlobalCfg.token

      const merged = {
        ...safeGlobalCfg,
        mcpServers: {
          ...normalizedGlobal,
          ...normalizedWorkspace
        },
        workspace: workspaceId,
        mergedAt: new Date().toISOString()
      }

      // Also write a merged file inside .codesurf so it doesn't pollute the workspace root
      const wsContex = join(safeWorkspaceDir(workspaceId), '.codesurf')
      await fsP.mkdir(wsContex, { recursive: true })
      await fsP.writeFile(
        join(wsContex, 'mcp-merged.json'),
        JSON.stringify(merged, null, 2)
      )

      return merged
    } catch (e) { return null }
  })
}
