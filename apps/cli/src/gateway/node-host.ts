// Node -> Agent host (Phase 3 -> the runnable node's turn seam). Binds the
// EngineNode HostedTurnRunner to a real engine Agent per session (persistent
// sessions, so a node session keeps memory across messages), reusing the same
// Agent code path the TUI and serve use. No provider call happens until a
// session message turn runs, so the node boots without an API key too.
//
// One node, many folders: each session gets its own WorkspaceScope (its folder
// and its own shell), and its Agent is built and driven inside that scope, so
// tools, settings, hooks and providers resolve to the session's folder rather
// than the node's. See docs/architecture/per-session-workspace.md.

import { Agent } from "../agent/agent";
import type { BashSink } from "../core/plugins/sinks";
import type { HostedTurnRunner, SessionWorkspace } from "../relay/host";
import type { JobRunner } from "../relay/jobs";
import { BashTool } from "../tools/bash";
import type { StreamChunk } from "../types/index";
import { getCurrentSandboxMode, getCurrentSandboxSettings, mergeSandboxSettings } from "../utils/settings";
import {
  createWorkspaceScope,
  runInWorkspace,
  scopeAsyncIterable,
  type WorkspaceScope,
} from "../utils/workspace-scope";

/** A session's own shell, in the shape the kernel's bash services expect. */
function bashSinkFor(bash: BashTool): BashSink {
  return {
    cwd: () => bash.getCwd(),
    execute: (command, timeout, abortSignal) => bash.execute(command, timeout, abortSignal),
    startBackground: (command) => bash.startBackground(command),
    getProcessLogs: (id, tail) => bash.getProcessLogs(id, tail),
    stopProcess: (id) => bash.stopProcess(id),
    listProcesses: () => bash.listProcesses(),
    spawnChild: (initialCwd, options) => new BashTool(initialCwd, options),
    cleanup: () => bash.cleanup(),
    getSandboxMode: () => bash.getSandboxMode(),
    setSandboxMode: (mode) => bash.setSandboxMode(mode),
    getSandboxSettings: () => bash.getSandboxSettings(),
    setSandboxSettings: (settings) => bash.setSandboxSettings(settings),
  };
}

function openWorkspaceScope(cwd: string): WorkspaceScope {
  return createWorkspaceScope(cwd, bashSinkFor(new BashTool(cwd)));
}

interface HostedSession {
  agent: Agent;
  scope: WorkspaceScope;
}

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
  private readonly sessions = new Map<string, HostedSession>();

  constructor(private readonly config: NodeAgentConfig) {}

  disposeSession(sessionId: string): Promise<void> {
    const hosted = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    // In scope: the Agent's cleanup tears down this session's shell and
    // provider sessions only, never another session's.
    return hosted ? runInWorkspace(hosted.scope, () => hosted.agent.cleanup()) : Promise.resolve();
  }

  async cleanup(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(({ agent, scope }) => runInWorkspace(scope, () => agent.cleanup()).catch(() => {})));
  }

  /** Build a session's Agent inside its own folder and shell. */
  private openSession(workspace: SessionWorkspace): HostedSession {
    const scope = openWorkspaceScope(workspace.cwd);
    const agent = runInWorkspace(scope, () => {
      // Read in scope, so the folder's own .grok/settings.json applies.
      const sandboxMode = workspace.sandboxMode ?? getCurrentSandboxMode();
      const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), workspace.sandboxSettings);
      return new Agent(this.config.apiKey, this.config.baseURL, this.config.model, this.config.maxToolRounds, {
        persistSession: true,
        sandboxMode,
        sandboxSettings,
      });
    });
    return { agent, scope };
  }

  private async *runTurn(
    sessionId: string,
    message: string,
    signal: AbortSignal,
    workspace: SessionWorkspace = { cwd: process.cwd() },
  ): AsyncGenerator<StreamChunk> {
    let hosted = this.sessions.get(sessionId);
    if (!hosted) {
      hosted = this.openSession(workspace);
      this.sessions.set(sessionId, hosted);
    }
    const requester = this.config.approvalRequester;
    const observer = {};
    const { agent: turnAgent, scope } = hosted;
    // Host-driven cancel (client gone / session destroyed), not a human stop: no UserInterrupt.
    const onAbort = () => runInWorkspace(scope, () => turnAgent.abort({ userInitiated: false }));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) return;
      yield* scopeAsyncIterable(scope, this.drive(turnAgent, sessionId, message, observer, requester, signal));
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
    // Its own scope on the node's folder, so its cleanup cannot tear down a
    // hosted session's shell or provider sessions.
    const scope = openWorkspaceScope(process.cwd());
    const agent = runInWorkspace(
      scope,
      () =>
        new Agent(this.config.apiKey, this.config.baseURL, this.config.model, this.config.maxToolRounds, {
          persistSession: false,
        }),
    );
    let text = "";
    try {
      for await (const chunk of scopeAsyncIterable(scope, agent.processMessage(prompt, {}))) {
        if (chunk.type === "content" && typeof chunk.content === "string") text += chunk.content;
      }
    } finally {
      await runInWorkspace(scope, () => agent.cleanup());
    }
    return { statement: text.slice(0, 4000), anchors: [], handle: spec.type };
  };

  /** Binds the EngineNode HostedTurnRunner seam to real Agent turns. */
  readonly runner: HostedTurnRunner = (sessionId, message, signal, workspace) =>
    this.runTurn(sessionId, message, signal, workspace);
}
