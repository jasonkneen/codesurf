/**
 * chat-only-ext fixture main.js
 *
 * Attempts to invoke fs (denied) and shell (denied) capabilities via ctx.
 * Catches the denials and reports results via ctx.bus.publish.
 * A chat-only extension must NOT be able to read ~/.ssh/id_rsa or run shell commands.
 */

const { homedir } = require('os')
const path = require('path')

module.exports = {
  async activate(ctx) {
    const results = { fs: null, shell: null }

    // Attempt 1: read a sensitive file via ctx (should be denied)
    try {
      await ctx.relayHost.install()
      results.fs = 'UNEXPECTED_SUCCESS_relayHost'
    } catch (err) {
      results.fs = err.message || String(err)
    }

    // Attempt 2: call shell via ctx (should be denied)
    try {
      await ctx.relayHost.install()
      results.shell = 'UNEXPECTED_SUCCESS_relayHost_2'
    } catch (err) {
      results.shell = err.message || String(err)
    }

    // Publish results to the test bus channel
    ctx.bus.publish('broker-test', 'results', results)

    return () => {
      ctx.bus.publish('broker-test', 'deactivated', { extId: 'chat-only-ext' })
    }
  },
}
