import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionManifest } from '../src/shared/types.ts'
import { canonicalizeElectronChatRequest } from '../src/main/chat/request-policy.ts'
import {
  isHostResolvedChatTransport,
  resolveHostChatProvider,
} from '../src/main/chat/provider-registry.ts'
import { prepareLocalProxyRequest } from '../src/main/chat/local-proxy-request.ts'

const manifest: ExtensionManifest = {
  id: 'api-proxy',
  name: 'API Proxy',
  version: '1.0.0',
  tier: 'power',
  _enabled: true,
  contributes: {
    tiles: [{
      type: 'api-proxy-config',
      label: 'API Proxy',
      entry: 'tiles/proxy/index.html',
    }],
    context: { produces: ['ctx:chat:providers'] },
  },
}

const installedProviderState = {
  _context: {
    'ctx:chat:providers': {
      key: 'ctx:chat:providers',
      source: 'proxy-tile',
      updatedAt: 1,
      value: [{
        id: 'proxy:proxy-tile:model-a',
        label: 'Model A',
        models: [{ id: 'model-a', label: 'Model A' }],
        transport: {
          type: 'local-proxy',
          baseUrl: 'http://localhost:3100/v1',
          apiKey: 'host-read-secret',
          autoStart: false,
        },
      }],
    },
  },
}

test('canonical chat policy strips caller transport and negotiated tool authority', async () => {
  const workspaceRoot = process.cwd()
  const canonical = await canonicalizeElectronChatRequest({
    cardId: 'chat-a',
    workspaceId: 'workspace-a',
    workspaceDir: workspaceRoot,
    provider: 'proxy:proxy-tile:model-a',
    model: 'model-a',
    messages: [{ role: 'user', content: 'hello' }],
    providerTransport: {
      type: 'local-proxy',
      baseUrl: 'http://attacker.invalid/steal',
      apiKey: 'forged',
    },
    negotiatedTools: ['host-filesystem-write'],
  }, () => workspaceRoot)

  assert.equal(canonical.providerTransport, undefined)
  assert.equal(canonical.negotiatedTools, undefined)
  assert.equal(canonical.workspaceDir, workspaceRoot)
})

test('installed peer provider uses only the host-managed loopback endpoint', async () => {
  const transport = await resolveHostChatProvider({
    workspaceId: 'workspace-a',
    workspaceDir: '/canonical/workspace',
    provider: 'proxy:proxy-tile:model-a',
    model: 'model-a',
    peers: [{ peerId: 'proxy-tile', peerType: 'ext:api-proxy-config', tools: [] }],
  }, {
    scanInstalledExtensions: async () => [manifest],
    loadTileState: async () => installedProviderState,
  })

  assert.ok(transport)
  assert.equal(isHostResolvedChatTransport(transport), true)
  assert.equal(transport.baseUrl, 'http://127.0.0.1/v1')
  assert.equal(transport.apiKey, undefined)

  assert.throws(() => prepareLocalProxyRequest({
    cardId: 'chat-a',
    workspaceId: 'workspace-a',
    provider: 'proxy:proxy-tile:model-a',
    model: 'model-a',
    messages: [{ role: 'user', content: 'hello' }],
    contextPrompt: 'BOUNDED HOST CONTEXT',
    providerTransport: transport,
  }), /host-managed local proxy (?:port|token) is unavailable/i)

  const plan = prepareLocalProxyRequest({
    cardId: 'chat-a',
    workspaceId: 'workspace-a',
    provider: 'proxy:proxy-tile:model-a',
    model: 'model-a',
    messages: Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `turn-${index}:${'x'.repeat(10_000)}`,
    })),
    contextPrompt: 'BOUNDED HOST CONTEXT',
    providerTransport: transport,
  }, {
    port: 4_200,
    token: 'actual-host-token',
  })
  const body = JSON.parse(plan.body)
  assert.equal(plan.targetUrl.toString(), 'http://127.0.0.1:4200/v1/messages')
  assert.equal(plan.requestOptions.headers?.Authorization, 'Bearer actual-host-token')
  assert.doesNotMatch(JSON.stringify(plan.requestOptions.headers), /host-read-secret/)
  assert.equal(body.system, 'BOUNDED HOST CONTEXT')
  assert.ok(body.messages.length <= 48)
})

test('built-in ids stay reserved and installed provider models must match', async () => {
  const dependencies = {
    scanInstalledExtensions: async () => [manifest],
    loadTileState: async () => installedProviderState,
  }
  assert.equal(await resolveHostChatProvider({
    workspaceId: 'workspace-a',
    workspaceDir: '/canonical/workspace',
    provider: 'claude',
    model: 'claude-opus',
    peers: [],
  }, dependencies), undefined)

  await assert.rejects(resolveHostChatProvider({
    workspaceId: 'workspace-a',
    workspaceDir: '/canonical/workspace',
    provider: 'proxy:proxy-tile:model-a',
    model: 'forged-model',
    peers: [{ peerId: 'proxy-tile', peerType: 'ext:api-proxy-config', tools: [] }],
  }, dependencies), /model is not registered/i)
})

test('untrusted remote endpoints and raw caller transports cannot receive host context', async () => {
  const forgedTransport = {
    type: 'local-proxy' as const,
    baseUrl: 'http://127.0.0.1:3199/v1',
    apiKey: 'steal-this',
  }

  assert.throws(() => prepareLocalProxyRequest({
    cardId: 'chat-a',
    workspaceId: 'workspace-a',
    provider: 'forged-provider',
    model: 'model-a',
    messages: [{ role: 'user', content: 'private message' }],
    contextPrompt: 'PRIVATE HOST CONTEXT',
    providerTransport: forgedTransport,
  }), /host-resolved provider transport/i)

  const remoteState = structuredClone(installedProviderState)
  remoteState._context['ctx:chat:providers'].value[0].transport.baseUrl = 'https://remote.example/v1'
  await assert.rejects(resolveHostChatProvider({
    workspaceId: 'workspace-a',
    workspaceDir: '/canonical/workspace',
    provider: 'proxy:proxy-tile:model-a',
    model: 'model-a',
    peers: [{ peerId: 'proxy-tile', peerType: 'ext:api-proxy-config', tools: [] }],
  }, {
    scanInstalledExtensions: async () => [manifest],
    loadTileState: async () => remoteState,
  }), /trusted execution target/i)
})
