// Which engine an interactive TUI launch uses: a background server (attach,
// auto-starting the default one) or the in-process Agent (serverless).
// decideStartup is the pure policy (scope rules live in ./scope.ts);
// resolveStartupServer wires it to discovery, settings, and the startup prompt.

import { isServerAutoStartEnabled } from "../utils/settings";
import { discoverServerCandidates, realCwd } from "./candidates";
import { startServer } from "./lifecycle";
import { DEFAULT_SERVER_NAME } from "./registry";
import { chooseStartupServer, type ServerCandidate, scopeLabel } from "./scope";

export interface StartupInputs {
  /** A TTY-backed interactive launch (no -p/--prompt, --verify, background task). */
  interactive: boolean;
  /** --connect <url>. */
  connect?: string;
  /** --serverless. */
  serverless: boolean;
  /** settings.server.autoStart (default true). */
  autoStart: boolean;
  /** Reachable servers. */
  candidates: readonly ServerCandidate[];
  /** The launch folder (realpath). */
  cwd: string;
}

export type StartupDecision =
  | { action: "serverless" }
  | { action: "connect"; url: string }
  | { action: "attach"; server: ServerCandidate }
  | { action: "prompt"; server: ServerCandidate }
  | { action: "choose"; servers: ServerCandidate[] }
  | { action: "start" };

export function decideStartup(inputs: StartupInputs): StartupDecision {
  if (inputs.connect) return { action: "connect", url: inputs.connect };
  if (!inputs.interactive || inputs.serverless) return { action: "serverless" };
  const choice = chooseStartupServer(inputs.candidates, inputs.cwd);
  switch (choice.kind) {
    case "attach":
      return { action: "attach", server: choice.server };
    case "confirm":
      return { action: "prompt", server: choice.server };
    case "choose":
      return { action: "choose", servers: choice.servers };
    case "none":
      return inputs.autoStart ? { action: "start" } : { action: "serverless" };
  }
}

function describe(server: ServerCandidate): string {
  return `${server.url}${server.name ? ` (${server.name})` : ""}, ${scopeLabel(server)}`;
}

export function formatServerPrompt(server: ServerCandidate): string {
  return `\nA CodeSurf server is running at ${describe(server)}.\nConnect to it? [y]es / [N]o: `;
}

export function formatChoosePrompt(servers: readonly ServerCandidate[]): string {
  const rows = servers.map((s, i) => `  [${i + 1}] ${describe(s)}${s.known ? "" : " — new"}`);
  return [
    "",
    "Several CodeSurf servers can serve this folder:",
    ...rows,
    "  [0] serverless (run locally)",
    "",
    "Choice [0]: ",
  ].join("\n");
}

export function isYes(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}

/** 1-based pick from formatChoosePrompt; anything else (incl. empty/0) = serverless. */
export function parseChoice(answer: string, count: number): number | null {
  const n = Number.parseInt(answer.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : null;
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
  cwd?: string;
}

function toTarget(server: ServerCandidate): StartupTarget {
  return { kind: "server", url: server.url, name: server.name, remember: true };
}

/** Turn the decision into a concrete target, starting the default server when asked to. */
export async function resolveStartupServer(options: ResolveStartupOptions): Promise<StartupTarget> {
  // No probes when the flags already decide it (--connect, --serverless, non-interactive).
  if (options.connect) return { kind: "server", url: options.connect, remember: true };
  if (!options.interactive || options.serverless) return { kind: "serverless" };

  const decision = decideStartup({
    ...options,
    autoStart: isServerAutoStartEnabled(),
    candidates: await discoverServerCandidates(options.configDir),
    cwd: realCwd(options.cwd),
  });
  switch (decision.action) {
    case "connect":
      return { kind: "server", url: decision.url, remember: true };
    case "attach":
      return toTarget(decision.server);
    case "prompt":
      return isYes(await options.ask(formatServerPrompt(decision.server)))
        ? toTarget(decision.server)
        : { kind: "serverless" };
    case "choose": {
      const index = parseChoice(await options.ask(formatChoosePrompt(decision.servers)), decision.servers.length);
      return index === null ? { kind: "serverless" } : toTarget(decision.servers[index]);
    }
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
