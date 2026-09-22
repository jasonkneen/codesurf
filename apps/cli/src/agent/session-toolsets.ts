// Per-turn ToolSet composition, and the session's MCP bundle.
//
// Extracted from `Agent` (plan phase 3: "extract remaining Agent
// responsibilities … toolset composition"). One responsibility with one piece
// of session-scoped state behind it: the MCP bundle is held open across turns
// so the tool schemas the provider caches stay byte-stable, and building a
// turn's ToolSet is the only thing that reads it.
//
// The Agent keeps exactly one back-reference into it, `runTask`, because a
// sub-agent's nested `task` tool has to re-enter the Agent. Everything else
// this needs comes from module imports, which is what made the cut clean.

import type { ToolExecutionOptions, ToolSet } from "ai";
import {
  filterToolSetByEnabled,
  getEnabledToolSet,
  getHostServices,
  type KernelModelRuntime,
  setKernelMode,
} from "../core/plugins/index";
import { type BashToolBackend, createBashToolDefinitions } from "../core/plugins/native/bash-tools";
import { createFileToolDefinitions } from "../core/plugins/native/file-tools";
import type { McpToolBundle } from "../mcp/runtime";
import type { AgentMode, TaskRequest, ToolResult } from "../types";
import { wrapToolSetWithLoopGuard } from "./loop-guard";
import { presentToolSet } from "./tool-presentation";
import type { SubagentExecutionContext, TurnToolset } from "./turns/types";

/** Close an MCP bundle without ever rejecting: at teardown a server that is
 *  already gone, or wedged, leaves nothing useful to do. */
async function closeMcpBundleQuietly(bundle: McpToolBundle | null | undefined): Promise<void> {
  try {
    await bundle?.close?.();
  } catch {
    // Server already gone, or wedged. Nothing useful to do at teardown.
  }
}

/** Text of an MCP `CallToolResult` flagged `isError`, or null for a success. */
function mcpErrorText(result: unknown): string | null {
  if (!result || typeof result !== "object" || (result as { isError?: unknown }).isError !== true) return null;
  const content = (result as { content?: unknown }).content;
  const text = Array.isArray(content)
    ? content
        .map((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n")
    : "";
  return text || "MCP tool reported an error";
}

/**
 * Run MCP tools through the host's PreToolUse / PostToolUse / failure hooks,
 * the flow `services.hooks.wrapExecute` gives every native tool — including
 * the `blocked` verdict, which was the one gate MCP calls skipped entirely.
 *
 * Not `wrapExecute` itself: that contract expects a `ToolResult` back and
 * reads `success` off it, while an MCP tool returns the server's
 * `CallToolResult` (`content` / `isError`), which must reach the model
 * unchanged. The hook sequence and the blocked result are the same.
 *
 * Returns new tool objects; the session-scoped bundle is never mutated, so a
 * later turn cannot wrap it twice.
 */
export function wrapMcpToolsWithHooks(tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute as ((input: unknown, options: ToolExecutionOptions) => unknown) | undefined;
    if (!execute) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, options: ToolExecutionOptions) => {
        const services = getHostServices();
        const sessionId = services.session.id() ?? undefined;
        const toolInput = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
        const abortSignal = options?.abortSignal;

        const pre = await services.hooks.runPre(name, toolInput, sessionId, abortSignal);
        if (pre.blocked) {
          const reason = pre.blockingErrors.map((e) => e.stderr).join("; ") || "Blocked by hook";
          return { success: false, output: `[Hook blocked] ${reason}` } satisfies ToolResult;
        }

        let result: unknown;
        try {
          result = await execute(input, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          services.hooks.runFailure(name, toolInput, message, sessionId, abortSignal).catch(() => {});
          throw error;
        }
        // Fire-and-forget — hooks must never gate the return.
        const failure = mcpErrorText(result);
        if (failure === null) {
          const output = (result && typeof result === "object" ? result : { output: result }) as Record<
            string,
            unknown
          >;
          services.hooks.runPost(name, toolInput, output, sessionId, abortSignal).catch(() => {});
        } else {
          services.hooks.runFailure(name, toolInput, failure, sessionId, abortSignal).catch(() => {});
        }
        return result;
      },
    } as typeof tool;
  }
  return wrapped;
}

export interface SessionToolsetsDeps {
  /** A sub-agent's nested `task` re-enters the Agent; see `buildTurn`. */
  runTask(
    request: TaskRequest,
    abortSignal: AbortSignal | undefined,
    context: SubagentExecutionContext,
  ): Promise<ToolResult>;
}

export class SessionToolsets {
  private readonly deps: SessionToolsetsDeps;

  /** MCP tool names seen on the first turn of this session, and whether any
   *  later turn differed. With a session-scoped bundle this should now be
   *  impossible within a session; it stays as a canary. */
  private toolNamesSnapshot: string[] | undefined;
  private churned = false;

  /** Session-scoped MCP bundle. Held open across turns so the tool schemas the
   *  provider caches stay byte-stable, and so sub-agents reuse the parent's
   *  server processes instead of spawning their own. */
  private bundle: McpToolBundle | null = null;
  /** In-flight connect, so concurrent sub-agent builds share one attempt. */
  private bundlePromise: Promise<McpToolBundle> | null = null;
  /** Bumped by every `closeBundle`. A connect that started under an older
   *  generation must not publish its bundle into the session that replaced it. */
  private generation = 0;
  /** Set by `shutdown()`: after teardown no connect is admitted at all. */
  private admissionClosed = false;

  constructor(deps: SessionToolsetsDeps) {
    this.deps = deps;
  }

  /** Whether MCP tool names drifted within this session. Reported on the cache
   *  line, because churn invalidates the prefix ahead of the system prompt. */
  get mcpToolsChurned(): boolean {
    return this.churned;
  }

  /**
   * Drop the churn canary and reconnect on the next turn.
   *
   * Called where the prefix cache is discarded anyway (session switch,
   * compaction): the schemas no longer need to stay stable against the old
   * prefix, and a reconnect picks up server config changed since the session
   * started. Never mid-conversation.
   */
  resetForNewCacheGeneration(): void {
    this.toolNamesSnapshot = undefined;
    this.churned = false;
    void this.closeBundle();
  }

  /**
   * Tear down for good. Admission is closed first, so a connect completing
   * after this point can neither publish its bundle nor start another.
   */
  async shutdown(): Promise<void> {
    this.admissionClosed = true;
    await this.closeBundle();
  }

  /**
   * Connect the MCP servers once per session and reuse the bundle.
   *
   * Concurrent sub-agent builds can reach this simultaneously, so the in-flight
   * promise is shared — otherwise a fan-out of `task` calls would each start
   * their own connect and the last one would win, leaking the rest.
   */
  async resolveBundle(): Promise<McpToolBundle> {
    if (this.bundle) return this.bundle;
    if (this.admissionClosed) {
      throw new Error("MCP servers are shut down for this agent.");
    }
    if (!this.bundlePromise) {
      const generation = this.generation;
      const attempt: Promise<McpToolBundle> = getHostServices()
        .mcp.getToolBundle()
        .then(async (bundle) => {
          if (this.generation === generation && !this.admissionClosed) {
            this.bundle = bundle;
            return bundle;
          }
          // The session that asked for this bundle was reset or torn down
          // while its servers were connecting. Publishing it now would
          // resurrect subprocesses the replacement session never asked for,
          // so dispose it (awaited, so nothing outlives this promise) and,
          // when a new session is admitting connects, join that one instead.
          await closeMcpBundleQuietly(bundle);
          if (this.admissionClosed) {
            throw new Error("MCP servers are shut down for this agent.");
          }
          return this.resolveBundle();
        })
        .finally(() => {
          // Only the attempt that still owns the slot clears it: a newer
          // connect started after a reset must keep its own ownership.
          if (this.bundlePromise === attempt) this.bundlePromise = null;
        });
      this.bundlePromise = attempt;
    }
    return this.bundlePromise;
  }

  /** Close and forget the session's MCP servers. Safe to call repeatedly, and
   *  never rejects — one caller invokes it from a synchronous reset path, where
   *  an unhandled rejection would surface as an unrelated crash. */
  async closeBundle(): Promise<void> {
    // Invalidate any in-flight connect BEFORE taking the snapshot: its
    // completion handler compares generations and disposes the late bundle
    // instead of publishing it.
    this.generation += 1;
    const bundle = this.bundle;
    this.bundle = null;
    this.bundlePromise = null;
    await closeMcpBundleQuietly(bundle);
  }

  /**
   * Record this turn's MCP tool names and flag any drift from the first turn.
   *
   * Not a fix — the connection lifecycle is per-turn by design — but it turns a
   * silent full re-prefill into something the cache line reports.
   */
  noteToolNames(names: string[]): void {
    const sorted = [...names].sort();
    if (this.toolNamesSnapshot === undefined) {
      this.toolNamesSnapshot = sorted;
      return;
    }
    if (
      sorted.length !== this.toolNamesSnapshot.length ||
      sorted.some((name, index) => name !== this.toolNamesSnapshot?.[index])
    ) {
      this.churned = true;
      this.toolNamesSnapshot = sorted;
    }
  }

  /**
   * Assemble the per-turn ToolSet: kernel tools merged with MCP tools (agent
   * mode only), then filtered by the enabled-extension gate.
   *
   * IMPORTANT (Phase 2 #9 regression): seed from `kernelTools` — not `{}`. An
   * earlier version spread `childBaseTools` here; after the kernel migration
   * `baseTools` reduced to `{}` and silently dropped every kernel tool from
   * the turn. `kernelTools` (via `getEnabledToolSet()`) is the single source
   * of truth for the merge. The MCP spread overlays on top, and the enabled
   * filter runs last so disabled tools cannot slip through either side.
   */
  async buildTurn(args: {
    runtime: KernelModelRuntime;
    mode: AgentMode;
    onMcpUnavailable?: (errors: string[]) => void;
    /**
     * Subagent / verify isolation: when set, the bash-group tools are rebuilt
     * against this child `BashTool` so delegated commands run in the child's
     * cwd + sandbox instead of mutating the parent agent's working directory.
     * Only the bash tools the host already registered (and that survive the
     * enabled-gate) are overridden, so a globally-disabled bash stays disabled.
     */
    bashOverride?: BashToolBackend;
    /** Child cwd for the file tools, paired with `bashOverride`. */
    cwdOverride?: () => string;
    /** Set for a sub-agent's toolset: binds its nested `task` tool to this
     *  ancestry so depth is counted along the chain, not across siblings. */
    subagentContext?: SubagentExecutionContext;
    /** PTC presentation for this turn's wire tool set (default native). */
    presentation?: "native" | "code" | "both";
  }): Promise<{ tools: ToolSet; closeMcp: () => Promise<void>; sdkSection?: string }> {
    const { runtime, mode, onMcpUnavailable, bashOverride, cwdOverride, subagentContext } = args;

    // `setKernelMode` writes module-global state in the extension loader. A
    // sub-agent build runs with the CHILD's mode, so without restoring it the
    // parent's mode stays clobbered after the child returns — and background
    // delegations (which run concurrently with parent turns) can flip it
    // mid-turn. Snapshot and restore around the build; only the ToolSet
    // produced here should see the child's mode.
    // Mode is passed EXPLICITLY to every mode-sensitive read below rather than
    // going through the module-global kernel mode. Concurrent sub-agent builds
    // interleave across the MCP await at `getToolBundle()`: a sibling build
    // completing in between used to leave the global at ITS mode, and the
    // re-read in `filterToolSetByEnabled` then stripped this child's tools —
    // producing a child that reported success having silently written nothing.
    // The global is still synced for consumers outside this path (the UI's
    // /extensions view), but it is never read to build a ToolSet.
    setKernelMode(mode);
    const kernelTools = getEnabledToolSet(mode);
    let tools: ToolSet = runtime.modelInfo?.supportsClientTools === false ? {} : { ...kernelTools };
    let closeMcp: () => Promise<void> = async () => {};

    // Route the child's bash through the isolated backend. Done before the
    // enabled-filter + loop-guard wrap so the override inherits both, and only
    // replaces tools that are already present (respecting bash enablement).
    if (bashOverride && runtime.modelInfo?.supportsClientTools !== false) {
      const childBashDefs = createBashToolDefinitions({
        bash: () => bashOverride,
        hooks: () => getHostServices().hooks,
        sessionId: () => getHostServices().session.id() ?? undefined,
      });
      for (const def of childBashDefs) {
        if (def.name in tools) tools[def.name] = def.tool;
      }

      // Same treatment for the file tools. They resolve relative paths through
      // `services.workspace.cwd()`, which is the PARENT's bash cwd — so a child
      // whose shell had been `cd`-ed elsewhere read and wrote against a
      // different directory than the one its own commands ran in. Bind them to
      // the child's cwd so both halves of the child agree.
      if (cwdOverride) {
        const childFileDefs = createFileToolDefinitions({
          cwd: cwdOverride,
          hooks: () => getHostServices().hooks,
          // The child's own shell carries the live sandbox mode; without this
          // the child's writes fell back to the settings-derived default.
          // Read at execute time, like the cwd, and only when the backend
          // exposes it (the BashToolBackend contract does not require it).
          sandboxMode: () => {
            const mode = (bashOverride as Partial<{ getSandboxMode(): string }>).getSandboxMode?.();
            return mode === "off" || mode === "shuru" ? mode : undefined;
          },
        });
        for (const def of childFileDefs) {
          if (def.name in tools) tools[def.name] = def.tool;
        }
      }
    }

    // A nested `task` call from a sub-agent re-enters `runTask` on this same
    // Agent through the process-global subagents sink, which carries no
    // ancestry. Bind the child's `task` to its own execution context instead.
    if (subagentContext && "task" in tools) {
      tools.task = {
        ...tools.task,
        execute: getHostServices().hooks.wrapExecute<TaskRequest>("task", async (input, ctx) =>
          this.deps.runTask(input, ctx.abortSignal, subagentContext),
        ),
      };
    }

    if (mode === "agent" && runtime.modelInfo?.supportsClientTools !== false) {
      // Session-scoped, not per-turn. Reconnecting every turn had three costs:
      //   1. the ai-sdk `tools` array is serialized AHEAD of the system prompt
      //      in the provider's cache prefix, so any change to the tool set
      //      re-prefills the ENTIRE request — strictly worse than a system
      //      prompt change. A server that flaps silently destroyed the cache.
      //   2. every sub-agent built its own bundle, so N parallel `task` calls
      //      spawned N full sets of stdio server subprocesses.
      //   3. connection setup ran on the critical path of every turn.
      // The bundle is closed at session teardown instead (`cleanup()`), and
      // invalidated wherever the cache generation is discarded anyway.
      const mcpBundle: McpToolBundle = await this.resolveBundle();
      // Closing is owned by the session now; per-turn callers get a no-op so
      // their existing `finally` blocks stay correct.
      closeMcp = async () => {};
      tools = { ...tools, ...wrapMcpToolsWithHooks(mcpBundle.tools) };
      // The ai-sdk `tools` array is serialized AHEAD of the system prompt in the
      // provider's cache prefix, so a change here invalidates strictly more than
      // a system-prompt change does. MCP clients are (re)connected per turn, so
      // a server that flaps silently re-prefills the entire request. We cannot
      // fix that without reworking the connection lifecycle, but we can stop it
      // being invisible: record churn so the cache line can report it.
      this.noteToolNames(Object.keys(mcpBundle.tools));
      if (mcpBundle.errors.length > 0) {
        onMcpUnavailable?.(mcpBundle.errors);
      }
    }

    tools = filterToolSetByEnabled(tools, mode);
    tools = wrapToolSetWithLoopGuard(tools);

    // PTC presentation: under code/both the model sees run_code (+ SDK); the
    // native set is handed to the presentation as bindings, so sub-calls run
    // through the same execute closures (same-pipeline dispatch). The code
    // runtime is resolved through host services (lazy), never a side-context.
    let sdkSection: string | undefined;
    if (args.presentation && args.presentation !== "native") {
      const codeRuntime = getHostServices().codeRuntime;
      if (!codeRuntime) {
        throw new Error("PTC presentation requires the engine code-runtime service");
      }
      const presented = presentToolSet({
        tools,
        presentation: args.presentation,
        runner: (request) => codeRuntime.run(request),
      });
      tools = presented.tools;
      sdkSection = presented.sdkSection;
    }
    return { tools, closeMcp, sdkSection };
  }

  async buildShared(args: {
    runtime: KernelModelRuntime;
    mode: AgentMode;
    onMcpUnavailable?: (message: string) => void;
    bashOverride?: BashToolBackend;
    cwdOverride?: () => string;
    subagentContext?: SubagentExecutionContext;
    presentation?: "native" | "code" | "both";
  }): Promise<TurnToolset> {
    let mcpUnavailableMessage: string | null = null;
    const toolset = await this.buildTurn({
      runtime: args.runtime,
      mode: args.mode,
      bashOverride: args.bashOverride,
      subagentContext: args.subagentContext,
      cwdOverride: args.cwdOverride,
      presentation: args.presentation,
      onMcpUnavailable: (errors) => {
        if (errors.length > 0) {
          mcpUnavailableMessage = `MCP unavailable: ${errors.join(" | ")}`;
          args.onMcpUnavailable?.(mcpUnavailableMessage);
        }
      },
    });

    return {
      ...toolset,
      mcpUnavailableMessage,
    };
  }
}
