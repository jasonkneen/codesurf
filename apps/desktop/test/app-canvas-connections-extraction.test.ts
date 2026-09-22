import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT_DIR = process.cwd()
const APP_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/App.tsx'), 'utf8')
const CONNECTIONS_SOURCE = readFileSync(join(ROOT_DIR, 'src/renderer/src/components/AppCanvasConnections.tsx'), 'utf8')

describe('wave 25 connection layer extraction', () => {
  test('App delegates connection rendering to AppCanvasConnections', () => {
    expect(APP_SOURCE).toContain("from './components/AppCanvasConnections'")
    expect(APP_SOURCE).toContain('appCanvasConnectionProps')
    expect(APP_SOURCE).toContain('<AppCanvasConnections layer="pills"')
    expect(APP_SOURCE).toContain('<AppCanvasConnections layer="routes"')
    expect(APP_SOURCE).toContain('<AppCanvasConnections layer="glow"')
    expect(APP_SOURCE).not.toContain('LazyConnectionPill')
    expect(APP_SOURCE).not.toContain('manual-route-')
    expect(APP_SOURCE).not.toContain('discovery-route-travel')
  })

  test('AppCanvasConnections owns pills, routes, and glow layers', () => {
    expect(CONNECTIONS_SOURCE).toContain('export function AppCanvasConnections')
    expect(CONNECTIONS_SOURCE).toContain('export function shouldShowConnectionPills')
    expect(CONNECTIONS_SOURCE).toContain('export function shouldShowConnectionRoutes')
    expect(CONNECTIONS_SOURCE).toContain('export function shouldShowConnectionGlow')
    expect(CONNECTIONS_SOURCE).toContain('LazyConnectionPill')
    expect(CONNECTIONS_SOURCE).toContain('manual-route-')
    expect(CONNECTIONS_SOURCE).toContain('discovery-route-travel')
    expect(CONNECTIONS_SOURCE).toContain('getBezierConnectionPath')
    expect(CONNECTIONS_SOURCE).toContain('discoveryGlowRef')
  })
})