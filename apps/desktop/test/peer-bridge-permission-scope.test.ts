import { register } from 'node:module'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const testCodesurfHome = await mkdtemp(join(tmpdir(), 'codesurf-peer-permission-'))
process.env.CODESURF_HOME = testCodesurfHome

const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(\`
        export class BrowserWindow {
          static getAllWindows() { return [] }
          static getFocusedWindow() { return null }
          isDestroyed() { return false }
        }
        export const dialog = {
          showMessageBox: async () => {
            globalThis.__peerPermissionDialogCalls = (globalThis.__peerPermissionDialogCalls ?? 0) + 1
            return { response: 5, checkboxChecked: false }
          },
        }
      \`),
    }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.(ts|js|json|node)$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {}
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)

const { handlePeerBridgeTool } = await import('../src/main/mcp/tools/peer-bridge.ts')
const { bus } = await import('../src/main/event-bus.ts')
const { resolveStoredPermission } = await import('../src/main/permissions.ts')

test('legacy global MCP grants are migrated away and never authorize a scoped request', () => {
  writeFileSync(join(testCodesurfHome, 'permissions.json'), JSON.stringify({
    version: 1,
    grants: [{
      id: 'legacy-global-mcp',
      provider: 'mcp',
      toolName: 'terminal_send_input',
      action: 'allow',
      scope: 'forever',
      workspaceDir: null,
      createdAt: new Date().toISOString(),
    }],
  }))

  assert.equal(resolveStoredPermission({
    provider: 'mcp',
    toolName: 'terminal_send_input',
    workspaceDir: join(testCodesurfHome, 'workspace-a'),
  }), null)
  const migrated = JSON.parse(readFileSync(join(testCodesurfHome, 'permissions.json'), 'utf8')) as { grants?: unknown[] }
  assert.deepEqual(migrated.grants, [])
})

test('terminal and note peer tools reject an unresolved permission scope before prompting or dispatching', async t => {
  t.after(() => {
    rmSync(testCodesurfHome, { recursive: true, force: true })
  })

  const workspaceId = 'unresolved-permission-workspace'
  const callerTileId = 'permission-caller'
  const terminalTileId = 'permission-terminal'
  const noteTileId = 'permission-note'
  const terminalChannel = `tile:${workspaceId}:${terminalTileId}`
  const noteChannel = `tile:${workspaceId}:${noteTileId}`
  const canvasDir = join(testCodesurfHome, 'workspaces', workspaceId, '.codesurf')
  const terminalEvents: unknown[] = []
  const noteEvents: unknown[] = []

  mkdirSync(canvasDir, { recursive: true })
  writeFileSync(join(canvasDir, 'canvas-state.json'), JSON.stringify({
    tiles: [
      { id: callerTileId, type: 'chat' },
      { id: terminalTileId, type: 'terminal' },
      { id: noteTileId, type: 'note' },
    ],
    lockedConnections: [
      { sourceTileId: callerTileId, targetTileId: terminalTileId },
      { sourceTileId: callerTileId, targetTileId: noteTileId },
    ],
  }))

  bus.subscribe(terminalChannel, 'unresolved-permission-terminal', event => {
    terminalEvents.push(event)
  })
  bus.subscribe(noteChannel, 'unresolved-permission-note', event => {
    noteEvents.push(event)
  })
  t.after(() => {
    bus.unsubscribeAll('unresolved-permission-terminal')
    bus.unsubscribeAll('unresolved-permission-note')
    bus.dropChannel(terminalChannel)
    bus.dropChannel(noteChannel)
  })

  const globals = globalThis as Record<string, unknown>
  globals.__peerPermissionDialogCalls = 0
  t.after(() => {
    delete globals.__peerPermissionDialogCalls
  })

  const ctx = {
    principal: { kind: 'tile' as const, workspaceId, tileId: callerTileId },
    sendToRenderer: () => {},
    getExtensionRegistry: () => null,
    pushSSE: () => {},
  }

  for (const invocation of [
    { name: 'terminal_send_input', tileId: terminalTileId, args: { input: 'echo unsafe' } },
    { name: 'note_write_content', tileId: noteTileId, args: { content: 'unsafe replacement' } },
    { name: 'note_append_context', tileId: noteTileId, args: { message: 'unsafe append' } },
  ]) {
    const result = await handlePeerBridgeTool(invocation.name, {
      tile_id: invocation.tileId,
      ...invocation.args,
    }, ctx)
    assert.match(result ?? '', /requires an authoritative workspace scope/i)
  }

  assert.equal(globals.__peerPermissionDialogCalls, 0)
  assert.equal(terminalEvents.length, 0)
  assert.equal(noteEvents.length, 0)

  const permissionStore = (() => {
    try {
      return JSON.parse(readFileSync(join(testCodesurfHome, 'permissions.json'), 'utf8')) as {
        grants?: unknown[]
      }
    } catch {
      return { grants: [] }
    }
  })()
  assert.deepEqual(permissionStore.grants, [])
})
