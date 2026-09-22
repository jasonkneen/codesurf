#!/usr/bin/env node
/**
 * CodeSurf Extension Dev Harness Server
 * Serves examples/extensions/ as static root + /api/extensions discovery
 * for both tile entries and chat-surface entries.
 *
 * Usage: node server.mjs [port=4040]
 */

import { createServer } from 'http'
import { readFile, readdir } from 'fs/promises'
import { extname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

export const DEFAULT_PORT = 4040
const __dir = fileURLToPath(new URL('.', import.meta.url))
export const ROOT = resolve(__dir, '..')   // examples/extensions/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export async function discoverExtensions(root = ROOT) {
  const entries = await readdir(root)
  const exts = []
  for (const name of entries) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const manifestPath = join(root, name, 'extension.json')
    try {
      const raw = await readFile(manifestPath, 'utf8')
      const manifest = JSON.parse(raw)
      exts.push({ dir: name, ...manifest })
    } catch {}
  }
  return exts
}

export function createHarnessServer(root = ROOT) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    res.setHeader('Access-Control-Allow-Origin', '*')

    if (pathname === '/api/extensions') {
      try {
        const exts = await discoverExtensions(root)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(exts))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    const filePath = pathname === '/' ? '/_harness/index.html' : pathname
    const abs = resolve(root, filePath.replace(/^\//, ''))
    if (!abs.startsWith(root)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    try {
      const data = await readFile(abs)
      const ext = extname(abs)
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Not found: ' + filePath)
    }
  })
}

export async function startHarnessServer(
  port = DEFAULT_PORT,
  opts = {},
) {
  const listenHost = opts.listenHost ?? '127.0.0.1'
  const displayHost = opts.displayHost ?? '127.0.0.1'
  const root = opts.root ?? ROOT
  const quiet = opts.quiet ?? false
  const server = createHarnessServer(root)

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(port, listenHost, () => {
      server.off('error', rejectPromise)
      resolvePromise()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${displayHost}:${actualPort}`

  if (!quiet) {
    console.log(`\n  CodeSurf Extension Harness`)
    console.log(`  ${url}\n`)
  }

  return { server, port: actualPort, url }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rawPort = Number.parseInt(process.argv[2] ?? `${DEFAULT_PORT}`, 10)
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : DEFAULT_PORT

  startHarnessServer(port, { listenHost: '0.0.0.0', displayHost: 'localhost' }).catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
