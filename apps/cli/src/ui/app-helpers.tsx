// Pure helpers, types, and constants extracted from app.tsx (2026-06-22 review,
// §1.1). These are stateless utilities used by the App component — formatting,
// paste/mention tokenization, questionnaire mapping, tool-approval preview,
// adapter preference resolution, and the ASCII hero logo. Keeping them out of
// the 7k-line component improves navigability and lets them be unit-tested
// independently.

import type { ReactNode } from "react";
import type { Agent } from "../agent/agent";
import type { RegisteredModel, RegisteredModelProvider } from "../core/plugins";
import { normalizeModelId } from "../grok/models";
import type { DelegationRun, ReasoningEffort } from "../types/index";
import type { SandboxMode, SandboxSettings } from "../utils/settings";
import type { QuestionnaireTab } from "./ai-output/questionnaire-tabs";
import type { ClaudeAgentGroup } from "./claude-agent-modal.js";
import { extractExistingLocalFilePaths } from "./local-file-paths.js";
import type { McpEditorField } from "./mcp-modal-types";
import type { Theme } from "./theme";

// ── Types ────────────────────────────────────────────────────────────────────

export type ContextStats = {
  contextWindow: number;
  usedTokens: number;
  remainingTokens: number;
  ratioUsed: number;
  ratioRemaining: number;
};

export type PasteBlock = { id: number; content: string; lines: number; isImage?: boolean };
export type FileMentionBlock = { id: number; path: string };
export type QueuedMessage = { id: string; text: string; displayText: string };

export type RuntimeMode = { kind: "local" } | { kind: "server"; url: string };

export interface AppStartupConfig {
  apiKey: string | undefined;
  baseURL: string;
  model: string;
  modelAdapterId?: string;
  sandboxMode: SandboxMode;
  sandboxSettings: SandboxSettings;
  maxToolRounds: number;
  runtimeMode: RuntimeMode;
  version: string;
}

import type { RemoteFront } from "../relay/session-stream";

export interface AppProps {
  agent: Agent;
  remoteFront?: RemoteFront;
  startupConfig: AppStartupConfig;
  initialMessage?: string;
  onExit?: () => void;
}

export interface ActiveTurnState {
  kind: "local" | "telegram";
  agent: Agent;
  modeColor?: string;
  remoteKey?: string;
  sourceLabel?: string;
  userId?: number;
  /** Run id of the local turn (see hooks/turn-ownership.ts); Telegram turns omit it. */
  runId?: number;
  latestAssistantText: string;
  flushedAssistantChars: number;
}

// ── Paste / file-mention tokenization ────────────────────────────────────────

export function getPasteBlockToken(block: Pick<PasteBlock, "id" | "lines" | "isImage">): string {
  if (block.isImage) {
    return `[Image #${block.id}]`;
  }
  return `[Pasted #${block.id} ${block.lines}+ lines]`;
}

export function getFileMentionToken(block: FileMentionBlock): string {
  const name = block.path.split("/").pop() || block.path;
  return `[File: ${name}]`;
}

export function extractFileDropPaths(text: string, cwd: string): string[] {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const paths: string[] = [];
  for (const line of lines) {
    const found = extractExistingLocalFilePaths(line, cwd);
    if (found.length !== 1) return [];
    paths.push(found[0]!);
  }
  return paths;
}

// ── Starter suggestions + reasoning effort ───────────────────────────────────

/** Starter prompt chips rendered in MessageList.idleSuggestionsSlot when the
 *  conversation is empty. Strings starting with `/` are dispatched as slash
 *  commands; anything else is sent as a regular user message. */
export const STARTER_SUGGESTIONS: string[] = [
  "/help",
  "/showcase",
  "Summarize the current project",
  "What can you do?",
];

const USER_REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

export function isUserReasoningEffort(value: string): value is ReasoningEffort {
  return USER_REASONING_EFFORTS.has(value as ReasoningEffort);
}

// ── Questionnaire mapping ─────────────────────────────────────────────────────

/** Raw structured-questions payload shared by two sources: CodeSurf's
 *  `ask_user_structured` kernel tool (ai-sdk path) and the Claude Agent SDK's
 *  built-in `AskUserQuestion` tool (owning-adapter path). Field overlap is
 *  enough that one mapping covers both (`prompt`/`question`, `header`,
 *  `options{label,description}`). */
export type RawQuestionnaire = {
  title?: string;
  questions?: Array<{
    id?: string;
    header?: string;
    prompt?: string;
    question?: string;
    options?: Array<{ id?: string; label?: string; description?: string; recommended?: boolean }>;
  }>;
};

/** Map a {@link RawQuestionnaire} into the QuestionnaireTabs shape. Returns
 *  null when no question has at least two options (nothing renderable). */
export function mapQuestionsToQuestionnaire(
  parsed: RawQuestionnaire | null | undefined,
): { title?: string; tabs: QuestionnaireTab[] } | null {
  if (!parsed?.questions?.length) return null;
  const tabs: QuestionnaireTab[] = parsed.questions
    .filter((q) => (q.options?.length ?? 0) >= 2)
    .map((q, i) => {
      const qid = q.id ?? `q${i + 1}`;
      const promptText = q.prompt ?? q.question ?? "";
      const tabTitle = q.header?.trim() || promptText.split(/\s+/).slice(0, 2).join(" ") || `Q${i + 1}`;
      return {
        id: qid,
        title: tabTitle,
        status: "pending" as const,
        question: {
          prompt: promptText,
          options: (q.options ?? []).map((o, j) => ({
            id: o.id ?? `${qid}-opt${j + 1}`,
            label: o.label ?? `Option ${j + 1}`,
            description: o.description,
            recommended: o.recommended,
          })),
        },
      };
    });
  if (tabs.length === 0) return null;
  return { title: parsed.title, tabs };
}

// ── Tool-approval preview + risk labels ───────────────────────────────────────

/** One-line preview of a tool's args for the ApprovalCard detail row. Mirrors
 *  the `Requested command: …` style from /showcase. Falls back to a compact
 *  JSON dump when the tool isn't specifically recognized. */
export function formatToolApprovalDetail(toolName: string, args: Record<string, unknown>): string {
  const lower = toolName.toLowerCase();
  if (lower === "bash" || lower === "execute" || lower === "shellexec") {
    const cmd = typeof args.command === "string" ? args.command : "";
    return cmd ? `Requested command: \`${cmd}\`` : `Requested ${toolName} call`;
  }
  if (lower === "read" || lower === "view") {
    const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
    return path ? `Read file: \`${path}\`` : `Requested ${toolName} call`;
  }
  if (lower === "glob") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    return pattern ? `Glob: \`${pattern}\`` : `Requested ${toolName} call`;
  }
  if (lower === "grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    const where = typeof args.path === "string" ? args.path : "";
    return pattern ? `Grep \`${pattern}\`${where ? ` in \`${where}\`` : ""}` : `Requested ${toolName} call`;
  }
  if (lower === "webfetch" || lower === "websearch") {
    const url = typeof args.url === "string" ? args.url : typeof args.query === "string" ? args.query : "";
    return url ? `${toolName}: \`${url}\`` : `Requested ${toolName} call`;
  }
  // Generic fallback — compact JSON, truncated.
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    json = "{…}";
  }
  if (json.length > 240) json = `${json.slice(0, 240)}…`;
  return `Requested ${toolName} call: \`${json}\``;
}

/** Risk pill for tools that mutate the system or run unconstrained shell.
 *  Read-only tools return `undefined` so the pill is omitted. */
export function riskLabelForTool(toolName: string): string | undefined {
  const lower = toolName.toLowerCase();
  if (lower === "bash" || lower === "execute" || lower === "shellexec") return "shell command";
  if (lower === "write" || lower === "write_file") return "filesystem write";
  if (lower === "edit" || lower === "multiedit" || lower === "edit_file") return "filesystem edit";
  if (lower === "killshell") return "process control";
  return undefined;
}

// ── Hero logo ─────────────────────────────────────────────────────────────────

const HERO_ROWS: string[] = [
  " ██████╗ ██████╗ ██████╗ ███████╗███████╗██╗   ██╗██████╗ ███████╗",
  "██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██║   ██║██╔══██╗██╔════╝",
  "██║     ██║   ██║██║  ██║█████╗  ███████╗██║   ██║██████╔╝█████╗  ",
  "██║     ██║   ██║██║  ██║██╔══╝  ╚════██║██║   ██║██╔══██╗██╔══╝  ",
  "╚██████╗╚██████╔╝██████╔╝███████╗███████║╚██████╔╝██║  ██║██║     ",
  " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝     ",
];

export function HeroLogo({ t }: { t: Theme }): ReactNode {
  return (
    <box flexDirection="column" alignItems="center">
      {HERO_ROWS.map((row, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static constant array that never reorders
        <text key={r} style={{ fg: t.primary }}>
          {row}
        </text>
      ))}
    </box>
  );
}

// ── Modal constant tables ─────────────────────────────────────────────────────

export const CLAUDE_AGENT_SETTING_KEYS = {
  thinking: "anthropic.agent-sdk.thinking",
  effort: "anthropic.agent-sdk.effort",
  permission: "anthropic.agent-sdk.permissionMode",
} as const;

export const CODESURF_DAEMON_PERMISSION_SETTING_KEY = "codesurf.daemon.permissionMode";

export const CLAUDE_AGENT_SETTING_DEFAULTS = {
  thinking: "adaptive",
  effort: "high",
  permission: "default",
} as const;

export const CLAUDE_AGENT_SETTING_LABELS: Record<ClaudeAgentGroup, string> = {
  thinking: "thinking",
  effort: "effort",
  permission: "permission mode",
};

export const CONNECT_CHANNELS: { id: string; label: string; description: string }[] = [
  { id: "telegram", label: "Telegram", description: "Chat with Codesurf from Telegram" },
];

export const MCP_REMOTE_FIELDS: McpEditorField[] = ["transport", "label", "url", "headers", "env"];
export const MCP_STDIO_FIELDS: McpEditorField[] = ["transport", "label", "command", "args", "cwd", "env"];

// ── Adapter preference ───────────────────────────────────────────────────────

export function preferredAdapterIdForModel(
  modelId: string,
  models: readonly RegisteredModel[],
  providers: readonly RegisteredModelProvider[],
): string | null {
  const normalizedModelId = normalizeModelId(modelId);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const candidates = models.filter((model) => model.id === normalizedModelId || model.aliases?.includes(modelId));
  candidates.sort((a, b) => {
    const providerA = a.adapterId ? providerById.get(a.adapterId) : undefined;
    const providerB = b.adapterId ? providerById.get(b.adapterId) : undefined;
    const scoreA = providerA?.connectionMode === "persistent" ? 0 : 1;
    const scoreB = providerB?.connectionMode === "persistent" ? 0 : 1;
    return scoreA - scoreB;
  });
  return candidates[0]?.adapterId ?? null;
}

// ── Delegation-run equality (footer-poll bailout) ─────────────────────────────

/**
 * True when two delegation-run lists are render-identical (same members in the
 * same order, same visible fields). Used to bail out of the 1.5s footer poll's
 * setState: `getDelegationRuns()` returns a fresh array every tick, so without
 * a value guard React would reconcile the whole App every 1.5s at idle — felt
 * as pervasive keyboard/navigation lag. Returning the prev array reference lets
 * React skip the re-render entirely.
 */
export function sameRunningDelegations(prev: DelegationRun[], next: DelegationRun[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.description !== b.description ||
      a.title !== b.title ||
      a.startedAt !== b.startedAt
    ) {
      return false;
    }
  }
  return true;
}
