/**
 * ipc-ext fixture main.js
 *
 * Registers an ipcMain handler via ctx.ipc.handle.
 * Used to verify that deactivate() properly removes the handler so the
 * extension can be re-activated without hitting "second handler" errors.
 */

module.exports = {
  async activate(ctx) {
    ctx.ipc.handle('ping', async () => 'pong')
    ctx.bus.publish('broker-test', 'ipc-activated', { extId: 'ipc-ext' })

    return () => {
      ctx.bus.publish('broker-test', 'ipc-deactivated', { extId: 'ipc-ext' })
    }
  },
}
