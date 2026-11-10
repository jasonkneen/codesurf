// `codesurf serve` command (Phase 1 W2). Boots the engine host and serves the
// agent gateway: sessions + tool plane over HTTP/SSE, one in-process Agent per
// session (PTC presentation included). Provider-backed turns need a configured
// API key; the server itself starts without one so session tooling is usable.

import { bootstrapPlugins, getHostServices } from "../core/plugins";
import { loadBuiltinPlugins } from "../core/plugins/builtin";
import { normalizeModelId } from "../grok/models";
import {
  getApiKey,
  getBaseURL,
  getCurrentSandboxMode,
  getCurrentSandboxSettings,
  mergeSandboxSettings,
} from "../utils/settings";
import { GatewayAgentHost } from "./agent-host";
import { startGatewayServer } from "./http-server";
import { GatewaySessionRegistry } from "./session-registry";
import { resolveGatewayToken } from "./token";
import type { GatewayPresentation } from "./types";

export interface ServeOptions {
  port?: string;
  host?: string;
  presentation?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxToolRounds?: string;
}

export async function runServeCommand(options: ServeOptions): Promise<never> {
  await bootstrapPlugins([...(await loadBuiltinPlugins())]);

  const apiKey = options.apiKey || getApiKey();
  const baseURL = options.baseUrl || getBaseURL();
  const model = options.model ? normalizeModelId(options.model) : undefined;
  const maxToolRounds = parseInt(options.maxToolRounds || "400", 10) || 400;
  const presentation: GatewayPresentation =
    options.presentation === "code" || options.presentation === "both" ? options.presentation : "native";

  const bashServices = getHostServices().bash;
  bashServices.setSandboxMode(getCurrentSandboxMode());
  const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), {});
  if (sandboxSettings) bashServices.setSandboxSettings(sandboxSettings);

  const token = await resolveGatewayToken();
  const host = new GatewayAgentHost({ apiKey, baseURL, model, maxToolRounds });
  const started = await startGatewayServer({
    token,
    runner: host.runner,
    registry: new GatewaySessionRegistry(presentation),
    port: parseInt(options.port || "3947", 10) || 3947,
    host: options.host || "127.0.0.1",
    onRemove: (id) => void host.disposeSession(id),
  });

  const lines = [
    "codesurf gateway listening:",
    `  url: ${started.url}`,
    `  presentation default: ${presentation}`,
    `  api key: ${apiKey ? "configured" : "NOT SET (turns will fail with auth errors)"}`,
  ];
  console.log(lines.join("\n"));

  const shutdown = async () => {
    await host.cleanup();
    await started.server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {});
  return undefined as never;
}
