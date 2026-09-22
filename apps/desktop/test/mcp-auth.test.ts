import { register } from 'node:module'
import assert from 'node:assert/strict'
import { describe, test, before, after } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Redirect the app home to a throwaway dir BEFORE importing mcp-server:
// startMCPServer writes mcp-server.json into CODESURF_HOME and drops
// .mcp.json / CLAUDE.md into every workspace from config.json — without this
// override the test suite overwrites the live ~/.codesurf configuration.
const testCodesurfHome = mkdtempSync(join(tmpdir(), 'codesurf-mcp-auth-'))
process.env.CODESURF_HOME = testCodesurfHome
process.on('exit', () => {
  rmSync(testCodesurfHome, { recursive: true, force: true })
})

// Electron and extensionless relative imports are unavailable under plain
// node:test; register a tiny resolver before loading mcp-server.
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
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
          showMessageBox: async () => ({ response: globalThis.__mcpAuthDialogResponse ?? 0, checkboxChecked: false }),
        }
      \`),
    }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\\\.(ts|js|json|node)$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {}
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)

const {
  requireMcpAuth,
  getMCPToken,
  getTileToken,
  revokeTileToken,
  buildContexHttpMcpServerEntry,
  tileMcpConfigPath,
  writeTileMcpConfig,
  writeMCPConfigToWorkspace,
  readContextFilesBounded,
  isValidSseEventName,
  requireMcpPermissionWorkspace,
  startMCPServer,
  stopMCPServer,
} = await import('../src/main/mcp-server.ts')
const { bus } = await import('../src/main/event-bus.ts')

function mockResponse(): ServerResponse & { status?: number, body?: string, headers: Record<string, string | string[] | undefined> } {
  const headers: Record<string, string | string[] | undefined> = {}
  const res = {
    headers,
    status: undefined as number | undefined,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    writeHead(status: number, hdrs?: Record<string, string>) {
      this.status = status
      if (hdrs) {
        for (const [name, value] of Object.entries(hdrs)) {
          this.setHeader(name, value)
        }
      }
    },
    end(payload?: string) {
      this.body = payload
    },
  }
  return res as ServerResponse & typeof res
}

async function request(
  port: number,
  options: {
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
  },
): Promise<{ status: number, body: string }> {
  const headers = {
    host: `127.0.0.1:${port}`,
    ...options.headers,
  }
  if (options.body) {
    headers['content-length'] = String(Buffer.byteLength(options.body))
  }
  const res = await fetch(`http://127.0.0.1:${port}${options.path}`, {
    method: options.method,
    headers,
    body: options.body,
  })
  return { status: res.status, body: await res.text() }
}

describe('buildContexHttpMcpServerEntry', () => {
  test('includes bearer auth headers for HTTP MCP clients', () => {
    const entry = buildContexHttpMcpServerEntry('http://127.0.0.1:4242/mcp')
    assert.equal(entry.type, 'http')
    assert.equal(entry.url, 'http://127.0.0.1:4242/mcp')
    assert.deepEqual(entry.headers, { Authorization: `Bearer ${getMCPToken()}` })
  })
})

describe('MCP persistence and context boundaries', () => {
  test('permission-gated routes reject unresolved workspace authority', () => {
    assert.throws(
      () => requireMcpPermissionWorkspace(null, '/inject'),
      /requires an authoritative workspace scope/,
    )
    assert.throws(
      () => requireMcpPermissionWorkspace('  ', '/inject'),
      /requires an authoritative workspace scope/,
    )
    assert.equal(
      requireMcpPermissionWorkspace('/workspace/project', '/inject'),
      '/workspace/project',
    )
  })

  test('scrubs legacy workspace-global CodeSurf credentials', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'codesurf-workspace-mcp-'))
    try {
      writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({
        mcpServers: {
          codesurf: {
            type: 'http',
            url: 'http://127.0.0.1:9999/mcp',
            headers: { Authorization: 'Bearer legacy-global-secret' },
          },
          userServer: { command: 'user-mcp' },
        },
      }))
      await writeMCPConfigToWorkspace(workspace)
      const scrubbed = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8'))
      assert.equal(scrubbed.mcpServers.codesurf, undefined)
      assert.deepEqual(scrubbed.mcpServers.userServer, { command: 'user-mcp' })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('context reads skip symlinks and bound aggregate source bytes', async () => {
    const contextDir = mkdtempSync(join(tmpdir(), 'codesurf-context-'))
    const outside = join(contextDir, '..', `outside-${Date.now()}.txt`)
    try {
      writeFileSync(outside, 'must-not-leak')
      writeFileSync(join(contextDir, 'a.txt'), 'a'.repeat(20_000))
      symlinkSync(outside, join(contextDir, 'escape.txt'))
      const context = await readContextFilesBounded(contextDir)
      assert.match(context, /--- a\.txt ---/)
      assert.doesNotMatch(context, /must-not-leak/)
      assert.ok(Buffer.byteLength(context, 'utf8') <= 8 * 1024)
    } finally {
      rmSync(contextDir, { recursive: true, force: true })
      rmSync(outside, { force: true })
    }
  })

  test('context reads reject a context directory that escapes through a symlink', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'codesurf-context-root-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'codesurf-context-outside-'))
    try {
      writeFileSync(join(outsideRoot, 'secret.txt'), 'must-not-leak')
      const linkedContext = join(workspaceRoot, 'context')
      symlinkSync(outsideRoot, linkedContext, 'dir')
      assert.equal(
        await readContextFilesBounded(linkedContext, workspaceRoot),
        '',
      )
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  test('accepts only single-line bounded SSE event names', () => {
    assert.equal(isValidSseEventName('card_update.v2'), true)
    assert.equal(isValidSseEventName('card_update\ndata: forged'), false)
    assert.equal(isValidSseEventName('x'.repeat(65)), false)
  })
})

describe('requireMcpAuth', () => {
  test('rejects missing Authorization with 401 JSON', () => {
    const req = { headers: {} } as IncomingMessage
    const res = mockResponse()
    assert.equal(requireMcpAuth(req, res), null)
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body ?? ''), { error: 'Unauthorized' })
  })

  test('rejects invalid Bearer token', () => {
    const req = { headers: { authorization: 'Bearer wrong-token' } } as IncomingMessage
    const res = mockResponse()
    assert.equal(requireMcpAuth(req, res), null)
    assert.equal(res.status, 401)
  })

  test('accepts valid Bearer token and returns a global principal', () => {
    const token = getMCPToken()
    const req = { headers: { authorization: `Bearer ${token}` } } as IncomingMessage
    const res = mockResponse()
    assert.deepEqual(requireMcpAuth(req, res), { kind: 'global' })
    assert.equal(res.status, undefined)
  })

  test('same tile ID in different workspaces authenticates as distinct principals', () => {
    const tileId = 'shared-auth-tile'
    const workspaceAToken = getTileToken('auth-workspace-a', tileId)
    const workspaceBToken = getTileToken('auth-workspace-b', tileId)
    assert.notEqual(workspaceAToken, workspaceBToken)

    const workspaceARequest = {
      headers: { authorization: `Bearer ${workspaceAToken}` },
    } as IncomingMessage
    const workspaceBRequest = {
      headers: { authorization: `Bearer ${workspaceBToken}` },
    } as IncomingMessage
    assert.deepEqual(requireMcpAuth(workspaceARequest, mockResponse()), {
      kind: 'tile',
      workspaceId: 'auth-workspace-a',
      tileId,
    })
    assert.deepEqual(requireMcpAuth(workspaceBRequest, mockResponse()), {
      kind: 'tile',
      workspaceId: 'auth-workspace-b',
      tileId,
    })

    revokeTileToken('auth-workspace-a', tileId)
    const revokedResponse = mockResponse()
    assert.equal(requireMcpAuth(workspaceARequest, revokedResponse), null)
    assert.equal(revokedResponse.status, 401)
    assert.deepEqual(requireMcpAuth(workspaceBRequest, mockResponse()), {
      kind: 'tile',
      workspaceId: 'auth-workspace-b',
      tileId,
    })
    revokeTileToken('auth-workspace-b', tileId)
  })
})

describe('MCP HTTP auth gates', () => {
  let port = 0

  before(async () => {
    const injectProjectId = 'inject-project'
    const injectProjectRoot = join(testCodesurfHome, injectProjectId)
    mkdirSync(join(injectProjectRoot, '.codesurf', 'card-1'), { recursive: true })
    writeFileSync(
      join(testCodesurfHome, 'config.json'),
      JSON.stringify({
        projects: [{ id: injectProjectId, path: injectProjectRoot }],
        workspaces: [{
          id: 'inject-workspace',
          projectIds: [injectProjectId],
          primaryProjectId: injectProjectId,
        }],
      }),
    )
    port = await startMCPServer()
  })

  after(async () => {
    await stopMCPServer()
  })

  test('POST /mcp without Bearer is rejected', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('server discovery config never persists the global bearer', () => {
    const configText = readFileSync(join(testCodesurfHome, 'mcp-server.json'), 'utf8')
    const config = JSON.parse(configText) as {
      token?: string
      mcpServers?: { codesurf?: { headers?: unknown, token?: unknown } }
    }
    assert.equal(config.token, undefined)
    assert.equal(config.mcpServers?.codesurf?.headers, undefined)
    assert.equal(config.mcpServers?.codesurf?.token, undefined)
    assert.doesNotMatch(configText, new RegExp(getMCPToken()))
  })

  test('POST /mcp with valid Bearer succeeds', async () => {
    const token = getMCPToken()
    const res = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body) as {
      result?: {
        tools?: Array<{
          name?: string
          inputSchema?: { properties?: Record<string, unknown> }
        }>
      }
    }
    assert.ok(Array.isArray(payload.result?.tools))
    const browserNavigate = payload.result?.tools?.find(tool => tool.name === 'browser_navigate')
    assert.ok(browserNavigate?.inputSchema?.properties?.workspace_id)
  })

  test('peer commands dispatch once inside the authenticated workspace', async () => {
    const callerTileId = 'peer-caller'
    const targetTileId = 'shared-peer-target'
    const workspaceA = 'peer-workspace-a'
    const workspaceB = 'peer-workspace-b'
    const token = getTileToken(workspaceA, callerTileId)
    const workspaceAEvents: unknown[] = []
    const workspaceBEvents: unknown[] = []
    bus.subscribe(`tile:${workspaceA}:${targetTileId}`, 'peer-scope-a', event => {
      workspaceAEvents.push(event)
    })
    bus.subscribe(`tile:${workspaceB}:${targetTileId}`, 'peer-scope-b', event => {
      workspaceBEvents.push(event)
    })
    const canvasDir = join(testCodesurfHome, 'workspaces', workspaceA, '.codesurf')
    mkdirSync(canvasDir, { recursive: true })
    writeFileSync(join(canvasDir, 'canvas-state.json'), JSON.stringify({
      tiles: [
        { id: callerTileId, type: 'terminal' },
        { id: targetTileId, type: 'browser' },
      ],
      lockedConnections: [{ sourceTileId: callerTileId, targetTileId }],
    }))

    const call = async (
      authorization: string,
      args: Record<string, unknown>,
    ): Promise<string> => {
      const response = await request(port, {
        method: 'POST',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${authorization}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'browser_navigate',
            arguments: {
              tile_id: targetTileId,
              url: 'https://example.com',
              ...args,
            },
          },
        }),
      })
      if (response.status !== 200) {
        throw new Error(`Unexpected MCP response: ${JSON.stringify(response)}`)
      }
      const body = JSON.parse(response.body) as {
        result?: { content?: Array<{ text?: string }> }
      }
      return body.result?.content?.[0]?.text ?? ''
    }

    try {
      assert.equal(await call(token, {}), `Dispatched browser_navigate to ${targetTileId}`)
      assert.equal(workspaceAEvents.length, 1)
      assert.equal(workspaceBEvents.length, 0)
      assert.deepEqual(
        (workspaceAEvents[0] as { payload?: Record<string, unknown> }).payload,
        {
          url: 'https://example.com',
          mode: undefined,
          workspaceId: workspaceA,
          tileId: targetTileId,
          cardId: targetTileId,
          command: 'browser_navigate',
        },
      )

      assert.match(await call(token, { workspace_id: workspaceB }), /Forbidden/)
      assert.equal(workspaceAEvents.length, 1)
      assert.equal(workspaceBEvents.length, 0)

      assert.equal(await call(getMCPToken(), {}), 'Missing workspace_id')
      assert.equal(workspaceAEvents.length, 1)
      assert.equal(workspaceBEvents.length, 0)
    } finally {
      bus.unsubscribeAll('peer-scope-a')
      bus.unsubscribeAll('peer-scope-b')
      bus.dropChannel(`tile:${workspaceA}:${targetTileId}`)
      bus.dropChannel(`tile:${workspaceB}:${targetTileId}`)
      revokeTileToken(workspaceA, callerTileId)
    }
  })

  test('writes workspace-qualified tile config with an authenticating tile bearer', async () => {
    const workspaceId = 'config-workspace'
    const tileId = 'config-tile'
    const configPath = await writeTileMcpConfig(workspaceId, tileId)
    assert.equal(configPath, tileMcpConfigPath(workspaceId, tileId))
    assert.ok(configPath)
    assert.equal(statSync(configPath!).mode & 0o777, 0o600)

    const config = JSON.parse(readFileSync(configPath!, 'utf8')) as {
      port: number
      token: string
      workspaceId: string
      tileId: string
      mcpServers: {
        codesurf: {
          url: string
          headers: { Authorization: string }
        }
      }
    }
    assert.equal(config.port, port)
    assert.equal(config.workspaceId, workspaceId)
    assert.equal(config.tileId, tileId)
    assert.notEqual(config.token, getMCPToken())
    assert.equal(
      config.mcpServers.codesurf.headers.Authorization,
      `Bearer ${config.token}`,
    )
    assert.equal(config.mcpServers.codesurf.url, `http://127.0.0.1:${port}/mcp`)

    const req = {
      headers: { authorization: `Bearer ${config.token}` },
    } as IncomingMessage
    assert.deepEqual(requireMcpAuth(req, mockResponse()), {
      kind: 'tile',
      workspaceId,
      tileId,
    })
    revokeTileToken(workspaceId, tileId)
  })

  test('POST /push without Bearer is rejected', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/push',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card_id: 'card-1', event: 'card_update', data: { note: 'hi' } }),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('POST /inject without Bearer is rejected', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/inject',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card_id: 'card-1', message: 'hello' }),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('GET /events without Bearer is rejected', async () => {
    const res = await request(port, { method: 'GET', path: '/events?card_id=global' })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('GET /events accepts token query param for EventSource clients', async () => {
    const token = getMCPToken()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events?card_id=global&token=${encodeURIComponent(token)}`, {
        method: 'GET',
        headers: { host: `127.0.0.1:${port}` },
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
      const reader = res.body?.getReader()
      assert.ok(reader)
      const first = await reader.read()
      const chunk = new TextDecoder().decode(first.value ?? new Uint8Array())
      assert.match(chunk, /:connected/)
      await reader.cancel()
    } finally {
      clearTimeout(timeout)
    }
  })

  test('POST /push with valid Bearer succeeds', async () => {
    const token = getMCPToken()
    const res = await request(port, {
      method: 'POST',
      path: '/push',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workspace_id: 'push-workspace',
        card_id: 'card-1',
        event: 'card_update',
        data: { note: 'ok' },
      }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
  })

  test('POST /push rejects event-name framing injection', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/push',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${getMCPToken()}`,
      },
      body: JSON.stringify({
        workspace_id: 'push-workspace',
        card_id: 'card-1',
        event: 'card_update\ndata: forged',
        data: {},
      }),
    })
    assert.equal(res.status, 400)
    assert.deepEqual(JSON.parse(res.body), { error: 'Invalid event name' })
  })

  test('same-card SSE streams do not cross workspace token scopes', async () => {
    const cardId = 'shared-sse-card'
    const tokenA = getTileToken('sse-workspace-a', cardId)
    const tokenB = getTileToken('sse-workspace-b', cardId)
    const responseA = await fetch(
      `http://127.0.0.1:${port}/events?card_id=${cardId}&token=${encodeURIComponent(tokenA)}`,
      { headers: { host: `127.0.0.1:${port}` } },
    )
    const responseB = await fetch(
      `http://127.0.0.1:${port}/events?card_id=${cardId}&token=${encodeURIComponent(tokenB)}`,
      { headers: { host: `127.0.0.1:${port}` } },
    )
    const readerA = responseA.body!.getReader()
    const readerB = responseB.body!.getReader()
    await readerA.read()
    await readerB.read()

    try {
      const pushed = await request(port, {
        method: 'POST',
        path: '/push',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          card_id: cardId,
          event: 'card_update',
          data: { note: 'workspace-a-only' },
        }),
      })
      assert.equal(pushed.status, 200)

      const eventA = new TextDecoder().decode((await readerA.read()).value)
      assert.match(eventA, /workspace-a-only/)
      const bReceived = await Promise.race([
        readerB.read().then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 100)),
      ])
      assert.equal(bReceived, false)
    } finally {
      await readerA.cancel()
      await readerB.cancel()
      revokeTileToken('sse-workspace-a', cardId)
      revokeTileToken('sse-workspace-b', cardId)
    }
  })

  test('POST /mcp tools/call without Bearer is rejected', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'canvas_list_tiles', arguments: {} },
      }),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('POST /inject with valid Bearer is denied when the user rejects the permission prompt', async () => {
    const token = getMCPToken()
    ;(globalThis as Record<string, unknown>).__mcpAuthDialogResponse = 0 // "Deny"
    try {
      const res = await request(port, {
        method: 'POST',
        path: '/inject',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          workspace_id: 'inject-workspace',
          card_id: 'card-1',
          message: 'rm -rf ~',
        }),
      })
      assert.equal(res.status, 403)
      assert.deepEqual(JSON.parse(res.body), {
        error: 'Permission denied: /inject was not approved',
      })
    } finally {
      delete (globalThis as Record<string, unknown>).__mcpAuthDialogResponse
    }
  })

  test('POST /inject with valid Bearer succeeds when the user approves the permission prompt', async () => {
    const token = getMCPToken()
    ;(globalThis as Record<string, unknown>).__mcpAuthDialogResponse = 2 // "Allow Once"
    try {
      const res = await request(port, {
        method: 'POST',
        path: '/inject',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          workspace_id: 'inject-workspace',
          card_id: 'card-1',
          message: 'hello from agent',
        }),
      })
      assert.equal(res.status, 200)
      const payload = JSON.parse(res.body) as { ok?: boolean }
      assert.equal(payload.ok, true)
    } finally {
      delete (globalThis as Record<string, unknown>).__mcpAuthDialogResponse
    }
  })
})
