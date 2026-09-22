// Gateway bearer-token management (Phase 1 W2). Token comes from
// CODESURF_GATEWAY_TOKEN or a machine-local file under the codesurf home
// (~/.codesurf/gateway/token), generated on first use with 0600 perms.
// The engine node (`codesurf node`) keeps its own token the same way under
// ~/.codesurf/node/token (CODESURF_NODE_TOKEN).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TokenName = "gateway" | "node";

const TOKEN_ENV: Record<TokenName, string> = {
  gateway: "CODESURF_GATEWAY_TOKEN",
  node: "CODESURF_NODE_TOKEN",
};

export function tokenPath(name: TokenName, homeDir?: string): string {
  const home = homeDir ?? process.env.CODESURF_HOME ?? join(homedir(), ".codesurf");
  return join(home, name, "token");
}

export function gatewayTokenPath(homeDir?: string): string {
  return tokenPath("gateway", homeDir);
}

export async function resolveToken(name: TokenName, homeDir?: string): Promise<string> {
  const fromEnv = process.env[TOKEN_ENV[name]];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const path = tokenPath(name, homeDir);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch {
    // fall through to generation
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return token;
}

/** Read an existing token (env or file) without generating one; null when none exists. */
export function readTokenSync(name: TokenName, homeDir?: string): string | null {
  const fromEnv = process.env[TOKEN_ENV[name]];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const existing = readFileSync(tokenPath(name, homeDir), "utf8").trim();
    return existing.length > 0 ? existing : null;
  } catch {
    return null;
  }
}

export async function resolveGatewayToken(homeDir?: string): Promise<string> {
  return resolveToken("gateway", homeDir);
}

/** Constant-time token comparison. */
export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
