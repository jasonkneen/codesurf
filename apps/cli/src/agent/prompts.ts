import { getRegistrySnapshot } from "../core/plugins";
import { buildChatEntries } from "../storage/index";
import type { AgentMode, SessionInfo, TaskRequest } from "../types/index";
import { loadCustomInstructions } from "../utils/instructions";
import {
  type CustomSubagentConfig,
  loadValidSubAgents,
  type SandboxMode,
  type SandboxSettings,
} from "../utils/settings";
import { formatEntriesForRecap, truncate } from "./agent-helpers";
import { MODE_PROMPTS } from "./mode-prompts";

export function findCustomSubagent(
  agent: string,
  subagents: CustomSubagentConfig[] = loadValidSubAgents(),
): CustomSubagentConfig | undefined {
  return (
    subagents.find((item) => item.name === agent) ??
    subagents.find((item) => item.name.toLowerCase() === agent.toLowerCase())
  );
}

export function formatCustomSubagentsPromptSection(subagents: CustomSubagentConfig[]): string {
  if (subagents.length === 0) return "";

  const lines = subagents.map((agent) => {
    const instruction = agent.instruction.trim() || "(none)";
    return `### ${agent.name}\n- model: ${agent.model}\n- instruction:\n${instruction}`;
  });

  return `\n\nCUSTOM SUB-AGENTS:\nUser-defined foreground sub-agents from ~/.codesurf/user-settings.json. When one matches the task, call the task tool with agent set to the exact name.\n\n${lines.join("\n\n")}\n`;
}

/**
 * Assemble the system prompt, ordered STABLE -> VOLATILE.
 *
 * Prompt caching is prefix-based, so section order is load-bearing, not
 * cosmetic. Anything that can change between turns must sit AFTER everything
 * that cannot, or a change to it re-prefills the whole tail.
 *
 * Stable for the life of a session:
 *   mode prompt, sandbox, CLAUDE.md custom instructions, subagent roster,
 *   follow-up protocol, cwd
 * Volatile (may grow/change per turn):
 *   progressively-disclosed skills, approved plan
 *
 * `skillsSection` is supplied by the caller from a `ProgressiveSkillContext`
 * so it can only ever GROW within a session — see src/utils/skill-context.ts
 * for why growth is cache-safe and removal is not.
 *
 * `learningNotes` is passed in rather than read here: it is rewritten at the
 * END of every turn by TraceCollector.finish() -> maybeRefreshLearningArtifacts,
 * so reading it inline made the prompt mutate between turn 1 and turn 2 and
 * silently destroyed caching. The Agent snapshots it once per session instead.
 */
export function buildSystemPrompt(
  cwd: string,
  mode: AgentMode,
  sandboxMode: SandboxMode,
  planContext?: string | null,
  subagents?: CustomSubagentConfig[],
  sandboxSettings?: SandboxSettings,
  skillsSection?: string | null,
  learningNotes?: string | null,
  customInstructions?: string | null,
): string {
  // Both of these live in the STABLE prefix, so they must not change between
  // turns of one session. `loadCustomInstructions` reads AGENTS.md/CLAUDE.md and
  // the roster reads user settings — each is editable while the session runs,
  // and a mid-session change rewrites the middle of the cached prefix, which
  // re-prefills everything after it (the exact failure 2e1f74f fixed for
  // learning notes). Callers pass session-stable snapshots; the inline reads
  // below are the fallback for non-session callers (estimates, compaction).
  const custom = customInstructions === undefined ? loadCustomInstructions(cwd) : customInstructions;
  const customSection = custom
    ? `\n\nCUSTOM INSTRUCTIONS:\n${custom}\n\nFollow the above alongside standard instructions.\n`
    : "";

  const learningSection = learningNotes ? `\n\nLOCAL LEARNING NOTES:\n${learningNotes}\n` : "";
  // Plugin-contributed guidance. Registering a tool tells the model the tool
  // exists; it does not tell the model a plugin is installed, or when to prefer
  // its tool over a built-in one the model already knows well. Sections are
  // sorted deterministically by the registry so this text is byte-stable across
  // turns and does not re-prefill the cached prefix.
  const pluginSections = getRegistrySnapshot()
    .promptSections.map((section) => `\n\n${section.title.toUpperCase()}:\n${section.body}\n`)
    .join("");
  const subagentsSection = formatCustomSubagentsPromptSection(subagents ?? loadValidSubAgents());
  const sandboxSection = formatSandboxPromptSection(sandboxMode, sandboxSettings);

  const planSection = planContext
    ? `\n\nAPPROVED PLAN:\nThe following plan has been approved by the user. Execute it now.\n${planContext}\n`
    : "";
  const followupSuggestionsSection = `\n\nFOLLOW-UP SUGGESTIONS:\nAt the very end of each final assistant answer, include one hidden HTML comment in this exact form:\n<!-- codesurf-followups: ["specific next prompt", "specific next prompt"] -->\nProvide 0-4 concise suggestions that are specific to your answer and useful as direct next user prompts. Use [] when no useful follow-up exists. Do not mention this marker in visible text.\n`;

  // ── stable prefix ──────────────────────────────────────────────────────────
  const stable = `${MODE_PROMPTS[mode]}${sandboxSection}${customSection}${learningSection}${pluginSections}${subagentsSection}${followupSuggestionsSection}

Current working directory: ${cwd}`;

  // ── volatile suffix ────────────────────────────────────────────────────────
  const volatileSuffix = `${skillsSection ? `\n\n${skillsSection}\n` : ""}${planSection}`;

  return `${stable}${volatileSuffix}`;
}

export function buildSubagentPrompt(
  request: TaskRequest,
  cwd: string,
  custom: CustomSubagentConfig | null,
  sandboxMode: SandboxMode,
  subagents?: CustomSubagentConfig[],
  sandboxSettings?: SandboxSettings,
  skillsSection?: string | null,
): string {
  const isExplore = request.agent === "explore";
  const isVision = request.agent === "vision";
  const isVerify = request.agent === "verify";
  const isVerifyDetect = request.agent === "verify-detect";
  const isVerifyManifest = request.agent === "verify-manifest";
  const isComputer = request.agent === "computer";
  const mode: AgentMode = isExplore || isVerifyDetect ? "ask" : "agent";
  const role = custom
    ? `You are the custom sub-agent "${custom.name}". You can investigate, edit files, and run commands unless the delegated task says otherwise.`
    : request.agent === "explore"
      ? "You are the Explore sub-agent. You are read-only and focus on fast codebase research."
      : isVision
        ? "You are the Vision sub-agent."
        : isVerifyDetect
          ? "You are the Verify Detect sub-agent. You inspect a repository to produce a structured verification recipe. You are read-only."
          : isVerifyManifest
            ? "You are the Verify Manifest sub-agent. You inspect a repository and create or update .grok/environment.json so verification can run reproducibly."
            : isVerify
              ? "You are the Verify sub-agent. You specialize in sandbox-aware local verification using builds, tests, app boot checks, and optional browser smoke tests."
              : isComputer
                ? "You are the Computer sub-agent. You specialize in host desktop automation using accessibility snapshots, semantic element refs, screenshots, and careful mouse and keyboard actions."
                : "You are the General sub-agent. You can investigate, edit files, and run commands to complete delegated work.";

  const rules = isExplore
    ? [
        "Do not create, modify, or delete files.",
        "Prefer `read_file` and search commands over broad shell exploration.",
        "Return concise findings for the parent agent.",
      ]
    : isVerifyDetect
      ? [
          "Do not create, modify, or delete files.",
          "Read config files, package manifests, scripts, and source layout to understand the project.",
          "Return ONLY a valid JSON object with the VerifyRecipe schema. No markdown, no prose, no explanation outside the JSON.",
        ]
      : isVerifyManifest
        ? [
            "Focus on creating or updating .grok/environment.json as the primary verification contract for this repository.",
            "Read package.json and key config files to understand the project, then write .grok/environment.json.",
            "Prefer editing only .grok/environment.json unless the delegated task explicitly requires something else.",
            "",
            "SANDBOX ENVIRONMENT (Shuru):",
            "- OS: Debian GNU/Linux 13 (trixie)",
            "- Architecture: aarch64 (ARM64)",
            "- Pre-installed: NOTHING. No node, npm, npx, bun, python3, pip, go, cargo, java, or any runtime.",
            "- Only basic system tools exist (sh, apt-get, curl, etc).",
            "- Network access is available during bootstrap and install.",
            "- The workspace is mounted at /workspace.",
            "",
            "MANIFEST REQUIREMENTS:",
            "- bootstrapCommands: MUST install every runtime and build tool the project needs from scratch via apt-get or curl.",
            "- For Node.js/Next.js/Vite/etc: `apt-get update && apt-get install -y curl unzip ca-certificates git python3 make g++ pkg-config nodejs npm`",
            "- For Bun projects: also `curl -fsSL https://bun.sh/install | bash` and shellInitCommands with BUN_INSTALL/PATH exports.",
            "- For Python: `apt-get update && apt-get install -y python3 python3-pip python3-venv ca-certificates git`",
            "- For Go: `apt-get update && apt-get install -y golang ca-certificates git`",
            "- For Rust: `apt-get update && apt-get install -y curl ca-certificates git build-essential && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`",
            "- installCommands: The package install command (npm install, pip install, etc).",
            "- buildCommands: Build commands if applicable.",
            "- testCommands: Test/lint commands if applicable.",
            "- startCommand + startPort: How to start the app for smoke testing.",
            "- smokeKind: 'http' if the app has a web UI, 'cli' for CLI tools, 'none' otherwise.",
            "- Do NOT leave bootstrapCommands empty. The sandbox has nothing.",
            "",
            "Return a concise summary of what you wrote and why.",
          ]
        : isVision
          ? ["Validate the image."]
          : isComputer
            ? [
                "Operate carefully on the HOST desktop, not inside the shell sandbox.",
                "Start with `computer_snapshot` when possible. It returns stable refs like @e1 that remain valid until the next snapshot.",
                "Prefer accessibility refs over coordinates. Use `computer_click`, `computer_type`, `computer_scroll`, and `computer_get` with refs from the latest snapshot.",
                "After any meaningful UI transition, launch, dialog open, or menu change, take another `computer_snapshot` before reusing old refs.",
                "Use `computer_launch`, `computer_list_windows`, `computer_focus_window`, and `computer_wait` to manage apps and window state.",
                "Use `computer_press` for shortcuts like Enter or cmd+k. Use `computer_screenshot` only for visual confirmation or when the accessibility tree is insufficient.",
                "If `agent-desktop` is unavailable, permissions are missing, refs go stale, or the state is ambiguous, stop and return the blocker clearly to the parent agent.",
                "Do not perform destructive or high-risk desktop actions unless the delegated task explicitly requires them.",
              ]
            : isVerify
              ? [
                  "You are a QA engineer. Your job is to prove the app works end-to-end, not just that it builds.",
                  "Do not make durable source edits unless the delegated task explicitly asks for fixes.",
                  "",
                  "MANDATORY VERIFICATION STEPS (do ALL of these in order):",
                  "1. Install dependencies (run installCommands from the recipe).",
                  "2. Build the project (run buildCommands from the recipe).",
                  "3. Run tests/lint if available (run testCommands from the recipe).",
                  "4. Start the app (run startCommand from the recipe in the background).",
                  "5. Wait for the app to be ready (curl readiness check or agent-browser wait).",
                  "6. Run browser smoke tests like a real human QA tester:",
                  "   - Open the app in the browser, record a video, take screenshots.",
                  "   - Navigate the app: click links, buttons, menus. Verify pages load.",
                  "   - Check for JavaScript console errors.",
                  "   - Spend 3-5 interactions testing the critical path.",
                  "7. Stop recording, close browser, then stop the dev server.",
                  "",
                  "Do NOT stop after build/lint. Starting the app and testing it in the browser is the most important part.",
                  "agent-browser commands run on the HOST, not inside the sandbox. They WILL work. Do not skip them.",
                  "Return a concise verification report. Keep it compact but always include Evidence with artifact file paths.",
                ]
              : [
                  "Work only on the delegated task below.",
                  "Use tools directly instead of narrating your intent.",
                  "Return a concise summary for the parent agent with key outcomes and any open risks.",
                ];

  const instructionLines = custom?.instruction.trim() ? ["", "SUB-AGENT INSTRUCTIONS:", custom.instruction.trim()] : [];

  return [
    role,
    ...instructionLines,
    "",
    "You are helping a parent agent. Do not address the end user directly.",
    "Focus tightly on the delegated scope and summarize what matters back to the parent agent.",
    "",
    ...rules,
    "",
    `Delegated task: ${request.description}`,
    "",
    buildSystemPrompt(cwd, mode, sandboxMode, undefined, subagents, sandboxSettings, skillsSection),
  ].join("\n");
}

export function formatSandboxPromptSection(sandboxMode: SandboxMode, settings?: SandboxSettings): string {
  if (sandboxMode === "off") return "";

  const s = settings ?? {};
  let networkLine: string;
  if (s.allowNet) {
    networkLine = s.allowedHosts?.length
      ? `- Network access is restricted to: ${s.allowedHosts.join(", ")}.`
      : "- Network access is enabled.";
  } else {
    networkLine = "- Network is disabled.";
  }

  const lines = [
    "",
    "SANDBOX MODE:",
    "- Bash commands run inside a Shuru sandbox.",
    networkLine,
    "- The current workspace is mounted inside the sandbox at `/workspace`.",
    "- Shell-side workspace file changes do not persist back to the host in this version.",
    "- Use `read_file`, `edit_file`, and `write_file` for durable source edits.",
    "- If a task needs a host-persistent shell mutation, explain that sandbox mode blocks that workflow and ask whether to disable sandbox mode.",
  ];

  if (s.ports?.length) {
    lines.push(`- Port forwards: ${s.ports.join(", ")}.`);
  }
  if (s.from) {
    lines.push(`- Starting from checkpoint: ${s.from}.`);
  }

  return lines.join("\n");
}

/** Build the recap-refresh prompt for a session transcript. */
export function buildRecapPrompt(session: SessionInfo): string | null {
  const transcript = formatEntriesForRecap(buildChatEntries(session.id), 5_000);
  if (!transcript) {
    return null;
  }
  const sections = [
    "Refresh the saved recap for this coding session using the latest transcript.",
    session.recap?.text ? `Existing recap:\n${truncate(session.recap.text, 1_200)}` : "Existing recap:\n(none)",
    `Session transcript:\n${transcript}`,
  ];
  return sections.join("\n\n");
}
