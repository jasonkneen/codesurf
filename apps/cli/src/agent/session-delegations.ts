// Delegation: starting background sub-agent runs, and reading them back.
//
// Extracted from `Agent` (plan phase 3: "extract remaining Agent
// responsibilities … task/delegation execution"). One responsibility with one
// piece of state — the `DelegationManager` — and a clear boundary: everything
// here either starts a delegation, reports one, or fires the hooks that bracket
// it.
//
// The Agent keeps the two UI accessors (`getDelegationRuns`,
// `getDelegationOutput`) as thin passthroughs, because the footer drill-down
// wants the raw rows while the model wants them wrapped in a `ToolResult`.

import { getHostServices } from "../core/plugins";
import type { TaskCompletedHookInput, TaskCreatedHookInput } from "../hooks/types";
import type { DelegationRun, TaskRequest, ToolResult } from "../types";
import type { DelegationManager } from "./delegations";

/**
 * What delegation needs from the Agent.
 *
 * Getters, not values: `modelId` and the token budgets change while a session
 * runs, and a snapshot taken at construction would start delegations against
 * the model the session opened with rather than the one it is using.
 */
export interface SessionDelegationsDeps {
  modelId(): string;
  maxToolRounds(): number;
  maxTokens(): number;
  batchApi(): boolean;
  sessionId(): string | undefined;
  fireHook(input: TaskCreatedHookInput | TaskCompletedHookInput, abortSignal?: AbortSignal): Promise<unknown>;
}

export class SessionDelegations {
  private readonly manager: DelegationManager;
  private readonly deps: SessionDelegationsDeps;

  constructor(manager: DelegationManager, deps: SessionDelegationsDeps) {
    this.manager = manager;
    this.deps = deps;
  }

  async runDelegation(request: TaskRequest, abortSignal?: AbortSignal): Promise<ToolResult> {
    const taskCreatedInput: TaskCreatedHookInput = {
      hook_event_name: "TaskCreated",
      agent_type: request.agent,
      description: request.description,
      session_id: this.deps.sessionId(),
      cwd: getHostServices().bash.cwd(),
    };
    await this.deps.fireHook(taskCreatedInput, abortSignal).catch(() => {});

    let result: ToolResult;
    try {
      if (abortSignal?.aborted) {
        return { success: false, output: "[Cancelled]" };
      }

      result = await this.manager.start(request, {
        model: this.deps.modelId(),
        sandboxMode: getHostServices().bash.getSandboxMode(),
        sandboxSettings: getHostServices().bash.getSandboxSettings(),
        maxToolRounds: this.deps.maxToolRounds(),
        maxTokens: this.deps.maxTokens(),
        batchApi: this.deps.batchApi(),
      });
    } catch (err: unknown) {
      if (abortSignal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        success: false,
        output: `Delegation failed: ${msg}`,
      };
    }

    const taskCompletedInput: TaskCompletedHookInput = {
      hook_event_name: "TaskCompleted",
      agent_type: request.agent,
      description: request.description,
      success: result.success,
      session_id: this.deps.sessionId(),
      cwd: getHostServices().bash.cwd(),
    };
    await this.deps.fireHook(taskCompletedInput, abortSignal).catch(() => {});

    return result;
  }

  // ── UI accessors for the running-subagents footer drill-down. Raw views over
  // the DelegationManager (the private `readDelegation`/`listDelegations` above
  // wrap these in ToolResult for the model; the UI wants the unwrapped data).
  async getDelegationRuns(): Promise<DelegationRun[]> {
    return this.manager.list();
  }

  /** Saved output for a delegation. Returns a "still running" sentinel while in flight. */
  async getDelegationOutput(id: string): Promise<string> {
    return this.manager.read(id);
  }

  async readDelegation(id: string): Promise<ToolResult> {
    try {
      return {
        success: true,
        output: await this.manager.read(id),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to read delegation: ${msg}`,
      };
    }
  }

  async listDelegations(): Promise<ToolResult> {
    try {
      const delegations = await this.manager.list();
      if (delegations.length === 0) {
        return {
          success: true,
          output: "No delegations found for this project.",
        };
      }

      const lines = delegations.map((delegation) => {
        const title = delegation.description || delegation.id;
        return `- \`${delegation.id}\` [${delegation.status}] ${title}\n  ${delegation.summary}`;
      });

      return {
        success: true,
        output: `## Delegations\n\n${lines.join("\n")}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to list delegations: ${msg}`,
      };
    }
  }
}
