// Kernel-owned Bash & Processes tools.
//
// Phase 2 step 7 of the kernel-extensibility plan: takes the four bash tools
// (`bash`, `process_logs`, `process_stop`, `process_list`) out of
// `createTools()` in `src/grok/tools.ts` and into a kernel extension that
// owns the full ai-sdk `tool({...})` defs PLUS the `BashTool` instance
// itself. Replaced the metadata-only `bashToolsExtension` previously in
// `./groups.ts` (now removed).
//
// Sink ownership: this extension constructs its own `BashTool` in
// `activate()` and binds it via `setBashSink(...)`. The Agent reads through
// `services.bash.*` instead of holding its own `BashTool` reference. This
// matches the "after" diagram in the plan — Agent reads, doesn't construct.
//
// Sandbox config: activation runs BEFORE Agent construction in 7b, so we
// can't take `sandboxMode` / `sandboxSettings` from the Agent constructor at
// activation time. The extension boots the `BashTool` with the safe
// "off" default; the Agent overrides via
// `services.bash.setSandboxMode(...)` / `services.bash.setSandboxSettings(...)`
// early in its constructor (see 7b for that wiring). This is option 1 from
// the spec — clean separation, no loader-signature changes.
//
// Tool description (sandbox-mode-aware): the original `tool({description})`
// was rebuilt every turn from `bash.getToolDescription()` so the description
// reflected the current sandbox mode. Kernel-owned tools register once at
// activation, so the sandbox-mode-specific text would freeze at "off". We
// register with the static "off"-mode description here. The shuru-mode
// hint (mount path, network policy) is informational; the model still
// receives a usable bash tool description, and `setSandboxMode` callers who
// need the hint can surface it via the system prompt. Re-registering on
// sandbox change is non-trivial (requires kernel re-registration support
// and is not a Phase-2 goal). Documented for 7b/7c follow-up.
//
// Hooks: the original `bash` tool's execute path runs three hook calls
// (PreToolUse → optional block → PostToolUse / PostToolUseFailure). Phase 2
// step 7c moved those calls behind `services.hooks.*` so this extension no
// longer imports from `../../../hooks/index` directly. The Agent binds the
// hooks sink at construction (closing over the hooks-module functions and
// the live `services.bash.cwd()`); when no Agent has bound the sink (e.g.
// headless boot, tests without an Agent) every method resolves to a no-op
// `AggregatedHookResult`, so the bash tool works either way.
//
// Group: keeps the `"bash"` group string the metadata-only extension used
// so user toggles via `services.tools.setEnabled(...)` and `/extensions`
// filters continue to work unchanged.

import type { CodesurfPlugin, PluginContext, PluginManifest, ToolsService } from "@codesurf/plugin-api";
import { type Tool as AiTool, tool } from "ai";
import { z } from "zod";
import { BashTool } from "../../../tools/bash";
import type { ToolResult } from "../../../types/index";

const manifest: PluginManifest = {
  id: "builtin.tools.bash",
  name: "Bash & Processes",
  version: "1.0.0",
  description: "Shell command execution and background process management.",
  enabledByDefault: true,
  protected: true, // bash is load-bearing for most coding workflows
  capabilities: ["tools"],
};

// Static "off"-mode bash tool description. The original
// `bash.getToolDescription()` returned a different (Shuru-aware) string
// when sandbox mode was "shuru"; that variant is documented in the system
// prompt instead — see file header for context.
const BASH_TOOL_DESCRIPTION =
  "Execute a bash command. Use for find, ls, git, build tools, package managers, running tests, and any other shell command. For content search, prefer the dedicated grep tool. Set background=true for long-running processes like dev servers, watchers, or anything that should keep running while you continue working. For file read/write/edit, prefer the dedicated file tools instead.";

/**
 * Minimal bash backend the four tools drive. Satisfied by both the kernel bash
 * sink (`services.bash`) and a child `BashTool` from `services.bash.spawnChild`
 * — the latter is how subagent / verify runs get an isolated cwd + sandbox so
 * delegated commands cannot mutate the parent agent's working directory.
 */
export interface BashToolBackend {
  execute: (command: string, timeout?: number, abortSignal?: AbortSignal) => Promise<ToolResult>;
  startBackground: (command: string) => Promise<ToolResult>;
  getProcessLogs: (id: number, tail?: number) => Promise<ToolResult>;
  stopProcess: (id: number) => Promise<ToolResult>;
  listProcesses: () => ToolResult;
}

/**
 * Dependencies for {@link createBashToolDefinitions}. Each accessor is resolved
 * at execute-time (NOT captured once) so the bash tools observe sink swaps —
 * the contract `bash-rewire.test.ts` pins — and so a child backend can be
 * injected per subagent run without re-registering tools.
 */
export interface BashToolDeps {
  bash: () => BashToolBackend;
  hooks: () => Pick<ToolsService, "runPre" | "runPost" | "runFailure">;
  sessionId: () => string | undefined;
}

export interface BashToolDefinition {
  name: string;
  description: string;
  group: string;
  tool: AiTool;
}

/**
 * Build the four bash-group tool definitions bound to a specific backend. The
 * extension registers these against the kernel bash sink; the Agent rebuilds
 * them against a child `BashTool` for subagent / verify turns (see
 * `agent.ts` `buildTurnToolset`'s `bashOverride`).
 */
export function createBashToolDefinitions(deps: BashToolDeps): BashToolDefinition[] {
  return [
    {
      name: "bash",
      description: "Execute a shell command.",
      group: "bash",
      tool: tool({
        description: BASH_TOOL_DESCRIPTION,
        inputSchema: z.object({
          command: z.string().describe("The bash command to execute"),
          timeout: z
            .number()
            .optional()
            .describe(
              "Timeout in milliseconds (default: 30000). Use higher values for long-running commands. Ignored when background=true.",
            ),
          background: z
            .boolean()
            .optional()
            .describe(
              "Run the command as a background process. Returns immediately with a process ID. Use process_logs/process_stop/process_list to manage it.",
            ),
        }),
        execute: async ({ command, timeout, background }, ctx) => {
          const abortSignal = ctx?.abortSignal;
          const sessionId = deps.sessionId();
          const hooks = deps.hooks();
          const bash = deps.bash();
          const toolInput = { command, timeout, background };

          // cwd is resolved internally by the bound hooks sink (which closes
          // over `services.bash.cwd()`), so we no longer pass it here.
          const preResult = await hooks.runPre("bash", toolInput, sessionId, abortSignal);
          if (preResult.blocked) {
            const reason = preResult.blockingErrors.map((e) => e.stderr).join("; ") || "Blocked by hook";
            return { success: false, output: `[Hook blocked] ${reason}` };
          }

          if (background) {
            return bash.startBackground(command);
          }

          const result = await bash.execute(command, timeout, abortSignal);
          const output = {
            success: result.success,
            output: result.success
              ? result.output || "Command executed successfully (no output)"
              : result.error || "Command failed",
          };

          if (result.success) {
            hooks.runPost("bash", toolInput, output, sessionId, abortSignal).catch(() => {});
          } else {
            hooks
              .runFailure("bash", toolInput, result.error || "Command failed", sessionId, abortSignal)
              .catch(() => {});
          }

          return output;
        },
      }),
    },
    {
      name: "process_logs",
      description: "Read logs from a background process.",
      group: "bash",
      tool: tool({
        description:
          "View recent output (stdout + stderr) from a background process by its ID. Returns the last N lines of the log.",
        inputSchema: z.object({
          id: z.number().describe("The background process ID"),
          tail: z.number().optional().describe("Number of lines to return from the end (default: 50)"),
        }),
        execute: async ({ id, tail }) => {
          return deps.bash().getProcessLogs(id, tail);
        },
      }),
    },
    {
      name: "process_stop",
      description: "Stop a background process.",
      group: "bash",
      tool: tool({
        description:
          "Stop a running background process by its ID. Sends SIGTERM, then SIGKILL after 3 seconds if still alive.",
        inputSchema: z.object({
          id: z.number().describe("The background process ID to stop"),
        }),
        execute: async ({ id }) => {
          return deps.bash().stopProcess(id);
        },
      }),
    },
    {
      name: "process_list",
      description: "List active background processes.",
      group: "bash",
      tool: tool({
        description: "List all background processes with their ID, status, PID, age, and command.",
        inputSchema: z.object({}),
        execute: async () => {
          return deps.bash().listProcesses();
        },
      }),
    },
  ];
}

export const bashToolsPlugin: CodesurfPlugin = {
  name: "codesurf-bash-tools",
  manifest,
  inject: ["contributions", "tools", "sinks", "session"],
  apply(ctx: PluginContext) {
    // Construct the kernel's BashTool instance — defaults to sandbox "off",
    // current process cwd. The Agent overrides both via
    // `services.bash.setSandboxMode(...)` / `setSandboxSettings(...)` in 7b.
    const bash = new BashTool(process.cwd());

    // Bind the bash sink so other extensions / the Agent can read through
    // `services.bash.*`. `bindKernelSink` registers the clear-on-dispose
    // hook automatically; we only need to add the BashTool.cleanup() call
    // so background processes don't leak when shutdown runs without an
    // Agent.cleanup() before it (headless / test scenarios).
    ctx.effect(() =>
      ctx.sinks.bind({
        bash: {
          cwd: () => bash.getCwd(),
          execute: (command, timeout, abortSignal) => bash.execute(command, timeout, abortSignal),
          startBackground: (command) => bash.startBackground(command),
          getProcessLogs: (id, tail) => bash.getProcessLogs(id, tail),
          stopProcess: (id) => bash.stopProcess(id),
          listProcesses: () => bash.listProcesses(),
          spawnChild: (initialCwd, options) => new BashTool(initialCwd, options as never),
          cleanup: () => bash.cleanup(),
          getSandboxMode: () => bash.getSandboxMode(),
          setSandboxMode: (mode) => bash.setSandboxMode(mode as never),
          getSandboxSettings: () => bash.getSandboxSettings(),
          setSandboxSettings: (settings) => bash.setSandboxSettings(settings as never),
        },
      }),
    );
    // Awaited on disposal: disable and shutdown resolve only once the owned
    // process trees have actually exited (see `BashTool.cleanup`).
    ctx.effect(() => () => bash.cleanup());

    // ── bash + process_* ──────────────────────────────────────────────────
    // Built against the kernel bash sink. Accessors resolve lazily so a sink
    // swap (e.g. headless reboot, tests) is observed. The same factory is
    // reused by the Agent with a child `BashTool` to isolate subagent / verify
    // shell state from the parent cwd — see `createBashToolDefinitions`.
    for (const def of createBashToolDefinitions({
      bash: () => ctx.bash,
      hooks: () => ctx.tools,
      sessionId: () => ctx.session.id() ?? undefined,
    })) {
      ctx.effect(() => ctx.contributions.registerTool(def));
    }
  },
};
