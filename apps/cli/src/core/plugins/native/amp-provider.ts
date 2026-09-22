// Builtin Amp provider (Sourcegraph Amp CLI).
//
// Owning adapter: CodeSurf delegates each turn to `amp`, which runs its own
// agent loop, tools, and model routing. CodeSurf feeds it user turns and renders
// what streams back.
//
// Transport: `amp -x --stream-json --stream-json-input --stream-json-thinking`.
// This is the one CLI in the fleet besides claude/codex that accepts turns on
// stdin AFTER start, so it gets a genuinely persistent session (see
// `transports/persistent-stdio-session.ts`): the process boots once per
// conversation, and `warm()` moves even that off the first message.
//
// Wire format is Anthropic stream-json — amp's own --help calls it "Claude
// Code-compatible stream JSON format" — so the shared decoder handles it
// unmodified. Verified against amp directly:
//
//   {"type":"system","subtype":"init","session_id":"T-019f...","tools":[...]}
//   {"type":"user","message":{...}}                       ← echo of our input
//   {"type":"assistant","message":{"content":[{"type":"text","text":"ok"}],
//                                  "stop_reason":"end_turn","usage":{...}}}
//   {"type":"result","subtype":"success","is_error":false,...}
//
// Granularity note: amp streams whole assistant MESSAGES, not token deltas —
// it has no `--include-partial-messages` equivalent, and no `stream_event`
// lines appear in its output. The shared decoder handles that automatically
// (its dedupe only suppresses complete blocks when partials actually arrived),
// but expect chunkier rendering here than with grok or claude.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { PersistentStdioSession, textContent } from "../builtin/transports";

const EXTENSION_ID = "builtin.provider-amp";
const PROVIDER_ID = "amp";
const ADAPTER_ID = "amp.cli";
const AMP_BIN = "amp";

const BIN_SETTING = `${ADAPTER_ID}.bin`;
const MODE_SETTING = `${ADAPTER_ID}.mode`;
const THINKING_SETTING = `${ADAPTER_ID}.thinking`;
const STALL_SETTING = `${ADAPTER_ID}.stallMs`;

const DEFAULT_MODE = "medium";
// amp's agent modes; each selects a different model + system prompt + toolset.
const MODE_OPTIONS = [
  { value: "low", label: "Low — fastest, cheapest" },
  { value: "medium", label: "Medium — default balance" },
  { value: "high", label: "High — most capable" },
  { value: "ultra", label: "Ultra — maximum effort" },
];
const DEFAULT_STALL_MS = 180_000;

/** amp routes models internally via `--mode`, so CodeSurf registers one model
 *  per mode rather than a model catalogue it does not control. */
function models(): ModelSpec[] {
  return MODE_OPTIONS.map((mode) => ({
    id: `amp:${mode.value}`,
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: `Amp (${mode.value})`,
    description: `Sourcegraph Amp agent in ${mode.value} mode. Amp owns model selection, tools, and its own agent loop.`,
    capabilities: { tools: true, reasoning: true, images: false },
  }));
}

function modeFromModelId(modelId: string | undefined): string | null {
  if (!modelId) return null;
  const match = /^amp:(.+)$/.exec(modelId.trim());
  return match ? match[1] : null;
}

/** The executable both the session and the credential probe use. One resolver
 *  so a configured absolute path outside PATH passes the same gate it runs on. */
function resolveAmpExecutable(settings: ProviderConnectionContext["settings"]): string {
  return (settings.get<string>(BIN_SETTING, AMP_BIN) || AMP_BIN).trim() || AMP_BIN;
}

class AmpSession implements ProviderSession {
  readonly adapterId = ADAPTER_ID;
  readonly providerId = PROVIDER_ID;
  readonly mode = "persistent" as const;
  readonly strategy = "per-conversation" as const;

  private transport: PersistentStdioSession | null = null;
  /** Upstream thread id reported on amp's init message. Retained for
   *  diagnostics and so a future reconnect can `amp threads continue <id>`. */
  private ampSessionId: string | null = null;

  constructor(private readonly ctx: ProviderConnectionContext) {}

  private bin(): string {
    return resolveAmpExecutable(this.ctx.settings);
  }

  private cwd(): string {
    return this.ctx.workspace?.cwd() ?? process.cwd();
  }

  private buildArgs(): string[] {
    // `-x` with no message: execute mode reading turns from stdin.
    const args = ["-x", "--stream-json", "--stream-json-input"];
    // Off by default, deliberately. `--stream-json-thinking` made amp itself
    // fail on `--mode low` with:
    //   result.subtype=error_during_execution
    //   "InvalidModelOutputError: Assistant produced thinking..."
    // and it buys little here: amp emits no partial deltas, so thinking would
    // arrive as one block at the end of the turn regardless. Opt in per-setting
    // if your mode tolerates it.
    if (this.ctx.settings.get<boolean>(THINKING_SETTING, false) === true) {
      args.push("--stream-json-thinking");
    }
    const mode = modeFromModelId(this.ctx.modelId) ?? this.ctx.settings.get<string>(MODE_SETTING, DEFAULT_MODE);
    if (mode) args.push("--mode", mode);
    // Notifications write to the terminal bell / audio; meaningless when the
    // process is a headless child of the TUI.
    args.push("--no-notifications", "--no-color");
    return args;
  }

  private ensureTransport(): PersistentStdioSession {
    if (this.transport) return this.transport;
    const stallMs = this.ctx.settings.get<number>(STALL_SETTING, DEFAULT_STALL_MS) ?? DEFAULT_STALL_MS;
    this.transport = new PersistentStdioSession({
      bin: this.bin(),
      args: this.buildArgs(),
      cwd: this.cwd(),
      label: "amp",
      stallMs,
      onSessionId: (id) => {
        this.ampSessionId = id;
      },
    });
    return this.transport;
  }

  warm = (): void => {
    this.ensureTransport().warm();
  };

  sendTurn = (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> => {
    return this.ensureTransport().sendTurn(textContent(input.prompt), controller, input.abortSignal);
  };

  abortTurn = (): void => {
    this.transport?.abortTurn();
  };

  disconnect = (): Promise<void> => {
    const transport = this.transport;
    this.transport = null;
    return transport?.disconnect() ?? Promise.resolve();
  };

  /** Exposed for diagnostics/tests — the upstream thread id, once known. */
  getUpstreamSessionId(): string | null {
    return this.ampSessionId;
  }
}

function checkCredential(ctx: ProviderConnectionContext): CredentialStatus {
  // Same resolution as the session: a configured absolute path outside PATH
  // must pass the gate it will actually be run from.
  const bin = resolveAmpExecutable(ctx.settings);
  if (!isBinaryInstalled(bin)) {
    const where = bin === AMP_BIN ? "" : ` (configured: ${bin})`;
    return {
      ok: false,
      reason: `Amp CLI not found${where}. Install it from https://ampcode.com, then sign in with \`amp login\`.`,
      needsUserAction: "install-cli",
    };
  }
  // amp stores its access token in its settings file or AMP_API_KEY. Checking
  // presence is a file stat, not a subprocess — this runs on the render-path
  // credential loop (see utils/cli-check-cache.ts for why that matters).
  if (process.env.AMP_API_KEY?.trim()) return { ok: true };
  const settingsPath =
    process.env.AMP_SETTINGS_FILE?.trim() ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "amp", "settings.json");
  try {
    // Presence of the settings file means `amp login` has been run at least
    // once. A stale/expired token surfaces as a turn error, which is the more
    // honest failure than claiming "not installed".
    if (existsSync(settingsPath)) return { ok: true };
  } catch {
    // Fall through to the logged-out branch.
  }
  return {
    ok: false,
    reason: "Not signed in to Amp. Run `amp login` (or set AMP_API_KEY).",
    needsUserAction: "start-oauth",
  };
}

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Amp",
  version: "1.0.0",
  description: "Sourcegraph Amp CLI as a CodeSurf provider, over a persistent stream-json stdio session.",
  group: CODESURF_PROVIDERS_GROUP,
  // Off by default: amp is a paid third-party CLI most users will not have.
  enabledByDefault: false,
  protected: false,
  capabilities: ["provider-adapters", "models", "settings"],
  // Advisory metadata only: in-process extension modules are not sandboxed.
};

export const ampProviderPlugin: CodesurfPlugin = {
  name: "codesurf-amp-provider",
  manifest,
  inject: ["contributions", "settings"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BIN_SETTING,
        title: "Amp binary",
        description: "Path to the `amp` executable. Leave blank to resolve from PATH.",
        type: "string",
        default: AMP_BIN,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: MODE_SETTING,
        title: "Default agent mode",
        description: "Used when the selected model does not pin a mode.",
        type: "select",
        default: DEFAULT_MODE,
        options: MODE_OPTIONS,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: THINKING_SETTING,
        title: "Stream thinking blocks",
        description:
          "Pass --stream-json-thinking to render Amp's reasoning. Off by default: some agent modes (observed on `low`) reject it with InvalidModelOutputError.",
        type: "boolean",
        default: false,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: STALL_SETTING,
        title: "Stall timeout (ms)",
        description: "Fail a turn if Amp produces no output for this long. 0 disables.",
        type: "number",
        default: DEFAULT_STALL_MS,
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Amp",
        description:
          "Sourcegraph Amp CLI. Persistent stream-json stdio session: the process boots once per conversation and turns are written as JSON lines on stdin.",
        providerId: PROVIDER_ID,
        shape: "provider-family",
        transport: "stdio",
        connectionMode: "persistent",
        sessionStrategy: "per-conversation",
        capabilities: { streaming: true, tools: true, images: false, reasoning: true },
        models: models(),
        auth: { mode: "oauth", check: checkCredential },
        adapter: {
          connect: (ctx: ProviderConnectionContext): ProviderSession => new AmpSession(ctx),
        },
      }),
    );
  },
};

export { AmpSession, checkCredential as checkAmpCredential, modeFromModelId, resolveAmpExecutable };
