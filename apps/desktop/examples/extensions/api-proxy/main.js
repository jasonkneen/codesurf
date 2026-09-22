/**
 * API Proxy extension host.
 *
 * Subscribes to the localProxy:stats event bus channel and caches live status.
 * Exposes ext:api-proxy:getStatus so the tile can poll without needing window.electron.
 *
 * Start/stop is handled directly by the renderer via window.electron.localProxy.
 */

let cachedStatus = {
  running: false,
  port: 1337,
  uptime: null,        // ms since start
  connections: 0,
  requests: 0,
  requestsFailed: 0,
  activeConnections: [],
}

module.exports = {
  activate(ctx) {
    ctx.log('API Proxy extension activated')

    // Keep status cache current via bus events from the core proxy
    ctx.bus.subscribe('localProxy:stats', 'api-proxy-ext', (event) => {
      const p = event?.payload ?? {}
      const action = p.action

      if (action === 'started') {
        cachedStatus.running = true
        cachedStatus.port = p.port ?? cachedStatus.port
        cachedStatus.uptime = 0
      } else if (action === 'stopped') {
        cachedStatus.running = false
        cachedStatus.uptime = null
        cachedStatus.connections = 0
        cachedStatus.activeConnections = []
      } else if (action === 'update') {
        // stat update after each request
        cachedStatus.requests = p.requestsServed ?? cachedStatus.requests
        cachedStatus.requestsFailed = p.requestsFailed ?? cachedStatus.requestsFailed
        cachedStatus.activeConnections = (p.activeConnections ?? []).map(c => ({
          host: c.remoteAddr,
          model: c.model,
          backend: c.backend,
          id: c.id,
        }))
        cachedStatus.connections = cachedStatus.activeConnections.length
        if (p.startedAt) {
          cachedStatus.uptime = Date.now() - p.startedAt
        }
      }
    })

    // tile calls: bridge.ext.invoke('getStatus')
    ctx.ipc.handle('getStatus', () => {
      // Refresh uptime if running
      if (cachedStatus.running) {
        // uptime maintained approximately via last known startedAt delta
        // (updated on each bus event; good enough for 5s polling)
      }
      return { ...cachedStatus }
    })

    // Probe local backends on demand
    ctx.ipc.handle('probeBackends', async () => {
      const http = require('http')
      const backends = [
        { name: 'Ollama',    base: 'http://localhost:11434', path: '/api/chat' },
        { name: 'LM Studio', base: 'http://localhost:1234',  path: '/v1/chat/completions' },
        { name: 'llama.cpp', base: 'http://localhost:8080',  path: '/v1/chat/completions' },
      ]
      return Promise.all(backends.map(b =>
        new Promise(resolve => {
          const url = new URL(b.base)
          const req = http.request({
            hostname: url.hostname, port: url.port || 80,
            path: b.path, method: 'GET', timeout: 800,
          }, res => resolve({ name: b.name, base: b.base, live: res.statusCode < 500 }))
          req.on('error', () => resolve({ name: b.name, base: b.base, live: false }))
          req.on('timeout', () => { req.destroy(); resolve({ name: b.name, base: b.base, live: false }) })
          req.end()
        })
      ))
    })

    ctx.mcp.registerTool({
      name: 'status',
      description: 'Get the status of the local OpenAI-compat API proxy. Returns running state, port, request count, active connections.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(cachedStatus),
    })

    return () => ctx.log('API Proxy extension deactivated')
  },
}
