// Server scopes and the choice of which running server a front uses.
//
// A "user" server serves any folder (the default server is one); a "project"
// server serves only its project root and below. A front may auto-attach only
// to a server it has used before that serves its folder. Pure: callers pass in
// the discovered candidates and the front's folder (already realpath'd).

import path from "node:path";
import { DEFAULT_SERVER_NAME } from "./registry";

export type ServerScope = "user" | "project";

export interface ServerCandidate {
  url: string;
  name?: string;
  scope: ServerScope;
  /** Project root (realpath) for a project server. */
  project?: string;
  /** Started or connected to by this user before. */
  known: boolean;
  /** Last time this user attached to it (ISO), when known. */
  lastUsedAt?: string;
}

export function isInsideProject(cwd: string, root: string): boolean {
  const rel = path.relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Serves `cwd`: a user server, or a project server whose root contains `cwd`. */
export function isEligible(server: ServerCandidate, cwd: string): boolean {
  if (server.scope === "user") return true;
  return Boolean(server.project) && isInsideProject(cwd, server.project as string);
}

export function scopeLabel(server: Pick<ServerCandidate, "scope" | "project">): string {
  return server.scope === "project" ? `project: ${server.project ?? "?"}` : "user";
}

/** 0 = project server for this folder, 1 = the default user server, 2 = anything else. */
export function rankTier(server: ServerCandidate, cwd: string): 0 | 1 | 2 {
  if (server.scope === "project" && isEligible(server, cwd)) return 0;
  if (server.scope === "user" && server.name === DEFAULT_SERVER_NAME) return 1;
  return 2;
}

function lastUsedMs(server: ServerCandidate): number {
  const ms = server.lastUsedAt ? Date.parse(server.lastUsedAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Eligible servers first, best first: tier, then most recently used. */
export function rankServers(servers: readonly ServerCandidate[], cwd: string): ServerCandidate[] {
  return [...servers].sort((a, b) => {
    const ea = isEligible(a, cwd) ? 0 : 1;
    const eb = isEligible(b, cwd) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const ta = rankTier(a, cwd);
    const tb = rankTier(b, cwd);
    if (ta !== tb) return ta - tb;
    return lastUsedMs(b) - lastUsedMs(a);
  });
}

export type StartupChoice =
  /** Nothing serves this folder. */
  | { kind: "none" }
  /** One clear winner the user has used before: attach silently. */
  | { kind: "attach"; server: ServerCandidate }
  /** One eligible server, never used: ask yes/no. */
  | { kind: "confirm"; server: ServerCandidate }
  /** Several and no clear winner: let the user pick (eligible, ranked). */
  | { kind: "choose"; servers: ServerCandidate[] };

/**
 * Startup: prefer this folder's project server, then the default user server,
 * then the most recently used. Another folder's project server never counts.
 */
export function chooseStartupServer(candidates: readonly ServerCandidate[], cwd: string): StartupChoice {
  const eligible = rankServers(
    candidates.filter((c) => isEligible(c, cwd)),
    cwd,
  );
  if (eligible.length === 0) return { kind: "none" };
  const known = eligible.filter((c) => c.known);
  if (known.length === 0) {
    return eligible.length === 1 ? { kind: "confirm", server: eligible[0] } : { kind: "choose", servers: eligible };
  }
  const [best, next] = known;
  const tied =
    next !== undefined && rankTier(best, cwd) === rankTier(next, cwd) && lastUsedMs(best) === lastUsedMs(next);
  return tied ? { kind: "choose", servers: eligible } : { kind: "attach", server: best };
}

export type PickerChoice =
  | { kind: "connect"; server: ServerCandidate }
  | { kind: "picker"; servers: ServerCandidate[] };

/**
 * `/server`: connect straight away only when exactly one server is running,
 * it has been used before, it serves this folder, and it is not the one
 * already attached. Otherwise show every server (ranked, labelled).
 */
export function choosePickerAction(
  candidates: readonly ServerCandidate[],
  cwd: string,
  currentUrl?: string | null,
): PickerChoice {
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only.known && isEligible(only, cwd) && only.url !== currentUrl) return { kind: "connect", server: only };
  }
  return { kind: "picker", servers: rankServers(candidates, cwd) };
}
