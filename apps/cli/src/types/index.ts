import type { ModelMessage } from "ai";
import type { LspDiagnosticFile } from "../lsp/types";

export interface FileDiff {
  filePath: string;
  additions: number;
  removals: number;
  patch: string;
  isNew: boolean;
}

export interface PlanStep {
  title: string;
  description: string;
  filePaths?: string[];
}

export interface PlanQuestion {
  id: string;
  question: string;
  header?: string;
  type: "select" | "multiselect" | "text";
  options?: { id: string; label: string }[];
}

export interface Plan {
  title: string;
  summary: string;
  steps: PlanStep[];
  questions?: PlanQuestion[];
}

export type BuiltinSubagentId =
  | "general"
  | "explore"
  | "vision"
  | "verify"
  | "verify-detect"
  | "verify-manifest"
  | "computer";

export interface TaskRequest {
  agent: BuiltinSubagentId | string;
  description: string;
  prompt: string;
  /**
   * Optional per-call model override (model id, e.g. "claude-opus-4-8"). When
   * set, the sub-agent runs on this model instead of the one its agent type /
   * custom config would pick. Used by `.js` workflow scripts whose `agent()`
   * primitive runs each phase on an explicitly named model. Unknown ids fall
   * back to the caller's current model (resolveModelRuntimeViaKernel throws,
   * caught by the runner). */
  model?: string;
}

export interface TaskRun {
  agent: string;
  description: string;
  summary: string;
  activity?: string;
}

export type DelegationStatus = "running" | "complete" | "error";

export interface DelegationRun {
  id: string;
  agent: "explore";
  description: string;
  summary: string;
  status: DelegationStatus;
  // Optional UI-facing metadata (running-agents footer drill-down). Additive —
  // populated by toDelegationRun; older consumers ignore these.
  title?: string;
  startedAt?: string;
}

export interface SubagentStatus {
  agent: string;
  description: string;
  detail: string;
  /** ISO timestamp of when this sub-agent run started, so the UI can show
   *  elapsed time the same way it does for background delegations. */
  startedAt?: string;
}

export interface BackgroundProcessInfo {
  id: number;
  pid: number;
  command: string;
}

export interface MediaAsset {
  kind: "image" | "video";
  path: string;
  url?: string;
  mediaType?: string;
  prompt?: string;
  sourcePath?: string;
  sourceUrl?: string;
  durationSeconds?: number;
  modelId?: string;
}

export interface ComputerToolMetadata {
  action: string;
  path?: string;
  hint?: string;
  ref?: string;
  app?: string;
  windowId?: string;
}

export interface VerifyRecipe {
  ecosystem: string;
  appKind: string;
  appLabel: string;
  shellInitCommands: string[];
  bootstrapCommands: string[];
  installCommands: string[];
  buildCommands: string[];
  testCommands: string[];
  startCommand?: string;
  startPort?: string;
  smokeKind: "http" | "cli" | "none";
  smokeTarget?: string;
  evidence: string[];
  notes: string[];
}

export interface VerifyEnvironmentManifest {
  ecosystem?: string;
  appKind?: string;
  appLabel?: string;
  shellInit?: string[] | string;
  shellInitCommands?: string[] | string;
  bootstrap?: string[] | string;
  bootstrapCommands?: string[] | string;
  install?: string[] | string;
  installCommands?: string[] | string;
  build?: string[] | string;
  buildCommands?: string[] | string;
  test?: string[] | string;
  testCommands?: string[] | string;
  start?: string;
  startCommand?: string;
  startPort?: string;
  smokeKind?: "http" | "cli" | "none";
  smokeTarget?: string;
  evidence?: string[] | string;
  notes?: string[] | string;
  sandbox?: {
    allowNet?: boolean;
    allowedHosts?: string[];
    ports?: string[];
    cpus?: number;
    memory?: number;
    diskSize?: number;
    secrets?: Array<{ name: string; fromEnv: string; hosts: string[] }>;
    from?: string;
    verifyBaseFrom?: string;
    guestWorkdir?: string;
    syncHostWorkspace?: boolean;
    shellInit?: string[];
    hostBrowserCommandsOnHost?: boolean;
  };
  recipe?: Partial<VerifyRecipe> & Record<string, unknown>;
}

export interface VerifyRetryStrategy {
  id: string;
  when: string;
  reason: string;
  commands: string[];
}

export interface VerifyArtifact {
  kind: "log" | "screenshot" | "video";
  path: string;
  description: string;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  diff?: FileDiff;
  plan?: Plan;
  task?: TaskRun;
  delegation?: DelegationRun;
  backgroundProcess?: BackgroundProcessInfo;
  media?: MediaAsset[];
  computer?: ComputerToolMetadata;
  verifyRecipe?: VerifyRecipe;
  lspDiagnostics?: LspDiagnosticFile[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatEntry {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  /** For `type: "system"` rows (UI-only, never persisted): `error` for a
   *  failed turn or provider error, `summary` for the turn-end line, `info`
   *  for notices such as compaction or a finished background delegation. */
  systemKind?: "error" | "info" | "summary";
  timestamp: Date;
  modeColor?: string;
  remoteKey?: string;
  sourceLabel?: string;
  queued?: boolean;
  /** UI-only: id of the live turn run that pushed this optimistic row. Absent
   *  on rows rebuilt from persistence. Lets the post-turn rebuild skip rows a
   *  cancelled run left behind (see ui/transcript-reconcile.ts). */
  runId?: number;
  toolCalls?: ToolCall[];
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  /** UI-only: wall-clock duration of a tool_result entry's call, measured by
   *  the live turn (see ui/hooks/tool-timing.ts). Absent on rows rebuilt from
   *  persistence. */
  durationMs?: number;
  /** Set when this entry is a live terminal session view rendered inline
   *  in the chat feed (see /term). The id refers to the terminal manager's
   *  session store. */
  terminalSessionId?: string;
  /** Captured reasoning/thinking text for assistant entries. Rendered as a
   *  collapsible "Thought for Xs" chip above the message. In-memory only —
   *  the storage layer doesn't persist it across session reload (see
   *  buildChatEntries in src/storage/transcript.ts). The host preserves it
   *  across the post-turn `getChatEntries()` rebuild by carrying entries
   *  forward from the previous render. */
  reasoningText?: string;
  /** How long the model reasoned before its first text token, in ms. In-memory
   *  only, carried across the rebuild with `reasoningText`. */
  reasoningDurationMs?: number;
  /** Model-suggested next prompts for the chips beneath an assistant answer.
   *  In-memory only. The visible message strips the hidden metadata marker. */
  followupSuggestions?: string[];
  /** Web/RAG citations surfaced under the assistant message. Populated when
   *  the turn used `WebFetch` / `WebSearch` or other source-producing tools.
   *  Renders via the `Sources` widget. In-memory only. */
  sources?: ChatEntrySource[];
  /** Generated/downloadable artifacts (images, files, datasets) produced by
   *  tools during this turn. Renders via the `ArtifactList` widget below
   *  the message content. In-memory only. */
  artifacts?: ChatEntryArtifact[];
}

export interface ChatEntrySource {
  /** Stable id for React keys; falls back to `url` when omitted. */
  id?: string;
  url: string;
  title?: string;
  /** Short snippet / description shown beneath the title. */
  snippet?: string;
  /** Origin tag — `web` (open internet), `docs` (project/api docs), `rag`
   *  (vector store result), `tool` (generic tool output). Used for the
   *  pill color in the `Sources` widget. */
  kind?: "web" | "docs" | "rag" | "tool";
}

export interface ChatEntryArtifact {
  id: string;
  /** Display name — e.g. `chart.png`, `report.md`. */
  name: string;
  /** Absolute path on disk. Optional — some artifacts may only have URLs. */
  path?: string;
  /** Public URL when the artifact lives off-disk (e.g. signed S3 link). */
  url?: string;
  /** Lifecycle state — drives the pill color in `ArtifactList`. */
  status?: "new" | "updated" | "generated" | "deleted";
  /** MIME / format hint (e.g. `image/png`, `text/markdown`). */
  mimeType?: string;
  /** Human-readable size summary (e.g. `12 KB`, `1.2 MB`). */
  size?: string;
}

export interface PaymentPrecheck {
  security?: string;
  securityLabel?: string;
  securityUrl?: string;
  amount?: string;
  network?: string;
  asset?: string;
  /** Recipient address of the option the approval quoted — the one that is paid. */
  payTo?: string;
  description?: string;
}

/** Pre-execution diff preview for write_file / edit_file approval requests.
 *  The agent computes this in agent.ts BEFORE the tool runs so the UI can
 *  render the exact pending change inline with Accept / Reject buttons. */
export interface EditPrecheck {
  filePath: string;
  absolutePath: string;
  isNew: boolean;
  additions: number;
  removals: number;
  patch: string;
  /** When true, the prospective change is byte-identical to the existing
   *  file. UI can either suppress the prompt or label it as a no-op. */
  noop: boolean;
}

export interface StreamChunk {
  type:
    | "content"
    | "tool_calls"
    | "tool_result"
    | "tool_approval_request"
    | "questionnaire"
    | "done"
    | "error"
    | "reasoning"
    | "warning"
    | "status";
  content?: string;
  /** Payload for `type: "status"` — provider lifecycle (`connecting`, `ready`,
   *  `streaming`, `complete`, `error`) or `compacted` when the engine rewrote
   *  history to fit the context window. `content` carries an optional note. */
  status?: string;
  toolCalls?: ToolCall[];
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  approvalId?: string;
  paymentPrecheck?: PaymentPrecheck;
  editPrecheck?: EditPrecheck;
  isAuthError?: boolean;
  /** Payload for `type: "questionnaire"` — a structured multiple-choice
   *  prompt the host should render via its QuestionnaireTabs surface. Set by
   *  the owning-adapter path when the model invokes the Claude Agent SDK's
   *  built-in `AskUserQuestion` tool. */
  questionnaire?: { title?: string; questions: unknown };
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  inputPrice: number;
  outputPrice: number;
  reasoning: boolean;
  description: string;
  aliases?: string[];
  responsesOnly?: boolean;
  multiAgent?: boolean;
  supportsClientTools?: boolean;
  supportsMaxOutputTokens?: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportsReasoningEffort?: boolean;
}

export type AgentMode = "agent" | "plan" | "ask";
export type SessionStatus = "active" | "archived";
export type UsageSource = "message" | "title" | "recap" | "task" | "delegation" | "other";

export interface SessionRecap {
  text: string;
  model: string | null;
  updatedAt: Date | null;
}

export interface WorkspaceInfo {
  id: string;
  scopeKey: string;
  canonicalPath: string;
  gitRoot: string | null;
  displayName: string;
  lastSeenAt: Date;
}

export interface SessionInfo {
  id: string;
  workspaceId: string;
  title: string | null;
  recap: SessionRecap | null;
  model: string;
  mode: AgentMode;
  cwdAtStart: string;
  cwdLast: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsageEvent {
  id: number;
  sessionId: string;
  messageSeq: number | null;
  source: UsageSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
  createdAt: Date;
}

export interface SessionSnapshot {
  workspace: WorkspaceInfo;
  session: SessionInfo;
  messages: ModelMessage[];
  entries: ChatEntry[];
  totalTokens: number;
}

export const MODES: { id: AgentMode; label: string; color: string }[] = [
  { id: "agent", label: "Agent", color: "#5c9cf5" },
  { id: "plan", label: "Plan", color: "#e5c07b" },
  { id: "ask", label: "Ask", color: "#22c55e" },
];
