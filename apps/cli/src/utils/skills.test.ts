import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DiscoveredSkill, discoverSkills, formatSkillsForChat, parseSkillsCommandArgs } from "./skills";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverSkills", () => {
  it("discovers project skills from parent directories up to the git root", () => {
    const repoRoot = makeTempDir("claude-skills-root-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const nested = path.join(repoRoot, "tmp", "app");
    fs.mkdirSync(nested, { recursive: true });

    writeSkill(repoRoot, "agent-browser", "Host browser smoke testing");

    const skills = discoverSkills(nested);
    expect(skills.map((skill) => skill.name)).toContain("agent-browser");
    expect(skills.find((skill) => skill.name === "agent-browser")?.scope).toBe("project");
  });

  it("lets nearer project skills override parent project skills", () => {
    const repoRoot = makeTempDir("claude-skills-override-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const nested = path.join(repoRoot, "tmp", "app");
    fs.mkdirSync(nested, { recursive: true });

    writeSkill(repoRoot, "agent-browser", "Root browser skill");
    writeSkill(path.join(repoRoot, "tmp"), "agent-browser", "Nested browser skill");

    const skills = discoverSkills(nested);
    expect(skills.find((skill) => skill.name === "agent-browser")?.description).toBe("Nested browser skill");
  });
});

describe("parseSkillsCommandArgs", () => {
  it("returns defaults for empty input", () => {
    expect(parseSkillsCommandArgs("")).toEqual({ showPaths: false, filter: "" });
    expect(parseSkillsCommandArgs("   ")).toEqual({ showPaths: false, filter: "" });
  });

  it("treats a leading 'paths' token as a flag", () => {
    expect(parseSkillsCommandArgs("paths")).toEqual({ showPaths: true, filter: "" });
    expect(parseSkillsCommandArgs("  paths  ")).toEqual({ showPaths: true, filter: "" });
  });

  it("treats remaining tokens as a substring filter", () => {
    expect(parseSkillsCommandArgs("paseo")).toEqual({ showPaths: false, filter: "paseo" });
    expect(parseSkillsCommandArgs("foo bar")).toEqual({ showPaths: false, filter: "foo bar" });
  });

  it("combines paths flag and filter", () => {
    expect(parseSkillsCommandArgs("paths paseo")).toEqual({ showPaths: true, filter: "paseo" });
  });

  it("only treats 'paths' as the flag when it is the first token", () => {
    // A skill literally named "paths" can still be filtered.
    expect(parseSkillsCommandArgs("foo paths")).toEqual({ showPaths: false, filter: "foo paths" });
  });
});

describe("formatSkillsForChat", () => {
  function skill(name: string, description: string, scope: "project" | "user" = "user"): DiscoveredSkill {
    return {
      name,
      description,
      skillMdPath: path.join(os.homedir(), ".agents", "skills", name, "SKILL.md"),
      rootDir: path.join(os.homedir(), ".agents", "skills", name),
      scope,
    };
  }

  it("shows a help message when there are no skills", () => {
    const out = formatSkillsForChat([], "/some/project");
    expect(out).toContain("No Agent Skills found.");
    expect(out).toContain(".agents/skills");
  });

  it("renders a one-line-per-skill compact listing without paths by default", () => {
    const skills = [
      skill("paseo-chat", "Use chat rooms through the Paseo CLI"),
      skill("update-heartbeat", "Update the project heartbeat", "project"),
    ];
    const out = formatSkillsForChat(skills, "/p", { terminalWidth: 100 });
    expect(out).toContain("paseo-chat");
    expect(out).toContain("update-heartbeat");
    expect(out).toContain("user");
    expect(out).toContain("project");
    // Path must NOT appear by default.
    expect(out).not.toContain("SKILL.md");
  });

  it("includes the path line under each skill when showPaths is true", () => {
    const skills = [skill("paseo-chat", "Chat rooms")];
    const out = formatSkillsForChat(skills, "/p", { terminalWidth: 100, showPaths: true });
    expect(out).toContain("paseo-chat");
    expect(out).toContain("SKILL.md");
    // Path is printed in tilde-relative form for the user's home.
    expect(out).toContain("~/.agents/skills/paseo-chat/SKILL.md");
  });

  it("auto-sizes the name column to the longest skill name (no 30-char cap)", () => {
    const longName = "vercel-react-best-practices";
    const skills = [skill(longName, "Long description")];
    const out = formatSkillsForChat(skills, "/p", { terminalWidth: 200 });
    // Longest name appears verbatim (not clipped to 29 chars + "…").
    expect(out).toContain(longName);
    expect(out).not.toContain(`${longName.slice(0, 29)}…`);
  });

  it("truncates descriptions to the terminal width (with an ellipsis)", () => {
    const longDesc = "A".repeat(500);
    const skills = [skill("x", longDesc)];
    const out = formatSkillsForChat(skills, "/p", { terminalWidth: 60 });
    const longestLine = Math.max(...out.split("\n").map((l) => l.length));
    expect(longestLine).toBeLessThanOrEqual(60);
    expect(out).toContain("…");
  });

  it("does not truncate descriptions that fit within the terminal width", () => {
    const desc = "Short and sweet.";
    const skills = [skill("x", desc)];
    const out = formatSkillsForChat(skills, "/p", { terminalWidth: 200 });
    expect(out).toContain(desc);
    expect(out).not.toContain("…");
  });

  it("filters skills by case-insensitive substring on name or description", () => {
    const skills = [
      skill("paseo-chat", "Chat rooms"),
      skill("update-heartbeat", "Update heartbeat", "project"),
      skill("webtest", "Test web apps using PASEO infra"),
    ];
    const out = formatSkillsForChat(skills, "/p", { terminalWidth: 200, filter: "PASEO" });
    expect(out).toContain("paseo-chat");
    expect(out).toContain("webtest"); // matches via description
    expect(out).not.toContain("update-heartbeat");
    expect(out).toContain('filter: "PASEO"');
  });

  it("returns a clear message when the filter matches nothing", () => {
    const skills = [skill("paseo-chat", "Chat rooms")];
    const out = formatSkillsForChat(skills, "/p", { terminalWidth: 100, filter: "zzznomatch" });
    expect(out).toContain("No skills match");
    expect(out).toContain("zzznomatch");
  });
});
