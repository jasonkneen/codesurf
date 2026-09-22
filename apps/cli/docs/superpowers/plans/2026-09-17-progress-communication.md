# Progress and Thinking Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TUI tell the user what the agent is doing, for how long, and what it did, without losing the order of events at turn end.

**Architecture:** The engine already emits everything needed except a status chunk; the work is mostly UI wiring plus one persistence change (per-round messages on the provider-session path). New pure helpers (`tool-timing.ts`, `turn-summary.ts`) carry the logic so it is unit-testable; hooks call them. System rows are UI-only `ChatEntry` rows carried across the post-turn rebuild by the reconcile step.

**Tech Stack:** Bun, TypeScript, OpenTUI React, vitest (`bunx vitest run <file>`), bun:test for two footer files (`bun test <file>`), biome.

**Spec:** `docs/superpowers/specs/2026-09-17-progress-communication-design.md`

## Global Constraints

- Use `command grep`, never bare `grep`, in shell.
- No commits. Leave everything uncommitted and say so.
- Do not delete dead components or props (`InterruptBar`, `ActivityStatus`, `SessionHeader` fields, `sessionRecap`).
- Product name is codesurf-cli / CodeSurf. Never "grok-cli".
- After every task: `bun run typecheck` and the task's test files. At the end: full `bunx vitest run`, `bun run test:bun`, `bun run lint` on touched files, a tmux capture, `bun run parity`.
- Telegram turns share `finalizeActiveTurn` and `flushPendingAssistantMessage`: run `src/ui/telegram-turn-ui.test.ts` after touching `use-turn-stream.ts`.

---

### Task 1: Per-tool timing and concurrent tool tracking

**Files:**
- Create: `src/ui/hooks/tool-timing.ts`, `src/ui/hooks/tool-timing.test.ts`
- Modify: `src/types/index.ts:203-240` (add `durationMs?: number` to `ChatEntry`)
- Modify: `src/ui/context/conversation-state-context.tsx` (replace `activeToolStartRef: RefObject<number>` with `toolStartTimesRef: RefObject<Map<string, number>>`)
- Modify: `src/ui/hooks/use-turn-stream.ts` (`clearLiveTurnUi`, `showLiveToolCalls`, `appendLiveToolResult`)
- Modify: `src/ui/routes/session-route.tsx:117,530-540` (status model inputs)
- Modify: `src/ui/components/message-list.tsx:1191-1200` (`entryToChipRecord` copies `durationMs`)
- Modify: `src/ui/telegram-turn-ui.ts:46-62` (`buildToolResultEntry` accepts `durationMs` in decoration)

**Interfaces:**
- Produces: `startToolTimers(map: Map<string, number>, calls: ToolCall[], now: number): void`, `finishToolTimer(map: Map<string, number>, id: string, now: number): number | undefined`, `removeActiveToolCall(calls: ToolCall[], id: string): ToolCall[]`, `earliestToolStart(map: Map<string, number>): number | undefined`.
- Produces: `ChatEntry.durationMs?: number`; `EntryDecoration.durationMs?: number`.

- [x] **Step 1: Write the failing test** `src/ui/hooks/tool-timing.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../types/index";
import { earliestToolStart, finishToolTimer, removeActiveToolCall, startToolTimers } from "./tool-timing";

function tc(id: string): ToolCall {
  return { id, type: "function", function: { name: "bash", arguments: "{}" } };
}

describe("tool timing", () => {
  it("records a start per call and returns each call's own duration", () => {
    const map = new Map<string, number>();
    startToolTimers(map, [tc("a"), tc("b")], 1_000);
    expect(finishToolTimer(map, "a", 1_250)).toBe(250);
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(1_000);
  });

  it("returns undefined for an unknown id", () => {
    expect(finishToolTimer(new Map(), "zzz", 5)).toBeUndefined();
  });

  it("removes only the finished call from the active list", () => {
    const rest = removeActiveToolCall([tc("a"), tc("b"), tc("c")], "b");
    expect(rest.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("reports the earliest in-flight start", () => {
    const map = new Map<string, number>([["a", 500], ["b", 200]]);
    expect(earliestToolStart(map)).toBe(200);
    expect(earliestToolStart(new Map())).toBeUndefined();
  });
});
```

- [x] **Step 2: Run it to verify it fails**: `bunx vitest run src/ui/hooks/tool-timing.test.ts` → module not found.

- [x] **Step 3: Implement** `src/ui/hooks/tool-timing.ts`

```ts
import type { ToolCall } from "../../types/index";

export function startToolTimers(map: Map<string, number>, calls: ToolCall[], now: number): void {
  for (const call of calls) if (!map.has(call.id)) map.set(call.id, now);
}

export function finishToolTimer(map: Map<string, number>, id: string, now: number): number | undefined {
  const started = map.get(id);
  if (started === undefined) return undefined;
  map.delete(id);
  return Math.max(0, now - started);
}

export function removeActiveToolCall(calls: ToolCall[], id: string): ToolCall[] {
  return calls.filter((call) => call.id !== id);
}

export function earliestToolStart(map: Map<string, number>): number | undefined {
  let min: number | undefined;
  for (const started of map.values()) if (min === undefined || started < min) min = started;
  return min;
}
```

- [x] **Step 4: Wire it.** In `conversation-state-context.tsx` replace `activeToolStartRef` with `toolStartTimesRef = useRef(new Map<string, number>())` (type `RefObject<Map<string, number>>`) in the interface, the ref list, and the memo value. In `use-turn-stream.ts`: `clearLiveTurnUi` calls `toolStartTimesRef.current.clear()`; `showLiveToolCalls` calls `startToolTimers(toolStartTimesRef.current, toolCalls, Date.now())` and `setActiveToolCalls((prev) => [...prev, ...toolCalls.filter((c) => !prev.some((p) => p.id === c.id))])`; `appendLiveToolResult` computes `const durationMs = finishToolTimer(toolStartTimesRef.current, toolCall.id, Date.now())`, passes `durationMs` into `buildToolResultEntry` decoration, and calls `setActiveToolCalls((prev) => removeActiveToolCall(prev, toolCall.id))`. Check `setActiveToolCalls` in `approval-context.tsx` is a state setter that accepts an updater; if it is a plain function, add the updater form there. In `session-route.tsx` replace the `activeToolStartRef` read with `earliestToolStart(toolStartTimesRef.current)`. In `message-list.tsx` `entryToChipRecord` add `durationMs: entry.durationMs`. Grep for any other `activeToolStartRef` reader and update it.

- [x] **Step 5: Verify**: `bunx vitest run src/ui/hooks/tool-timing.test.ts src/ui/telegram-turn-ui.test.ts src/ui/transcript-reconcile.test.ts && bun run typecheck`.

---

### Task 2: Status line phases, both layouts, and the placeholder

**Files:**
- Modify: `src/ui/components/claude-code-status-line.tsx`, `src/ui/components/claude-code-status-line.test.ts`
- Modify: `src/ui/routes/session-route.tsx:526-560` (drop the `uiMode === "claude-code"` gate, pass reasoning and provider status)
- Modify: `src/ui/stream-store.ts` (add a `status` slot with the same listener pattern)
- Modify: `src/ui/components/prompt-box.tsx:109,155` (placeholder text)
- Modify: `src/ui/app.layout.test.ts` if its source-shape assertions mention the gate.

**Interfaces:**
- Produces: `ClaudeCodeStatusPhase = "connecting" | "thinking" | "writing" | "tool" | "stopped"`.
- Produces: `buildClaudeCodeStatusModel(params)` gains `streamReasoning: string`, `providerStatus: string | null`, `activeToolCount: number`, `toolStartedAtMs?: number`.
- Produces: `ClaudeCodeStatusLineModel` gains `extraToolCount?: number`, `toolStartedAtMs?: number`.
- Produces in stream-store: `getStreamStatus(): string | null`, `setStreamStatus(next: string | null)`, `useStreamStatus()`.

- [x] **Step 1: Failing tests.** Replace the label test and add phase tests in `claude-code-status-line.test.ts`:

```ts
it("labels each phase with elapsed at the end", () => {
  expect(formatClaudeCodeStatusLabel({ phase: "connecting", elapsedMs: 0 }, "3s")).toBe("Waiting for model… 3s");
  expect(formatClaudeCodeStatusLabel({ phase: "thinking", elapsedMs: 0 }, "12s")).toBe("Thinking… 12s");
  expect(formatClaudeCodeStatusLabel({ phase: "writing", elapsedMs: 0 }, "4s")).toBe("Writing… 4s");
  expect(formatClaudeCodeStatusLabel({ phase: "stopped", elapsedMs: 0 }, "8s")).toBe("Stopped · 8s");
});

it("is thinking while reasoning streams and writing once text streams", () => {
  const base = { activeToolCalls: [], isProcessing: true, justStopped: false, elapsedMs: 1, homeDir: "/h", providerStatus: null };
  expect(buildClaudeCodeStatusModel({ ...base, streamContent: "", streamReasoning: "hm" })?.phase).toBe("thinking");
  expect(buildClaudeCodeStatusModel({ ...base, streamContent: "Hi", streamReasoning: "hm" })?.phase).toBe("writing");
  expect(buildClaudeCodeStatusModel({ ...base, streamContent: "", streamReasoning: "" })?.phase).toBe("connecting");
});

it("counts the other active tools", () => {
  const model = buildClaudeCodeStatusModel({ ...base, streamContent: "", streamReasoning: "", activeToolCalls: [tc, tc2, tc3] });
  expect(model?.phase).toBe("tool");
  expect(model?.extraToolCount).toBe(2);
});
```

- [x] **Step 2: Run to fail.** `bunx vitest run src/ui/components/claude-code-status-line.test.ts`.

- [x] **Step 3: Implement.** In `buildClaudeCodeStatusModel`: tool phase when `activeToolCalls.length > 0` with `extraToolCount: activeToolCalls.length - 1` and `toolStartedAtMs`; else `writing` when `streamContent.trim()`; else `thinking` when `streamReasoning.trim()`; else `connecting`. Labels: `connecting` → `Waiting for model…` (or `Connecting…` when `providerStatus === "connecting"`), `thinking` → `Thinking…`, `writing` → `Writing…`, `stopped` → `Stopped ·`. Right side always shows elapsed since `startedAtMs` (turn start). In the tool phase the left side appends ` +N more` in `t.textMuted` when `extraToolCount > 0` and shows the head tool's own elapsed (from `toolStartedAtMs`, 100ms tick) in place of the turn elapsed on the right. In `session-route.tsx` build the model for both layouts; pass `streamReasoning: getStreamReasoning()`, `providerStatus: getStreamStatus()`, `startedAtMs: startTimeRef.current || undefined`, `toolStartedAtMs: earliestToolStart(toolStartTimesRef.current)`. Add the `status` slot to `stream-store.ts` copying the `reasoning` pattern. Change both placeholders to `"Queue a follow-up... (ctrl+x to stop)"`.

- [x] **Step 4: Verify**: `bunx vitest run src/ui/components/claude-code-status-line.test.ts src/ui/app.layout.test.ts src/ui/stream-store.test.ts && bun run typecheck`.

---

### Task 3: Provider status chunk

**Files:**
- Modify: `src/types/index.ts:296-320` (`StreamChunk.type` gains `"status"`; add `status?: string`)
- Modify: `src/agent/turns/session-turn.ts:171-181` (queue union gains `{ kind: "status"; status: string; message?: string }`), `:317-318` (replace the drop), and the consumer switch (yield `{ type: "status", status, content: message }`)
- Modify: `src/agent/turns/session-turn.test.ts` (new test)
- Modify: `src/ui/hooks/use-turn-engine.ts` switch (case `"status"` → `setStreamStatus(chunk.status ?? null)`); `clearLiveTurnUi` resets it to `null`.

- [x] **Step 1: Failing test** in `session-turn.test.ts`:

```ts
it("forwards provider status events as status chunks", async () => {
  const ctx = makeCtx();
  const session = makeSession(async (_input, controller) => {
    controller.emit({ type: "status", status: "connecting" });
    controller.emit({ type: "text-delta", delta: "hi" });
    controller.emit({ type: "done" });
    return {};
  });
  const chunks = await drain(await runTurn(ctx, session, new AbortController().signal));
  expect(chunks[0]).toEqual({ type: "status", status: "connecting", content: undefined });
});
```

- [x] **Step 2: Run to fail**, then implement per the file list. In `use-turn-engine.ts` the `"status"` case must also clear the status on `"streaming"`/`"complete"` so the connecting label does not linger: `setStreamStatus(chunk.status === "connecting" ? "connecting" : null)`.

- [x] **Step 3: Verify**: `bunx vitest run src/agent/turns/session-turn.test.ts && bun run typecheck`.

---

### Task 4: Chronological persistence on the provider-session path

**Files:**
- Modify: `src/agent/turns/session-turn.ts:155-200` (add `rounds`), `:366-384` (text), `:384-403` (tool call), `:474-506` (tool result), `:566` and `:575` (build messages from rounds)
- Modify: `src/agent/turns/session-turn.test.ts:342-370` (existing persistence test still passes; add a two-round test)
- Modify: `src/ui/transcript-reconcile.test.ts` (two-round pairing test)

**Interfaces:**
- Internal: `type TurnRound = { text: string; toolCalls: ToolCall[]; toolParts: ExecutedBatchTool[] }`.

- [x] **Step 1: Failing test** in `session-turn.test.ts`:

```ts
it("persists one assistant/tool pair per tool round so the transcript keeps its order", async () => {
  const ctx = makeCtx();
  const session = makeSession(async (_input, controller) => {
    controller.emit({ type: "text-delta", delta: "I'll read the file first." });
    controller.emit({ type: "tool-call", id: "c1", toolName: "bash", args: { command: "cat a" } });
    controller.emit({ type: "tool-result", id: "c1", result: "A" });
    controller.emit({ type: "text-delta", delta: "Done." });
    controller.emit({ type: "done" });
    return {};
  });
  await drain(await runTurn(ctx, session, new AbortController().signal));
  const [, messages] = vi.mocked(ctx.appendCompletedTurn).mock.calls[0]!;
  expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
  expect(messages[2]).toEqual({ role: "assistant", content: "Done." });
});
```

- [x] **Step 2: Implement.** Add after `fullText`:

```ts
type TurnRound = { text: string; toolCalls: ToolCall[]; toolParts: ExecutedBatchTool[] };
const rounds: TurnRound[] = [{ text: "", toolCalls: [], toolParts: [] }];
const currentRound = () => rounds[rounds.length - 1]!;
const openRoundIfSettled = () => {
  if (currentRound().toolParts.length > 0) rounds.push({ text: "", toolCalls: [], toolParts: [] });
};
```

Text case: `openRoundIfSettled(); currentRound().text += event.delta;` (keep `fullText`). Tool-call case: `openRoundIfSettled(); currentRound().toolCalls.push(tc);` (keep `completedToolCalls` for the fabrication count). Tool-result case: `currentRound().toolParts.push({ toolCall: tc, input, toolResult: tr })` (keep `completedToolResults` if still referenced; otherwise remove it). Both `buildProviderTurnMessages(fullText, completedToolCalls, completedToolResults)` sites become `rounds.flatMap((r) => buildProviderTurnMessages(r.text, r.toolCalls, r.toolParts))`.

- [x] **Step 3: Reconcile test** in `transcript-reconcile.test.ts`:

```ts
it("pairs assistant segments by ordinal across a multi-round turn", () => {
  const prev = [
    entry({ type: "user", content: "go", runId: 1 }),
    entry({ type: "assistant", content: "First.", runId: 1, reasoningText: "r-first" }),
    entry({ type: "tool_result", content: "A", runId: 1 }),
    entry({ type: "assistant", content: "Done.", runId: 1, followupSuggestions: ["next"] }),
  ];
  const fresh = [
    entry({ type: "user", content: "go" }),
    entry({ type: "assistant", content: "First." }),
    entry({ type: "tool_result", content: "A" }),
    entry({ type: "assistant", content: "Done." }),
  ];
  const merged = reconcileRebuiltTranscript(prev, fresh, new Set());
  expect(merged.map((e) => e.content)).toEqual(["go", "First.", "A", "Done."]);
  expect(merged[1]?.reasoningText).toBe("r-first");
  expect(merged[3]?.followupSuggestions).toEqual(["next"]);
});
```

- [x] **Step 4: Verify**: `bunx vitest run src/agent/turns/session-turn.test.ts src/ui/transcript-reconcile.test.ts src/agent/turns && bun run typecheck`.

---

### Task 5: System rows, error routing, stop row, turn summary

**Files:**
- Modify: `src/types/index.ts:203-240` (`type` gains `"system"`; add `systemKind?: "error" | "info" | "summary"`)
- Modify: `src/ui/telegram-turn-ui.ts` (add `buildSystemEntry(content, kind, decoration)`)
- Create: `src/ui/turn-summary.ts`, `src/ui/turn-summary.test.ts`
- Modify: `src/ui/transcript-reconcile.ts`, `src/ui/transcript-reconcile.test.ts` (carry system rows forward)
- Modify: `src/ui/components/message-list.tsx` (render case at ~263, height case at ~804, grouping: system rows are `single`)
- Modify: `src/ui/hooks/use-turn-engine.ts:392-424` (error path), `src/ui/hooks/use-turn-stream.ts:269-331` (summary row), `src/ui/hooks/use-session-lifecycle.ts:64-100` (stop row)
- Modify: `src/ui/hooks/use-running-agent-rows.ts:115-125` (background notifications become `system/info` rows)

**Interfaces:**
- Produces: `buildSystemEntry(content: string, systemKind: "error" | "info" | "summary", decoration?: EntryDecoration): ChatEntry`.
- Produces: `formatTurnSummary(input: { outcome: "done" | "stopped" | "error"; elapsedMs: number; toolCount: number; filesChanged: number; tokenDelta?: number }): string`, `collectTurnStats(entries: ChatEntry[], runId: number): { toolCount: number; filesChanged: number }`.

- [x] **Step 1: Failing tests** `src/ui/turn-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../types/index";
import { collectTurnStats, formatTurnSummary } from "./turn-summary";

const tool = (name: string, path?: string, runId = 7): ChatEntry => ({
  type: "tool_result", content: "", timestamp: new Date(0), runId,
  toolCall: { id: name + path, type: "function", function: { name, arguments: JSON.stringify(path ? { path } : {}) } },
  toolResult: { success: true },
});

describe("turn summary", () => {
  it("formats done, stopped, and error outcomes", () => {
    expect(formatTurnSummary({ outcome: "done", elapsedMs: 12_340, toolCount: 4, filesChanged: 2, tokenDelta: 1_200 }))
      .toBe("✓ Done in 12.3s · 4 tools · 2 files changed · +1.2k tokens");
    expect(formatTurnSummary({ outcome: "stopped", elapsedMs: 8_000, toolCount: 2, filesChanged: 0 }))
      .toBe("■ Stopped after 8.0s · 2 tools");
    expect(formatTurnSummary({ outcome: "error", elapsedMs: 3_000, toolCount: 0, filesChanged: 0 }))
      .toBe("✗ Failed after 3.0s");
    expect(formatTurnSummary({ outcome: "done", elapsedMs: 900, toolCount: 1, filesChanged: 0 })).toBe("✓ Done in 0.9s · 1 tool");
  });

  it("counts tools and distinct edited files for one run only", () => {
    const entries = [tool("bash"), tool("edit_file", "/a.ts"), tool("write_file", "/a.ts"), tool("edit_file", "/b.ts"), tool("bash", undefined, 6)];
    expect(collectTurnStats(entries, 7)).toEqual({ toolCount: 4, filesChanged: 2 });
  });
});
```

- [x] **Step 2: Implement** `src/ui/turn-summary.ts`:

```ts
import type { ChatEntry } from "../types/index";

const EDIT_TOOLS = new Set(["write_file", "edit_file", "Write", "Edit", "MultiEdit"]);

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function tokens(n: number): string {
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : String(abs);
  return `${n < 0 ? "-" : "+"}${body} tokens`;
}

export function formatTurnSummary(input: {
  outcome: "done" | "stopped" | "error";
  elapsedMs: number;
  toolCount: number;
  filesChanged: number;
  tokenDelta?: number;
}): string {
  const parts: string[] = [];
  if (input.outcome === "done") parts.push(`✓ Done in ${seconds(input.elapsedMs)}`);
  else if (input.outcome === "stopped") parts.push(`■ Stopped after ${seconds(input.elapsedMs)}`);
  else parts.push(`✗ Failed after ${seconds(input.elapsedMs)}`);
  if (input.toolCount > 0) parts.push(plural(input.toolCount, "tool"));
  if (input.filesChanged > 0) parts.push(`${plural(input.filesChanged, "file")} changed`);
  if (input.tokenDelta !== undefined && input.tokenDelta !== 0) parts.push(tokens(input.tokenDelta));
  return parts.join(" · ");
}

export function collectTurnStats(entries: ChatEntry[], runId: number): { toolCount: number; filesChanged: number } {
  let toolCount = 0;
  const files = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "tool_result" || entry.runId !== runId || !entry.toolCall) continue;
    toolCount++;
    if (!EDIT_TOOLS.has(entry.toolCall.function.name)) continue;
    try {
      const args = JSON.parse(entry.toolCall.function.arguments) as { path?: string; file_path?: string };
      const path = args.path ?? args.file_path;
      if (path) files.add(path);
    } catch {}
  }
  return { toolCount, filesChanged: files.size };
}
```

- [x] **Step 3: Reconcile carry-forward test** in `transcript-reconcile.test.ts`:

```ts
it("carries UI-only system rows forward at their anchor position", () => {
  const prev = [
    entry({ type: "user", content: "q1" }),
    entry({ type: "assistant", content: "a1" }),
    entry({ type: "system", content: "✓ Done in 1.0s", systemKind: "summary" }),
    entry({ type: "user", content: "q2", runId: 2 }),
    entry({ type: "assistant", content: "a2", runId: 2 }),
  ];
  const fresh = [
    entry({ type: "user", content: "q1" }),
    entry({ type: "assistant", content: "a1" }),
    entry({ type: "user", content: "q2" }),
    entry({ type: "assistant", content: "a2" }),
  ];
  const merged = reconcileRebuiltTranscript(prev, fresh, new Set());
  expect(merged.map((e) => e.content)).toEqual(["q1", "a1", "✓ Done in 1.0s", "q2", "a2"]);
});
```

Implementation in `reconcileRebuiltTranscript`: before pairing, split `persisted` into `pairable` (non-system) and a list of `{ row, afterPairableIndex }` for system rows, where `afterPairableIndex` is the count of pairable rows preceding it. Pair using `pairable`. After `preserveStableEntryIdentities`, re-insert each system row after the fresh row at that index (append when the index exceeds the fresh length). System rows from cancelled runs are dropped like any other.

- [x] **Step 4: Rendering.** In `MessageView` add:

```tsx
case "system": {
  const kind = entry.systemKind ?? "info";
  const glyphColor = kind === "error" ? t.diffRemovedFg : kind === "summary" ? t.diffAddedFg : t.textMuted;
  return (
    <box paddingLeft={3} marginTop={topGap} flexShrink={0}>
      <text fg={t.textMuted}>
        <span style={{ fg: glyphColor }}>{kind === "error" ? "✗ " : ""}</span>
        {entry.content}
      </text>
    </box>
  );
}
```

Check the theme for the exact names of the red/green tokens (`command grep -n "diffRemovedFg\|diffAddedFg" src/ui/theme.ts`). Height estimate: `case "system": h = 2 + Math.floor((e.content?.length || 0) / 80);`.

- [x] **Step 5: Error routing.** In `use-turn-engine.ts` `case "error"`: keep `turnHadError`/auth flags; replace the two buffer lines with `flushPendingAssistantMessage(); pushSystemRow(chunk.content || "Unknown error", "error");` where `pushSystemRow` is a new function returned by `useTurnStream` that does `setMessages((prev) => [...prev, buildSystemEntry(content, kind, { runId: activeTurnRef.current?.runId })])`. Do the same in the `catch`. Export `flushPendingAssistantMessage` from `useTurnStream` if it is not already returned.

- [x] **Step 6: Summary row.** In `finalizeActiveTurn`, after the final assistant entry is pushed and before the reconcile, compute `const elapsedMs = startTimeRef.current ? Date.now() - startTimeRef.current : 0`, read `contextStatsRef` from `useModel()` for `usedTokens` before the turn (store it in `beginLiveTurn` as `turnStartTokensRef`) and after, and push `buildSystemEntry(formatTurnSummary({ outcome: hadError ? "error" : "done", elapsedMs, ...collectTurnStats(prevMessages, activeTurn.runId), tokenDelta }), "summary")`. Use the `setMessages((prev) => ...)` updater so `collectTurnStats` sees the current rows. Skip the summary when `hadError` (the error row already carries the failure). In `abortActiveRun` (use-session-lifecycle) push a `"summary"` row with `outcome: "stopped"` before `clearLiveTurnUi()` using the same helpers; the interrupted run's rows carry its runId, so `collectTurnStats(prev, interruptedRunId)` works.

- [x] **Step 7: Verify**: `bunx vitest run src/ui/turn-summary.test.ts src/ui/transcript-reconcile.test.ts src/ui/telegram-turn-ui.test.ts src/ui/hooks src/ui/components/message-list.layout.test.tsx && bun run typecheck`.

---

### Task 6: Reasoning timing

**Files:**
- Modify: `src/ui/stream-store.ts` (add `reasoningStartedAt: number | null` with getter/setter, notified with the reasoning listeners)
- Modify: `src/ui/hooks/use-turn-engine.ts:209-213` (set start on first delta), `src/ui/hooks/use-turn-stream.ts` (`clearLiveTurnUi` resets; `finalizeActiveTurn` passes `reasoningDurationMs`)
- Modify: `src/types/index.ts` (`ChatEntry.reasoningDurationMs?: number`), `src/ui/telegram-turn-ui.ts` (`EntryDecoration.reasoningDurationMs`)
- Modify: `src/ui/ai-output/thinking-block.tsx`, `src/ui/ai-output/thinking-block.test.ts`
- Modify: `src/ui/components/message-list.tsx:242` (pass `duration={Math.ceil(entry.reasoningDurationMs / 1000)}`), `:598-635` (pass `startedAtMs` into `ThinkingBlock`)
- Modify: `src/ui/transcript-reconcile.ts` (carry `reasoningDurationMs` with `reasoningText`)

- [x] **Step 1: Failing test** in `thinking-block.test.ts`:

```ts
it("formats the header with elapsed while thinking and with duration once done", () => {
  expect(formatThinkingHeader({ isThinking: true, elapsedMs: 4_200 })).toBe("◌ Thinking 4s");
  expect(formatThinkingHeader({ isThinking: false, lineCount: 12, durationMs: 8_000 })).toBe("Reasoned  12 lines · 8s");
  expect(formatThinkingHeader({ isThinking: false, lineCount: 1 })).toBe("Reasoned  1 line");
});
```

- [x] **Step 2: Implement** `formatThinkingHeader` (exported, pure) and use it in the component; add `startedAtMs?: number` and `durationMs?: number` props; while `isThinking && startedAtMs` tick `now` every 1000ms with `useEffect`. Record `reasoningStartedAt` in `use-turn-engine` on the first reasoning delta of a turn (`if (!getStreamReasoningStartedAt()) setStreamReasoningStartedAt(Date.now())`), and in `finalizeActiveTurn` compute `reasoningDurationMs = startedAt ? (firstContentAt ?? Date.now()) - startedAt : undefined` where `firstContentAt` is recorded by `applyLocalAssistantDelta` on its first call per turn (a ref reset in `beginLiveTurn`).

- [x] **Step 3: Verify**: `bunx vitest run src/ui/ai-output/thinking-block.test.ts src/ui/transcript-reconcile.test.ts && bun run typecheck`.

---

### Task 7: Subagent elapsed, roster status, live cards in claude-code

**Files:**
- Modify: `src/types/index.ts:77-81` (`SubagentStatus.startedAt?: number`)
- Modify: `src/agent/mixins/subagent.ts:672-682` (record `const startedAt = Date.now()` before `runTaskRequest`; include it in the status)
- Modify: `src/ui/hooks/use-running-agent-rows.ts:148-155` (`startedAt: activeSubagent.startedAt`)
- Modify: `src/ui/ai-output/agent-roster.tsx` (`AgentRosterEntry.status?: "running" | "done" | "error"`; render `✓`/`✗`/`◌` before the name)
- Modify: `src/ui/hooks/use-turn-engine.ts:331-336` (on `tool_result` for a roster id, set status from `toolResult.success`)
- Modify: `src/ui/components/message-list.tsx:1088-1089` (remove `!compactLiveStatus &&` on the specials block only)

- [x] **Step 1: Failing test** in `use-running-agent-rows.test.ts`, exercising a pure helper `buildRunningAgentRows(activeSubagent, runningDelegations)` extracted from the `useMemo`:

```ts
it("gives the inline subagent its start time so elapsed can render", () => {
  const rows = buildRunningAgentRows({ agent: "explore", description: "d", detail: "x", startedAt: 1_000 }, []);
  expect(rows[0]).toMatchObject({ kind: "inline", startedAt: 1_000 });
});
```

- [x] **Step 2: Implement** all six edits. In `agent-roster.tsx` render `const glyph = entry.status === "done" ? "✓ " : entry.status === "error" ? "✗ " : entry.status === "running" ? "◌ " : ""` before `- ${entry.name}`, green/red/accent respectively.

- [x] **Step 3: Verify**: `bunx vitest run src/ui/hooks/use-running-agent-rows.test.ts src/ui/running-agents-projection.test.ts src/agent/agent-subagent-admission.test.ts && bun run typecheck`.

---

### Task 8: Todo completion state

**Files:**
- Modify: `src/ui/hooks/use-turn-engine.ts:289-290` (`setTodoPlan({ items, title: allDone ? "Plan complete" : undefined })`)
- Modify: `src/ui/ai-output/plan-update.tsx` (`PlanUpdateData.title?: string` if absent; render it)
- Modify: `src/ui/hooks/use-turn-stream.ts` `finalizeActiveTurn` (clear the plan when every item is completed: `setTodoPlan((p) => p && p.items.every((i) => i.status === "completed") ? null : p)`)

- [x] **Step 1:** Check `PlanUpdateData` in `plan-update.tsx`; add `title` if missing. Implement the two hook edits. No new test file: `src/ui/ai-output` has no plan-update test and the logic is two lines; cover it in the tmux capture.

- [x] **Step 2: Verify**: `bun run typecheck`.

---

### Task 9: Chrome fixes and clearer 400 errors

**Files:**
- Modify: `src/ui/components/claude-code-title-bar.tsx:53-77` (path box `flexShrink={0}`; stats in a sibling box with `flexShrink={1} minWidth={0} overflow="hidden"`)
- Modify: `src/ui/layouts/claude-code.tsx:160-164`, `src/ui/layouts/opencode.tsx:158-162` (runtime label loses its leading `· `)
- Modify: `src/agent/turns/helpers.ts:435-446` (`humanizeApiError` appends the raw message)
- Test: `src/agent/turns/helpers.test.ts` if present, else add the case to `src/agent/turns/stream-turn-failure.test.ts` where `humanizeApiError` is imported; check with `command grep -rln "humanizeApiError" src --include='*.test.ts'`.

- [x] **Step 1: Failing test**:

```ts
it("keeps the raw provider message when the status text is generic", () => {
  const err = new APICallError({ message: "unknown model: claude-sonnet-5", url: "u", requestBodyValues: {}, statusCode: 400, responseBody: "" });
  expect(humanizeApiError(err)).toBe("The request was invalid. This may be caused by an unsupported parameter or model. (unknown model: claude-sonnet-5)");
});
```

- [x] **Step 2: Implement**: in the `STATUS_MESSAGES` branch return `` `${STATUS_MESSAGES[code]} (${raw})` `` when `raw` is non-empty and not already contained in the status text. Apply the layout and title-bar edits.

- [x] **Step 3: Verify**: the helper test, `bun test src/ui/components/claude-code-title-bar.test.ts src/ui/components/prompt-bar.test.ts`, `bunx vitest run src/ui/app.layout.test.ts`, `bun run typecheck`.

---

### Task 10: Cache tokens on the provider-session path and a compaction notice

**Files:**
- Modify: `src/agent/mixins/telemetry.ts:77-80` (widen `usage` to `ProviderUsageSnapshot`-compatible: `{ totalTokens?, inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, cachedInputTokens?, cache_read_input_tokens?, cache_creation_input_tokens? }` or simply `Record<string, number | undefined> & { totalTokens?: number; inputTokens?: number; outputTokens?: number }`)
- Modify: `src/agent/turns/session-turn.ts:581-590` (pass `{ ...finalUsage, totalTokens }` unchanged)
- Modify: `src/agent/turns/session-turn.test.ts` (assert `recordUsage` receives the cache fields)
- Modify: `src/agent/turns/stream-turn.ts:51-59`, `src/agent/turns/batch-turn.ts:53-61` (`const compacted = await ctx.compactForContext(...)`; when true, `yield { type: "status", status: "compacted", content: "Context compacted to fit the model window" }`)
- Modify: `src/ui/hooks/use-turn-engine.ts` `"status"` case: when `chunk.status === "compacted"` push a `system/info` row with `chunk.content`.

- [x] **Step 1: Failing test** in `session-turn.test.ts`:

```ts
it("passes provider cache token counts through to usage recording", async () => {
  const ctx = makeCtx();
  const session = makeSession(async (_input, controller) => {
    controller.emit({ type: "text-delta", delta: "ok" });
    controller.emit({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 100 } });
    controller.emit({ type: "done" });
    return {};
  });
  await drain(await runTurn(ctx, session, new AbortController().signal));
  expect(ctx.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ cacheReadTokens: 900, cacheWriteTokens: 100, totalTokens: 15 }), "message", expect.any(String));
});
```

Check the exact `ProviderUsageSnapshot` field names in `src/core/plugins/api.ts` first and use those.

- [x] **Step 2: Implement** and run `bunx vitest run src/agent/turns src/agent/mixins && bun run typecheck`.

---

### Task 11: Final verification

- [x] `bun run typecheck`
- [x] `bunx vitest run` (full) and `bun run test:bun`
- [x] `bun run lint` on the touched files (`bunx biome check <files>`), fix what it reports
- [x] Re-run the tmux capture (`docs/superpowers/sessions/observe2.sh`) and read the frames: status line phases, tool durations on chips, summary row, chronological transcript at turn end
- [x] `bun run parity` and confirm the comparator passes
- [x] Update the spec's Deferred section with anything not delivered and why
