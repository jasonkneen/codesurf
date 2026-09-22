/**
 * crashy-ext fixture main.js
 *
 * Activates successfully and publishes an 'activated' event.
 * The test kills this child process via SIGKILL to verify crash recovery.
 */

module.exports = {
  async activate(ctx) {
    ctx.bus.publish('broker-test', 'activated', { extId: 'crashy-ext' })

    return () => {
      ctx.bus.publish('broker-test', 'deactivated', { extId: 'crashy-ext' })
    }
  },
}
