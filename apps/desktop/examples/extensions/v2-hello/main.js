/**
 * v2-hello reference extension — minimal host entry.
 *
 * Safe-tier plugins run in iframe; main.js is only loaded for power tier.
 * Declared here so manifest validation passes and authors can copy the stub
 * when upgrading to tier: "power".
 */
module.exports = {
  activate(_ctx) {},
}