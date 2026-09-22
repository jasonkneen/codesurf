import { ipcMain } from 'electron'
import { executeImageEditTool } from '../mcp-server'

export function registerImageIPC(): void {
  ipcMain.handle('image:edit', async (_, req: {
    workspaceId?: string
    tileId?: string
    prompt?: string
    provider?: string
    model?: string
    outputPath?: string
  }) => {
    const workspaceId = typeof req?.workspaceId === 'string' ? req.workspaceId.trim() : ''
    const tileId = typeof req?.tileId === 'string' ? req.tileId.trim() : ''
    const prompt = typeof req?.prompt === 'string' ? req.prompt.trim() : ''
    if (!workspaceId) return { ok: false, error: 'Missing image workspace id' }
    if (!tileId) return { ok: false, error: 'Missing image block id' }
    if (!prompt) return { ok: false, error: 'Missing image instruction' }

    const result = await executeImageEditTool(workspaceId, tileId, 'image_edit_request', {
      prompt,
      provider: req.provider,
      model: req.model,
      output_path: req.outputPath,
    })
    const ok = /^Image updated via /.test(result)
    return ok ? { ok: true, result } : { ok: false, error: result }
  })
}
