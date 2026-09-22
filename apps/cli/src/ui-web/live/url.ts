// Live-mode URL. `?node=ws://host:port` takes the web bundle off the parity
// scenes and onto a real node. Anything that is not a ws:// or wss:// URL is
// rejected so a typo cannot be handed to WebSocket, which would fail with an
// opaque security error after the page had already left the fixture renderer.
// Optional `?session=<id>` reattaches to a session the node still owns.

export function nodeUrlFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("node");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Optional `?session=<id>` — reattach to a session the node still owns. */
export function sessionIdFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("session");
  const id = raw?.trim() ?? "";
  return id.length > 0 ? id : null;
}

/** Optional `?token=<t>` — the node's access token, forwarded on the stream
 *  URL and on /files hrefs. */
export function tokenFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("token");
  const token = raw?.trim() ?? "";
  return token.length > 0 ? token : null;
}
