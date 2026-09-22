// Web HostFiles: local paths become HTTP GETs against the node that owns them.
//
// `?node=ws://127.0.0.1:3948` → `http://127.0.0.1:3948/files?path=...`
// exists() is false: the browser cannot stat the node's disk synchronously.
// open() is window.open of the same href.

import type { HostFiles } from "../ui/host-files-types.js";
import { tokenFromSearch } from "./live/url.js";

/** ws(s)://host:port → http(s)://host:port, or null if the URL is not a node. */
export function httpOriginFromNodeUrl(node: string): string | null {
  try {
    const url = new URL(node);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else return null;
    return url.origin;
  } catch {
    return null;
  }
}

function origin(): string {
  if (typeof window === "undefined") return "";
  const node = new URLSearchParams(window.location.search).get("node");
  return node ? (httpOriginFromNodeUrl(node) ?? "") : "";
}

function pageToken(): string | null {
  if (typeof window === "undefined") return null;
  return tokenFromSearch(window.location.search);
}

/** HTTP(S) `/files?path=` href the live front uses. Never `file://`. The node
 *  requires its token on /files, so it rides in the query, before any #L. */
export function hrefForNodeFile(origin: string, path: string, line?: number, token?: string | null): string {
  let href = `${origin}/files?path=${encodeURIComponent(path)}`;
  if (token) href += `&token=${encodeURIComponent(token)}`;
  return line ? `${href}#L${line}` : href;
}

export const hostFiles: HostFiles = {
  hrefForPath(path, line) {
    const base = origin();
    return base ? hrefForNodeFile(base, path, line, pageToken()) : path;
  },
  exists: () => false,
  open(path) {
    const href = hostFiles.hrefForPath(path);
    if (typeof window !== "undefined") window.open(href, "_blank", "noopener");
    return true;
  },
};
