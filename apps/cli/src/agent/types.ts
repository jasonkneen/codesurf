import type { ModelMessage } from "ai";
import type { SandboxMode, SandboxSettings } from "../utils/settings";
import type { ToolPresentation } from "./tool-presentation";

export interface AgentOptions {
  persistSession?: boolean;
  session?: string;
  modelAdapterId?: string;
  sandboxMode?: SandboxMode;
  sandboxSettings?: SandboxSettings;
  batchApi?: boolean;
  /** PTC tool presentation for this agent's sessions (default native). */
  presentation?: ToolPresentation;
}

export type TurnTerminalState =
  | { kind: "success"; signal: AbortSignal }
  | { kind: "failure"; error: string; signal: AbortSignal }
  | { kind: "cancelled"; userModelMessage?: ModelMessage };

// Turn-machine types live in ./turns/types; re-exported here so existing
// `import { ProcessMessageObserver } from "../agent/agent"` callers keep working.
export type {
  ProcessMessageError,
  ProcessMessageFinishReason,
  ProcessMessageObserver,
  ProcessMessageStepFinish,
  ProcessMessageStepStart,
  ProcessMessageToolFinish,
  ProcessMessageToolStart,
  ProcessMessageUsage,
} from "./turns/types";
