import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  computeShellLayoutMetricsGrouped,
  flattenShellLayoutMetrics,
} from '../src/renderer/src/hooks/useShellLayoutMetrics.ts'
import type { AppTheme } from '../src/renderer/src/theme.ts'
import type { AppSettings, Workspace } from '../src/shared/types.ts'

function fakeTheme(mode: 'light' | 'dark' = 'dark'): AppTheme {
  return {
    id: 'test',
    name: 'Test',
    mode,
    accent: { base: '#7bf1ff' },
    surface: {
      app: '#111',
      panel: '#222',
      hover: '#333',
      selection: '#444',
    },
    text: { primary: '#eee' },
    canvas: { backgroundEffect: '' },
  } as unknown as AppTheme
}

function fakeSettings(): AppSettings {
  return {
    canvasBackground: '#0a0a0a',
    translucentBackgroundOpacity: 1,
  } as AppSettings
}

const fonts = {
  primary: 'sans',
  secondary: 'sans',
  mono: 'mono',
  size: 13,
  lineHeight: 1.5,
  weight: 400,
  secondarySize: 11,
  secondaryLineHeight: 1.4,
  secondaryWeight: 400,
  monoSize: 13,
  monoLineHeight: 1.5,
  monoWeight: 400,
}

describe('shell layout metrics grouping', () => {
  test('computeShellLayoutMetricsGrouped exposes sidebar/mainPanel/tabs/discovery groups', () => {
    const ws: Workspace = { id: 'w1', name: 'One', path: '/tmp/one' } as Workspace
    const grouped = computeShellLayoutMetricsGrouped({
      settings: fakeSettings(),
      theme: fakeTheme('dark'),
      sidebarCollapsed: false,
      sidebarWidth: 300,
      panelLayout: null,
      openWorkspaceIds: ['w1'],
      workspaces: [ws],
      workspace: ws,
      showWorkspacePickerTab: false,
      appFonts: fonts,
    })

    assert.equal(typeof grouped.sidebar.footerHeight, 'number')
    assert.equal(typeof grouped.mainPanel.left, 'number')
    assert.equal(typeof grouped.workspaceTabs.labelSize, 'number')
    assert.equal(typeof grouped.discovery.pillZIndex, 'number')
    assert.equal(grouped.hasWorkspaceTabs, true)
    assert.equal(grouped.openWorkspaceTabs[0]?.id, 'w1')
    assert.ok(grouped.mainPanel.left > 300) // expanded layout offset
  })

  test('flattenShellLayoutMetrics preserves legacy flat field names', () => {
    const grouped = computeShellLayoutMetricsGrouped({
      settings: fakeSettings(),
      theme: fakeTheme('light'),
      sidebarCollapsed: true,
      sidebarWidth: 300,
      panelLayout: null,
      openWorkspaceIds: [],
      workspaces: [],
      workspace: null,
      showWorkspacePickerTab: true,
      appFonts: fonts,
    })
    const flat = flattenShellLayoutMetrics(grouped)
    assert.equal(flat.sidebarFooterHeight, grouped.sidebar.footerHeight)
    assert.equal(flat.mainPanelLeft, grouped.mainPanel.left)
    assert.equal(flat.workspaceTabLabelSize, grouped.workspaceTabs.labelSize)
    assert.equal(flat.discoveryPillZIndex, grouped.discovery.pillZIndex)
    assert.equal(flat.dsc, grouped.discovery.colors)
    assert.equal(flat.mainStatusBarLeft, 0) // collapsed sidebar
  })
})
