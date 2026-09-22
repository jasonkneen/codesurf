// Builtin Fractal (RLM) provider.
//
// Owning adapter: CodeSurf delegates each turn to the `fractal` CLI
// (Trampoline AI's Recursive Language Model coding agent) running in its own
// Docker `sbx` sandbox. Fractal owns its model routing, skills, and the
// sandboxed code execution; CodeSurf just feeds it the user message and renders
// what comes back.
//
// Transport: spawn `fractal -p <prompt> --workspace <cwd> --json [--resume <id>]`.
//   - stdout: ONE final JSON `HeadlessResult`
//     ({ session_id, status, response, changed_files, usage, error }).
//   - stderr: human progress lines (`fractal: running RLM...`, runtime events).
//     We forward the `fractal:`-prefixed lines live as reasoning-deltas so the
//     UI shows progress while the (potentially long) turn runs.
//
// Session continuity: the JSON carries `session_id`; we keep it and pass
// `--resume <id>` on the next turn so multi-turn conversations share Fractal's
// session history. `--ephemeral` disables both sandbox reuse and resume.
//
// Prereqs (surfaced by the auth check): the `fractal` CLI on PATH, plus a
// working `sbx` runtime (`sbx login` AND `sbx policy set-default <profile>`).
// Without a default sbx policy, `sbx create` fails and Fractal can't start its
// sandbox.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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

const EXTENSION_ID = "builtin.provider-fractal";
const PROVIDER_ID = "fractal";
const ADAPTER_ID = "fractal.cli";
const MODEL_ID = "fractal";

const BIN_SETTING = `${ADAPTER_ID}.bin`;
const LM_SETTING = `${ADAPTER_ID}.lm`;
const MAX_ITERATIONS_SETTING = `${ADAPTER_ID}.maxIterations`;
const EPHEMERAL_SETTING = `${ADAPTER_ID}.ephemeral`;
const TIMEOUT_SETTING = `${ADAPTER_ID}.timeoutMs`;

const DEFAULT_BIN = "fractal";
// Generous default: the FIRST run pulls the `sbx` sandbox template image, which
// can take several minutes. Subsequent runs reuse the cached image and are fast.
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min

// Strip ANSI SGR sequences from forwarded stderr lines.
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function model(): ModelSpec {
  return {
    id: MODEL_ID,
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: "Fractal (RLM)",
    description:
      "Trampoline AI's Recursive Language Model coding agent. Runs each turn in a Docker sbx sandbox; uses Fractal's own configured model (see `fractal config`).",
    capabilities: { tools: true, reasoning: true, images: false },
    aliases: ["fractal:default"],
  };
}

interface HeadlessResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  duration_ms?: number;
  iterations?: number;
  context_tokens?: number;
}

interface HeadlessResult {
  session_id?: string;
  workspace?: string;
  status?: "succeeded" | "failed" | "max_iterations" | "interrupted";
  response?: string;
  changed_files?: string[];
  usage?: HeadlessResultUsage | null;
  error?: string | null;
}

function usageFromResult(result: HeadlessResult): ProviderUsageSnapshot {
  const usage = result.usage;
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}

/** Parse the final HeadlessResult JSON from Fractal's stdout (one object). */
function parseHeadlessResult(stdout: string): HeadlessResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Fractal emits exactly one JSON object, but be defensive: take the last
  // non-empty line that parses as an object.
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as unknown;
      if (parsed && typeof parsed === "object") return parsed as HeadlessResult;
    } catch {
      // keep walking up
    }
  }
  try {
    return JSON.parse(trimmed) as HeadlessResult;
  } catch {
    return null;
  }
}

class FractalCliSession implements ProviderSession {
  readonly adapterId = ADAPTER_ID;
  readonly providerId = PROVIDER_ID;
  // One `fractal -p` process per turn — the CLI has no stdin turn loop and
  // exits when the turn ends. Continuity is `--resume <session_id>` (see
  // buildArgs), not process lifetime. This used to claim "persistent", which
  // told the host it could warm a connection that does not exist.
  readonly mode = "stateless" as const;
  readonly strategy = "singleton" as const;

  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionId: string | null = null;

  constructor(private readonly ctx: ProviderConnectionContext) {}

  private cwd(): string {
    return this.ctx.workspace?.cwd() ?? process.cwd();
  }

  private bin(): string {
    return (this.ctx.settings.get<string>(BIN_SETTING, DEFAULT_BIN) || DEFAULT_BIN).trim();
  }

  private buildArgs(prompt: string): string[] {
    const ephemeral = this.ctx.settings.get<boolean>(EPHEMERAL_SETTING, false) === true;
    const args = ["-p", prompt, "--workspace", this.cwd(), "--json"];

    if (ephemeral) {
      args.push("--ephemeral");
    } else if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const maxIterations = this.ctx.settings.get<number>(MAX_ITERATIONS_SETTING, 0) ?? 0;
    if (maxIterations > 0) args.push("--max-iterations", String(maxIterations));

    const lm = this.ctx.settings.get<string>(LM_SETTING, "")?.trim();
    if (lm) args.push("--lm", lm);

    return args;
  }

  async sendTurn(
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> {
    controller.emit({ type: "status", status: "connecting", message: "Starting Fractal" });

    const bin = this.bin();
    const args = this.buildArgs(input.prompt);
    const timeoutMs = this.ctx.settings.get<number>(TIMEOUT_SETTING, DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, { cwd: this.cwd() });
    } catch (err) {
      const message = `Failed to launch \`${bin}\`: ${err instanceof Error ? err.message : String(err)}`;
      controller.emit({ type: "error", message });
      throw new Error(message);
    }
    this.child = child;

    // Abort wiring.
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    if (input.abortSignal) {
      if (input.abortSignal.aborted) onAbort();
      else input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    let stdout = "";
    let stderrLineBuffer = "";
    let emittedFirstProgress = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrLineBuffer += chunk;
      let newlineIndex = stderrLineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const rawLine = stderrLineBuffer.slice(0, newlineIndex);
        stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1);
        const cleaned = rawLine.replace(ANSI_SGR, "").trimEnd();
        // Forward only the meaningful "fractal: ..." status lines; skip the
        // ASCII banner and decorative trace formatting.
        const match = cleaned.match(/^fractal:\s?(.*)$/);
        if (match && match[1].trim().length > 0) {
          const message = match[1].trim();
          // Pick up the session id from stderr as a backup to the JSON.
          const sessionMatch = message.match(/^session\s+([0-9a-f]+)$/i);
          if (sessionMatch) this.sessionId = sessionMatch[1];
          if (!emittedFirstProgress) {
            emittedFirstProgress = true;
            controller.emit({ type: "status", status: "streaming", message: "Fractal running" });
          }
          controller.emit({ type: "reasoning-delta", delta: `${message}\n` });
        }
        newlineIndex = stderrLineBuffer.indexOf("\n");
      }
    });

    const exit = await new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null;
        child.kill("SIGTERM");
      }, timeoutMs);
      const clear = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      child.on("error", (err) => {
        clear();
        resolve({ code: null, spawnError: err instanceof Error ? err : new Error(String(err)) });
      });
      child.on("close", (code) => {
        clear();
        resolve({ code });
      });
    });

    input.abortSignal?.removeEventListener("abort", onAbort);
    this.child = null;

    if (exit.spawnError) {
      const message = `\`${bin}\` failed to run: ${exit.spawnError.message}. Is the fractal CLI installed and on PATH?`;
      controller.emit({ type: "error", message });
      throw new Error(message);
    }

    const result = parseHeadlessResult(stdout);

    if (!result) {
      const message =
        exit.code === 0
          ? "Fractal produced no JSON result."
          : `Fractal exited with code ${exit.code} and produced no JSON result.`;
      controller.emit({ type: "error", message });
      throw new Error(message);
    }

    if (result.session_id) this.sessionId = result.session_id;

    if (result.status === "failed" || result.error) {
      const message = result.error || "Fractal turn failed.";
      controller.emit({ type: "error", message });
      throw new Error(message);
    }

    const response = result.response ?? "";
    if (response) controller.emit({ type: "text-delta", delta: response });

    const changed = result.changed_files ?? [];
    if (changed.length > 0) {
      const list = changed.map((file) => `- ${file}`).join("\n");
      controller.emit({ type: "text-delta", delta: `\n\nChanged files:\n${list}` });
    }

    if (result.status === "max_iterations") {
      controller.emit({
        type: "text-delta",
        delta: "\n\n_(Fractal stopped at its max-iteration limit.)_",
      });
    }

    const usage = usageFromResult(result);
    controller.emit({ type: "usage", usage });
    controller.emit({ type: "done", stopReason: result.status === "max_iterations" ? "length" : "stop" });
    return { usage };
  }

  abortTurn(): void {
    this.child?.kill("SIGTERM");
  }

  disconnect(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
    this.sessionId = null;
  }
}

function fractalBin(ctx: ProviderConnectionContext): string {
  return (ctx.settings.get<string>(BIN_SETTING, DEFAULT_BIN) || DEFAULT_BIN).trim();
}

function fractalInstalled(bin: string): boolean {
  // A PATH stat, not a subprocess. This runs in the render-path credential check,
  // and `fractal --help` alone blocked the event loop for ~1.5s — it boots a whole
  // runtime just to print help. Presence on PATH answers the same question.
  return isBinaryInstalled(bin);
}

function sbxReady(): { ok: boolean; reason?: string } {
  if (isBinaryInstalled("sbx")) return { ok: true };
  return {
    ok: false,
    reason:
      "`sbx` CLI not found. Install with `brew install docker/tap/sbx`, then `sbx login` and `sbx policy set-default balanced`.",
  };
}

function checkFractal(ctx: ProviderConnectionContext): CredentialStatus {
  const bin = fractalBin(ctx);
  if (!fractalInstalled(bin)) {
    return {
      ok: false,
      reason:
        "Fractal CLI not found. Install it: `curl -LsSf https://fractal.trampoline.ai/install.sh | sh` (or set the fractal.cli.bin setting).",
      needsUserAction: "install-cli",
    };
  }
  const sbx = sbxReady();
  if (!sbx.ok) {
    return { ok: false, reason: sbx.reason, needsUserAction: "install-cli" };
  }
  return { ok: true };
}

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "Fractal (RLM)",
  version: "1.0.0",
  description: "Delegate turns to Trampoline AI's Fractal coding agent (RLM) running in a Docker sbx sandbox.",
  group: CODESURF_PROVIDERS_GROUP,
  enabledByDefault: false,
  protected: false,
  capabilities: ["provider-adapters", "models", "settings", "commands"],
};

export const fractalProviderPlugin: CodesurfPlugin = {
  name: "codesurf-fractal-provider",
  manifest,
  inject: ["contributions", "settings", "chat", "ui", "session"],
  apply(ctx: PluginContext) {
    const settings = ctx.settings;

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: BIN_SETTING,
        title: "Fractal CLI path",
        description: "Path to the `fractal` executable. Default resolves `fractal` on PATH.",
        type: "string",
        default: DEFAULT_BIN,
        section: "Fractal",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: LM_SETTING,
        title: "Fractal model override",
        description:
          "Optional `--lm` value forwarded to fractal (e.g. a litellm model string). Blank uses Fractal's own configured model (`fractal config`).",
        type: "string",
        default: "",
        section: "Fractal",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: MAX_ITERATIONS_SETTING,
        title: "Fractal max iterations",
        description: "Cap fractal's RLM iterations per turn (`--max-iterations`). 0 uses Fractal's default.",
        type: "number",
        default: 0,
        section: "Fractal",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: EPHEMERAL_SETTING,
        title: "Fractal ephemeral sandbox",
        description:
          "Run each turn in a throwaway sandbox (`--ephemeral`). Disables sandbox reuse AND multi-turn session continuity. Slower; off by default.",
        type: "boolean",
        default: false,
        section: "Fractal",
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: TIMEOUT_SETTING,
        title: "Fractal turn timeout (ms)",
        description:
          "Kill a fractal turn after this long. The first run pulls the sbx sandbox image and can take minutes; default is 30 min.",
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        section: "Fractal",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerModelProvider({
        id: ADAPTER_ID,
        label: "Fractal (RLM)",
        description:
          "Trampoline AI Fractal agent via its CLI. Auth, model routing, skills, and sandboxed execution are owned by Fractal/sbx.",
        providerId: PROVIDER_ID,
        shape: "single-model",
        transport: "stdio",
        // One process per turn; `--resume <session_id>` carries the conversation.
        connectionMode: "stateless",
        sessionStrategy: "singleton",
        capabilities: { streaming: true, tools: true, images: false, reasoning: true },
        model: model(),
        auth: { mode: "none", check: checkFractal },
        adapter: {
          connect: (ctx: ProviderConnectionContext): ProviderSession => new FractalCliSession(ctx),
        },
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/fractal",
        description: "Show Fractal provider status and prerequisites.",
        argsHint: "[status]",
        handler: () => {
          const status = checkFractal({
            conversationId: ctx.session.id() ?? "ephemeral",
            adapterId: ADAPTER_ID,
            providerId: PROVIDER_ID,
            settings,
          });
          const bin = settings.get<string>(BIN_SETTING, DEFAULT_BIN) || DEFAULT_BIN;
          const lm = settings.get<string>(LM_SETTING, "")?.trim() || "(Fractal config)";
          const ephemeral = settings.get<boolean>(EPHEMERAL_SETTING, false) === true;
          ctx.chat.appendAssistant(
            [
              "Fractal (RLM) provider",
              `Binary: ${bin}`,
              `Model override: ${lm}`,
              `Ephemeral: ${ephemeral ? "on" : "off"}`,
              `Status: ${status.ok ? "ready" : status.reason}`,
              "",
              "Select it with /model → Fractal (RLM). Each turn runs in a Docker sbx sandbox.",
            ].join("\n"),
          );
        },
      }),
    );
  },
};

export { ADAPTER_ID as FRACTAL_ADAPTER_ID, MODEL_ID as FRACTAL_MODEL_ID, parseHeadlessResult };
