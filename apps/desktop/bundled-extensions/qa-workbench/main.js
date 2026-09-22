const {
  createWorkbenchState,
  applyBrowserBusEvent,
  buildQaWorkbenchReport,
  buildChatSurfacePayload,
  buildVisualFixHandoff,
  serializeWorkbenchState,
} = require('./shared.js')

const EXT_ID = 'qa-workbench'

function normalizeBrowserIds(input, state) {
  const explicit = Array.isArray(input) ? input : []
  const ids = explicit
    .map(id => String(id || '').trim())
    .filter(Boolean)

  if (ids.length > 0) return Array.from(new Set(ids))
  return Array.isArray(state.browserOrder) ? state.browserOrder.slice() : []
}

function publishBrowserCommand(ctx, tileId, command) {
  ctx.bus.publish(`tile:${tileId}`, 'mcp_qa_command', {
    command,
    requester: EXT_ID,
    requestedAt: Date.now(),
  })
}

module.exports = {
  activate(ctx) {
    const maxEvents = Number(ctx.settings.get('maxEvents')) || 120
    const state = createWorkbenchState({ maxEvents })

    ctx.log('QA Workbench activated')

    ctx.bus.subscribe('tile:*', `${EXT_ID}:browser-evidence`, (event) => {
      try {
        applyBrowserBusEvent(state, event)
      } catch (error) {
        ctx.log(`Failed to process browser evidence: ${error && error.message ? error.message : String(error)}`)
      }
    })

    ctx.ipc.handle('getState', (options = {}) => {
      return serializeWorkbenchState(state, {
        now: Date.now(),
        includeBrowserReports: options && options.includeBrowserReports !== false,
      })
    })

    ctx.ipc.handle('getReport', (options = {}) => {
      const report = buildQaWorkbenchReport(state, {
        now: Date.now(),
        includeBrowserReports: options && options.includeBrowserReports !== false,
      })
      state.report = report
      ctx.bus.publish('workspace:qa-workbench', 'data', {
        kind: 'qa-workbench.report',
        report,
        summary: serializeWorkbenchState(state).summary,
      })
      return report
    })

    ctx.ipc.handle('getChatPayload', (options = {}) => {
      return buildChatSurfacePayload(state, {
        now: Date.now(),
        includeBrowserReports: options && options.includeBrowserReports !== false,
      })
    })

    ctx.ipc.handle('getVisualFixHandoff', (options = {}) => {
      const handoff = buildVisualFixHandoff(state, {
        now: Date.now(),
        includeBrowserReports: options && options.includeBrowserReports !== false,
      })
      state.report = handoff.report
      ctx.bus.publish('workspace:qa-workbench', 'data', {
        kind: 'qa-workbench.visual_fix_handoff',
        handoff,
        summary: handoff.summary,
      })
      return handoff
    })

    ctx.ipc.handle('captureAll', (browserIds = []) => {
      const ids = normalizeBrowserIds(browserIds, state)
      for (const tileId of ids) {
        publishBrowserCommand(ctx, tileId, 'browser_capture_snapshot')
      }
      state.capturesRequestedAt = Date.now()
      return {
        requested: ids.length,
        browserIds: ids,
        requestedAt: state.capturesRequestedAt,
      }
    })

    ctx.ipc.handle('requestEvidence', (browserIds = []) => {
      const ids = normalizeBrowserIds(browserIds, state)
      for (const tileId of ids) {
        publishBrowserCommand(ctx, tileId, 'browser_get_evidence')
      }
      return {
        requested: ids.length,
        browserIds: ids,
        requestedAt: Date.now(),
      }
    })

    ctx.mcp.registerTool({
      name: 'report',
      description: 'Return the latest markdown QA Workbench browser evidence report.',
      inputSchema: {
        type: 'object',
        properties: {
          includeBrowserReports: { type: 'boolean' },
        },
      },
      handler: async (args = {}) => buildQaWorkbenchReport(state, {
        now: Date.now(),
        includeBrowserReports: args.includeBrowserReports !== false,
      }),
    })

    ctx.mcp.registerTool({
      name: 'visual_fix_handoff',
      description: 'Return a Builder-ready QA/browser evidence handoff for visual frontend fixes.',
      inputSchema: {
        type: 'object',
        properties: {
          includeBrowserReports: { type: 'boolean' },
        },
      },
      handler: async (args = {}) => JSON.stringify(buildVisualFixHandoff(state, {
        now: Date.now(),
        includeBrowserReports: args.includeBrowserReports !== false,
      })),
    })

    ctx.mcp.registerTool({
      name: 'capture_all',
      description: 'Request evidence snapshots from known BrowserTile instances. Params: { browserIds?: string[] }',
      inputSchema: {
        type: 'object',
        properties: {
          browserIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      handler: async (args = {}) => {
        const ids = normalizeBrowserIds(args.browserIds, state)
        for (const tileId of ids) {
          publishBrowserCommand(ctx, tileId, 'browser_capture_snapshot')
        }
        state.capturesRequestedAt = Date.now()
        return JSON.stringify({ requested: ids.length, browserIds: ids })
      },
    })

    return () => {
      ctx.log('QA Workbench deactivated')
    }
  },
}
