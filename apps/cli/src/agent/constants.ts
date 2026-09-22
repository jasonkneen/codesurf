import type { CustomSubagentConfig } from "../utils/settings";
import type { SubagentExecutionContext } from "./turns/types";

export const MAX_TOOL_ROUNDS = 400;
/** Deepest sub-agent chain. 2 allows "parent -> reviewer -> focused check";
 *  beyond that the extra context is almost always worse than doing it inline. */
export const MAX_SUBAGENT_DEPTH = 2;
/** Concurrent sub-agent runs per Agent. Each holds a BashTool (up to 8 background
 *  processes), its own MCP client set, and a full step budget. */
export const MAX_INFLIGHT_SUBAGENTS = 4;
/** Cap on sub-agent teardown (MCP close + child shell cleanup). */
export const SUBAGENT_TEARDOWN_TIMEOUT_MS = 5_000;

/**
 * Ancestry carried by each sub-agent execution context. Immutable per run:
 * a child's nested `task` tool is bound to `{ depth: parent.depth + 1 }`, so
 * depth follows the actual chain instead of a counter shared by concurrent
 * siblings on the same Agent.
 */
export const ROOT_SUBAGENT_CONTEXT: SubagentExecutionContext = { depth: 0 };

/** Synchronous admission facts handed from `runTaskRequest` to the reserved run. */
export interface TaskAdmission {
  agentKey: string;
  isExplore: boolean;
  isVision: boolean;
  isVerify: boolean;
  isVerifyDetect: boolean;
  isVerifyManifest: boolean;
  isComputer: boolean;
  custom: CustomSubagentConfig | undefined;
  subagents: CustomSubagentConfig[];
}

/** Resolve when `work` settles or the timeout elapses, whichever comes first. */
export async function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const VISION_MODEL = "grok-4.6";
export const COMPUTER_MODEL = "grok-4.6";
export const DEFAULT_TITLE_MODEL = "grok-4-1-fast-non-reasoning";
// Feature-flag settings key for learned adaptive model routing (see
// src/ui/feature-flags.ts -> "learning.adaptiveModelRouting"). Read directly
// from the settings store to avoid an agent->ui import edge.
export const ADAPTIVE_ROUTING_SETTING = "featureFlags.learning.adaptiveModelRouting";
// Cap how many recent same-class traces feed the learned router per turn.
export const ADAPTIVE_ROUTING_TRACE_LIMIT = 300;
