// Builtin Grok CLI provider (xAI's `grok` agent CLI).
//
// NOT the same thing as `xai-provider.ts`. That one talks to the xAI HTTP API
// and CodeSurf runs the agent loop. This one delegates the whole turn to the
// `grok` CLI, which owns its own tools, skills, MCP servers, and permission
// modes — the same relationship CodeSurf has with claude/codex/amp.
//
// Transport: one child process per turn.
//
//   grok -p <prompt> --output-format streaming-messages-json
//        --include-partial-messages [--resume <session-id>]
//
// Grok has no stdin turn loop (`-p/--single` is the only headless input), so it
// cannot hold a persistent session the way amp/claude/codex do — the process
// exits at end of turn. `grok leader` + ~/.grok/leader.sock exist but are
// process management (list/info/kill), not a client protocol. Continuity comes
// from `--resume <session-id>` instead, which is why this adapter is declared
// `stateless` rather than lying about `persistent`.
//
// The upside: grok is the best streaming citizen of the fleet. With
// `--include-partial-messages` it emits true token-level `thinking_delta` AND
// `text_delta` events, then repeats the content whole in a trailing `assistant`
// message. Verified directly:
//
//   {"type":"system","subtype":"init","session_id":"019fc6d0-...","model":"grok-4.5"}
//   {"type":"stream_event","event":{"type":"content_block_delta",
//     "index":0,"delta":{"type":"thinking_delta","thinking":"The"}}}
//   {"type":"stream_event","event":{"type":"content_block_delta",
//     "index":1,"delta":{"type":"text_delta","text":"ok"}}}
//   {"type":"assistant","message":{"content":[{"type":"thinking",...},
//                                             {"type":"text","text":"ok"}]}}
//   {"type":"result","subtype":"success","stop_reason":"end_turn","usage":{...}}
//
// The shared decoder's dedupe latch is what stops that trailing complete
// message from printing everything a second time.

import type {
  CodesurfPlugin,
  CredentialStatus,
  ModelSpec,
  PluginContext,
  PluginManifest,
  ProviderConnectionContext,
  ProviderSession,
  ProviderStreamController,
  ProviderTurnInput,
  ProviderUsageSnapshot,
} from "@codesurf/plugin-api";
import { isBinaryInstalled } from "../../../utils/binary-on-path";
import { CODESURF_PROVIDERS_GROUP } from "../builtin/groups";
import { runOneshotStreamJsonTurn } from "../builtin/transports";

const EXTENSION_ID = "builtin.provider-grok-cli";
const PROVIDER_ID = "grok-cli";
const ADAPTER_ID = "grok.cli";
const GROK_BIN = "grok";

const BIN_SETTING = `${ADAPTER_ID}.bin`;
const PERMISSION_SETTING = `${ADAPTER_ID}.permissionMode`;
const MAX_TURNS_SETTING = `${ADAPTER_ID}.maxTurns`;
const THINKING_SETTING = `${ADAPTER_ID}.partialMessages`;

const DEFAULT_PERMISSION = "default";
const PERMISSION_OPTIONS = [
  { value: "default", label: "default — ask on first use" },
  { value: "acceptEdits", label: "acceptEdits — auto-approve edits" },
  { value: "auto", label: "auto" },
  { value: "dontAsk", label: "dontAsk" },
  { value: "plan", label: "plan — read-only planning" },
  { value: "bypassPermissions", label: "bypassPermissions — approve everything" },
];

/** Registered before `grok models` answers, and the fallback if it fails.
 *  Kept to the one model every install has. */
const FALLBACK_MODELS: ModelSpec[] = [
  {
    id: "grok-4.5",
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: "Grok 4.5 (CLI)",
    description: "xAI's `grok` agent CLI. Owns its own tools, skills, and MCP servers.",
    capabilities: { tools: true, reasoning: true, images: false },
  },
];

/**
 * Parse `grok models` stdout.
 *
 *   You are logged in with grok.com.
 *
 *   Default model: grok-4.5
 *
 *   Available models:
 *     * grok-4.5 (default)
 *     - alex/claude-opus-4-8
 *     - alex/gpt-5.5
 *     ...
 *
 * `*` marks the default, `-` the rest. Ids may be namespaced (`alex/...`),
 * which is why we take the token verbatim rather than trying to normalise it —
 * grok expects its own id back on `--model`.
 */
export function parseGrokModels(stdout: string): ModelSpec[] {
  const out: ModelSpec[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = /^\s*([*-])\s+(\S+)/.exec(rawLine);
    if (!match) continue;
    const id = match[2];
    // Guard against prose lines that happen to start with a dash.
    if (!id || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    const isDefault = match[1] === "*";
    // Namespaced ids (`alex/gpt-5.5`) are third-party models grok proxies; the
    // bare ones are xAI's own.
    const slash = id.indexOf("/");
    const shortName = slash === -1 ? id : id.slice(slash + 1);
    const namespace = slash === -1 ? null : id.slice(0, slash);
    out.push({
      id,
      providerId: PROVIDER_ID,
      adapterId: ADAPTER_ID,
      label: `${shortName} (Grok CLI)${isDefault ? " — default" : ""}`,
      description: namespace
        ? `${shortName} proxied through the \`grok\` CLI (${namespace} namespace).`
        : "xAI's `grok` agent CLI. Owns its own tools, skills, and MCP servers.",
      capabilities: { tools: true, reasoning: true, images: false },
    });
  }
  return out;
}

/** Ask the CLI what models this account actually has.
 *
 *  Runs at activation only (the host calls `listModels` fire-and-forget), never
 *  on the render path — a subprocess there would freeze the TUI. Bounded so a
 *  hung CLI cannot stall extension activation. */
async function discoverGrokModels(bin: string): Promise<ModelSpec[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run(bin, ["models"], { timeout: 15_000, encoding: "utf-8" });
    const parsed = parseGrokModels(stdout);
    return parsed.length > 0 ? parsed : FALLBACK_MODELS;
  } catch {
    // Not installed / not logged in — the auth check reports that properly.
    return FALLBACK_MODELS;
  }
}

/** The executable the session, model discovery, and the credential probe all
 *  use. One resolver so a configured absolute path outside PATH passes the
 *  same gate it runs on. */
function resolveGrokExecutable(settings: ProviderConnectionContext["settings"]): string {
  return (settings.get<string>(BIN_SETTING, GROK_BIN) || GROK_BIN).trim() || GROK_BIN;
}

class GrokCliSession implements ProviderSession {
  readonly adapterId = ADAPTER_ID;
  readonly providerId = PROVIDER_ID;
  // Honest: the process does not survive the turn. Continuity is --resume.
  readonly mode = "stateless" as const;
  readonly strategy = "per-conversation" as const;

  /** Upstream session id from grok's init message. Passed back as `--resume`
   *  on every subsequent turn so the conversation keeps its history. */
  private grokSessionId: string | null = null;
  private abortController: AbortController | null = null;
  private disconnected = false;

  constructor(private readonly ctx: ProviderConnectionContext) {}

  private bin(): string {
    return resolveGrokExecutable(this.ctx.settings);
  }

  private cwd(): string {
    return this.ctx.workspace?.cwd() ?? process.cwd();
  }

  private buildArgs(input: ProviderTurnInput): string[] {
    const args = ["-p", input.prompt, "--output-format", "streaming-messages-json"];

    if (this.ctx.settings.get<boolean>(THINKING_SETTING, true) !== false) {
      // Token-level deltas. Without this grok buffers the entire response and
      // emits it as one assistant message at the end — the exact "silent for
      // 5s then a wall of text" failure mode this whole transport exists to fix.
      args.push("--include-partial-messages");
    }

    // Resume keeps grok's own session log continuous across turns. Only valid
    // once grok has told us an id (first turn creates it).
    if (this.grokSessionId) args.push("--resume", this.grokSessionId);

    if (input.modelId && !input.modelId.startsWith("grok.cli")) {
      args.push("--model", input.modelId);
    }

    const permission = this.ctx.settings.get<string>(PERMISSION_SETTING, DEFAULT_PERMISSION);
    if (permission) args.push("--permission-mode", permission);

    const maxTurns = this.ctx.settings.get<number>(MAX_TURNS_SETTING, 0) ?? 0;
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));

    args.push("--cwd", this.cwd());
    return args;
  }

  sendTurn = async (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> => {
    if (this.disconnected) throw new Error("Grok CLI session has been disconnected.");

    // Bridge the host signal to a per-turn controller so `abortTurn()` works
    // even when the host did not pass one.
    const abortController = new AbortController();
    this.abortController = abortController;
    const onHostAbort = () => abortController.abort();
    if (input.abortSignal) {
      if (input.abortSignal.aborted) abortController.abort();
      else input.abortSignal.addEventListener("abort", onHostAbort, { once: true });
    }

    try {
      return await runOneshotStreamJsonTurn(
        {
          bin: this.bin(),
          args: this.buildArgs(input),
          cwd: this.cwd(),
          label: "grok",
          abortSignal: abortController.signal,
          onSessionId: (id) => {
            this.grokSessionId = id;
          },
        },
        controller,
      );
    } finally {
      input.abortSignal?.removeEventListener("abort", onHostAbort);
      this.abortController = null;
    }
  };

  abortTurn = (): void => {
    this.abortController?.abort();
  };

  disconnect = (): void => {
    this.disconnected = true;
    this.abortController?.abort();
  };

  /** Exposed for diagnostics/tests. */
  getUpstreamSessionId(): string | null {
    return this.grokSessionId;
  }
}

function checkCredential(ctx: ProviderConnectionContext): CredentialStatus {
  // Same resolution as the session: a configured absolute path outside PATH
  // must pass the gate it will actually be run from.
  const bin = resolveGrokExecutable(ctx.settings);
  if (!isBinaryInstalled(bin)) {
    const where = bin === GROK_BIN ? "" : ` (configured: ${bin})`;
    return {
      ok: false,
      reason: `Grok CLI not found${where}. Install it, then sign in with \`grok login\`.`,
      needsUserAction: "install-cli",
    };
  }
  // grok stores OAuth credentials under ~/.grok. A PATH+file check keeps this
  // safe to call from the render-path credential loop (no subprocess).
  return { ok: true };
}

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Grok CLI",
  version: "1.0.0",
  description: "xAI's `grok` agent CLI as a CodeSurf provider, with token-level partial-message streaming.",
  group: CODESURF_PROVIDERS_GROUP,
  enabledByDefault: false,
  protected: false,
  capabilities: ["provider-adapters", "models", "settings"],
  // Advisory metadata only: in-process extension modules are not sandboxed.
};

export const grokCliProviderPlugin: CodesurfPlugin = {
  name: "codesurf-grok-provider",
  manifest,
  inject: ["contributions", "settings"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BIN_SETTING,
        title: "Grok binary",
        description: "Path to the `grok` executable. Leave blank to resolve from PATH.",
        type: "string",
        default: GROK_BIN,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: THINKING_SETTING,
        title: "Token-level streaming",
        description:
          "Pass --include-partial-messages so text and thinking stream as deltas. Off means the whole response lands at once.",
        type: "boolean",
        default: true,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: PERMISSION_SETTING,
        title: "Permission mode",
        description: "Forwarded to grok as --permission-mode.",
        type: "select",
        default: DEFAULT_PERMISSION,
        options: PERMISSION_OPTIONS,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: MAX_TURNS_SETTING,
        title: "Max agent turns",
        description: "Forwarded as --max-turns. 0 leaves grok's own default in place.",
        type: "number",
        default: 0,
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Grok CLI",
        description:
          "xAI's `grok` agent CLI. One process per turn (grok has no stdin turn loop); conversation continuity via --resume.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "stdio",
        connectionMode: "stateless",
        sessionStrategy: "per-conversation",
        capabilities: { streaming: true, tools: true, images: false, reasoning: true },
        models: FALLBACK_MODELS,
        listModels: async (ctx) => discoverGrokModels(resolveGrokExecutable(ctx.settings)),
        auth: { mode: "oauth", check: checkCredential },
        adapter: {
          connect: (ctx: ProviderConnectionContext): ProviderSession => new GrokCliSession(ctx),
        },
      }),
    );
  },
};

export { checkCredential as checkGrokCredential, GrokCliSession, resolveGrokExecutable };
