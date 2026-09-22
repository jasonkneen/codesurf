// Native Cordis plugin: the host UI action slash commands.
//
// Converted from `builtin/host-actions.ts`. It owns the 26 slash commands that
// either open a host-owned modal or trigger a simple host side effect. Each
// handler is a one-liner that fires `ctx.ui.action({...})`; the host (app.tsx)
// binds a sink that calls the existing `openXxxModal()` helper or sets the
// relevant React state.
//
// Aliases (e.g. `/models` ↔ `/model`) ride on the command spec's `aliases`
// field, exactly as the V1 entry declared them. Arg-carrying commands
// (`/thinking`, `/effort`, `/permission`, `/ui <mode>`) parse args inside the
// handler and pick the matching payload variant. `/thinking`, `/effort` and
// `/claude` carry the V1 `visible` predicate, so the slash menu still hides
// them unless the Claude Agent SDK adapter is active (typed dispatch is
// unaffected either way).
//
// The plugin imports only `@codesurf/plugin-api`: no host UI, no
// `PluginHostApi`, no concrete tool, no storage module. Every registration
// is owned by `ctx.effect`, so disposing the fiber removes the command.

import type {
  CodesurfPlugin,
  CommandSpec,
  HostActionPayload,
  PluginContext,
  PluginManifest,
  SettingSpec,
} from "@codesurf/plugin-api";

const manifest: PluginManifest = {
  id: "builtin.commands.host-actions",
  name: "Host Actions",
  version: "1.0.0",
  description:
    "Slash commands that open host-owned modals or trigger simple host effects (/model, /agents, /clear, /quit, /ui, etc.).",
  enabledByDefault: true,
  protected: true,
  capabilities: ["commands"],
};

// Map a /feedback argument to a [0,1] score. Returns null for unrecognized
// input (the handler then prints usage). Words/emoji map to the poles; a bare
// number is clamped.
const FEEDBACK_UP = new Set(["up", "good", "great", "yes", "y", "👍", "+1", "1"]);
const FEEDBACK_DOWN = new Set(["down", "bad", "poor", "no", "n", "👎", "-1", "0"]);

export function parseFeedbackScore(raw: string): number | null {
  const token = raw.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!token) return null;
  if (FEEDBACK_UP.has(token)) return 1;
  if (FEEDBACK_DOWN.has(token)) return 0;
  const n = Number(token);
  if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  return null;
}

const PERMISSION_MODE_ALIASES: Record<string, string> = {
  ask: "default",
  default: "default",
  prompt: "default",
  prompts: "default",
  bypass: "bypassPermissions",
  bypasspermissions: "bypassPermissions",
  "bypass-permissions": "bypassPermissions",
  yolo: "bypassPermissions",
  "always-approve": "bypassPermissions",
  alwaysapprove: "bypassPermissions",
  "always-allow": "bypassPermissions",
  alwaysallow: "bypassPermissions",
  edits: "acceptEdits",
  "accept-edits": "acceptEdits",
  accept: "acceptEdits",
  acceptEdits: "acceptEdits",
  acceptedits: "acceptEdits",
  plan: "plan",
  read: "plan",
  readonly: "plan",
  "read-only": "plan",
  grant: "dontAsk",
  grants: "dontAsk",
  allowlist: "dontAsk",
  "allow-list": "dontAsk",
  dontask: "dontAsk",
  "dont-ask": "dontAsk",
  "don't-ask": "dontAsk",
  cli: "dontAsk",
  auto: "auto",
};

const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: "ask",
  bypassPermissions: "always-approve",
  acceptEdits: "accept edits",
  plan: "plan",
  dontAsk: "dont-ask",
  auto: "auto",
};

/** Canonical suffix every permission-mode setting key must end with. */
const PERMISSION_MODE_KEY_SUFFIX = ".permissionMode";

/**
 * Keys written when the settings registry has no matching select.
 *
 * Hosts that boot host-actions before the provider extensions register their
 * settings (and unit tests that only exercise the slash command) would
 * otherwise write nothing, so the historical dual-write contract is kept as a
 * fallback — exactly as `extensions/permission-mode.ts` does.
 */
const FALLBACK_PERMISSION_MODE_KEYS = [
  "anthropic.agent-sdk.permissionMode",
  "codesurf.daemon.permissionMode",
  "grok.cli.permissionMode",
  "anthropic.agent-sdk-claude-skills.permissionMode",
];

/**
 * Codex does not use `*.permissionMode`; without this bridge `/permissions
 * bypass` would leave the native Codex adapter on `on-request`.
 */
const CODEX_APPROVAL_FROM_PERMISSION: Record<string, string> = {
  default: "on-request",
  bypassPermissions: "never",
  dontAsk: "never",
  acceptEdits: "on-request",
  plan: "untrusted",
  auto: "on-request",
};

const CODEX_APPROVAL_KEY = "openai.codex-app-server.approvalPolicy";

/** True when a registered setting is a permission-mode select. */
function isPermissionModeSetting(setting: SettingSpec): boolean {
  return setting.type === "select" && setting.key.endsWith(PERMISSION_MODE_KEY_SUFFIX);
}

/** A select that declares options only accepts a value it lists. */
function accepts(setting: SettingSpec, value: string): boolean {
  if (!setting.options || setting.options.length === 0) return true;
  return setting.options.some((option) => option.value === value);
}

/**
 * Write a permission mode to every adapter that understands one.
 *
 * Discovery-based, mirroring `extensions/permission-mode.ts`: every registered
 * `*.permissionMode` select is written (skipping any whose declared options
 * reject the value), then the historical keys the registry did not cover, then
 * the Codex approval-policy bridge.
 */
function applyPermissionMode(ctx: PluginContext, mode: string): void {
  const registered = ctx.settings.list().filter(isPermissionModeSetting);
  const written = new Set<string>();

  for (const setting of registered) {
    if (written.has(setting.key)) continue;
    if (!accepts(setting, mode)) continue;
    ctx.settings.set(setting.key, mode);
    written.add(setting.key);
  }

  for (const key of FALLBACK_PERMISSION_MODE_KEYS) {
    if (written.has(key)) continue;
    // Only fall back-write when the registry had no setting for that key, so a
    // select that rejected the value above is not overwritten behind its back.
    if (registered.some((setting) => setting.key === key)) continue;
    ctx.settings.set(key, mode);
    written.add(key);
  }

  const codexApproval = CODEX_APPROVAL_FROM_PERMISSION[mode];
  if (!codexApproval) return;
  // Prefer the registered key if present (an extension may rename it); fall
  // back to the known default so the write still lands before Codex activates.
  const registeredCodex = ctx.settings
    .list()
    .find((setting) => setting.key.endsWith(".approvalPolicy") && setting.key.includes("codex"));
  if (registeredCodex && !accepts(registeredCodex, codexApproval)) return;
  ctx.settings.set(registeredCodex?.key ?? CODEX_APPROVAL_KEY, codexApproval);
}

/** A command body: parse the args, return the payload to dispatch (or null). */
type BuildAction = (args: string) => HostActionPayload | null;

/**
 * Wrap a command body in the dispatch step every host action shares.
 *
 * The dispatcher is read off the context passed in, never off a module-level
 * binding: two roots mounting this plugin must not share a sink.
 */
function command(
  ctx: PluginContext,
  spec: {
    name: string;
    description: string;
    argsHint?: string;
    aliases?: string[];
    visible?: () => boolean;
    build: BuildAction;
  },
): CommandSpec {
  const { build, ...rest } = spec;
  return {
    ...rest,
    handler: ({ args }) => {
      const action = build(args);
      if (action) ctx.ui.action(action);
    },
  };
}

/** Build a static-payload command. The handler ignores args. */
function staticAction(ctx: PluginContext, name: string, description: string, payload: HostActionPayload): CommandSpec {
  return command(ctx, { name, description, build: () => payload });
}

function permissionModeActionCommand(ctx: PluginContext, name: string, aliases?: string[]): CommandSpec {
  return command(ctx, {
    name,
    aliases,
    description: "Set permission mode. Use ask, yolo, dont-ask, plan, edits, or auto.",
    argsHint: "[ask|yolo|dont-ask|plan|edits|auto]",
    build: (args) => {
      const raw = args.trim();
      if (!raw) return { type: "claude-agent", focusGroup: "permission" };

      const first = raw.split(/\s+/)[0] ?? "";
      const normalized = PERMISSION_MODE_ALIASES[first] ?? PERMISSION_MODE_ALIASES[first.toLowerCase()];
      if (!normalized) {
        ctx.chat.appendAssistant("Usage: /permissions ask | yolo | dont-ask | plan | edits | auto");
        return null;
      }

      // Write every registered `*.permissionMode` select so the active adapter
      // (Claude SDK, Codesurf daemon, Grok CLI, Claude+Grok skills, …) picks
      // up the change regardless of which model is currently selected.
      applyPermissionMode(ctx, normalized);
      ctx.chat.appendAssistant(`permission mode -> ${PERMISSION_MODE_LABELS[normalized] ?? normalized}`);
      return null;
    },
  });
}

function termCommandAction(ctx: PluginContext, commandType: "term" | "term-modal"): CommandSpec {
  const isModal = commandType === "term-modal";
  return command(ctx, {
    name: isModal ? "/term-modal" : "/term",
    description: isModal ? "Open the terminal popup with a command." : "Run a shell command inline.",
    build: (args) => {
      const shellCommand = args.trim();
      if (!shellCommand && !isModal) {
        ctx.chat.appendAssistant("Usage: /term <command>\nExample: /term npm test");
        return null;
      }
      if (isModal) {
        return { type: "term-modal", command: shellCommand || undefined };
      }
      return { type: "term", command: shellCommand };
    },
  });
}

function btwCommandAction(ctx: PluginContext): CommandSpec {
  return command(ctx, {
    name: "/btw",
    description: "Ask a side question without interrupting.",
    build: (args) => {
      const question = args.trim();
      if (!question) {
        ctx.chat.appendAssistant("Usage: /btw <question>\nExample: /btw what does useEffect cleanup do?");
        return null;
      }
      return { type: "btw", question };
    },
  });
}

function helpCommandAction(ctx: PluginContext): CommandSpec {
  return command(ctx, {
    name: "/help",
    description: "Show available slash commands.",
    build: () => {
      const names = ctx.commands
        .list()
        .map((entry) => entry.name)
        .filter((name, idx, self) => self.indexOf(name) === idx)
        .sort()
        .join("\n");
      ctx.chat.appendAssistant(names.length ? `Available commands:\n${names}` : "No commands are currently available.");
      return null;
    },
  });
}

function telegramCommandAction(ctx: PluginContext): CommandSpec {
  return command(ctx, {
    name: "/telegram",
    description: "Open Telegram setup. Use /telegram key to replace the bot token.",
    argsHint: "[key|token]",
    build: (args) => {
      const arg = args.trim().toLowerCase();
      if (!arg) return { type: "telegram" };
      if (arg === "key" || arg === "token" || arg === "bot-token" || arg === "botkey") {
        return { type: "telegram", openTokenModal: true };
      }
      ctx.chat.appendAssistant(
        "Usage: /telegram             · open Telegram setup\n" +
          "       /telegram key         · enter or replace Telegram bot token",
      );
      return null;
    },
  });
}

function feedbackCommandAction(ctx: PluginContext): CommandSpec {
  return command(ctx, {
    name: "/feedback",
    description: "Rate the last turn (up/down or 0–1) to improve future routing.",
    argsHint: "[up|down|0-1]",
    build: (args) => {
      const score = parseFeedbackScore(args);
      if (score === null) {
        ctx.chat.appendAssistant("Usage: /feedback up | down | <0-1>\nExample: /feedback up   ·   /feedback 0.8");
        return null;
      }
      const sessionId = ctx.session.id();
      if (!sessionId) {
        ctx.chat.appendAssistant("No active session yet — send a message first, then rate it.");
        return null;
      }
      const [last] = ctx.traces.listTraces({ sessionId, limit: 1 });
      if (!last) {
        ctx.chat.appendAssistant("No completed turn to rate yet.");
        return null;
      }
      ctx.traces.setFeedback(last.traceId, score);
      const label = score >= 0.5 ? "👍" : "👎";
      ctx.chat.appendAssistant(`${label} Recorded feedback ${score} for the last turn.`);
      return null;
    },
  });
}

function uiCommandAction(ctx: PluginContext): CommandSpec {
  return command(ctx, {
    name: "/ui",
    description: "Toggle UI layout. /ui (toggle), /ui oc, /ui cc, /ui opencode, /ui claude-code.",
    argsHint: "[oc|cc|opencode|claude-code]",
    build: (args) => {
      const arg = args.trim().toLowerCase();
      if (!arg) return { type: "toggle-ui-mode" };
      if (arg === "opencode" || arg === "open-code" || arg === "flat" || arg === "oc") {
        return { type: "set-ui-mode", mode: "opencode" };
      }
      if (
        arg === "claude-code" ||
        arg === "claudecode" ||
        arg === "claude" ||
        arg === "cc" ||
        arg === "termcast" ||
        arg === "bordered"
      ) {
        return { type: "set-ui-mode", mode: "claude-code" };
      }
      ctx.chat.appendAssistant(
        "Usage: /ui                    · toggle between opencode and claude-code\n" +
          "       /ui oc | opencode      · flat layout (default)\n" +
          "       /ui cc | claude-code   · bordered prompt + termcast chrome",
      );
      return null;
    },
  });
}

/**
 * Every command this plugin contributes, in the V1 registration order.
 *
 * Exported so the parity test can assert the table without mounting twice.
 */
export function buildHostActionCommands(ctx: PluginContext): CommandSpec[] {
  // Commands that only make sense when the Claude Agent SDK adapter is active.
  // Used as the `visible` predicate so the slash menu hides them on other
  // models — replaces the old hard-coded name list that lived in app.tsx.
  const claudeAgentVisible = () => ctx.models.getActiveAdapterId() === "anthropic.agent-sdk";

  return [
    // Simple host actions
    staticAction(ctx, "/clear", "Start a fresh session (clear transcript).", { type: "clear" }),
    { ...staticAction(ctx, "/quit", "Exit codesurf.", { type: "quit" }), aliases: ["/exit", "/q"] },
    // Modal opens (no args)
    { ...staticAction(ctx, "/model", "Open the model picker.", { type: "model" }), aliases: ["/models"] },
    {
      ...staticAction(ctx, "/api-key", "Enter or replace the built-in Grok/xAI API key.", { type: "api-key" }),
      aliases: ["/apikey"],
    },
    staticAction(ctx, "/sandbox", "Open the sandbox picker.", { type: "sandbox" }),
    // /wallet moved to builtin.tools.payments so it is filtered when payments is disabled.
    staticAction(ctx, "/remote-control", "Open the remote-control modal.", { type: "remote-control" }),
    telegramCommandAction(ctx),
    // /mcp moved to builtin.mcp so the command (and the entire MCP surface) is filtered when the extension is disabled.
    { ...staticAction(ctx, "/agents", "Open the subagents modal.", { type: "agents" }), aliases: ["/agent"] },
    { ...staticAction(ctx, "/schedule", "Open the schedule modal.", { type: "schedule" }), aliases: ["/schedules"] },
    {
      // Renamed from /extensions. The old names stay as aliases permanently —
      // people have typed them for months, and a slash command is muscle
      // memory, not an implementation detail.
      ...staticAction(ctx, "/plugins", "Open the plugins modal.", { type: "extensions" }),
      // `/plugin` (singular) is NOT an alias here: it is the management verb,
      // matching Claude Code, and belongs to builtin.claude-plugins.
      aliases: ["/extensions", "/extension"],
    },
    { ...staticAction(ctx, "/sessions", "Open the sessions modal.", { type: "sessions" }), aliases: ["/session"] },
    { ...staticAction(ctx, "/theme", "Open the theme modal.", { type: "theme" }), aliases: ["/themes"] },
    {
      ...staticAction(ctx, "/flags", "Open the feature flags modal.", { type: "flags" }),
      aliases: ["/feature-flags", "/featureflags"],
    },
    // A demo screen; the starter chip is its discovery path, so keep it out of the menu.
    { ...staticAction(ctx, "/showcase", "Open the showcase.", { type: "showcase" }), visible: () => false },
    helpCommandAction(ctx),
    staticAction(ctx, "/update", "Install the latest available update.", { type: "update" }),
    staticAction(ctx, "/terms", "Open the terminal-session manager.", { type: "terms" }),
    termCommandAction(ctx, "term"),
    termCommandAction(ctx, "term-modal"),
    btwCommandAction(ctx),
    feedbackCommandAction(ctx),
    // Claude-agent modal commands (thinking/effort/claude) are specific to the
    // anthropic.agent-sdk adapter. Permission mode is universal — it controls the
    // active backend whether that is Claude SDK, Codesurf daemon, Grok CLI, etc.
    // The /permission handler fans out to every registered `*.permissionMode`
    // setting so whichever adapter is active always sees the right value.
    {
      ...staticAction(ctx, "/thinking", "Open Claude-agent settings (thinking).", {
        type: "claude-agent",
        focusGroup: "thinking",
      }),
      visible: claudeAgentVisible,
    },
    {
      ...staticAction(ctx, "/effort", "Open Claude-agent settings (effort).", {
        type: "claude-agent",
        focusGroup: "effort",
      }),
      visible: claudeAgentVisible,
    },
    // /permission and /permissions are intentionally not gated — they apply to any
    // model that supports a permission mode (Claude SDK, codesurf daemon Codex/Opencode, etc.).
    permissionModeActionCommand(ctx, "/permission", ["/permissions"]),
    {
      ...staticAction(ctx, "/claude", "Open Claude-agent settings.", { type: "claude-agent" }),
      aliases: ["/claude-agent"],
      visible: claudeAgentVisible,
    },
    // /ui — args-aware
    uiCommandAction(ctx),
  ];
}

export const hostActionsPlugin: CodesurfPlugin = {
  name: "codesurf-host-actions",
  manifest,
  inject: ["contributions", "chat", "ui", "commands", "session", "settings", "models", "traces"],
  apply(ctx: PluginContext) {
    for (const spec of buildHostActionCommands(ctx)) {
      ctx.effect(() => ctx.contributions.registerCommand(spec));
    }
  },
};
