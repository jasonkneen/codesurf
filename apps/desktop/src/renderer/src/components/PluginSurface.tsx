/**
 * PluginSurface — renders a plugin contribution surface in one of three render modes.
 *
 *   render: 'component'  → trusted in-host React node (built-ins). Renders props.component.
 *   render: 'iframe'     → a sandboxed iframe pointed at a pre-resolved codesurf-ext:// entry
 *                          URL. Same serving path ExtensionTile uses; the host injects the
 *                          window.contex bridge into codesurf-ext://-served HTML.
 *   render: 'mcp-ui'     → @mcp-ui/client <AppRenderer> fed pre-fetched HTML (or an entry
 *                          URL resolved to HTML upstream), a self-hosted cross-origin sandbox
 *                          proxy, explicit hostContext + hostCapabilities, and onCallTool
 *                          bridged to codesurf via window.electron.extensions.invoke.
 *
 * mcp-ui guests do NOT receive the window.contex postMessage bridge — they speak AppBridge
 * JSON-RPC through the double-iframe sandbox proxy. The only codesurf-ext:// touchpoint for
 * mcp-ui is serving the proxy document itself (see src/main/extensions/sandbox-proxy.ts).
 */

import { AppRenderer } from '@mcp-ui/client'
import type { AppRendererProps, McpUiHostContext, McpUiHostCapabilities } from '@mcp-ui/client'
import { useTheme } from '../ThemeContext'
import { MCP_UI_SANDBOX_PROXY_URL } from '../../../shared/mcpUiProxy'
import {
  getExtensionIframeAllow,
  type SensitiveMediaCapability,
} from '../../../shared/extension-sensitive-media'

export type PluginSurfaceRenderMode = 'iframe' | 'component' | 'mcp-ui'

export interface PluginSurfaceProps {
  /** Owning plugin/extension id — used to bridge mcp-ui tool calls back to the host. */
  extId: string
  /** Which paint path to use. */
  render: PluginSurfaceRenderMode
  /** Pre-resolved codesurf-ext:// entry URL (render:'iframe'). */
  entry?: string
  /** Pre-fetched HTML string for the mcp-ui guest (render:'mcp-ui'). */
  html?: string
  /** Trusted in-host React node (render:'component'). */
  component?: React.ReactNode
  /** Stable id for this surface instance — used as the mcp-ui toolName label. */
  surfaceId?: string
  /** Optional input forwarded to the mcp-ui guest after init. */
  toolInput?: Record<string, unknown>
  /** Wrapper style. The surface fills this container. */
  style?: React.CSSProperties
  /** Sensitive media declared by an iframe plugin. Ignored by component and mcp-ui modes. */
  sensitiveMedia?: readonly SensitiveMediaCapability[]
}

// Host capabilities advertised to the mcp-ui guest. With no MCP Client passed to
// AppRenderer, capabilities are NOT derived from a server — they must be set explicitly
// or the guest is told it may not call tools / send messages. (Verified in
// @mcp-ui/client dist/index.mjs: derivation lives entirely inside `if (this._client)`.)
const HOST_CAPS: McpUiHostCapabilities = {
  openLinks: {},
  serverTools: {}, // enables guest tools/call → onCallTool
  message: { text: {} }, // enables ui/message
  logging: {},
}

export function PluginSurface({
  extId,
  render,
  entry,
  html,
  component,
  surfaceId,
  toolInput,
  style,
  sensitiveMedia,
}: PluginSurfaceProps) {
  const theme = useTheme()

  if (render === 'component') {
    return <div style={{ width: '100%', height: '100%', ...style }}>{component ?? null}</div>
  }

  if (render === 'iframe') {
    if (!entry) return null
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }}>
        <iframe
          src={entry}
          sandbox="allow-scripts allow-same-origin allow-modals"
          allow={getExtensionIframeAllow(sensitiveMedia)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            border: 'none',
            background: 'transparent',
          }}
          title={surfaceId ?? extId}
        />
      </div>
    )
  }

  // render === 'mcp-ui'
  const hostContext: McpUiHostContext = {
    theme: theme.mode === 'dark' ? 'dark' : 'light',
    platform: 'desktop',
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }

  // Structurally typed against AppRendererProps so we avoid a fragile transitive
  // subpath import of CallToolResult; the return shape is still fully checked.
  const onCallTool: NonNullable<AppRendererProps['onCallTool']> = async (params) => {
    try {
      const args = (params.arguments ?? {}) as Record<string, unknown>
      const raw = await window.electron.extensions.invoke(extId, params.name, args)
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      return {
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      }
    }
  }

  const onOpenLink: NonNullable<AppRendererProps['onOpenLink']> = async ({ url }) => {
    try {
      await window.electron.shell?.openExternal?.(url)
    } catch {
      /* ignore */
    }
    return {}
  }

  // Accept ui/message but echo nothing back (no content reflection — security).
  const onMessage: NonNullable<AppRendererProps['onMessage']> = async () => ({})

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', ...style }}>
      <AppRenderer
        // client intentionally omitted — we feed pre-fetched html + custom handlers.
        toolName={surfaceId ?? extId}
        sandbox={{ url: new URL(MCP_UI_SANDBOX_PROXY_URL) }}
        html={html ?? ''}
        toolInput={toolInput}
        hostContext={hostContext}
        hostCapabilities={HOST_CAPS}
        onCallTool={onCallTool}
        onOpenLink={onOpenLink}
        onMessage={onMessage}
        onError={(err) => console.error('[PluginSurface mcp-ui]', err)}
      />
    </div>
  )
}
