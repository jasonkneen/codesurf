/**
 * Constant URL for the self-hosted MCP-UI sandbox proxy.
 *
 * Served by the codesurf-ext:// protocol handler (see src/main/extensions/protocol.ts
 * `__runext_sandbox__` route and src/main/extensions/sandbox-proxy.ts).
 *
 * The string is identical in dev (`http://localhost:PORT` host renderer) and packaged
 * (`file://`) builds — codesurf-ext:// is a registered *standard* scheme with its own
 * distinct origin, so the proxy iframe is always CROSS-ORIGIN to the host renderer.
 * That cross-origin boundary is required for the @mcp-ui/client double-iframe sandbox
 * isolation to hold.
 *
 * The proxy is served on its own dedicated host `__runext_sandbox__`, distinct from every
 * extension's origin (`codesurf-ext://<extId>`). This ensures extension code cannot script
 * or read the proxy document via same-origin access.
 */
export const MCP_UI_SANDBOX_PROXY_URL = 'codesurf-ext://__runext_sandbox__/proxy.html'
