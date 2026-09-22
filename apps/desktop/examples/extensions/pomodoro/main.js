/**
 * Pomodoro power extension — registers MCP tools for AI agents.
 *
 * Tools:
 *   - pomodoro_status: Get current pomodoro state
 *   - pomodoro_start: Start/resume the pomodoro timer
 *   - pomodoro_skip: Skip to next phase (work → break → work)
 */

let state = {
  phase: 'idle',      // 'idle' | 'work' | 'break' | 'longBreak'
  remaining: 0,       // seconds remaining in current phase
  cycle: 0,           // completed work cycles
  totalCompleted: 0,  // lifetime completed pomodoros
}

let timer = null

module.exports = {
  activate(ctx) {
    ctx.log('Pomodoro extension activated')

    const workSec = 25 * 60
    const breakSec = 5 * 60
    const longBreakSec = 15 * 60
    const cyclesBeforeLong = 4

    function tick() {
      if (state.remaining > 0) {
        state.remaining--
        ctx.bus.publish('pomodoro', 'data', {
          action: 'tick',
          ...state,
        })
      } else {
        // Phase complete
        if (state.phase === 'work') {
          state.cycle++
          state.totalCompleted++
          if (state.cycle >= cyclesBeforeLong) {
            state.phase = 'longBreak'
            state.remaining = longBreakSec
            state.cycle = 0
          } else {
            state.phase = 'break'
            state.remaining = breakSec
          }
          ctx.bus.publish('pomodoro', 'notification', {
            message: `Work session complete! Take a ${state.phase === 'longBreak' ? 'long ' : ''}break.`,
          })
        } else {
          // Break complete — start next work session
          state.phase = 'work'
          state.remaining = workSec
          ctx.bus.publish('pomodoro', 'notification', {
            message: 'Break over! Time to focus.',
          })
        }
      }
    }

    // MCP: Get status
    ctx.mcp.registerTool({
      name: 'status',
      description: 'Get the current pomodoro timer status: phase, remaining time, completed cycles.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        return JSON.stringify({
          phase: state.phase,
          remainingSeconds: state.remaining,
          remainingFormatted: `${Math.floor(state.remaining / 60)}:${String(state.remaining % 60).padStart(2, '0')}`,
          cycle: state.cycle,
          totalCompleted: state.totalCompleted,
          running: timer !== null,
        })
      },
    })

    // MCP: Start/resume
    ctx.mcp.registerTool({
      name: 'start',
      description: 'Start or resume the pomodoro timer. Begins a 25-minute work session if idle.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (timer) return JSON.stringify({ status: 'already_running' })
        if (state.phase === 'idle') {
          state.phase = 'work'
          state.remaining = workSec
        }
        timer = setInterval(tick, 1000)
        ctx.bus.publish('pomodoro', 'data', { action: 'started', ...state })
        return JSON.stringify({ status: 'started', phase: state.phase, remaining: state.remaining })
      },
    })

    // MCP: Skip phase
    ctx.mcp.registerTool({
      name: 'skip',
      description: 'Skip the current pomodoro phase (work, break, or long break) and advance to the next.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        state.remaining = 0
        tick() // triggers phase transition
        return JSON.stringify({ status: 'skipped', phase: state.phase, remaining: state.remaining })
      },
    })

    // Listen for commands from the tile UI via bus
    ctx.bus.subscribe('pomodoro-cmd', 'pomodoro-ext', (event) => {
      const action = event?.payload?.action
      if (action === 'start') {
        if (!timer && state.phase === 'idle') {
          state.phase = 'work'
          state.remaining = workSec
        }
        if (!timer) timer = setInterval(tick, 1000)
      } else if (action === 'pause') {
        if (timer) { clearInterval(timer); timer = null }
      } else if (action === 'skip') {
        state.remaining = 0
        tick()
      } else if (action === 'reset') {
        if (timer) { clearInterval(timer); timer = null }
        state = { phase: 'idle', remaining: 0, cycle: 0, totalCompleted: state.totalCompleted }
      }
      ctx.bus.publish('pomodoro', 'data', { action: 'update', ...state })
    })

    // Return cleanup function
    return () => {
      if (timer) { clearInterval(timer); timer = null }
      ctx.log('Pomodoro extension deactivated')
    }
  },
}
