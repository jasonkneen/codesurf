const http = require('node:http')

const TOOL_SET = new Set(['Read', 'Edit', 'Write', 'MultiEdit'])

function extractPath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null
  return toolInput.file_path || toolInput.path || toolInput.notebook_path || null
}

function startIngestServer({ onEvent, host = '127.0.0.1', port = 0 } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/ingest') {
        res.writeHead(404); res.end('not found'); return
      }

      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let payload
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ignored":true}'); return }

        const tool = payload.tool_name
        if (!TOOL_SET.has(tool)) {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ignored":true}'); return
        }
        const filePath = extractPath(payload.tool_input)
        if (!filePath) {
          res.writeHead(200); res.end('{"ignored":true}'); return
        }

        try {
          onEvent({
            tool,
            path: filePath,
            cwd: payload.cwd || process.cwd(),
            sessionId: payload.session_id || 'unknown',
            ts: Math.floor(Date.now() / 1000),
          })
        } catch { /* swallow — hook must never see an error */ }

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      req.on('error', () => { try { res.writeHead(200); res.end('{"ignored":true}') } catch {} })
    })

    server.listen(port, host, () => {
      const addr = server.address()
      resolve({
        port: addr.port,
        host,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

module.exports = { startIngestServer }
