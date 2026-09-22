/**
 * MCP-UI sandbox proxy (host-authored).
 *
 * @mcp-ui/client@7.1.1 does NOT ship a sandbox proxy HTML asset (files=["dist"] only).
 * The double-iframe sandbox-proxy is part of the MCP Apps spec and the host must supply
 * it at `SandboxConfig.url`. This module returns a fully self-contained HTML document
 * (no ES imports — it is served as a static string), served at:
 *
 *     codesurf-ext://__runext_sandbox__/proxy.html
 *
 * CONTRACT (verified against @mcp-ui/client dist/index.mjs + @modelcontextprotocol/ext-apps):
 *
 * Outer iframe: created by @mcp-ui/client's AppFrame with
 *   sandbox="allow-scripts allow-same-origin allow-forms", src = SandboxConfig.url.
 *   It is THIS document. It runs the relay below and talks to window.parent (the host).
 *
 * Inner iframe: created by THIS proxy to hold untrusted guest HTML. It is sandboxed
 *   "allow-scripts" ONLY → opaque origin. This is the entire security point of the
 *   double-iframe.
 *
 * ORIGIN ISOLATION NOTE: The proxy is served from its own dedicated host
 *   codesurf-ext://__runext_sandbox__, which is DIFFERENT from every extension's
 *   origin (codesurf-ext://<extId>). The browser's same-origin policy therefore
 *   prevents any extension from scripting or reading the proxy document. The inner
 *   guest iframe uses "allow-scripts" only (opaque origin), so it cannot reach the
 *   proxy either. NEVER add allow-same-origin to the inner frame.
 *
 * Handshake:
 *  1. On load, post {jsonrpc, method:'ui/notifications/sandbox-proxy-ready'} to parent.
 *     AppFrame waits (10s) for a raw message whose source === outer.contentWindow and
 *     data.method === that string (method-only check; envelope is lenient).
 *  2. Host connects its PostMessageTransport to outer.contentWindow, sends ui/initialize,
 *     then sends ui/notifications/sandbox-resource-ready { html, sandbox?, csp?, permissions? }.
 *  3. We intercept sandbox-resource-ready, mount the inner iframe via srcdoc (the html is
 *     for the guest, never meant to be relayed onward), and the guest's App.connect()
 *     posts ui/initialize up to window.parent (== this proxy), which we relay to the host.
 *  4. All other JSON-RPC messages are relayed VERBATIM by source identity:
 *       - from parent (host)  → down to inner (guest)
 *       - from inner (guest)  → up to parent (host)
 *     PostMessageTransport drops anything failing JSONRPCMessageSchema and ignores any
 *     message whose event.source !== its expected source, so we must NOT re-wrap envelopes
 *     and must post from windows whose identity matches the expected source on each side.
 *     Both relay directions use targetOrigin:"*" — no hardcoded origin strings — so the
 *     proxy works regardless of which host it is served from.
 */

const PROXY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>html,body{margin:0;height:100%;background:transparent}#guest{border:0;width:100%;height:100%;display:block}</style>
</head>
<body>
<script>
(function () {
  "use strict";
  var parentWin = window.parent;
  var inner = null; // inner guest iframe element
  var PROXY_READY = "ui/notifications/sandbox-proxy-ready";
  var RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

  // Build the inner sandboxed iframe and load guest HTML via srcdoc.
  // SECURITY: "allow-scripts" ONLY — opaque origin. Never add allow-same-origin here:
  // the proxy is served from codesurf-ext://__runext_sandbox__ (its own isolated host).
  function mountGuest(html, sandboxAttr) {
    if (inner && inner.parentNode) inner.parentNode.removeChild(inner);
    inner = document.createElement("iframe");
    inner.id = "guest";
    inner.setAttribute("sandbox", sandboxAttr || "allow-scripts");
    inner.srcdoc = typeof html === "string" ? html : "";
    document.body.appendChild(inner);
  }

  window.addEventListener("message", function (ev) {
    // Host (parent) -> proxy.
    if (ev.source === parentWin) {
      var d = ev.data;
      if (d && d.method === RESOURCE_READY) {
        var p = (d && d.params) || {};
        // Consume: mount the guest. The html is for the inner frame, not relayed onward.
        mountGuest(p.html, p.sandbox);
        return;
      }
      // Relay everything else down to the guest verbatim.
      if (inner && inner.contentWindow) inner.contentWindow.postMessage(d, "*");
      return;
    }

    // Guest (inner) -> proxy. Relay up to host verbatim. event.source on the host side
    // becomes this proxy window (we post via parentWin.postMessage), which is exactly
    // outer.contentWindow — the source the host's transport expects.
    if (inner && ev.source === inner.contentWindow) {
      parentWin.postMessage(ev.data, "*");
    }
  });

  // Announce readiness so AppFrame resolves and begins the ui/initialize handshake.
  parentWin.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, "*");
})();
</script>
</body>
</html>`

export function getSandboxProxyHtml(): string {
  return PROXY_HTML
}
