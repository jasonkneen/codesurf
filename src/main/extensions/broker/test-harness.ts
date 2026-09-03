/**
 * Broker integration test harness.
 *
 * When CODESURF_BROKER_TEST=1, src/main/index.ts skips normal app startup and
 * runs this stdin/stdout JSON-RPC server instead. The integration test
 * (test/hosts/broker-host-integration.test.mjs) drives this harness to exercise:
 *   - activate/deactivate lifecycle
 *   - capability-deny assertions (chat-only ext cannot use fs/shell)
 *   - crash recovery (killing the child does not crash main)
 *
 * Transport: stdio JSON-RPC (same framing as the OWL host harness).
 */

import { app } from 'electron'
import { join } from 'node:path'
import { ExtensionBrokerHost } from './host'
import { JsonRpcPeer, type JsonValue, type JsonObject } from './json-rpc'
import { bus } from '../../event-bus'
import type { ExtensionManifest } from '../../../shared/types'
import { isValidExtensionCapabilityRequests } from '../../../shared/extension-types'
import type { ExtensionHostRegistry } from '../registry'

// Fake registry. `implements ExtensionHostRegistry` is load-bearing: it makes
// any new registry dependency in host.ts/context.ts a compile error here rather
// than a runtime TypeError that silently red-lines the whole broker suite.
// Do not replace this with a cast.
class TestRegistry implements ExtensionHostRegistry {
  private capGate: { enforced: boolean; granted: string[] } = { enforced: false, granted: [] }

  setGate(gate: { enforced: boolean; granted: string[] }): void {
    this.capGate = gate
  }

  getCapabilityGate(_id: string): { enforced: boolean; granted: string[] } {
    return this.capGate
  }

  registerMCPTool(): void {
    // no-op in test
  }

  getActiveWorkspacePath(): string | null {
    return null
  }
}

const registry = new TestRegistry()

// Accumulated bus events for the harness to report back
const capturedEvents: JsonObject[] = []
bus.subscribe('*', 'broker-test-harness', (event) => {
  capturedEvents.push(event as unknown as JsonObject)
})

// Active broker hosts keyed by extId
const activeHosts = new Map<string, ExtensionBrokerHost>()

export function isBrokerTestProcess(): boolean {
  return process.env.CODESURF_BROKER_TEST === '1'
}

export async function runBrokerTestHost(): Promise<void> {
  await app.whenReady()

  const peer = new JsonRpcPeer(
    line => process.stdout.write(line + '\n'),
    async (method, params) => handleHarnessCall(method, params),
  )

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => peer.feed(chunk))
  process.stdin.on('end', () => app.quit())
  process.on('SIGTERM', () => app.quit())
}

async function handleHarnessCall(method: string, params: JsonObject): Promise<JsonValue> {
  switch (method) {
    case 'health':
      return {
        ok: true,
        pid: process.pid,
        userData: app.getPath('userData'),
      }

    case 'activateFixture': {
      const { extDir } = params as { extDir: string }
      const rawCapabilities = params.capabilities
      if (
        rawCapabilities !== undefined
        && !isValidExtensionCapabilityRequests(rawCapabilities)
      ) {
        throw new Error('Invalid fixture capabilities')
      }
      const capabilities = rawCapabilities

      // Build a minimal manifest
      const manifest: ExtensionManifest = {
        id: (params.id as string | undefined) ?? 'test-fixture',
        name: (params.name as string | undefined) ?? 'test-fixture',
        version: '1.0.0',
        tier: 'power',
        main: 'main.js',
        _path: extDir,
        _enabled: true,
        capabilities: capabilities,
      }

      // Set the capability gate
      if (Array.isArray(capabilities) && capabilities.length > 0) {
        registry.setGate({ enforced: true, granted: capabilities.map(c => c.name) })
      } else {
        registry.setGate({ enforced: false, granted: [] })
      }

      const host = new ExtensionBrokerHost(manifest, registry, 'global')
      const ok = await host.activate()
      if (ok) {
        activeHosts.set(manifest.id, host)
      }
      return { activated: ok, extId: manifest.id }
    }

    case 'deactivateFixture': {
      const { extId } = params as { extId: string }
      const host = activeHosts.get(extId)
      if (!host) return { ok: false, reason: 'not found' }
      await host.deactivate()
      activeHosts.delete(extId)
      return { ok: true }
    }

    case 'getBusEvents': {
      // Return and clear captured events
      const events = [...capturedEvents]
      capturedEvents.length = 0
      return { events: events as JsonValue }
    }

    case 'killChild': {
      // Force-kills the utilityProcess child for crash-recovery testing.
      // We use the private _child field via casting.
      const { extId } = params as { extId: string }
      const host = activeHosts.get(extId)
      if (!host) return { ok: false, reason: 'not found' }
      const child = (host as unknown as { child?: { kill: (sig?: string) => void } }).child
      if (child) {
        child.kill('SIGKILL')
        return { ok: true }
      }
      return { ok: false, reason: 'no child' }
    }

    case 'mainAlive':
      return { ok: true, pid: process.pid }

    default:
      throw new Error(`Unknown harness method: ${method}`)
  }
}

// Helper: resolve fixture dir relative to project root for test use
export function fixtureDir(name: string): string {
  // In the built bundle, __dirname is dist-electron/main/
  const projectRoot = join(__dirname, '..', '..', '..')
  return join(projectRoot, 'test', 'fixtures', 'broker', name)
}
