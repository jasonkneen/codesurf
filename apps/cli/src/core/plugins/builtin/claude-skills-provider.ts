// Builtin Claude Agent SDK provider — Claude skills isolated mode.
//
// This is a sibling of `claude-agent-provider`, not a replacement. It still
// uses @anthropic-ai/claude-agent-sdk for the persistent subprocess, but it
// starts that subprocess in SDK-isolation mode:
//   - no Claude filesystem settings (`settingSources: []`)
//   - no project/user MCP config (`mcpServers: {}`)
//   - only Claude Code's shell tool (`tools: ["Bash"]`), gated by the
//     permission-mode setting (default: prompt before every command)
//   - no Claude agents, and no hooks beyond CodeSurf's own MCP deny hook
//   - one generated local Claude plugin containing ONLY Claude-discovered skills
//
// The only Claude-side capability intentionally left available is the SDK's
// skill-loading surface via `skills: "all"`, pointed at the generated plugin.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Options as ClaudeAgentOptions,
  Query as ClaudeAgentQuery,
  EffortLevel,
  PermissionMode,
  SDKUserMessage,
  ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CredentialStatus,
  ModelSpec,
  PluginContext,
  ProviderConnectionContext,
  ProviderSession,
  ProviderStreamController,
  ProviderTurnInput,
  ProviderUsageSnapshot,
} from "@codesurf/plugin-api";
import { loadCustomInstructions } from "../../../utils/instructions";
import { type DiscoveredSkill, discoverSkills, formatSkillsForPrompt } from "../../../utils/skills";
import { filterEnabledSkills } from "../../persistence/skills-enablement";
// A value import from the module that imports this one. Safe only because
// `buildMcpDenyHook` is a hoisted function called at connect time, never
// while either module is still evaluating.
import { buildMcpDenyHook, type ClaudeAgentSession } from "../native/claude-agent-provider";
import { ANTHROPIC_MODELS } from "./anthropic-models-catalog";

const PROVIDER_ID = "anthropic";
const ADAPTER_ID = "anthropic.agent-sdk-claude-skills";

const PERMISSION_MODE_SETTING = `${ADAPTER_ID}.permissionMode`;
// Bash is live in this adapter, so the default must prompt. Anything laxer is
// the user's explicit choice in /settings.
const DEFAULT_PERMISSION_MODE: PermissionMode = "default";
const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Default — prompt for every tool" },
  { value: "bypassPermissions", label: "Always approve (yolo) — skip every tool prompt" },
  { value: "acceptEdits", label: "Accept edits — auto-approve file edits" },
  { value: "plan", label: "Plan — no tool use, read-only planning" },
  { value: "dontAsk", label: "Don't ask — no host prompts (CLI deny rules still apply)" },
  { value: "auto", label: "Auto — let Claude choose" },
];

const THINKING_SETTING = `${ADAPTER_ID}.thinking`;
const DEFAULT_THINKING: ThinkingSettingValue = "adaptive";
type ThinkingSettingValue = "adaptive" | "enabled" | "disabled";
const THINKING_OPTIONS: Array<{ value: ThinkingSettingValue; label: string }> = [
  { value: "adaptive", label: "Adaptive — Claude decides when and how much to think" },
  { value: "enabled", label: "Enabled — always think (budget guided by effort)" },
  { value: "disabled", label: "Disabled — skip extended thinking entirely" },
];

const EFFORT_SETTING = `${ADAPTER_ID}.effort`;
const DEFAULT_EFFORT: EffortLevel = "high";
const EFFORT_OPTIONS: Array<{ value: EffortLevel; label: string }> = [
  { value: "low", label: "Low — fastest, minimal thinking" },
  { value: "medium", label: "Medium — balanced" },
  { value: "high", label: "High — deep reasoning (default)" },
  { value: "xhigh", label: "Extra high — Opus 4.7/4.8 only (falls back to high elsewhere)" },
  { value: "max", label: "Max — maximum effort (select models only)" },
];

interface ClaudeSkillsModelSpec {
  id: string;
  upstreamModel: string;
  label: string;
  description: string;
  contextWindow: number;
  aliases?: string[];
}

// Skills-isolated wrappers around the Anthropic catalog (see
// `./anthropic-models-catalog.ts`). Each row pairs an upstream model id with
// the skills-isolated synthetic id and its own aliases. The label suffix
// and description text are uniform — only the upstream id, synthetic id, and
// alias set differ.
const SKILLS_DESCRIPTION =
  "Claude Agent SDK with Claude tools/MCP/settings disabled; only Claude-discovered skills are exposed.";

const SKILLS_OVERLAY: Record<string, { idSuffix: string; labelPrefix: string; aliases: string[] }> = {
  "claude-fable-5-1": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Fable 5.1",
    aliases: ["claude-skills-fable"],
  },
  "claude-fable-5": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Fable 5",
    aliases: [],
  },
  "claude-opus-5-5": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Opus 5.5",
    aliases: ["claude-skills-opus"],
  },
  "claude-opus-5": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Opus 5",
    aliases: ["claude-skills-opus-5"],
  },
  "claude-opus-4-8": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Opus 4.8",
    aliases: ["claude-skills-opus-4-8"],
  },
  "claude-opus-4-7": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Opus 4.7",
    aliases: [],
  },
  "claude-opus-4-6": { idSuffix: "-claude-skills", labelPrefix: "Claude Opus 4.6", aliases: [] },
  "claude-sonnet-5-5": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Sonnet 5.5",
    aliases: ["claude-skills", "claude-skills-sonnet"],
  },
  "claude-sonnet-5": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Sonnet 5",
    aliases: ["claude-skills-sonnet-5"],
  },
  "claude-sonnet-4-6": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Sonnet 4.6",
    aliases: [],
  },
  "claude-haiku-5-5": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Haiku 5.5",
    aliases: ["claude-skills-haiku"],
  },
  "claude-haiku-4-5": {
    idSuffix: "-claude-skills",
    labelPrefix: "Claude Haiku 4.5",
    aliases: [],
  },
};

const SKILLS_MODELS: ClaudeSkillsModelSpec[] = ANTHROPIC_MODELS.filter((m) => SKILLS_OVERLAY[m.id]).map((m) => {
  const overlay = SKILLS_OVERLAY[m.id]!;
  return {
    id: `${m.id}${overlay.idSuffix}`,
    upstreamModel: m.id,
    label: `${overlay.labelPrefix} (Claude skills isolated)`,
    description: SKILLS_DESCRIPTION,
    contextWindow: m.contextWindow,
    aliases: overlay.aliases.length > 0 ? overlay.aliases : undefined,
  };
});

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODE_OPTIONS.some((opt) => opt.value === value);
}

function isThinkingMode(value: unknown): value is ThinkingSettingValue {
  return typeof value === "string" && THINKING_OPTIONS.some((opt) => opt.value === value);
}

function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_OPTIONS.some((opt) => opt.value === value);
}

function thinkingConfigFor(mode: ThinkingSettingValue): ThinkingConfig {
  switch (mode) {
    case "disabled":
      return { type: "disabled" };
    case "enabled":
      return { type: "enabled" };
    default:
      return { type: "adaptive" };
  }
}

function toRegisteredModels(): ModelSpec[] {
  return SKILLS_MODELS.map((model) => ({
    id: model.id,
    providerId: PROVIDER_ID,
    adapterId: ADAPTER_ID,
    label: model.label,
    description: model.description,
    contextWindow: model.contextWindow,
    aliases: model.aliases,
    capabilities: { tools: false, reasoning: true, images: true },
  }));
}

function upstreamModelFor(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  return SKILLS_MODELS.find((model) => model.id === modelId || model.aliases?.includes(modelId))?.upstreamModel;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function copySkillDir(skill: DiscoveredSkill, skillsDir: string): void {
  const target = path.join(skillsDir, safeSegment(skill.name));
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(skill.rootDir, target, {
    recursive: true,
    dereference: true,
    filter: (src) => !src.split(path.sep).includes("node_modules") && !src.split(path.sep).includes(".git"),
  });
}

export function createClaudeSkillsPlugin(cwd: string, skills: DiscoveredSkill[] = discoverSkills(cwd)): string {
  const fingerprint = createHash("sha256")
    .update(path.resolve(cwd))
    .update("\0")
    .update(skills.map((skill) => `${skill.name}:${skill.skillMdPath}`).join("\0"))
    .digest("hex")
    .slice(0, 16);
  const pluginDir = path.join(os.tmpdir(), "codesurf-claude-skills", fingerprint);
  const manifestDir = path.join(pluginDir, ".claude-plugin");
  const skillsDir = path.join(pluginDir, "skills");

  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify(
      {
        name: "codesurf-claude-skills",
        version: "0.1.0",
        description:
          "Generated plugin exposing only Claude-discovered Agent Skills to the isolated Claude SDK adapter.",
      },
      null,
      2,
    ),
    "utf-8",
  );

  for (const skill of skills) copySkillDir(skill, skillsDir);
  return pluginDir;
}

export function buildClaudeSkillsSystemPrompt(cwd: string, skills: DiscoveredSkill[] = discoverSkills(cwd)): string {
  const parts = [
    "You are Codesurf's isolated Claude SDK adapter.",
    "Claude Code MCP servers, hooks, project settings, slash commands, file-edit tools, read tools, and Claude subagents are intentionally disabled in this adapter.",
    "The only enabled execution tool is shell execution, surfaced to Codesurf as `bash`. Use the Claude-discovered Agent Skills made available in this session for workflow guidance.",
  ];

  const custom = loadCustomInstructions(cwd);
  if (custom) {
    parts.push(
      `CUSTOM INSTRUCTIONS:\n${custom}\n\nFollow these instructions alongside the isolated-adapter constraints above.`,
    );
  }

  const skillsText = formatSkillsForPrompt(skills);
  if (skillsText) parts.push(skillsText);

  return parts.join("\n\n");
}

export function buildIsolatedClaudeOptions(params: { cwd: string; modelId?: string }): ClaudeAgentOptions {
  const skills = filterEnabledSkills(discoverSkills(params.cwd));
  const pluginDir = createClaudeSkillsPlugin(params.cwd, skills);
  return {
    model: upstreamModelFor(params.modelId),
    cwd: params.cwd,
    tools: ["Bash"],
    mcpServers: {},
    // Per Anthropic Agent SDK docs: `strictMcpConfig: true` enforces strict
    // MCP validation (equivalent to CLI `--strict-mcp-config`). Combined with
    // `mcpServers: {}` this hides any SDK/gateway-injected MCP tools from the
    // model's tool list — not just blocking their execution at runtime. This
    // matches the contract for this isolated "no MCP, ever" adapter.
    strictMcpConfig: true,
    // Belt-and-braces: even though `mcpServers: {}` prevents local config
    // from loading, this isolated variant must also block any MCP tools
    // injected by the SDK gateway (Claude.ai-hosted connectors). A PreToolUse
    // hook, because hooks run in every permission mode — under
    // bypassPermissions the SDK approves tools without consulting
    // `canUseTool`. (No `canUseTool` here: ClaudeAgentSession installs its
    // own at start, which denies `mcp__*` via the `mcpPolicy` passed below.)
    agents: {},
    hooks: {
      PreToolUse: [{ hooks: [buildMcpDenyHook({ mcpEnabled: false, allowedPrefixes: new Set() })] }],
    },
    settingSources: [],
    plugins: [{ type: "local", path: pluginDir }],
    skills: "all",
    systemPrompt: buildClaudeSkillsSystemPrompt(params.cwd, skills),
  };
}

function checkCredential(): CredentialStatus {
  // Same auth model as the normal Claude Agent SDK adapter: the subprocess
  // owns authentication through the user's installed/authenticated claude CLI.
  return { ok: true };
}

export function toSdkModelIdForClaudeSkills(modelId: string): string {
  return upstreamModelFor(modelId) ?? modelId;
}

export function toCodesurfToolNameForClaudeSkills(toolName: string): string {
  return toolName === "Bash" || toolName === "execute" ? "bash" : toolName;
}

/**
 * When the model invokes the SDK’s builtin `Skill` tool, the wire-level
 * `toolName` is just `"Skill"` and the actual skill name lives in the args
 * (`{ skill_name: "opentui", ... }`). To make chips like `SKILL:OPENTUI`
 * possible, rewrite the toolName at forwarding time. Returns null when the
 * event is not a Skill invocation.
 */
export function rewriteSkillToolName(toolName: string, args: unknown): string | null {
  if (toolName !== "Skill") return null;
  if (!args || typeof args !== "object") return "skill";
  const skillName = (args as { skill_name?: unknown }).skill_name;
  if (typeof skillName !== "string" || skillName.length === 0) return "skill";
  return `skill:${skillName}`;
}

interface IsolatedSessionDelegate {
  readonly adapterId: string;
  readonly providerId: string;
  readonly mode: ProviderSession["mode"];
  readonly strategy?: ProviderSession["strategy"];
  sendTurn: (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ) => Promise<{ usage?: ProviderUsageSnapshot }>;
  abortTurn?: () => void | Promise<void>;
  respondToToolApproval?: (approvalId: string, approved: boolean) => void;
  disconnect?: () => void | Promise<void>;
}

export function wrapClaudeSkillsSession(delegate: IsolatedSessionDelegate): ProviderSession {
  return {
    adapterId: delegate.adapterId,
    providerId: delegate.providerId,
    mode: delegate.mode,
    strategy: delegate.strategy,
    sendTurn: (input, controller) =>
      delegate.sendTurn(
        {
          ...input,
          modelId: toSdkModelIdForClaudeSkills(input.modelId),
        },
        {
          emit: (event) => {
            if (event.type === "tool-call") {
              const skillRewrite = rewriteSkillToolName(event.toolName, event.args);
              const toolName = skillRewrite ?? toCodesurfToolNameForClaudeSkills(event.toolName);
              controller.emit({ ...event, toolName });
              return;
            }
            if (event.type === "tool-approval-request") {
              // Rewrite the tool name to match the chip the user already sees
              // for executed calls — keeps the permission prompt consistent
              // with the rest of the transcript.
              const skillRewrite = rewriteSkillToolName(event.toolName, event.input);
              const toolName = skillRewrite ?? toCodesurfToolNameForClaudeSkills(event.toolName);
              controller.emit({ ...event, toolName });
              return;
            }
            controller.emit(event);
          },
        },
      ),
    abortTurn: () => delegate.abortTurn?.(),
    respondToToolApproval: delegate.respondToToolApproval
      ? (approvalId, approved) => delegate.respondToToolApproval?.(approvalId, approved)
      : undefined,
    disconnect: () => delegate.disconnect?.(),
  };
}

/**
 * Register the skills-isolated Claude Agent adapter (Claude tools/MCP/settings
 * disabled, only Claude-discovered Agent Skills exposed) as a mode of the
 * claude-agent provider. Folded in from the former standalone
 * `builtin.provider-claude-skills` extension. `ClaudeAgentSessionClass` is
 * injected by claude-agent-provider so this module needs only a type-level
 * reference to the shared session class (no runtime sibling import / no cycle).
 */
/**
 * Register the skills-isolated Claude adapter on a plugin context.
 *
 * Takes the plugin context rather than the old host api object, so the Claude
 * provider plugin can call it natively. The session class is injected so this
 * module needs no runtime import back into the provider.
 */
export function registerClaudeSkillsProvider(
  ctx: PluginContext,
  ClaudeAgentSessionClass: typeof ClaudeAgentSession,
): void {
  ctx.effect(() =>
    ctx.contributions.registerSetting({
      key: PERMISSION_MODE_SETTING,
      title: "Claude skills permission mode",
      description:
        "Permission mode for the isolated Claude SDK adapter. It gates the adapter's one live tool, Bash (shell commands run in the workspace), and the SDK skill-loading surface. The default prompts before every command.",
      type: "select",
      default: DEFAULT_PERMISSION_MODE,
      section: "Claude SDK + Claude Skills",
      options: PERMISSION_MODE_OPTIONS,
    }),
  );

  ctx.effect(() =>
    ctx.contributions.registerSetting({
      key: THINKING_SETTING,
      title: "Claude skills thinking mode",
      description:
        "Controls extended thinking for the isolated Claude SDK adapter. Takes effect on the next fresh session.",
      type: "select",
      default: DEFAULT_THINKING,
      section: "Claude SDK + Claude Skills",
      options: THINKING_OPTIONS,
    }),
  );

  ctx.effect(() =>
    ctx.contributions.registerSetting({
      key: EFFORT_SETTING,
      title: "Claude skills effort level",
      description:
        "How hard Claude tries in the isolated Claude-skills adapter. Takes effect on the next fresh session.",
      type: "select",
      default: DEFAULT_EFFORT,
      section: "Claude SDK + Claude Skills",
      options: EFFORT_OPTIONS,
    }),
  );

  ctx.effect(() =>
    ctx.contributions.registerModelProvider({
      id: ADAPTER_ID,
      label: "Claude SDK + Claude Skills",
      description:
        "Persistent Claude Agent SDK session with Claude tools/MCP/settings disabled and only Claude skills exposed.",
      providerId: PROVIDER_ID,
      shape: "provider-family",
      transport: "stdio",
      connectionMode: "persistent",
      sessionStrategy: "singleton",
      capabilities: {
        streaming: true,
        tools: false,
        images: true,
        reasoning: true,
      },
      models: toRegisteredModels(),
      auth: {
        mode: "agent-sdk",
        check: checkCredential,
      },
      adapter: {
        connect: async (ctx: ProviderConnectionContext): Promise<ProviderSession> => {
          const sdk = await import("@anthropic-ai/claude-agent-sdk");
          // The agent's workspace, which can drift from process.cwd() once the
          // shell changes directory.
          const cwd = ctx.workspace?.cwd() ?? process.cwd();
          const resolveMode = (): PermissionMode => {
            const raw = ctx.settings.get<unknown>(PERMISSION_MODE_SETTING, DEFAULT_PERMISSION_MODE);
            return isPermissionMode(raw) ? raw : DEFAULT_PERMISSION_MODE;
          };
          const resolveThinking = (): ThinkingConfig => {
            const raw = ctx.settings.get<unknown>(THINKING_SETTING, DEFAULT_THINKING);
            const mode = isThinkingMode(raw) ? raw : DEFAULT_THINKING;
            return thinkingConfigFor(mode);
          };
          const resolveEffort = (): EffortLevel => {
            const raw = ctx.settings.get<unknown>(EFFORT_SETTING, DEFAULT_EFFORT);
            return isEffortLevel(raw) ? raw : DEFAULT_EFFORT;
          };

          return wrapClaudeSkillsSession(
            new ClaudeAgentSessionClass({
              adapterId: ctx.adapterId,
              queryFactory: sdk.query as unknown as (params: {
                prompt: AsyncIterable<SDKUserMessage>;
                options: ClaudeAgentOptions;
              }) => ClaudeAgentQuery,
              options: buildIsolatedClaudeOptions({ cwd, modelId: ctx.modelId }),
              // Isolated variant: no MCP, ever. ClaudeAgentSession's
              // buildCanUseTool will deny every `mcp__*` tool and route the
              // rest through the host's permission UI.
              mcpPolicy: { mcpEnabled: false, allowedPrefixes: new Set(), sdkServers: {} },
              getPermissionMode: resolveMode,
              getThinking: resolveThinking,
              getEffort: resolveEffort,
              emitSkillsInitChip: true,
            }),
          );
        },
      },
    }),
  );
}
