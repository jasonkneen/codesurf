// Node -> Agent host (Phase 3 -> the runnable node's turn seam). Binds the
// EngineNode HostedTurnRunner to a real engine Agent per session (persistent
// sessions, so a node session keeps memory across messages), reusing the same
// Agent code path the TUI and serve use. No provider call happens until a
// session message turn runs, so the node boots without an API key too.

import { Agent } from "../agent/agent";
import type { HostedTurnRunner } from "../relay/host";
import type { JobRunner } from "../relay/jobs";
import type { StreamChunk } from "../types/index";

export interface NodeAgentConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxToolRounds?: number;
  /**
   * Wire-approval bridge: when set, tool-approval requests surface through this
   * callback (the node pushes them to a front and awaits the decision). When
   * absent, approvals are DENIED unless autoApprove is explicitly set.
   */
  approvalRequester?: (sessionId: string, approvalId: string, toolName: string, input: unknown) => Promise<boolean>;
  /** Explicit opt-in (`codesurf node --auto-approve`): approve every tool call when no requester is set. */
  autoApprove?: boolean;
}

export class NodeAgentHost {
  private readonly agents = new Map<string, Agent>();

  constructor(private readonly config: NodeAgentConfig) {}

  disposeSession(sessionId: string): Promise<void> {
    const agent = this.agents.get(sessionId);
    this.agents.delete(sessionId);
    return agent ? agent.cleanup() : Promise.resolve();
  }

  async cleanup(): Promise<void> {
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(agents.map((agent) => agent.cleanup().catch(() => {})));
  }

  private async *runTurn(sessionId: string, message: string, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    let agent = this.agents.get(sessionId);
    if (!agent) {
      agent = new Agent(this.config.apiKey, this.config.baseURL, this.config.model, this.config.maxToolRounds, {
        persistSession: true,
      });
      this.agents.set(sessionId, agent);
    }
    const requester = this.config.approvalRequester;
    const observer = {};
    const turnAgent = agent;
    // Host-driven cancel (client gone / session destroyed), not a human stop: no UserInterrupt.
    const onAbort = () => turnAgent.abort({ userInitiated: false });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) return;
      yield* this.drive(turnAgent, sessionId, message, observer, requester, signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async *drive(
    agent: Agent,
    sessionId: string,
    message: string,
    observer: object,
    requester: NodeAgentConfig["approvalRequester"],
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    for await (const chunk of agent.processMessage(message, observer)) {
      yield chunk;
      if (signal.aborted) return;
      if (chunk.type === "tool_approval_request") {
        // Pause for an external decision; with no front to ask, deny unless the
        // operator opted into auto-approval.
        const toolName = (chunk.toolCall?.function?.name as string | undefined) ?? "tool";
        let input: unknown;
        try {
          input = JSON.parse((chunk.toolCall?.function?.arguments as string | undefined) ?? "{}");
        } catch {
          input = {};
        }
        const approve = requester
          ? await requester(sessionId, chunk.approvalId ?? "", toolName, input)
          : this.config.autoApprove === true;
        agent.respondToToolApproval(chunk.approvalId ?? "", approve);
        yield* agent.continueAfterToolApproval(observer);
      }
    }
  }

  /** A real distributed-compute job: one headless agent turn on a throwaway session. */
  readonly batchRunner: JobRunner = async (spec) => {
    const prompt = String((spec.args as { prompt?: string })?.prompt ?? "");
    const agent = new Agent(this.config.apiKey, this.config.baseURL, this.config.model, this.config.maxToolRounds, {
      persistSession: false,
    });
    let text = "";
    try {
      for await (const chunk of agent.processMessage(prompt, {})) {
        if (chunk.type === "content" && typeof chunk.content === "string") text += chunk.content;
      }
    } finally {
      await agent.cleanup();
    }
    return { statement: text.slice(0, 4000), anchors: [], handle: spec.type };
  };

  /** Binds the EngineNode HostedTurnRunner seam to real Agent turns. */
  readonly runner: HostedTurnRunner = (sessionId, message, signal) => this.runTurn(sessionId, message, signal);
}
