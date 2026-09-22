// Session-layout contract + registry.
//
// Scope A of the app.tsx decomposition (2026-06-22 review, §1.1): the two
// uiMode variants (opencode / claude-code) become swappable "layouts" keyed
// by id. A layout is a pure render contribution: given a LayoutContext (the
// state + handlers the session-column chrome needs) and a shared `center`
// node (the MessageList + its slots, built once by App), it renders the
// title bar, pending-queue banner, todo panel, composer wrapper, and footer.
//
// Keys stay host-owned — no key behavior is mode-specific, so layouts never
// touch the keyboard. This is what makes the extraction safe.
//
// Adding a layout: create src/ui/layouts/<id>.tsx exporting a LayoutEntry,
// register it in registry.ts. `/ui <id>` switches to it.

import type { PasteEvent, TextareaRenderable } from "@opentui/core";
import type React from "react";
import type { Agent } from "../../agent/agent";
import type { getModelInfo } from "../../grok/models";
import type { SandboxMode } from "../../utils/settings";
import type { PlanUpdateData } from "../ai-output/plan-update";
import type { ContextStats, QueuedMessage, RuntimeMode } from "../app-helpers";
import type { ShortcutHint } from "../components/composer-shortcut-hints";
import type { ModeInfo } from "../components/session-header";
import type { TypeaheadState } from "../hooks/useTypeahead";
import type { RunningAgentRow } from "../running-agents";
import type { Theme } from "../theme";

/** A pending questionnaire surfaced inline at the bottom of the transcript. */
export interface PendingQuestionnaire {
  title?: string;
  tabs: Array<{
    id: string;
    title: string;
    status: "pending" | "answered";
    question: {
      prompt: string;
      options: Array<{ id: string; label: string; description?: string; recommended?: boolean; answerLabel?: string }>;
      selectedIndex?: number;
      answer?: string;
    };
  }>;
}

/** A tool/payment approval surfaced inline at the bottom of the transcript. */
export interface PendingToolApproval {
  toolName: string;
  detail: string;
  riskLabel?: string;
  approvalId: string;
  selected: number;
}

export interface PendingPaymentApproval {
  approvalId?: string;
  url?: string;
  description?: string;
  amount?: string;
  network?: string;
  securityLabel?: string;
  selected: number;
}

/**
 * Everything a session layout needs to render the chrome around the shared
 * transcript center. Built once in App and forwarded as a prop. Defining
 * this interface *is* the decomposition: it forces the god component's
 * render-time state into a coherent, named surface.
 *
 * Layouts must be pure functions of this context — no hooks of their own
 * beyond what React requires (memo, etc.). Mutating handlers are passed in.
 */
export interface LayoutContext {
  t: Theme;
  agent: Agent;
  /** Composed theme: in claude-code mode the success/accent tokens are
   *  remapped. Layouts just use this; they don't compute it. */
  width: number;

  // ── Model / mode identity ──────────────────────────────────────────────
  model: string;
  modelInfo: ReturnType<typeof getModelInfo>;
  modeInfo: ModeInfo;
  isProcessing: boolean;

  // ── Composer ───────────────────────────────────────────────────────────
  inputRef: React.RefObject<TextareaRenderable | null>;
  shellMode: boolean;
  captureOpen: boolean;
  pasteBlocks: { id: number; content: string; lines: number; isImage?: boolean }[];
  typeahead: TypeaheadState;
  contextStats?: ContextStats | null;
  /** Prefix-cache health line for the last turn (Agent.getLastCacheStatsLine()). */
  cacheStatsLine?: string | null;
  onSubmit: () => void;
  onPaste: (event: PasteEvent) => void;

  // ── Live status / transient panels above queue + composer ──────────────
  statusSlot: React.ReactNode;

  // ── Queue (pending follow-ups) ─────────────────────────────────────────
  queuedMessages: QueuedMessage[];
  queueFocusId: string | null;

  // ── Todo / plan panel ──────────────────────────────────────────────────
  todoPlan: PlanUpdateData | null;
  showTodoPanel: boolean;
  onToggleTodoPanel: () => void;

  // ── Running subagents footer ───────────────────────────────────────────
  runningAgentRows: RunningAgentRow[];
  agentsFooterFocused: boolean;

  // ── Sandbox / footer bits ──────────────────────────────────────────────
  sandboxMode: SandboxMode;
  runtimeMode: RuntimeMode;
  openServerPicker: () => void;
  footerPermissionMode: string | null;

  // ── Slash menu (rendered inside the composer wrapper) ──────────────────
  showSlashMenu: boolean;
  slashDisplayItems: Array<{ id: string; label: string; description?: string }>;

  // ── Precomputed chrome strings (so layouts don't rebuild them) ─────────
  composerShortcutHints: ShortcutHint[];
  composerChromeBottomTitle: string;
  compactFooterHints: boolean;
  footerRightMaxWidth: number;
  cwdIcon: string;
  shellIcon: string;
  sandboxIcon: string;
}

/**
 * A registered session layout. `render` receives the shared transcript
 * `center` node (MessageList + slots, built once by App) plus the
 * LayoutContext, and returns the full session column (title bar → center →
 * queue/todo/composer → footer).
 */
export interface LayoutEntry {
  id: string;
  label: string;
  render: (props: { ctx: LayoutContext; center: React.ReactNode }) => React.ReactNode;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const layouts = new Map<string, LayoutEntry>();
let defaultLayoutId = "opencode";

export function registerLayout(entry: LayoutEntry): void {
  layouts.set(entry.id, entry);
}

export function getLayout(id: string): LayoutEntry | undefined {
  return layouts.get(id);
}

export function listLayouts(): LayoutEntry[] {
  return Array.from(layouts.values());
}

export function resolveLayoutId(id: string | undefined): string {
  if (id && layouts.has(id)) return id;
  return defaultLayoutId;
}

export function setDefaultLayoutId(id: string): void {
  if (layouts.has(id)) defaultLayoutId = id;
}
