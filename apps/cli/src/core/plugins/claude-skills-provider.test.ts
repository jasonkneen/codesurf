import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeSkillsSystemPrompt,
  buildIsolatedClaudeOptions,
  createClaudeSkillsPlugin,
  rewriteSkillToolName,
  toCodesurfToolNameForClaudeSkills,
  toSdkModelIdForClaudeSkills,
  wrapClaudeSkillsSession,
} from "./builtin/claude-skills-provider";
import { __resetPluginsForTests, bootstrapPlugins, getRegistrySnapshot } from "./index";
import { claudeAgentProviderPlugin } from "./native/claude-agent-provider";
import { createNativePluginModule } from "./native/host";

let tempDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

function writeSkill(root: string, name: string, description = `${name} description`): string {
  const dir = path.join(root, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill body.\n`,
    "utf-8",
  );
  return dir;
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-claude-skills-provider-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  originalHome = process.env.HOME;
  process.env.CODESURF_CONFIG_DIR = path.join(tempDir, "config");
  process.env.HOME = path.join(tempDir, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

beforeEach(() => {
  __resetPluginsForTests();
  fs.rmSync(process.env.CODESURF_CONFIG_DIR as string, { recursive: true, force: true });
});

afterEach(() => {
  __resetPluginsForTests();
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("claude-skills provider", () => {
  it("folds the claude-skills isolated adapter into the claude-agent provider", async () => {
    // The skills-isolated adapter is no longer a standalone extension; it is
    // registered as a mode of the claude-agent provider (enabledByDefault), so
    // its synthetic models appear once that provider activates.
    await bootstrapPlugins([createNativePluginModule(claudeAgentProviderPlugin)]);
    const grokSkillsModels = getRegistrySnapshot().models.filter(
      (model) => model.adapterId === "anthropic.agent-sdk-claude-skills",
    );
    expect(grokSkillsModels.map((model) => model.id).sort()).toEqual([
      "claude-fable-5-1-claude-skills",
      "claude-fable-5-claude-skills",
      "claude-haiku-4-5-claude-skills",
      "claude-haiku-5-5-claude-skills",
      "claude-opus-4-6-claude-skills",
      "claude-opus-4-7-claude-skills",
      "claude-opus-4-8-claude-skills",
      "claude-opus-5-5-claude-skills",
      "claude-opus-5-claude-skills",
      "claude-sonnet-4-6-claude-skills",
      "claude-sonnet-5-5-claude-skills",
      "claude-sonnet-5-claude-skills",
    ]);
  });

  it("materializes a Claude plugin containing only supplied Claude skills", () => {
    const skillRoot = writeSkill(path.join(tempDir, "project-a"), "sample-skill", "Sample skill");
    const pluginDir = createClaudeSkillsPlugin(path.join(tempDir, "project-a"), [
      {
        name: "sample-skill",
        description: "Sample skill",
        rootDir: skillRoot,
        skillMdPath: path.join(skillRoot, "SKILL.md"),
        scope: "project",
      },
    ]);

    expect(fs.existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(fs.readFileSync(path.join(pluginDir, "skills", "sample-skill", "SKILL.md"), "utf-8")).toContain(
      "name: sample-skill",
    );
    expect(fs.existsSync(path.join(pluginDir, "commands"))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "agents"))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "hooks"))).toBe(false);
  });

  it("builds SDK options that enable only Bash while disabling MCP, settings, and agents", async () => {
    const project = path.join(tempDir, "project-b");
    fs.mkdirSync(project, { recursive: true });
    writeSkill(project, "claude-only", "Claude only skill");

    const options = buildIsolatedClaudeOptions({ cwd: project, modelId: "claude-sonnet-4-6-claude-skills" });

    expect(options.model).toBe("claude-sonnet-4-6");
    expect(options.cwd).toBe(project);
    expect(options.tools).toEqual(["Bash"]);
    expect(options.mcpServers).toEqual({});
    expect(options.agents).toEqual({});
    // The only hook is CodeSurf's MCP gate, which runs in every permission
    // mode (canUseTool is skipped under bypassPermissions).
    expect(Object.keys(options.hooks ?? {})).toEqual(["PreToolUse"]);
    const [matcher] = options.hooks?.PreToolUse ?? [];
    const [hook] = matcher?.hooks ?? [];
    const signal = new AbortController().signal;
    const denied = await hook!({ hook_event_name: "PreToolUse", tool_name: "mcp__gmail__send" } as never, "t1", {
      signal,
    });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await hook!({ hook_event_name: "PreToolUse", tool_name: "Bash" } as never, "t2", { signal })).toEqual({});
    // Nothing inline: the session installs its own canUseTool at start.
    expect(options.canUseTool).toBeUndefined();
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toBe("all");
    expect(options.plugins).toHaveLength(1);
    expect(options.plugins?.[0]?.type).toBe("local");
    expect(fs.existsSync(path.join(options.plugins?.[0]?.path ?? "", "skills", "claude-only", "SKILL.md"))).toBe(true);
  });

  it("defaults the isolated adapter's permission mode to prompting, since Bash is live", async () => {
    await bootstrapPlugins([createNativePluginModule(claudeAgentProviderPlugin)]);
    const setting = getRegistrySnapshot().settings.find(
      (s) => s.key === "anthropic.agent-sdk-claude-skills.permissionMode",
    );
    expect(setting?.default).toBe("default");
    expect(setting?.description).toContain("Bash");
  });

  it("maps public model/tool names before forwarding events", async () => {
    let forwardedModelId = "";
    let emittedToolName = "";
    const session = wrapClaudeSkillsSession({
      adapterId: "anthropic.agent-sdk-claude-skills",
      providerId: "anthropic",
      mode: "persistent",
      strategy: "singleton",
      sendTurn: async (input, controller) => {
        forwardedModelId = input.modelId;
        controller.emit({ type: "tool-call", id: "tc1", toolName: "Bash", args: { command: "pwd" } });
        return {};
      },
    });

    await session.sendTurn?.(
      {
        conversationId: "test-conv",
        providerId: "anthropic",
        adapterId: "anthropic.agent-sdk-claude-skills",
        modelId: "claude-haiku-4-5-claude-skills",
        prompt: "hello",
        messages: [],
      },
      {
        emit: (event) => {
          if (event.type === "tool-call") emittedToolName = event.toolName;
        },
      },
    );

    expect(forwardedModelId).toBe("claude-haiku-4-5");
    expect(emittedToolName).toBe("bash");
    expect(toSdkModelIdForClaudeSkills("claude-skills")).toBe("claude-sonnet-5-5");
    expect(toCodesurfToolNameForClaudeSkills("execute")).toBe("bash");
  });

  it("rewrites Skill tool calls to skill:<name> so chips show the actual skill", () => {
    expect(rewriteSkillToolName("Skill", { skill_name: "opentui" })).toBe("skill:opentui");
    expect(rewriteSkillToolName("Skill", { skill_name: "" })).toBe("skill");
    expect(rewriteSkillToolName("Skill", null)).toBe("skill");
    expect(rewriteSkillToolName("Skill", { other: "value" })).toBe("skill");
    expect(rewriteSkillToolName("Bash", { command: "pwd" })).toBe(null);
  });

  it("forwards Skill invocations through wrapClaudeSkillsSession with the rewritten name", async () => {
    let emittedToolName = "";
    const session = wrapClaudeSkillsSession({
      adapterId: "anthropic.agent-sdk-claude-skills",
      providerId: "anthropic",
      mode: "persistent",
      strategy: "singleton",
      sendTurn: async (_input, controller) => {
        controller.emit({ type: "tool-call", id: "tc1", toolName: "Skill", args: { skill_name: "ascii-art" } });
        return {};
      },
    });

    await session.sendTurn?.(
      {
        conversationId: "test-conv",
        providerId: "anthropic",
        adapterId: "anthropic.agent-sdk-claude-skills",
        modelId: "claude-haiku-4-5-claude-skills",
        prompt: "hello",
        messages: [],
      },
      {
        emit: (event) => {
          if (event.type === "tool-call") emittedToolName = event.toolName;
        },
      },
    );

    expect(emittedToolName).toBe("skill:ascii-art");
  });

  it("puts the isolated adapter constraints and Claude skill catalog into the system prompt", () => {
    const skillRoot = writeSkill(path.join(tempDir, "project-c"), "prompt-skill", "Prompt skill description");
    const prompt = buildClaudeSkillsSystemPrompt(path.join(tempDir, "project-c"), [
      {
        name: "prompt-skill",
        description: "Prompt skill description",
        rootDir: skillRoot,
        skillMdPath: path.join(skillRoot, "SKILL.md"),
        scope: "project",
      },
    ]);

    expect(prompt).toContain("The only enabled execution tool is shell execution");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("prompt-skill");
  });
});
