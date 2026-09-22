// HTTP GET /files?path= — serve a workspace file to a web front.
//
// The live page is a different origin than the node (vite vs WS port), so
// responses carry CORS — but only for explicitly allowed origins; any other
// site gets no CORS header and cannot read the body. Paths must resolve (after
// symlinks) under one of the configured roots (cwd + tmpdir by default) so
// `../etc/passwd` or a symlink out of the root is 403, not a file. The caller
// (WsRelayServer) authenticates the request before it reaches this handler.

import { createReadStream, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

export interface FileRequestOptions {
  /** Browser origins allowed to read files cross-origin. Default: none. */
  allowedOrigins?: readonly string[];
}

function cors(req: IncomingMessage, res: ServerResponse, allowedOrigins: readonly string[]): void {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization");
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Absolute path under a root, or null if the request is outside every root. */
export function resolveSafePath(raw: string, roots: readonly string[]): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(decoded)) return null;
  const resolved = resolve(decoded);
  for (const root of roots) {
    const base = resolve(root);
    if (resolved === base || resolved.startsWith(base + sep)) return resolved;
  }
  return null;
}

/**
 * Like resolveSafePath, but the containment check runs on real paths (both the
 * target and the roots) so a symlink inside a root cannot escape it. Returns
 * null for a missing file too.
 */
export function resolveRealSafePath(raw: string, roots: readonly string[]): string | null {
  const lexical = resolveSafePath(raw, roots);
  if (!lexical) return null;
  const real = realpathOrNull(lexical);
  if (!real) return null;
  for (const root of roots) {
    const base = realpathOrNull(resolve(root));
    if (base && (real === base || real.startsWith(base + sep))) return real;
  }
  return null;
}

export function handleFileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  roots: readonly string[],
  options: FileRequestOptions = {},
): void {
  cors(req, res, options.allowedOrigins ?? []);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const raw = url.searchParams.get("path") ?? "";
  if (!resolveSafePath(raw, roots)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const safe = resolveRealSafePath(raw, roots);
  if (!safe) {
    // Missing, or a symlink resolving outside every root.
    res.writeHead(realpathOrNull(resolve(decodeURIComponent(raw))) ? 403 : 404);
    res.end();
    return;
  }
  try {
    const st = statSync(safe);
    if (!st.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = TYPES[extname(safe).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": st.size,
      "cache-control": "private, max-age=60",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(safe).pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
}
