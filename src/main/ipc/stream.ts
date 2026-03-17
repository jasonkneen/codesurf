import { ipcMain, BrowserWindow } from 'electron'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { getStreamParser } from '../agent-stream'

interface StreamRequest {
  cardId: string
  agentId: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

const activeStreams = new Map<string, ReturnType<typeof httpRequest>>()

export function registerStreamIPC(): void {
  ipcMain.handle('stream:start', async (event, req: StreamRequest) => {
    // Kill existing stream for this card
    if (activeStreams.has(req.cardId)) {
      activeStreams.get(req.cardId)?.destroy()
      activeStreams.delete(req.cardId)
    }

    const url = new URL(req.url)
    const isHttps = url.protocol === 'https:'
    const reqFn = isHttps ? httpsRequest : httpRequest

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...(req.headers ?? {})
      }
    }

    return new Promise<{ ok: boolean }>((resolve, reject) => {
      const httpReq = reqFn(options, res => {
        const parse = getStreamParser(req.agentId)
        parse(req.cardId, res)
        resolve({ ok: true })
      })

      httpReq.on('error', err => {
        // Send error to renderer
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.webContents.isDestroyed()) {
            win.webContents.send('agent:stream', {
              cardId: req.cardId, type: 'error', error: err.message
            })
          }
        })
        reject(err)
      })

      if (req.body) httpReq.write(req.body)
      httpReq.end()

      activeStreams.set(req.cardId, httpReq)
    })
  })

  ipcMain.handle('stream:stop', async (_, cardId: string) => {
    activeStreams.get(cardId)?.destroy()
    activeStreams.delete(cardId)
  })
}
