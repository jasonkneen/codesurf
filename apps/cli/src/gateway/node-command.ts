// `codesurf node` command (Phase 3). Boots a runnable engine node: a WS hub that
// owns sessions (create/message/status/destroy) bound to the real engine Agent —
// the fabric node that fronts (TUI, editor, agensis) connect to and delegate work
// into. It does not call the provider until a session message turn runs, so it
// boots without an API key (like serve).

import { bootstrapPlugins, getHostServices } from "../core/plugins";
import { loadBuiltinPlugins } from "../core/plugins/builtin";
import { normalizeModelId } from "../grok/models";
import { EngineNode } from "../relay/engine-node";
import { resolveNodeScope } from "../relay/session-workspace";
import {
  getApiKey,
  getBaseURL,
  getCurrentSandboxMode,
  getCurrentSandboxSettings,
  mergeSandboxSettings,
} from "../utils/settings";
import { NodeAgentHost } from "./node-host";
import { resolveToken, tokenPath } from "./token";

export interface NodeCommandOptions {
  port?: string;
  host?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxToolRounds?: string;
  /** Browser origins allowed to connect (repeatable), e.g. the live web front. */
  allowOrigin?: string[];
  /** Approve every tool call when no front is attached to decide (default: deny). */
  autoApprove?: boolean;
  /** Absolute project root: serve only sessions in it or below (a "project" server). Unset = any folder. */
  project?: string;
  /** Display name reported to fronts in the node's info. */
  name?: string;
}

export async function runNodeCommand(options: NodeCommandOptions): Promise<never> {
  // Validate --project before booting anything, so a typo fails fast.
  const scope = resolveNodeScope({ project: options.project, name: options.name });
  await bootstrapPlugins([...(await loadBuiltinPlugins())]);

  const apiKey = options.apiKey || getApiKey();
  const baseURL = options.baseUrl || getBaseURL();
  const model = options.model ? normalizeModelId(options.model) : undefined;
  const maxToolRounds = parseInt(options.maxToolRounds || "400", 10) || 400;

  const bashServices = getHostServices().bash;
  bashServices.setSandboxMode(getCurrentSandboxMode());
  const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), {});
  if (sandboxSettings) bashServices.setSandboxSettings(sandboxSettings);

  const host = options.host || "127.0.0.1";
  const token = await resolveToken("node");
  const agentHost = new NodeAgentHost({
    apiKey,
    baseURL,
    model,
    maxToolRounds,
    autoApprove: options.autoApprove === true,
  });
  const engine = new EngineNode({
    turnRunner: agentHost.runner,
    jobRunner: agentHost.batchRunner,
    port: parseInt(options.port || "3948", 10) || 3948,
    host,
    // Every socket must present this token; the steward then admits only the
    // token-authenticated principal (EngineNode's default when a token is set).
    authToken: token,
    allowedOrigins: options.allowOrigin ?? [],
    scope,
    // Reap abandoned/expired sessions, jobs, and traces; dispose the evicted
    // session's Agent so the node does not leak (the same failure the buddy
    // audit found: abandoned MCP sessions exhausting the server).
    sessionIdleTtlMs: 30 * 60_000,
    sessionMaxTtlMs: 24 * 60 * 60_000,
    reapIntervalMs: 30_000,
    onSessionEvict: (sessionId) => void agentHost.disposeSession(sessionId),
  });
  await engine.start();

  const wsUrl = "ws://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + engine.port();
  console.log("codesurf node listening:");
  console.log("  ws:  " + wsUrl);
  console.log("  connect: " + wsUrl + "/?token=" + token);
  console.log("  token: " + tokenPath("node") + " (or CODESURF_NODE_TOKEN)");
  console.log(
    "  tool approvals: " + (options.autoApprove ? "AUTO-APPROVED (--auto-approve)" : "denied (no front to ask)"),
  );
  console.log("  serves: " + (scope.scope === "project" ? "project " + scope.project : "any folder (user server)"));
  if (scope.name) console.log("  name: " + scope.name);
  console.log("  hub: " + engine.hub.peers().length + " node registered");
  console.log("  api key: " + (apiKey ? "configured" : "NOT SET (turns will fail with auth errors)"));

  const shutdown = async () => {
    await agentHost.cleanup();
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {});
  return undefined as never;
}
