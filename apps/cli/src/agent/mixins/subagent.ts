import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { getHostServices, type KernelModelRuntime, resolveModelRuntimeViaKernel } from "../../core/plugins";
import {
  addBatchRequests,
  type BatchClientOptions,
  createBatch,
  getBatchChatCompletion,
  pollBatchRequestResult,
} from "../../grok/batch";
import { DEFAULT_MODEL, normalizeModelId } from "../../grok/models";
import { toolSetToBatchTools } from "../../grok/tool-schemas";
import type { AggregatedHookResult, HookInput } from "../../hooks/index";
import type { SubagentStartHookInput, SubagentStopHookInput } from "../../hooks/types";
import type {
  AgentMode,
  SessionInfo,
  SubagentStatus,
  TaskRequest,
  ToolCall,
  ToolResult,
  UsageSource,
  VerifyRecipe,
} from "../../types/index";
import { loadValidSubAgents, type SandboxSettings } from "../../utils/settings";
import { prepareVerifySandbox } from "../../verify/entrypoint";
import { firstLine, formatSubagentActivity } from "./../agent-helpers";
import {
  COMPUTER_MODEL,
  MAX_INFLIGHT_SUBAGENTS,
  MAX_SUBAGENT_DEPTH,
  ROOT_SUBAGENT_CONTEXT,
  SUBAGENT_TEARDOWN_TIMEOUT_MS,
  type TaskAdmission,
  VISION_MODEL,
  withTimeout,
} from "./../constants";
import { applyModelConstraints } from "./../model-constraints";
import type { SessionPromptContext } from "./../prompt-context";
import { buildSubagentPrompt, findCustomSubagent } from "./../prompts";
import type { SessionToolsets } from "./../session-toolsets";
import {
  accumulateUsage,
  buildAssistantBatchMessage,
  buildBatchChatCompletionRequest,
  buildBatchName,
  buildToolBatchMessage,
  getBatchUsage,
  hasUsage,
  humanizeApiError,
  parseToolArgumentsOrRaw,
  toLocalToolCall,
} from "./../turns/helpers";
import type { ExecutedBatchTool, ProcessMessageUsage, SubagentExecutionContext } from "./../turns/types";
import { buildVisionUserMessages } from "./../vision-input";

interface SubagentState {
  batchApi: boolean;
  maxTokens: number;
  maxToolRounds: number;
  session: SessionInfo | null;
  inFlightSubagents: number;
  mode: AgentMode;
  modelId: string;
  subagentRunSeq: number;
  toolsets: SessionToolsets;
  promptContext: SessionPromptContext;
  recordUsage(
    usage?: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
    source?: UsageSource,
    model?: string,
  ): void;
  getBatchClientOptions(signal?: AbortSignal): BatchClientOptions;
  getSessionId(): string | null;
  fireHook(input: HookInput, signal?: AbortSignal): Promise<AggregatedHookResult>;
  emitSubagentStatus(status: SubagentStatus | null, runKey?: string): void;
  executeBatchToolCall(
    tools: ToolSet,
    toolCall: ToolCall,
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{ input: unknown; result: ToolResult }>;
}

function st(self: object): SubagentState {
  return self as unknown as SubagentState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function SubagentMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class Subagent extends Base {
    async runTaskRequestBatch(args: {
      request: TaskRequest;
      childMessages: ModelMessage[];
      childSystem: string;
      childRuntime: KernelModelRuntime;
      childTools: ToolSet;
      maxSteps: number;
      initialDetail: string;
      onActivity?: (detail: string) => void;
      signal?: AbortSignal;
    }): Promise<ToolResult> {
      const {
        request,
        childMessages,
        childSystem,
        childRuntime,
        childTools,
        maxSteps,
        initialDetail,
        onActivity,
        signal,
      } = args;

      if (childRuntime.modelInfo?.responsesOnly) {
        throw new Error("Batch mode currently supports chat-completions models only.");
      }

      const batchTools =
        childRuntime.modelInfo?.supportsClientTools === false ? [] : await toolSetToBatchTools(childTools);
      const batch = await createBatch({
        ...st(this).getBatchClientOptions(signal),
        name: buildBatchName(`task-${request.agent}`, request.description),
      });

      const turnMessages: ModelMessage[] = [];
      const totalUsage: ProcessMessageUsage = {};
      let assistantText = "";
      let lastActivity = initialDetail;

      for (let round = 0; round < maxSteps; round++) {
        const batchRequestId = `task-${Date.now()}-${round + 1}`;
        await addBatchRequests({
          ...st(this).getBatchClientOptions(signal),
          batchId: batch.batch_id,
          batchRequests: [
            {
              batch_request_id: batchRequestId,
              batch_request: {
                chat_get_completion: buildBatchChatCompletionRequest({
                  modelId: childRuntime.modelId,
                  system: childSystem,
                  messages: [...childMessages, ...turnMessages],
                  temperature: request.agent === "explore" ? 0.2 : 0.5,
                  maxOutputTokens:
                    childRuntime.modelInfo?.supportsMaxOutputTokens === false
                      ? undefined
                      : Math.min(st(this).maxTokens, 8_192),
                  reasoningEffort: childRuntime.providerOptions?.xai.reasoningEffort,
                  tools: batchTools,
                }),
              },
            },
          ],
        });

        const result = await pollBatchRequestResult({
          ...st(this).getBatchClientOptions(signal),
          batchId: batch.batch_id,
          batchRequestId,
        });
        const response = getBatchChatCompletion(result);
        accumulateUsage(totalUsage, getBatchUsage(response));

        const choice = response.choices[0];
        if (!choice) {
          throw new Error("Batch response did not contain any choices.");
        }
        const content = choice?.message.content ?? "";
        if (content) {
          assistantText += content;
        }

        const requestMessages = [...childMessages, ...turnMessages];
        const toolCalls = (choice?.message.tool_calls ?? []).map(toLocalToolCall);
        const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
        if (assistantMessage) {
          turnMessages.push(assistantMessage);
        }

        if (toolCalls.length === 0) {
          if (hasUsage(totalUsage)) {
            st(this).recordUsage(totalUsage, "task", childRuntime.modelId);
          }
          const output = assistantText.trim() || `Task completed. Last action: ${lastActivity}`;
          return {
            success: true,
            output,
            task: {
              agent: request.agent,
              description: request.description,
              summary: firstLine(output),
              activity: lastActivity,
            },
          };
        }

        const toolParts: ExecutedBatchTool[] = [];
        for (const toolCall of toolCalls) {
          const nextActivity = formatSubagentActivity(
            toolCall.function.name,
            parseToolArgumentsOrRaw(toolCall.function.arguments),
          );
          lastActivity = nextActivity;
          onActivity?.(nextActivity);

          const executed = await st(this).executeBatchToolCall(childTools, toolCall, requestMessages, signal);
          toolParts.push({
            toolCall,
            input: executed.input,
            toolResult: executed.result,
          });
        }

        const toolMessage = buildToolBatchMessage(toolParts);
        if (toolMessage) {
          turnMessages.push(toolMessage);
        }
      }

      if (hasUsage(totalUsage)) {
        st(this).recordUsage(totalUsage, "task", childRuntime.modelId);
      }
      const output =
        assistantText.trim() || `Task stopped after ${maxSteps} batch rounds. Last action: ${lastActivity}`;
      return {
        success: false,
        output,
        task: {
          agent: request.agent,
          description: request.description,
          summary: output,
          activity: lastActivity,
        },
      };
    }

    /**
     * Narrow adapter over this Agent's private internals for the extracted turn
     * state machines (./turns/batch-turn.ts, ./turns/session-turn.ts). Built
     * per call so each delegate reads the Agent's CURRENT state; see
     * TurnContext in ./turns/types.ts for the contract.
     */

    async runTaskRequest(
      request: TaskRequest,
      onActivity?: (detail: string) => void,
      abortSignal?: AbortSignal,
      context: SubagentExecutionContext = ROOT_SUBAGENT_CONTEXT,
    ): Promise<ToolResult> {
      const signal = abortSignal;
      const agentKey = String(request.agent);
      const isExplore = agentKey === "explore";
      const isGeneral = agentKey === "general";
      const isVision = agentKey === "vision";
      const isVerify = agentKey === "verify";
      const isVerifyDetect = agentKey === "verify-detect";
      const isVerifyManifest = agentKey === "verify-manifest";
      const isComputer = agentKey === "computer";
      const subagents = loadValidSubAgents();
      const custom =
        !isExplore && !isGeneral && !isVision && !isVerify && !isVerifyDetect && !isVerifyManifest && !isComputer
          ? findCustomSubagent(agentKey, subagents)
          : undefined;

      if (
        !isExplore &&
        !isGeneral &&
        !isVision &&
        !isVerify &&
        !isVerifyDetect &&
        !isVerifyManifest &&
        !isComputer &&
        !custom
      ) {
        const message = `Unknown sub-agent "${agentKey}". Use general, explore, vision, verify, verify-detect, verify-manifest, computer, or a configured name from ~/.codesurf/user-settings.json.`;
        return {
          success: false,
          output: message,
          task: {
            agent: agentKey,
            description: request.description,
            summary: message,
          },
        };
      }

      // The parent's authority bounds the child's. `task` is deliberately NOT
      // mode-gated (subagents-tools.ts registers it without `modes`), so without
      // this clamp a plan/ask-mode parent could call `task({ agent: "general" })`
      // and get a child booted in "agent" mode with write_file/edit_file/bash —
      // silently defeating the read-only guarantee those modes advertise.
      // Read-only parents may still delegate, but only to read-only children.
      // Depth/fan-out cap. `task` is in every child's ToolSet and the mode prompt
      // tells children to use it, so nesting is unbounded by default: depth D at
      // breadth B is B^D concurrent agents, each holding a BashTool, an MCP client
      // set, and a 120-step budget. The loop guard cannot see this — it is rebuilt
      // per toolset and only blocks byte-identical repeats.
      //
      // Depth is the caller's ancestry (immutable per execution context); the
      // fan-out slot is shared per Agent and reserved below, synchronously,
      // before the first await so concurrent starts cannot all pass this check.
      if (context.depth >= MAX_SUBAGENT_DEPTH) {
        const message = `Sub-agent nesting limit reached (depth ${MAX_SUBAGENT_DEPTH}). Do this work directly instead of delegating again.`;
        return {
          success: false,
          output: message,
          task: { agent: agentKey, description: request.description, summary: message },
        };
      }
      if (st(this).inFlightSubagents >= MAX_INFLIGHT_SUBAGENTS) {
        const message = `Too many sub-agents already running (${MAX_INFLIGHT_SUBAGENTS}). Wait for one to finish before starting another.`;
        return {
          success: false,
          output: message,
          task: { agent: agentKey, description: request.description, summary: message },
        };
      }

      const parentReadOnly = st(this).mode !== "agent";
      if (parentReadOnly && !isExplore && !isVerifyDetect && !isVision) {
        const message = `Sub-agent "${agentKey}" can modify files or run commands, which ${st(this).mode} mode does not allow. Use explore, verify-detect, or vision here, or switch to agent mode.`;
        return {
          success: false,
          output: message,
          task: {
            agent: agentKey,
            description: request.description,
            summary: message,
          },
        };
      }
      // Every check above is synchronous, so nothing can interleave between
      // admission and this reservation. Released in `finally` on every exit —
      // success, failed preparation, and cancellation before runtime resolution.
      st(this).inFlightSubagents += 1;
      try {
        return await this.runAdmittedTaskRequest({
          request,
          admission: {
            agentKey,
            isExplore,
            isVision,
            isVerify,
            isVerifyDetect,
            isVerifyManifest,
            isComputer,
            custom,
            subagents,
          },
          context,
          onActivity,
          signal,
        });
      } finally {
        st(this).inFlightSubagents -= 1;
      }
    }

    /** The reserved part of `runTaskRequest`: everything after synchronous
     *  admission. The caller holds this run's fan-out slot for its whole life. */
    async runAdmittedTaskRequest(args: {
      request: TaskRequest;
      admission: TaskAdmission;
      context: SubagentExecutionContext;
      onActivity?: (detail: string) => void;
      signal?: AbortSignal;
    }): Promise<ToolResult> {
      const { request, context, onActivity, signal } = args;
      const {
        agentKey,
        isExplore,
        isVision,
        isVerify,
        isVerifyDetect,
        isVerifyManifest,
        isComputer,
        custom,
        subagents,
      } = args.admission;
      const parentReadOnly = st(this).mode !== "agent";
      const childMode: AgentMode = parentReadOnly || isExplore || isVerifyDetect ? "ask" : "agent";
      const verifySandboxOverrides: SandboxSettings = isVerify
        ? { allowNet: true, allowedHosts: undefined, allowEphemeralInstall: true, hostBrowserCommandsOnHost: true }
        : {};
      let verifyPreparedSettings: SandboxSettings | null = null;
      let verifyPreparedRecipe: VerifyRecipe | null = null;
      if (isVerify) {
        const prepared = await prepareVerifySandbox(
          getHostServices().bash.cwd(),
          { ...getHostServices().bash.getSandboxSettings(), ...verifySandboxOverrides },
          undefined,
          onActivity,
          { signal },
        );
        verifyPreparedSettings = prepared.sandboxSettings;
        verifyPreparedRecipe = prepared.profile.recipe;
      }
      const bashServices = getHostServices().bash;
      const initialDetail = isExplore
        ? "Scanning the codebase"
        : isVerifyDetect
          ? "Detecting verification recipe"
          : isVerifyManifest
            ? "Creating verification manifest"
            : isVerify
              ? "Preparing verification pass"
              : isComputer
                ? "Preparing computer control pass"
                : "Planning delegated work";
      let assistantText = "";
      let lastActivity = initialDetail;
      /** Set when the child hit a tool that needs approval it cannot obtain. */
      let approvalBlocked: string | null = null;
      let streamError: unknown;
      let closeMcp: (() => Promise<void>) | undefined;
      const childModelId = normalizeModelId(
        // Explicit per-call override (e.g. `.js` workflow phases naming a model)
        // wins over the agent-type / custom-config default.
        request.model ??
          (isVision
            ? VISION_MODEL
            : isComputer
              ? COMPUTER_MODEL
              : isExplore
                ? DEFAULT_MODEL
                : custom
                  ? custom.model
                  : st(this).modelId),
      );
      const baseChildRuntime = await resolveModelRuntimeViaKernel(childModelId, st(this).getSessionId() ?? "ephemeral");
      let childRuntime: KernelModelRuntime = baseChildRuntime;
      if (isVision) {
        const responsesModel =
          baseChildRuntime.session?.getResponsesModel?.(childModelId) ??
          (() => {
            throw new Error(
              `Vision sub-agent requires xAI responses endpoint, but the registered provider for "${childModelId}" does not expose getResponsesModel(). Configure an xAI model for vision sub-agents.`,
            );
          })();
        // Spread + override: { ...baseChildRuntime, model: responsesModel } produces a
        // type TS won't auto-narrow back to KernelModelRuntime because responsesModel is
        // XaiResponsesModel (a subtype of GrokRuntimeModel). The cast is sound — model
        // stays a GrokRuntimeModel — but explicit because TS can't see through the spread.
        childRuntime = { ...baseChildRuntime, model: responsesModel } as KernelModelRuntime;
      }
      if (isComputer && childRuntime.modelInfo?.supportsClientTools === false) {
        return {
          success: false,
          output:
            "Computer sub-agent requires a tool-capable model, but the selected runtime does not support client tools.",
          task: {
            agent: agentKey,
            description: request.description,
            summary: "Computer sub-agent could not start because the chosen model does not support tools.",
          },
        };
      }
      const childBash = bashServices.spawnChild(bashServices.cwd(), {
        sandboxMode: isVerify ? "shuru" : bashServices.getSandboxMode(),
        sandboxSettings: isVerify
          ? (verifyPreparedSettings ?? { ...bashServices.getSandboxSettings(), ...verifySandboxOverrides })
          : bashServices.getSandboxSettings(),
      });

      // From this point the child owns isolated process/background state. Keep
      // every terminal branch below its finally so delegates cannot strand a
      // child shell after a success, failure, or parent abort.
      //
      // The child's ancestry is one level below the caller's. Its nested `task`
      // tool is bound to this context in `buildTurnToolset`, so a chain is
      // counted by depth while siblings only share the fan-out slot.
      const childContext: SubagentExecutionContext = { depth: context.depth + 1 };
      try {
        const childSystem = applyModelConstraints(
          buildSubagentPrompt(
            request,
            childBash.getCwd(),
            custom ?? null,
            childBash.getSandboxMode(),
            subagents,
            childBash.getSandboxSettings(),
            st(this).promptContext.subagentSkillsSection(childBash.getCwd(), request.prompt),
          ),
          childRuntime.modelId,
        );

        onActivity?.(initialDetail);

        const childToolset = await st(this).toolsets.buildShared({
          runtime: childRuntime,
          mode: childMode,
          // Isolate the subagent / verify shell to the child bash state so its
          // commands (incl. `cd`) cannot mutate the parent agent's cwd, and point
          // the file tools at the same cwd so reads/writes and shell commands
          // agree on where "here" is.
          bashOverride: childBash,
          cwdOverride: () => childBash.getCwd(),
          subagentContext: childContext,
          onMcpUnavailable: (message) => {
            lastActivity = message;
            onActivity?.(message);
          },
        });
        let childTools = childToolset.tools;
        closeMcp = childToolset.closeMcp;

        // `bash`/`process_*` carry no `modes`, so an "ask"-mode child still gets a
        // full shell — "read-only" was prompt-only, enforceable by nothing. When
        // the PARENT is read-only (plan/ask) that is a real containment breach:
        // the child could mutate the workspace through the shell after `task`
        // already bypassed the write-tool mode gate. Drop the shell entirely on
        // that path rather than pattern-matching commands, which cannot be made
        // sound against pipes, redirects, and subshells.
        if (parentReadOnly) {
          childTools = Object.fromEntries(
            Object.entries(childTools).filter(([name]) => name !== "bash" && !name.startsWith("process_")),
          );
        }

        if (childToolset.mcpUnavailableMessage) {
          onActivity?.(childToolset.mcpUnavailableMessage);
        }

        const childPrompt =
          isVerify && verifyPreparedRecipe
            ? `${request.prompt}\n\nPrepared verify recipe JSON (use this as the primary execution recipe and keep .grok/environment.json aligned with it if present):\n${JSON.stringify(verifyPreparedRecipe, null, 2)}`
            : request.prompt;

        const childMessages = isVision
          ? await buildVisionUserMessages(request.prompt, childBash.getCwd(), signal)
          : [{ role: "user" as const, content: childPrompt }];

        if (st(this).batchApi) {
          return await this.runTaskRequestBatch({
            request,
            childMessages,
            childSystem,
            childRuntime,
            childTools,
            maxSteps: Math.min(st(this).maxToolRounds, isExplore ? 60 : 120),
            initialDetail,
            onActivity,
            signal,
          });
        }

        const result = streamText({
          model: childRuntime.model,
          system: childSystem,
          messages: childMessages,
          tools: childRuntime.modelInfo?.supportsClientTools === false ? {} : childTools,
          stopWhen: stepCountIs(Math.min(st(this).maxToolRounds, isExplore ? 60 : 120)),
          maxRetries: 0,
          abortSignal: signal,
          temperature: isExplore ? 0.2 : 0.5,
          ...(childRuntime.modelInfo?.supportsMaxOutputTokens === false
            ? {}
            : { maxOutputTokens: Math.min(st(this).maxTokens, 8_192) }),
          ...(childRuntime.providerOptions ? { providerOptions: childRuntime.providerOptions } : {}),
          onFinish: ({ totalUsage }) => {
            st(this).recordUsage(totalUsage, "task", childRuntime.modelId);
          },
        });

        for await (const part of result.fullStream) {
          if (signal?.aborted) {
            break;
          }

          if (part.type === "text-delta") {
            assistantText += part.text;
            continue;
          }

          if (part.type === "tool-call") {
            lastActivity = formatSubagentActivity(part.toolName, part.input);
            onActivity?.(lastActivity);
            continue;
          }

          // The SDK feeds the error back to the model and the run goes on, but
          // the activity line should not keep showing the call as in progress.
          if (part.type === "tool-error") {
            lastActivity = `${formatSubagentActivity(part.toolName, part.input)} (failed)`;
            onActivity?.(lastActivity);
            continue;
          }

          // A provider/stream failure arrives as a part, not a throw, and the
          // stream simply ends after it. Ignoring it reported a run that died
          // mid-way as "Task completed".
          if (part.type === "error") {
            streamError = part.error;
            break;
          }

          // The ai-sdk emits this INSTEAD of executing a tool that declares
          // `needsApproval` (write_file/edit_file do, under editApproval
          // "ask-always"). A sub-agent has no approval UI, so the part used to be
          // ignored: the tool silently never ran and the run still reported
          // "Task completed." Silent data loss dressed as success. There is no
          // way to approve here, so fail loudly instead.
          if (part.type === "tool-approval-request") {
            // The name lives on the nested tool call, not on the part itself
            // (ai: ToolApprovalRequestOutput = { type, approvalId, toolCall }).
            const toolName = part.toolCall?.toolName ?? "a tool";
            approvalBlocked = `Sub-agent needed approval to run \`${toolName}\` and cannot request it. Run this work in the parent agent, or set edit approval to accept-all.`;
            break;
          }
        }

        if (signal?.aborted) {
          return { success: false, output: "[Cancelled]" };
        }

        if (streamError !== undefined) {
          // `result.response` is deliberately not awaited: after a stream error
          // it only rejects with the SDK's generic "No output generated".
          const output = `Task failed: ${humanizeApiError(streamError)}`;
          return {
            success: false,
            output,
            task: {
              agent: request.agent,
              description: request.description,
              summary: output,
              activity: lastActivity,
            },
          };
        }

        if (approvalBlocked) {
          return {
            success: false,
            output: approvalBlocked,
            task: {
              agent: request.agent,
              description: request.description,
              summary: approvalBlocked,
              activity: lastActivity,
            },
          };
        }

        await result.response;

        const output = assistantText.trim() || `Task completed. Last action: ${lastActivity}`;
        return {
          success: true,
          output,
          task: {
            agent: request.agent,
            description: request.description,
            summary: firstLine(output),
            activity: lastActivity,
          },
        };
      } catch (err: unknown) {
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        const output = `Task failed: ${msg}`;
        return {
          success: false,
          output,
          task: {
            agent: request.agent,
            description: request.description,
            summary: output,
            activity: lastActivity,
          },
        };
      } finally {
        // Run both teardowns concurrently and bound them. `client.close()` has no
        // internal timeout, so a wedged MCP server used to block the child shell
        // cleanup that follows it — stranding background processes behind a
        // server that was never coming back.
        await withTimeout(
          Promise.allSettled([closeMcp?.().catch(() => {}), childBash.cleanup().catch(() => {})]),
          SUBAGENT_TEARDOWN_TIMEOUT_MS,
        );
      }
    }

    async runTask(
      request: TaskRequest,
      abortSignal?: AbortSignal,
      context: SubagentExecutionContext = ROOT_SUBAGENT_CONTEXT,
    ): Promise<ToolResult> {
      const startInput: SubagentStartHookInput = {
        hook_event_name: "SubagentStart",
        agent_type: request.agent,
        description: request.description,
        session_id: st(this).session?.id,
        cwd: getHostServices().bash.cwd(),
      };
      await st(this)
        .fireHook(startInput, abortSignal)
        .catch(() => {});

      const runKey = `task-${++st(this).subagentRunSeq}`;
      const startedAt = new Date().toISOString();
      let result: ToolResult | undefined;
      try {
        result = await this.runTaskRequest(
          request,
          (detail) => {
            if (abortSignal?.aborted) return;
            st(this).emitSubagentStatus(
              {
                agent: request.agent,
                description: request.description,
                detail,
                startedAt,
              },
              runKey,
            );
          },
          abortSignal,
          context,
        );
        return result;
      } finally {
        st(this).emitSubagentStatus(null, runKey);
        // SubagentStop must fire on EVERY exit, including abort and throw.
        // Previously it sat after the try/finally, so an aborted or failed run
        // fired SubagentStart with no matching Stop and left hook consumers
        // (auto loops, /loop accounting) believing the sub-agent was still live.
        const stopInput: SubagentStopHookInput = {
          hook_event_name: "SubagentStop",
          agent_type: request.agent,
          description: request.description,
          success: result?.success ?? false,
          session_id: st(this).session?.id,
          cwd: getHostServices().bash.cwd(),
        };
        await st(this)
          .fireHook(stopInput, abortSignal)
          .catch(() => {});
      }
    }

    // ── UI accessors for the running-subagents footer drill-down ────────────
    // Raw views over the DelegationManager; `SessionDelegations` wraps the same
    // data in a ToolResult for the model. Both shapes are wanted.
  };
}
