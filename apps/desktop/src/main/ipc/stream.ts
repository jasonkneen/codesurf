import { ipcMain, type WebContents } from 'electron'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { promises as dnsPromises } from 'dns'
import { getStreamParser } from '../agent-stream'
import { assertSafeStreamUrl } from '../utils/urlSafety'
import { broadcastToRenderer } from '../utils/broadcast'

interface StreamRequest {
  cardId: string
  agentId: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

const activeStreams = new Map<string, ReturnType<typeof httpRequest>>()

// Track which cardIds each renderer owns so a window crash/reload that bypasses
// stream:stop still reclaims the live HTTP/SSE request and its Map entry, the
// same way terminal.ts / fs.ts / bus.ts handle 'destroyed'.
const senderCardIds = new WeakMap<WebContents, Set<string>>()
const senderCleanupAttached = new WeakSet<WebContents>()

function destroyStream(cardId: string): void {
  activeStreams.get(cardId)?.destroy()
  activeStreams.delete(cardId)
}

function trackStreamSender(sender: WebContents, cardId: string): void {
  let ids = senderCardIds.get(sender)
  if (!ids) {
    ids = new Set()
    senderCardIds.set(sender, ids)
  }
  ids.add(cardId)
  if (!senderCleanupAttached.has(sender)) {
    senderCleanupAttached.add(sender)
    sender.once('destroyed', () => {
      const owned = senderCardIds.get(sender)
      if (owned) {
        for (const id of owned) destroyStream(id)
        senderCardIds.delete(sender)
      }
    })
  }
}

export function registerStreamIPC(): void {
  ipcMain.handle('stream:start', async (event, req: StreamRequest) => {
    // Kill existing stream for this card
    if (activeStreams.has(req.cardId)) {
      activeStreams.get(req.cardId)?.destroy()
      activeStreams.delete(req.cardId)
    }

    assertSafeStreamUrl(req.url)

    const url = new URL(req.url)
    const isHttps = url.protocol === 'https:'
    const reqFn = isHttps ? httpsRequest : httpRequest

    // Resolve DNS before connecting and verify the resolved IP is not private.
    // This prevents DNS rebinding attacks where an attacker-controlled domain
    // resolves to 127.0.0.1, cloud metadata (169.254.169.254), or internal IPs.
    let resolvedAddress: string
    try {
      const lookup = await dnsPromises.lookup(url.hostname, { family: 0 })
      resolvedAddress = lookup.address
    } catch (err) {
      throw new Error(`DNS resolution failed for ${url.hostname}: ${(err as Error).message}`)
    }
    // Re-validate the resolved IP against the same blocklists used by assertSafeStreamUrl
    assertSafeStreamUrl(`${url.protocol}//${resolvedAddress}:${url.port || (isHttps ? 443 : 80)}${url.pathname}${url.search}`)

    const options = {
      hostname: resolvedAddress,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Host': url.host,
        ...(req.headers ?? {})
      }
    }

    return new Promise<{ ok: boolean }>((resolve, reject) => {
      // Declare httpReq first so reclaim can close over the binding safely.
      let httpReq: ReturnType<typeof httpRequest>
      const reclaim = (): void => {
        // Only reclaim if we still own the slot (a newer stream:start for the
        // same cardId would have replaced the Map entry already).
        if (activeStreams.get(req.cardId) === httpReq) {
          activeStreams.delete(req.cardId)
        }
        senderCardIds.get(event.sender)?.delete(req.cardId)
      }

      httpReq = reqFn(options, res => {
        // Non-2xx responses (401/403/500/etc.) carry an error body, not SSE.
        // Feeding them to the stream parser produces an empty/garbled transcript;
        // surface a real error instead (M4).
        const status = res.statusCode ?? 0
        if (status >= 400) {
          let body = ''
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            const message = `Upstream returned ${status}${body.trim() ? `: ${body.trim().slice(0, 500)}` : ''}`
            broadcastToRenderer('agent:stream', {
              cardId: req.cardId, type: 'error', error: message
            })
            reclaim()
            reject(new Error(message))
          }
          // Cap body at 4KB without destroy()-before-end so the error path
          // still settles (BUG-03). Truncate further reads instead.
          res.on('data', (chunk: Buffer | string) => {
            if (body.length < 4096) {
              body += chunk
              if (body.length > 4096) body = body.slice(0, 4096)
            }
          })
          res.on('end', finish)
          res.on('error', finish)
          res.on('close', () => { if (!settled) finish() })
          return
        }
        // Successful SSE: reclaim the Map entry when the response ends so
        // completed multi-turn streams don't leak sockets forever.
        res.on('end', reclaim)
        res.on('close', reclaim)
        res.on('error', reclaim)
        const parse = getStreamParser(req.agentId)
        parse(req.cardId, res)
        resolve({ ok: true })
      })

      httpReq.on('error', err => {
        // Send error to renderer
        broadcastToRenderer('agent:stream', {
          cardId: req.cardId, type: 'error', error: err.message
        })
        reclaim()
        reject(err)
      })
      httpReq.on('close', reclaim)

      if (req.body) httpReq.write(req.body)
      httpReq.end()

      activeStreams.set(req.cardId, httpReq)
      trackStreamSender(event.sender, req.cardId)
    })
  })

  ipcMain.handle('stream:stop', async (event, cardId: string) => {
    destroyStream(cardId)
    senderCardIds.get(event.sender)?.delete(cardId)
  })
}
