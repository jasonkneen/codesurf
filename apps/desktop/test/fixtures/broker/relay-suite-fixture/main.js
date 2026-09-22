/**
 * relay-suite-fixture main.js
 *
 * Simulates codesurf-relay-suite calling ctx.relayHost.install().
 * Used by the integration test to verify that a relay-granted extension
 * can call relayHost.install() through the broker.
 */

module.exports = {
  async activate(ctx) {
    let relayResult = null
    try {
      await ctx.relayHost.install()
      relayResult = 'success'
    } catch (err) {
      relayResult = err.message || String(err)
    }

    ctx.bus.publish('broker-test', 'relay-result', { result: relayResult })

    return () => {
      ctx.bus.publish('broker-test', 'deactivated', { extId: 'codesurf-relay-suite' })
    }
  },
}
