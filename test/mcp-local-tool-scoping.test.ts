import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

// bus.ts transitively imports the electron event-bus, so it cannot be loaded
// under plain node:test. Mirror the primitive here and assert (below) that the
// mirror still matches the source it copies.
function scopeBusChannel(workspaceId: string, requested: unknown): string | null {
  if (typeof requested !== 'string' || !requested.trim()) return null
  const channel = requested.trim()
  const tileMatch = /^tile:([^:]+)(?::(.+))?$/.exec(channel)
  if (tileMatch) {
    if (tileMatch[2]) {
      return tileMatch[1] === workspaceId ? channel : null
    }
    return `tile:${workspaceId}:${tileMatch[1]}`
  }
  if (channel.startsWith('workspace:')) {
    return channel.startsWith(`workspace:${workspaceId}:`) ? channel : null
  }
  return `workspace:${workspaceId}:${channel}`
}

const src = readFileSync(new URL('../src/main/mcp-server.ts', import.meta.url), 'utf8')
const pets = readFileSync(new URL('../src/main/ipc/pets.ts', import.meta.url), 'utf8')

describe('M20 — ask/pause_task must scope the bus channel', () => {
  const handler = src.slice(src.indexOf('async function handleLocalTool'))
  const body = handler.slice(0, handler.indexOf('\n  return null\n}'))

  it('neither branch publishes to a raw caller-supplied channel', () => {
    assert.equal(
      /channel: args\.channel as string/.test(body),
      false,
      'the unscoped channel publish must be gone',
    )
  })

  it('both branches resolve the principal scope then scope the channel', () => {
    const asks = body.match(/resolvePeerWorkspaceScope\(principal, args\.workspace_id\)/g) ?? []
    const scoped = body.match(/scopeBusChannel\(scope\.workspaceId, args\.channel\)/g) ?? []
    assert.equal(asks.length, 2, 'ask and pause_task each resolve scope')
    assert.equal(scoped.length, 2, 'ask and pause_task each scope the channel')
  })

  it('both reject a cross-workspace channel', () => {
    const refusals = body.match(/Forbidden: invalid or cross-workspace channel/g) ?? []
    assert.equal(refusals.length, 2)
  })
})

describe('M20 — scopeBusChannel behaviour (the shared primitive)', () => {
  it('refuses another workspace tile channel', () => {
    assert.equal(scopeBusChannel('workspace-a', 'tile:workspaceB:tile-99'), null)
  })

  it('allows an in-workspace tile channel', () => {
    assert.equal(scopeBusChannel('workspace-a', 'tile:workspace-a:tile-1'), 'tile:workspace-a:tile-1')
  })

  it('rewrites a bare tile channel into the caller workspace', () => {
    assert.equal(scopeBusChannel('workspace-a', 'tile:tile-1'), 'tile:workspace-a:tile-1')
  })

  it('refuses another workspace broadcast channel', () => {
    assert.equal(scopeBusChannel('workspace-a', 'workspace:workspace-b:global'), null)
  })

  it('refuses empty or non-string channels', () => {
    for (const bad of ['', '   ', undefined, null, 42, {}]) {
      assert.equal(scopeBusChannel('workspace-a', bad), null)
    }
  })
})

describe('the mirrored primitive matches its source', () => {
  it('scopeBusChannel in bus.ts is unchanged in the ways this test relies on', () => {
    const bus = readFileSync(new URL('../src/main/mcp/tools/bus.ts', import.meta.url), 'utf8')
    const fn = bus.slice(bus.indexOf('export function scopeBusChannel'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.includes("/^tile:([^:]+)(?::(.+))?$/"), 'tile channel parsing unchanged')
    assert.ok(body.includes("tileMatch[1] === workspaceId ? channel : null"), 'cross-workspace tile refusal unchanged')
    assert.ok(body.includes("channel.startsWith(`workspace:${workspaceId}:`)"), 'workspace prefix check unchanged')
  })
})

describe('M19 — the MCP listen callback cannot leave the promise unsettled', () => {
  it('wraps the async listen body in try/catch that rejects', () => {
    const listen = src.slice(src.indexOf("server.listen(0, '127.0.0.1'"))
    const block = listen.slice(0, listen.indexOf("server.on('error', reject)"))
    assert.ok(block.includes('try {'), 'the body must be guarded')
    assert.ok(block.includes('reject('), 'a failure must reject the outer promise')
    assert.ok(block.includes('server.close()'), 'a failed startup must not leave the socket open')
    assert.ok(block.indexOf('try {') < block.indexOf('resolve(serverPort)'))
  })
})

describe('M13 — pet spritesheetPath must stay inside the bundle', () => {
  it('uses resolveInside rather than a bare resolve', () => {
    assert.ok(pets.includes('resolveInside(bundleDir, raw.spritesheetPath as string)'))
    assert.equal(/resolve\(bundleDir, raw\.spritesheetPath/.test(pets), false, 'bare resolve must be gone')
  })

  it('requires a real image extension', () => {
    assert.ok(pets.includes("mimeFor(spritesheetPath) === 'application/octet-stream'"))
  })

  it('a traversal path is rejected, not read', () => {
    const fn = pets.slice(pets.indexOf('resolveInside(bundleDir, raw.spritesheetPath'))
    const guard = fn.slice(0, 400)
    assert.ok(guard.includes('return null'), 'an escaping path must abort manifest load')
  })
})
