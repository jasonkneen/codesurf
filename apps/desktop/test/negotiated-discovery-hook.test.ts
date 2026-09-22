import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const HOOK_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/hooks/useNegotiatedDiscovery.ts'), 'utf8')

describe('useNegotiatedDiscovery extraction', () => {
  test('App delegates discovery graph work to the hook', () => {
    expect(APP_SOURCE).toContain("from './hooks/useNegotiatedDiscovery'")
    expect(APP_SOURCE).toContain('useNegotiatedDiscovery({')
    expect(APP_SOURCE).not.toContain('const negotiatedDiscoveryState = React.useMemo')
    expect(APP_SOURCE).not.toContain('useDiscoveryGraph({')
  })

  test('hook owns worker graph merge, peer sync, and route rendering', () => {
    expect(HOOK_SOURCE).toContain('useDiscoveryGraph')
    expect(HOOK_SOURCE).toContain('negotiatedDiscoveryState')
    expect(HOOK_SOURCE).toContain('manualConnectionRenderRoutes')
    expect(HOOK_SOURCE).toContain('ambientDiscoveryRenderRoutes')
    expect(HOOK_SOURCE).toContain('window.electron?.terminal?.updatePeers')
  })
})
