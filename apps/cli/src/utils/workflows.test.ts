// Tests for user workflow discovery (.claude/workflows/*.md). Uses real tmp
// dirs with an injected userRoot so nothing depends on the machine's actual
// ~/.claude contents.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverUserCommands,
  discoverUserPromptCommands,
  discoverUserWorkflows,
  discoverWorkflowScripts,
  expandPromptArguments,
  extractWorkflowMeta,
  parseWorkflowFile,
} from "./workflows";

let tmp: string;
let userRoot: string;
let projectRoot: string;

function write(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflows-test-"));
  userRoot = path.join(tmp, "user-claude", "workflows");
  projectRoot = path.join(tmp, "project");
  // Make projectRoot a git root so the parent-dir walk stops inside tmp.
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("parseWorkflowFile", () => {
  it("returns whole content as body when there is no frontmatter", () => {
    const parsed = parseWorkflowFile("Do the thing.\nThen verify.");
    expect(parsed.body).toBe("Do the thing.\nThen verify.");
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
  });

  it("extracts name/description frontmatter and strips it from the body", () => {
    const parsed = parseWorkflowFile(
      ["---", 'name: "Escalate"', "description: Chain of escalation", "---", "", "Step 1."].join("\n"),
    );
    expect(parsed.name).toBe("Escalate");
    expect(parsed.description).toBe("Chain of escalation");
    expect(parsed.body).toBe("Step 1.");
  });

  it("treats an unterminated frontmatter block as plain body", () => {
    const content = "---\nname: broken\nStep 1.";
    expect(parseWorkflowFile(content).body).toBe(content);
  });
});

describe("discoverUserWorkflows", () => {
  it("returns empty results when no workflow dirs exist", () => {
    const res = discoverUserWorkflows(projectRoot, { userRoot });
    expect(res.workflows).toEqual([]);
    expect(res.unsupported).toEqual([]);
  });

  it("discovers user-level .md workflows with slug from filename", () => {
    write(userRoot, "ai_autonomous_dev_system.md", "Run the autonomous dev system.");
    const res = discoverUserWorkflows(projectRoot, { userRoot });
    expect(res.workflows).toHaveLength(1);
    expect(res.workflows[0]).toMatchObject({
      slug: "ai_autonomous_dev_system",
      name: "ai_autonomous_dev_system",
      scope: "user",
      prompt: "Run the autonomous dev system.",
    });
  });

  it("lists non-md files as unsupported instead of loading them", () => {
    write(userRoot, "escalation-chain.js", "export const meta = {}");
    write(userRoot, "good.md", "Body.");
    const res = discoverUserWorkflows(projectRoot, { userRoot });
    expect(res.workflows.map((w) => w.slug)).toEqual(["good"]);
    expect(res.unsupported).toHaveLength(1);
    expect(res.unsupported[0]).toContain("escalation-chain.js");
  });

  it("project workflows override user workflows with the same slug", () => {
    write(userRoot, "deploy.md", "User-level deploy.");
    write(path.join(projectRoot, ".claude", "workflows"), "deploy.md", "Project deploy.");
    const res = discoverUserWorkflows(projectRoot, { userRoot });
    expect(res.workflows).toHaveLength(1);
    expect(res.workflows[0].scope).toBe("project");
    expect(res.workflows[0].prompt).toBe("Project deploy.");
  });

  it("skips empty-bodied and dot-prefixed files", () => {
    write(userRoot, "empty.md", "---\nname: x\n---\n");
    write(userRoot, ".hidden.md", "Hidden.");
    const res = discoverUserWorkflows(projectRoot, { userRoot });
    expect(res.workflows).toEqual([]);
  });

  it("walks parent directories up to the git root", () => {
    const nested = path.join(projectRoot, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    write(path.join(projectRoot, ".claude", "workflows"), "root-flow.md", "Root flow.");
    const res = discoverUserWorkflows(nested, { userRoot });
    expect(res.workflows.map((w) => w.slug)).toEqual(["root-flow"]);
  });
});

describe("expandPromptArguments", () => {
  it("substitutes $ARGUMENTS with the full args string", () => {
    const { text, used } = expandPromptArguments("Review PR $ARGUMENTS now.", "123 urgent");
    expect(text).toBe("Review PR 123 urgent now.");
    expect(used).toBe(true);
  });

  it("substitutes positional $1..$9 from whitespace-split tokens", () => {
    const { text, used } = expandPromptArguments("pr=$1 reviewer=$2 missing=$3", "42 alice");
    expect(text).toBe("pr=42 reviewer=alice missing=");
    expect(used).toBe(true);
  });

  it("reports used=false when no placeholder is present", () => {
    const { text, used } = expandPromptArguments("No placeholders here.", "ignored");
    expect(text).toBe("No placeholders here.");
    expect(used).toBe(false);
  });
});

describe("parseWorkflowFile argument-hint", () => {
  it("extracts argument-hint frontmatter", () => {
    const parsed = parseWorkflowFile("---\nname: x\nargument-hint: <pr-number>\n---\nBody $1");
    expect(parsed.argumentHint).toBe("<pr-number>");
    expect(parsed.body).toBe("Body $1");
  });
});

describe("discoverUserCommands", () => {
  it("discovers .md files under .claude/commands and carries argument-hint", () => {
    const commandsUserRoot = path.join(tmp, "user-claude", "commands");
    write(
      commandsUserRoot,
      "escalation-chain.md",
      "---\ndescription: Escalate\nargument-hint: <sev>\n---\nEscalate $1.",
    );
    const res = discoverUserCommands(projectRoot, { userRoot: commandsUserRoot });
    expect(res.workflows.map((w) => w.slug)).toContain("escalation-chain");
    const wf = res.workflows.find((w) => w.slug === "escalation-chain");
    expect(wf?.argumentHint).toBe("<sev>");
    expect(wf?.description).toBe("Escalate");
  });
});

describe("discoverUserPromptCommands", () => {
  it("merges project commands/ and workflows/ with commands/ winning on slug collision", () => {
    // Project dirs are walked by the merged fn and are fully controllable here
    // (user roots default to ~/.claude and won't carry these unique slugs).
    write(path.join(projectRoot, ".claude", "workflows"), "zzdup-xyz.md", "From workflows.");
    write(path.join(projectRoot, ".claude", "commands"), "zzdup-xyz.md", "From commands.");
    write(path.join(projectRoot, ".claude", "workflows"), "zzonly-wf.md", "Workflow only.");
    const res = discoverUserPromptCommands(projectRoot);
    expect(res.workflows.find((w) => w.slug === "zzdup-xyz")?.prompt).toBe("From commands.");
    expect(res.workflows.find((w) => w.slug === "zzonly-wf")?.prompt).toBe("Workflow only.");
  });
});

describe("extractWorkflowMeta", () => {
  it("evaluates the meta object literal with nested arrays and braced strings", () => {
    const src = [
      "export const meta = {",
      '  name: "esc",',
      '  description: "d",',
      '  phases: [{ title: "Plan", model: "m1" }, { title: "Run }brace", model: "m2" }],',
      "}",
      "const x = 1",
      "return x",
    ].join("\n");
    const meta = extractWorkflowMeta(src);
    expect(meta?.name).toBe("esc");
    expect(Array.isArray(meta?.phases)).toBe(true);
    expect((meta?.phases as unknown[]).length).toBe(2);
  });

  it("returns null when there is no meta export", () => {
    expect(extractWorkflowMeta("const x = 1\nreturn x")).toBeNull();
  });
});

describe("discoverWorkflowScripts", () => {
  it("discovers .js scripts and parses meta name/description/phases", () => {
    write(
      userRoot,
      "escalation.js",
      [
        "export const meta = {",
        '  name: "escalation",',
        '  description: "cost-tiered chain",',
        '  phases: [{ title: "Plan", model: "m1" }, { title: "Exec", model: "m2" }],',
        "}",
        "return { ok: true }",
      ].join("\n"),
    );
    const { scripts } = discoverWorkflowScripts(projectRoot, { userRoot });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.slug).toBe("escalation");
    expect(scripts[0]!.name).toBe("escalation");
    expect(scripts[0]!.phases?.map((p) => p.model)).toEqual(["m1", "m2"]);
    expect(scripts[0]!.source).toContain("return { ok: true }");
  });

  it("does not read or evaluate project scripts in an untrusted workspace", () => {
    const g = globalThis as { __codesurfWorkflowMetaRan?: boolean };
    delete g.__codesurfWorkflowMetaRan;
    const projectDir = path.join(projectRoot, ".claude", "commands");
    write(
      projectDir,
      "evil.js",
      'export const meta = { name: (globalThis.__codesurfWorkflowMetaRan = true, "evil") }\nreturn 1',
    );

    const untrustedResult = discoverWorkflowScripts(projectRoot, { userRoot, projectTrusted: false });
    expect(g.__codesurfWorkflowMetaRan).toBeUndefined();
    expect(untrustedResult.scripts.find((s) => s.slug === "evil")).toBeUndefined();
    expect(untrustedResult.untrusted).toEqual([path.resolve(projectDir, "evil.js")]);

    // The same file loads (and its meta is evaluated) once the workspace is trusted.
    const trustedResult = discoverWorkflowScripts(projectRoot, { userRoot, projectTrusted: true });
    expect(trustedResult.scripts.find((s) => s.slug === "evil")?.scope).toBe("project");
    expect(g.__codesurfWorkflowMetaRan).toBe(true);
    delete g.__codesurfWorkflowMetaRan;
  });

  it("treats a workspace without a trust decision as untrusted", () => {
    const prev = process.env.CODESURF_TRUST_WORKSPACE;
    delete process.env.CODESURF_TRUST_WORKSPACE;
    try {
      write(path.join(projectRoot, ".claude", "workflows"), "p.js", "return 1");
      const result = discoverWorkflowScripts(projectRoot, { userRoot });
      expect(result.scripts.find((s) => s.slug === "p")).toBeUndefined();
      expect(result.untrusted).toHaveLength(1);
    } finally {
      if (prev !== undefined) process.env.CODESURF_TRUST_WORKSPACE = prev;
    }
  });

  it("lets a user script win over a project script with the same slug", () => {
    write(userRoot, "deploy.js", "return 'user'");
    const projectDir = path.join(projectRoot, ".claude", "workflows");
    write(projectDir, "deploy.js", "return 'project'");

    const { scripts, shadowed } = discoverWorkflowScripts(projectRoot, { userRoot, projectTrusted: true });
    const deploy = scripts.find((s) => s.slug === "deploy");
    expect(deploy?.scope).toBe("user");
    expect(deploy?.source).toContain("'user'");
    expect(shadowed).toEqual([path.resolve(projectDir, "deploy.js")]);
  });

  it("falls back to the slug when a script has no meta", () => {
    write(userRoot, "bare.js", "return 1");
    const { scripts } = discoverWorkflowScripts(projectRoot, { userRoot });
    const bare = scripts.find((s) => s.slug === "bare");
    expect(bare?.name).toBe("bare");
    expect(bare?.phases).toBeUndefined();
  });
});
