// Kernel-owned computer-use tools.
//
// Phase 2 #4 migration. Promotes the 12 macOS desktop-automation tools from
// `createTools()` (where they were registration-time gated to `mode === "agent"`)
// into a single kernel-owned extension that registers each tool with
// `modes: ["agent"]`. The kernel's mode filter (see loader.ts:setKernelMode +
// isModeFilteredOut) hides them in plan/ask modes at the active-ToolSet level
// instead of skipping registration, so `/extensions` always lists the same
// catalog regardless of mode.
//
// Why a single extension for all 12?
//   - One toggle (`builtin.tools.computer`) still governs the whole group,
//     matching the pre-migration UX in `groups.ts`.
//   - All 12 share the same host coupling (`services.workspace.cwd()` + the
//     ai-sdk `abortSignal` that flows through `execute(args, { abortSignal })`).
//   - The macOS automation backing these tools (`agent-desktop`) is a single
//     codebase — a per-tool extension boundary would just be ceremony.
//
// Mode filter semantics:
//   - When the kernel mode is "agent" → all 12 tools surface to the model.
//   - When the kernel mode is "plan" or "ask" → all 12 are stripped from the
//     active ToolSet via `filterToolSetByEnabled()` and `getEnabledToolSet()`.
//   - When the kernel mode is `null` (boot, tests, before the agent has
//     declared a mode) → the filter passes through, preserving backward
//     compat with code paths that don't set the mode.
//
// All 12 registrations share an identical shape (group + modes + hook-wrapped
// execute), differing only in name / descriptions / inputSchema / backing fn.
// They are declared as a data table (`COMPUTER_TOOLS`) and registered in a
// loop so the scaffolding lives in exactly one place.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";
import {
  computerClick,
  computerFocusWindow,
  computerGet,
  computerLaunch,
  computerListWindows,
  computerMouseMove,
  computerPress,
  computerScreenshot,
  computerScroll,
  computerSnapshot,
  computerType,
  computerWait,
} from "../../../tools/computer";
import type { ToolResult } from "../../../types/index";

const manifest: PluginManifest = {
  id: "builtin.tools.computer",
  name: "Computer Use",
  version: "1.0.0",
  description: "macOS desktop automation via agent-desktop (snapshot, click, type, etc.).",
  enabledByDefault: true,
  capabilities: ["tools"],
};

/** Backing automation fn shape: input + agent cwd + ai-sdk abortSignal. */
type ComputerFn<I> = (input: I, cwd: string, abortSignal?: AbortSignal) => Promise<ToolResult>;

interface ComputerToolDef {
  /** Canonical tool name (e.g. "computer_click"). */
  name: string;
  /** Short label for `/extensions` lists. */
  summary: string;
  /** Long, model-facing description. */
  description: string;
  /** ai-sdk input schema. */
  inputSchema: z.ZodTypeAny;
  /** Backing `agent-desktop` automation function. */
  fn: ComputerFn<unknown>;
}

/**
 * Declare one computer tool. `I` is inferred from `fn` (mirroring the previous
 * per-tool `wrap<I>` typing); `inputSchema` is passed independently and is not
 * cross-constrained to `I`, preserving the pre-refactor type behavior exactly.
 */
function def<I>(
  name: string,
  summary: string,
  description: string,
  inputSchema: z.ZodTypeAny,
  fn: ComputerFn<I>,
): ComputerToolDef {
  return { name, summary, description, inputSchema, fn: fn as ComputerFn<unknown> };
}

const COMPUTER_TOOLS: ComputerToolDef[] = [
  def(
    "computer_snapshot",
    "Capture the accessibility tree.",
    "Capture a semantic accessibility snapshot of a desktop app using agent-desktop. Prefer this before desktop interaction. It returns stable refs like @e1 that remain valid until the next snapshot.",
    z.object({
      app: z.string().optional().describe("Optional application name to scope the snapshot"),
      window_id: z.string().optional().describe("Optional window id from computer_list_windows"),
      interactive_only: z
        .boolean()
        .optional()
        .describe("If true or omitted, include only interactive elements with refs"),
      include_bounds: z.boolean().optional().describe("Include element bounds in the snapshot"),
      compact: z.boolean().optional().describe("Collapse single-child unnamed nodes to reduce tree depth"),
      max_depth: z.number().int().min(1).max(30).optional().describe("Maximum tree depth"),
      surface: z
        .enum(["window", "focused", "menu", "menubar", "sheet", "popover", "alert"])
        .optional()
        .describe("Optional UI surface to snapshot"),
    }),
    computerSnapshot,
  ),
  def(
    "computer_screenshot",
    "Capture a screenshot.",
    "Capture a PNG screenshot of a desktop app window using agent-desktop. Use for visual confirmation or when the accessibility snapshot is insufficient.",
    z.object({
      output_path: z
        .string()
        .optional()
        .describe("Optional output path for the screenshot. Defaults to .grok/computer/*.png"),
      app: z.string().optional().describe("Optional application name to capture"),
      window_id: z.string().optional().describe("Optional window id from computer_list_windows"),
    }),
    computerScreenshot,
  ),
  def(
    "computer_click",
    "Click an element by ref.",
    "Click a desktop element via agent-desktop. Prefer `ref` values from computer_snapshot. Coordinates are a fallback only when accessibility refs are unavailable.",
    z.object({
      ref: z.string().optional().describe("Element ref from computer_snapshot, such as @e3"),
      x: z.number().optional().describe("Fallback absolute screen X coordinate"),
      y: z.number().optional().describe("Fallback absolute screen Y coordinate"),
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button to click"),
      count: z.number().int().min(1).max(3).optional().describe("Number of clicks"),
    }),
    computerClick,
  ),
  def(
    "computer_mouse_move",
    "Move the mouse pointer.",
    "Hover over a desktop element or coordinates via agent-desktop. Prefer refs from computer_snapshot.",
    z.object({
      ref: z.string().optional().describe("Element ref from computer_snapshot, such as @e3"),
      x: z.number().optional().describe("Fallback absolute screen X coordinate"),
      y: z.number().optional().describe("Fallback absolute screen Y coordinate"),
      duration_ms: z.number().int().min(0).optional().describe("Optional hover duration in milliseconds"),
    }),
    computerMouseMove,
  ),
  def(
    "computer_type",
    "Type into an element.",
    "Type text into a specific desktop element via agent-desktop. Pass a ref from computer_snapshot. For shortcuts like cmd+k or enter, prefer computer_press.",
    z.object({
      ref: z.string().describe("Element ref from computer_snapshot, such as @e5"),
      text: z.string().describe("Text to type"),
    }),
    computerType,
  ),
  def(
    "computer_press",
    "Press a key combination.",
    "Press a key or key chord via agent-desktop, optionally targeting a specific app first.",
    z.object({
      key: z.string().describe("Key or key chord such as enter or cmd+s"),
      app: z.string().optional().describe("Optional application name to focus before pressing"),
    }),
    computerPress,
  ),
  def(
    "computer_scroll",
    "Scroll within an element.",
    "Scroll a desktop element via agent-desktop. Pass the element ref from computer_snapshot.",
    z.object({
      ref: z.string().describe("Element ref from computer_snapshot, such as @e8"),
      direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
      amount: z.number().int().min(1).max(100).optional().describe("Optional scroll amount"),
    }),
    computerScroll,
  ),
  def(
    "computer_launch",
    "Launch an application.",
    "Launch an application by name or bundle id using agent-desktop and wait for its window to appear.",
    z.object({
      app: z.string().describe("Application name or bundle id"),
      timeout_ms: z.number().int().min(100).max(120000).optional().describe("Optional launch timeout in milliseconds"),
    }),
    computerLaunch,
  ),
  def(
    "computer_list_windows",
    "List open windows.",
    "List visible desktop windows using agent-desktop. Use this to discover window ids before focusing or scoping snapshots.",
    z.object({
      app: z.string().optional().describe("Optional application name to filter windows"),
    }),
    computerListWindows,
  ),
  def(
    "computer_focus_window",
    "Focus a specific window.",
    "Bring a desktop window to the front using a window id, app name, or title.",
    z.object({
      window_id: z.string().optional().describe("Window id from computer_list_windows"),
      app: z.string().optional().describe("Application name"),
      title: z.string().optional().describe("Partial window title match"),
    }),
    computerFocusWindow,
  ),
  def(
    "computer_wait",
    "Wait for a UI condition.",
    "Wait for time, an element ref, a window title, or text to appear using agent-desktop. Use after launches, dialogs, or UI transitions.",
    z.object({
      milliseconds: z.number().int().min(0).max(120000).optional().describe("Optional pause duration in milliseconds"),
      element: z.string().optional().describe("Wait until this element ref appears"),
      window: z.string().optional().describe("Wait until a window title appears"),
      text: z.string().optional().describe("Wait until text appears in the accessibility tree"),
      timeout_ms: z.number().int().min(100).max(120000).optional().describe("Timeout for element/window/text waits"),
      app: z.string().optional().describe("Optional app scope for the wait"),
      menu: z.boolean().optional().describe("Wait until a menu is open"),
      menu_closed: z.boolean().optional().describe("Wait until a menu is dismissed"),
    }),
    computerWait,
  ),
  def(
    "computer_get",
    "Read a property of an element.",
    "Read a property like text, value, title, bounds, role, or states from a desktop element ref.",
    z.object({
      ref: z.string().describe("Element ref from computer_snapshot, such as @e4"),
      property: z.enum(["text", "value", "title", "bounds", "role", "states"]).optional().describe("Property to read"),
    }),
    computerGet,
  ),
];

export const computerToolsPlugin: CodesurfPlugin = {
  name: "codesurf-computer-tools",
  manifest,
  inject: ["contributions", "tools", "workspace"],
  apply(ctx: PluginContext) {
    const cwd = () => ctx.workspace.cwd();

    // Each computer_* tool has the same shape: forward input, cwd and the abort
    // signal to its `computerXxx` function. `wrap` keeps the hook ceremony and
    // the signal threading in one place so each registration is one line driven
    // from the COMPUTER_TOOLS table.
    const wrap = <I>(toolName: string, fn: ComputerFn<I>) =>
      ctx.tools.wrapExecute<I>(toolName, async (input, execCtx) => fn(input, cwd(), execCtx.abortSignal));

    for (const t of COMPUTER_TOOLS) {
      ctx.effect(() =>
        ctx.contributions.registerTool({
          name: t.name,
          description: t.summary,
          group: "computer",
          modes: ["agent"],
          tool: tool({
            description: t.description,
            inputSchema: t.inputSchema,
            execute: wrap(t.name, t.fn),
          }),
        }),
      );
    }
  },
};
