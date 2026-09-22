// Gateway -> Agent host (Phase 1 W2). Binds the gateway's turn seam to a real
// engine Agent per gateway session — the same code path the TUI uses, with
// per-session PTC presentation. Agents live for the gateway session and are
// cleaned up on removal/shutdown.

import { Agent } from "../agent/agent";
import type { StreamChunk } from "../types/index";
import type { GatewaySessionRecord, GatewayTurnRunner } from "./types";

export interface GatewayAgentConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxToolRounds?: number;
}

export class GatewayAgentHost {
  private readonly agents = new Map<string, Agent>();

  constructor(private readonly config: GatewayAgentConfig) {}

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

  /** Generate one turn for a gateway session (bound to this host). */
  private async *runTurn(
    session: GatewaySessionRecord,
    message: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    let agent = this.agents.get(session.id);
    if (!agent) {
      // Host services must be bootstrapped before construction (bash sink,
      // hooks, session providers). The serve command does that at startup.
      agent = new Agent(this.config.apiKey, this.config.baseURL, this.config.model, this.config.maxToolRounds, {
        persistSession: false,
        presentation: session.presentation,
      });
      this.agents.set(session.id, agent);
    }
    // The client went away: stop the turn instead of spending tokens for nobody.
    const turnAgent = agent;
    // Host-driven cancel (client gone / session destroyed), not a human stop: no UserInterrupt.
    const onAbort = () => turnAgent.abort({ userInitiated: false });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) return;
      yield* agent.processMessage(message, {});
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  readonly runner: GatewayTurnRunner = (session, message, signal) => this.runTurn(session, message, signal);
}
