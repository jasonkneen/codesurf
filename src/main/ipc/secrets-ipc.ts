/**
 * IPC for the secrets store. Renderer can list / set / clear named secrets
 * (API keys for STT/TTS/spokify providers). Values flow renderer → main → disk.
 *
 * Renderer never reads decrypted secrets back. The boolean `hasSecret`
 * lookup is the only way to ask "is this provider configured?"
 */
import { ipcMain } from 'electron'
import { deleteSecret, hasSecret, listSecretNames, setSecret } from '../secrets'
import {
  GATEWAY_SECRET_NAME,
  getGatewayModelsSnapshot,
  invalidateGatewayModelsCache,
} from '../chat/providers/gateway'
import { restartDaemonForGatewayKeyChange } from '../daemon/manager'
import { broadcastToRenderer } from '../utils/broadcast'

/**
 * Propagate an AI Gateway key change everywhere it is cached.
 *
 * Three consumers hold stale state after a key change:
 *  1. the in-process model catalog (a plain module cache),
 *  2. the daemon, which received the key as spawn-time env,
 *  3. open chat tiles, which fetch the catalog once per provider switch.
 *
 * (3) is why the broadcast exists: without it, a user who opens a gateway tile
 * BEFORE configuring a key is left with the hardcoded fallback model list for
 * the lifetime of that tile, because the fetch effect only re-runs when the
 * selected provider changes. Mirrors chat:opencodeModelsUpdated.
 */
function onGatewayKeyChanged(): void {
  invalidateGatewayModelsCache()
  void restartDaemonForGatewayKeyChange().catch(() => { /* best-effort: next spawn reads it */ })
  void getGatewayModelsSnapshot()
    .then(snapshot => { broadcastToRenderer('chat:gatewayModelsUpdated', snapshot) })
    .catch(() => { /* the tile keeps its current list */ })
}

export function registerSecretsIpc(): void {
  ipcMain.handle('secrets:set', (_event, args: { name: string; value: string }) => {
    try {
      const name = String(args?.name ?? '').trim()
      if (!name) return { ok: false, error: 'name required' }
      setSecret(name, String(args?.value ?? ''))
      if (name === GATEWAY_SECRET_NAME) onGatewayKeyChanged()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('secrets:delete', (_event, name: string) => {
    try {
      deleteSecret(String(name ?? ''))
      if (String(name ?? '') === GATEWAY_SECRET_NAME) onGatewayKeyChanged()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('secrets:list', () => {
    return { ok: true, names: listSecretNames() }
  })

  ipcMain.handle('secrets:has', (_event, name: string) => {
    return { ok: true, has: hasSecret(String(name ?? '')) }
  })
}
