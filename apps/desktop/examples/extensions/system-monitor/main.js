/**
 * System monitor power extension.
 * Publishes CPU/memory stats to the event bus every 2 seconds.
 */

const os = require('os')

module.exports = {
  activate(ctx) {
    ctx.log('System monitor activated')

    let prevCpuTimes = os.cpus().map(c => c.times)

    function getStats() {
      const cpus = os.cpus()
      const cpuPercents = cpus.map((cpu, i) => {
        const prev = prevCpuTimes[i]
        const curr = cpu.times
        const userDiff = curr.user - prev.user
        const niceDiff = curr.nice - prev.nice
        const sysDiff = curr.sys - prev.sys
        const idleDiff = curr.idle - prev.idle
        const irqDiff = curr.irq - prev.irq
        const total = userDiff + niceDiff + sysDiff + idleDiff + irqDiff
        return total > 0 ? Math.round(((total - idleDiff) / total) * 100) : 0
      })
      prevCpuTimes = cpus.map(c => c.times)

      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem
      const memPercent = Math.round((usedMem / totalMem) * 100)

      return {
        cpuAvg: Math.round(cpuPercents.reduce((a, b) => a + b, 0) / cpuPercents.length),
        cpuCores: cpuPercents,
        memPercent,
        memUsedGB: (usedMem / 1073741824).toFixed(1),
        memTotalGB: (totalMem / 1073741824).toFixed(1),
        uptime: os.uptime(),
        loadAvg: os.loadavg().map(l => l.toFixed(2)),
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
      }
    }

    // Publish stats every 2s
    const interval = setInterval(() => {
      const stats = getStats()
      ctx.bus.publish('sysmon', 'data', stats)
    }, 2000)

    // MCP tool: get stats on demand
    ctx.mcp.registerTool({
      name: 'stats',
      description: 'Get current system CPU and memory usage statistics.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(getStats()),
    })

    return () => {
      clearInterval(interval)
      ctx.log('System monitor deactivated')
    }
  },
}
