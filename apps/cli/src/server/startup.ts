// Which engine an interactive TUI launch uses: a background server (attach,
// auto-starting the default one) or the in-process Agent (serverless).
// decideStartup is the pure policy; resolveStartupServer wires it to the
// registry, discovery probes, settings, and the startup prompt.

import { DEFAULT_NODE_PORT, probeServer } from "../relay/server-discovery";
import { isKnownServer, isServerAutoStartEnabled } from "../utils/settings";
import { DEFAULT_SERVER_HOST, serverUrl, startServer } from "./lifecycle";
import { DEFAULT_SERVER_NAME, listRecords, liveRecord } from "./registry";

export interface RunningServer {
  url: string;
  name?: string;
  /** Started or connected to by this user before: attach without asking. */
  known: boolean;
}

export interface StartupInputs {
  /** A TTY-backed interactive launch (no -p/--prompt, --verify, background task). */
  interactive: boolean;
  /** --connect <url>. */
  connect?: string;
  /** --serverless. */
  serverless: boolean;
  /** settings.server.autoStart (default true). */
  autoStart: boolean;
  running: RunningServer | null;
}

export type StartupDecision =
  | { action: "serverless" }
  | { action: "connect"; url: string }
  | { action: "attach"; server: RunningServer }
  | { action: "prompt"; server: RunningServer }
  | { action: "start" };

export function decideStartup(inputs: StartupInputs): StartupDecision {
  if (inputs.connect) return { action: "connect", url: inputs.connect };
  if (!inputs.interactive || inputs.serverless) return { action: "serverless" };
  if (inputs.running) {
    return inputs.running.known
      ? { action: "attach", server: inputs.running }
      : { action: "prompt", server: inputs.running };
  }
  return inputs.autoStart ? { action: "start" } : { action: "serverless" };
}

/**
 * The server a launch would attach to: the registered default, else whatever
 * answers on the default port, else any other registered server.
 */
export async function findRunningServer(configDir?: string): Promise<RunningServer | null> {
  const registered = liveRecord(DEFAULT_SERVER_NAME, configDir);
  if (registered && (await probeServer(registered.url))) {
    return { url: registered.url, name: registered.name, known: true };
  }
  const records = listRecords(configDir);
  const defaultUrl = serverUrl(DEFAULT_SERVER_HOST, DEFAULT_NODE_PORT);
  if (await probeServer(defaultUrl)) {
    const record = records.find((r) => r.url === defaultUrl);
    return { url: defaultUrl, name: record?.name, known: Boolean(record) || isKnownServer(defaultUrl) };
  }
  for (const record of records) {
    if (record.name === DEFAULT_SERVER_NAME) continue;
    if (await probeServer(record.url)) return { url: record.url, name: record.name, known: true };
  }
  return null;
}

export function formatServerPrompt(server: RunningServer): string {
  const label = server.name ? ` (${server.name})` : "";
  return `\nA CodeSurf server is running at ${server.url}${label}.\nConnect to it? [y]es / [N]o: `;
}

export function isYes(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}

export type StartupTarget =
  | { kind: "serverless"; notice?: string }
  | {
      kind: "server";
      url: string;
      name?: string;
      /** Remember as known once attached. */
      remember: boolean;
    };

export interface ResolveStartupOptions {
  interactive: boolean;
  connect?: string;
  serverless: boolean;
  cliVersion: string;
  /** Ask the user; resolves to their raw answer. */
  ask: (question: string) => Promise<string>;
  configDir?: string;
}

/** Turn the decision into a concrete target, starting the default server when asked to. */
export async function resolveStartupServer(options: ResolveStartupOptions): Promise<StartupTarget> {
  // No probes when the flags already decide it (--connect, --serverless, non-interactive).
  if (options.connect) return { kind: "server", url: options.connect, remember: true };
  if (!options.interactive || options.serverless) return { kind: "serverless" };

  const decision = decideStartup({
    ...options,
    autoStart: isServerAutoStartEnabled(),
    running: await findRunningServer(options.configDir),
  });
  switch (decision.action) {
    case "connect":
      return { kind: "server", url: decision.url, remember: true };
    case "attach":
      return { kind: "server", url: decision.server.url, name: decision.server.name, remember: true };
    case "prompt":
      return isYes(await options.ask(formatServerPrompt(decision.server)))
        ? { kind: "server", url: decision.server.url, name: decision.server.name, remember: true }
        : { kind: "serverless" };
    case "serverless":
      return { kind: "serverless" };
    case "start":
      try {
        const { record } = await startServer({
          name: DEFAULT_SERVER_NAME,
          cliVersion: options.cliVersion,
          configDir: options.configDir,
          readyTimeoutMs: 10_000,
        });
        return { kind: "server", url: record.url, name: record.name, remember: true };
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0];
        return { kind: "serverless", notice: `could not start the background server (${reason}) — running serverless` };
      }
  }
}
