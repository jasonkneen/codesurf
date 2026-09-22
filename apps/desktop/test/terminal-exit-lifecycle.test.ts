import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import {
  handlePtyExit,
  type ExitListener,
  type ExitableSession,
  type TerminalBufferEntry,
} from '../src/main/ipc/terminal-exit.ts'

function makeListener(): ExitListener & { sent: Array<[string, unknown[]]> } {
  const sent: Array<[string, unknown[]]> = []
  return {
    sent,
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => { sent.push([channel, args]) },
  }
}

function makeDeps() {
  const terminals = new Map<string, ExitableSession>()
  const terminalBuffers = new Map<string, TerminalBufferEntry>()
  const published: Array<Record<string, unknown>> = []
  const deps = {
    terminals,
    terminalBuffers,
    publish: (event: Record<string, unknown>) => { published.push(event); return event },
  }
  return { terminals, terminalBuffers, published, deps }
}

describe('handlePtyExit', () => {
  test('removes the session from the terminals map', () => {
    const { terminals, deps } = makeDeps()
    const pty = {}
    terminals.set('tile-1', { workspaceId: 'workspace-a', pty, listeners: new Set() })

    handlePtyExit('tile-1', 0, pty, deps)

    assert.equal(terminals.has('tile-1'), false)
  })

  test('clears the pending buffer flush timer and deletes the buffer entry', () => {
    const { terminals, terminalBuffers, deps } = makeDeps()
    const pty = {}
    terminals.set('tile-1', { workspaceId: 'workspace-a', pty, listeners: new Set() })
    let cleared = false
    const timer = setTimeout(() => {}, 100000)
    // Wrap clearTimeout to observe it was invoked with our timer.
    const originalClear = global.clearTimeout
    global.clearTimeout = ((t: unknown) => {
      if (t === timer) cleared = true
      return originalClear(t as never)
    }) as typeof clearTimeout
    try {
      terminalBuffers.set('tile-1', { data: 'pending output', timer })
      handlePtyExit('tile-1', 0, pty, deps)
    } finally {
      global.clearTimeout = originalClear
    }

    assert.equal(cleared, true)
    assert.equal(terminalBuffers.has('tile-1'), false)
  })

  test('notifies live listeners on the terminal:exit channel with the exit code', () => {
    const { terminals, deps } = makeDeps()
    const pty = {}
    const listener = makeListener()
    terminals.set('tile-1', { workspaceId: 'workspace-a', pty, listeners: new Set([listener]) })

    handlePtyExit('tile-1', 7, pty, deps)

    assert.deepEqual(listener.sent, [['terminal:exit:tile-1', [7]]])
  })

  test('kills the backing tmux session when killTmuxSession is provided', () => {
    const { terminals, deps } = makeDeps()
    const pty = {}
    const killed: string[] = []
    terminals.set('tile-tmux', {
      workspaceId: 'workspace-a',
      pty,
      listeners: new Set(),
      tmuxSession: 'contex-tile-tmux',
    })

    handlePtyExit('tile-tmux', 0, pty, {
      ...deps,
      killTmuxSession: (name) => { killed.push(name) },
    })

    assert.deepEqual(killed, ['contex-tile-tmux'])
    assert.equal(terminals.has('tile-tmux'), false)
  })

  test('skips destroyed listeners without throwing', () => {
    const { terminals, deps } = makeDeps()
    const pty = {}
    const destroyed: ExitListener = {
      isDestroyed: () => true,
      send: () => { throw new Error('should not be called on destroyed listener') },
    }
    terminals.set('tile-1', { workspaceId: 'workspace-a', pty, listeners: new Set([destroyed]) })

    assert.doesNotThrow(() => handlePtyExit('tile-1', 0, pty, deps))
  })

  test('publishes a tile:<id> system event with action "exited"', () => {
    const { terminals, published, deps } = makeDeps()
    const pty = {}
    terminals.set('tile-1', { workspaceId: 'workspace-a', pty, listeners: new Set() })

    handlePtyExit('tile-1', 130, pty, deps)

    assert.equal(published.length, 1)
    assert.deepEqual(published[0], {
      channel: 'tile:workspace-a:tile-1',
      type: 'system',
      source: 'terminal:tile-1',
      payload: { action: 'exited', workspaceId: 'workspace-a', exitCode: 130 },
    })
  })

  test('superseded-pty guard: a stale exit from a replaced pty does not delete the new session', () => {
    const { terminals, deps } = makeDeps()
    const oldPty = {}
    const newPty = {}
    const newListener = makeListener()
    // Simulate terminal:create respawning tileId with a new pty before the
    // old pty's exit event is processed.
    terminals.set('tile-1', {
      workspaceId: 'workspace-a',
      pty: newPty,
      listeners: new Set([newListener]),
    })

    handlePtyExit('tile-1', 1, oldPty, deps)

    assert.equal(terminals.has('tile-1'), true)
    assert.equal(terminals.get('tile-1')?.pty, newPty)
    assert.deepEqual(newListener.sent, [], 'the live session\'s listeners must not receive the stale exit event')
  })

  test('no-op when the tileId has no session at all', () => {
    const { terminals, published, deps } = makeDeps()

    assert.doesNotThrow(() => handlePtyExit('missing-tile', 0, {}, deps))
    assert.equal(terminals.size, 0)
    assert.equal(published.length, 0)
  })
})

test('terminal data callback rejects bytes from a superseded PTY before side effects', () => {
  // terminal.ts cannot be imported under plain node:test because it loads the
  // Electron and node-pty hosts at module scope. Keep a source-level wiring
  // contract around the identity guard while the pure exit lifecycle behavior
  // above exercises the same stale-session invariant directly.
  const source = readFileSync(resolve(process.cwd(), 'src/main/ipc/terminal.ts'), 'utf8')
  const callbackStart = source.indexOf('term.onData((data: string) => {')
  const callbackEnd = source.indexOf('\n    term.onExit(', callbackStart)
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart, 'terminal data callback must exist')

  const callback = source.slice(callbackStart, callbackEnd)
  const guard = 'if (terminals.get(tileId) !== session || session.pty !== term) return'
  const guardIndex = callback.indexOf(guard)
  const bufferMutationIndex = callback.indexOf('session.buffer =')
  const listenerSendIndex = callback.indexOf('listener.send(`terminal:data:${tileId}`, data)')
  // The bus accumulator is now bounded (M15): `buf.data = (buf.data + data)
  // .slice(-TERMINAL_BUS_MAX_BUFFER)` instead of an unbounded `+=`. The
  // ordering contract this test guards is unchanged.
  const busBufferMutationIndex = callback.indexOf('buf.data = (buf.data + data)')

  assert.ok(guardIndex >= 0, 'onData must identity-guard its PTY and session')
  assert.ok(guardIndex < bufferMutationIndex, 'guard must precede session buffer mutation')
  assert.ok(guardIndex < listenerSendIndex, 'guard must precede renderer delivery')
  assert.ok(guardIndex < busBufferMutationIndex, 'guard must precede bus buffering')
})
