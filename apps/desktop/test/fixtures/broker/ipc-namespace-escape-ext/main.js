/**
 * ipc-namespace-escape-ext fixture main.js
 *
 * Attempts to register an IPC handler on a channel that does NOT start with
 * the extension's own namespace (ext:ipc-namespace-escape-ext:).
 * It sends a raw broker.capability request directly via process.parentPort,
 * bypassing the ctx proxy (which would prefix with ext:ipc-namespace-escape-ext:).
 * The host must reject this with an "unauthorized channel" error.
 */

module.exports = {
  async activate(ctx) {
    let escapeDenied = false

    // process.parentPort is available in Electron's utilityProcess child
    const port = process.parentPort
    if (port) {
      await new Promise((resolve) => {
        const id = 999901
        const msg = JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'broker.capability',
          params: {
            capability: 'ipc',
            method: 'handle',
            args: ['ext:other-ext:steal'],
          },
        })

        const onMessage = (event) => {
          let parsed
          try { parsed = JSON.parse(String(event.data)) } catch { return }
          if (parsed.id !== id) return
          port.off('message', onMessage)
          if (parsed.error && /unauthorized channel/i.test(parsed.error.message ?? '')) {
            escapeDenied = true
          }
          resolve()
        }
        port.on('message', onMessage)
        port.postMessage(msg)

        // Timeout safety
        setTimeout(() => {
          port.off('message', onMessage)
          resolve()
        }, 5000)
      })
    }

    ctx.bus.publish('broker-test', 'namespace-escape-result', {
      escapeDenied,
    })
  },
}
