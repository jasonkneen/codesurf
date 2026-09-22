import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeDatabase } from "../../storage/db";
import { SessionStore } from "../../storage/sessions";
import { recordTrace } from "../../storage/traces";
import { discoverSkills } from "../../utils/skills";
import { attributeSkills, mineFewShot, optimizeSkillsFromTraces } from "./skill-optimizer";
import { loadSkillOverlays } from "./skill-overlay";

// Bun-native (the integration test + module import touch bun:sqlite storage).

describe("attributeSkills", () => {
  const skills = [{ name: "demo", skillMdPath: "/abs/.agents/skills/demo/SKILL.md" }];

  it("attributes a trace that read the skill's SKILL.md", () => {
    const steps = [
      { toolName: "grep", input: { pattern: "x" } },
      { toolName: "read_file", input: { path: "/abs/.agents/skills/demo/SKILL.md" } },
    ];
    expect(attributeSkills(steps, skills)).toEqual(["demo"]);
  });

  it("ignores reads of unrelated files and non-read tools", () => {
    expect(attributeSkills([{ toolName: "read_file", input: { path: "/abs/foo.ts" } }], skills)).toEqual([]);
    expect(attributeSkills([{ toolName: "edit_file", input: { path: skills[0].skillMdPath } }], skills)).toEqual([]);
  });

  describe("path boundaries and execution cwd (A14)", () => {
    const two = [
      { name: "demo", skillMdPath: "/abs/.agents/skills/demo/SKILL.md" },
      { name: "other", skillMdPath: "/abs/.agents/skills/other/SKILL.md" },
    ];
    const bareRead = [{ toolName: "read_file", input: { path: "SKILL.md" } }];

    it("attributes a bare SKILL.md read only to the skill whose directory was the cwd", () => {
      expect(attributeSkills(bareRead, two, { cwd: "/abs/.agents/skills/demo" })).toEqual(["demo"]);
      expect(attributeSkills(bareRead, two, { cwd: "/abs" })).toEqual([]);
    });

    it("does not guess when a relative read has no cwd", () => {
      expect(attributeSkills(bareRead, two)).toEqual([]);
      expect(attributeSkills(bareRead, two, { cwd: null })).toEqual([]);
    });

    it("resolves relative reads against the cwd and normalizes the result", () => {
      const relative = [{ toolName: "read_file", input: { path: ".agents/skills/demo/SKILL.md" } }];
      expect(attributeSkills(relative, two, { cwd: "/abs" })).toEqual(["demo"]);
      expect(attributeSkills(relative, two, { cwd: "/elsewhere" })).toEqual([]);
      const dotted = [{ toolName: "read_file", input: { path: "/abs/.agents/skills/other/../demo/SKILL.md" } }];
      expect(attributeSkills(dotted, two)).toEqual(["demo"]);
    });

    it("prefers the cwd the step itself recorded over the trace's cwd", () => {
      // A `cd` partway through a turn moves the session cwd, so the trace-level
      // cwd is not what an earlier read resolved against. The collector now
      // stamps each tool step with the directory it started in; attribution
      // must use that in preference.
      const steps = [
        { toolName: "read_file", input: { path: "SKILL.md" }, metadata: { cwd: "/abs/.agents/skills/demo" } },
      ];
      // Trace cwd says the model ended up somewhere else entirely.
      expect(attributeSkills(steps, two, { cwd: "/abs/.agents/skills/other" })).toEqual(["demo"]);
      // And with no trace cwd at all, the step's own cwd still resolves it.
      expect(attributeSkills(steps, two)).toEqual(["demo"]);
    });

    it("falls back to the trace cwd for steps recorded before per-step cwd existed", () => {
      const legacy = [{ toolName: "read_file", input: { path: "SKILL.md" }, metadata: null }];
      expect(attributeSkills(legacy, two, { cwd: "/abs/.agents/skills/other" })).toEqual(["other"]);
      // A non-string cwd in metadata is ignored rather than trusted.
      const bogus = [{ toolName: "read_file", input: { path: "SKILL.md" }, metadata: { cwd: 42 } }];
      expect(attributeSkills(bogus, two, { cwd: "/abs/.agents/skills/demo" })).toEqual(["demo"]);
    });

    it("never matches by suffix: a same-named skill elsewhere stays isolated", () => {
      const foreign = [{ toolName: "read_file", input: { path: "/other-project/.agents/skills/demo/SKILL.md" } }];
      expect(attributeSkills(foreign, two)).toEqual([]);
      const partial = [{ toolName: "read_file", input: { path: "skills/demo/SKILL.md" } }];
      expect(attributeSkills(partial, two, { cwd: "/abs" })).toEqual([]);
    });

    it("ignores failed reads", () => {
      const failed = [{ toolName: "read_file", input: { path: two[0].skillMdPath }, success: false }];
      expect(attributeSkills(failed, two)).toEqual([]);
      const ok = [{ toolName: "read_file", input: { path: two[0].skillMdPath }, success: true }];
      expect(attributeSkills(ok, two)).toEqual(["demo"]);
    });
  });
});

describe("same-named skills in two projects (A14 integration)", () => {
  const originalCodesurfHome = process.env.CODESURF_HOME;
  let home = "";
  let projectA = "";
  let projectB = "";

  function writeSkill(project: string): string {
    const dir = path.join(project, ".agents", "skills", "demo");
    fs.mkdirSync(dir, { recursive: true });
    const skillMd = path.join(dir, "SKILL.md");
    fs.writeFileSync(skillMd, "---\nname: demo\ndescription: A demo skill for tests\n---\nBody.\n", "utf-8");
    return skillMd;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-overlay-home-"));
    projectA = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-overlay-a-"));
    projectB = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-overlay-b-"));
    process.env.CODESURF_HOME = home;
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    for (const dir of [home, projectA, projectB]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps overlays for same-named skills isolated by source, including failed and bare reads", () => {
    const skillA = writeSkill(projectA);
    const skillB = writeSkill(projectB);
    const sessionA = new SessionStore(projectA).createSession("m", "agent", projectA).id;
    const sessionB = new SessionStore(projectB).createSession("m", "agent", projectB).id;

    const trace = (traceId: string, sessionId: string, query: string, readPath: string, success = true): void => {
      recordTrace({
        traceId,
        sessionId,
        query,
        model: "m",
        result: `done: ${query}`,
        feedback: 0.9,
        outcome: "success",
        steps: [{ stepIndex: 0, stepType: "tool_call", toolName: "read_file", input: { path: readPath }, success }],
      });
    };
    trace("a1", sessionA, "A relative read", ".agents/skills/demo/SKILL.md");
    trace("a2", sessionA, "A failed read", skillA, false);
    trace("b1", sessionB, "B absolute read", skillB);
    trace("b2", sessionB, "B bare read from project root", "SKILL.md");

    const resultsA = optimizeSkillsFromTraces({ cwd: projectA });
    expect(resultsA.map((r) => [r.skill, r.source, r.sampleCount])).toEqual([["demo", skillA, 1]]);
    const resultsB = optimizeSkillsFromTraces({ cwd: projectB });
    expect(resultsB.map((r) => [r.skill, r.source, r.sampleCount])).toEqual([["demo", skillB, 1]]);

    const overlayA = loadSkillOverlays(discoverSkills(projectA)).get("demo");
    expect(overlayA?.source).toBe(skillA);
    expect(overlayA?.fewShot.map((f) => f.query)).toEqual(["A relative read"]);

    const overlayB = loadSkillOverlays(discoverSkills(projectB)).get("demo");
    expect(overlayB?.source).toBe(skillB);
    expect(overlayB?.fewShot.map((f) => f.query)).toEqual(["B absolute read"]);

    // Two overlay files, one per source; a catalog-less load refuses to guess between them.
    const files = fs.readdirSync(path.join(home, "skill-overlays")).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);
    expect(loadSkillOverlays().get("demo")).toBeUndefined();
  });
});

describe("mineFewShot", () => {
  it("keeps high-quality examples, dedupes by query, caps at topN", () => {
    const examples = mineFewShot(
      [
        { query: "q1", result: "r1", feedback: 0.9, outcome: "success" },
        { query: "q1", result: "r1b", feedback: 0.8, outcome: "success" }, // dup query
        { query: "q2", result: "r2", feedback: 0.2, outcome: "failure" }, // below minFeedback
        { query: "q3", result: "   ", feedback: 0.9, outcome: "success" }, // empty result
        { query: "q4", result: "r4", feedback: null, outcome: "success" }, // success, no feedback => kept
      ],
      { minFeedback: 0.7, topN: 4 },
    );
    expect(examples.map((e) => e.query)).toEqual(["q1", "q4"]);
  });
});

describe("optimizeSkillsFromTraces (integration)", () => {
  const tempRoot = path.join(process.cwd(), ".tmp-skill-opt-tests");
  const originalCodesurfHome = process.env.CODESURF_HOME;
  let cwd = "";
  let skillPath = "";

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    process.env.CODESURF_HOME = fs.mkdtempSync(path.join(tempRoot, "home-"));
    cwd = fs.mkdtempSync(path.join(tempRoot, "proj-"));
    const skillDir = path.join(cwd, ".agents", "skills", "demo");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: A demo skill for tests\n---\nBody.\n",
      "utf-8",
    );
    closeDatabase();
    const sessionId = new SessionStore(cwd).createSession("m", "agent", cwd).id;
    skillPath = discoverSkills(cwd).find((s) => s.name === "demo")?.skillMdPath ?? "";
    // 3 high-feedback traces that each read the demo SKILL.md.
    for (let i = 0; i < 3; i++) {
      recordTrace({
        traceId: `t${i}`,
        sessionId,
        query: `use the demo skill case ${i}`,
        model: "m",
        result: `completed case ${i}`,
        feedback: 0.9,
        outcome: "success",
        steps: [{ stepIndex: 0, stepType: "tool_call", toolName: "read_file", input: { path: skillPath } }],
      });
    }
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("mines few-shot overlays for a skill from its high-feedback traces", () => {
    expect(skillPath).toContain("demo");
    const results = optimizeSkillsFromTraces({ cwd });
    const demo = results.find((r) => r.skill === "demo");
    expect(demo).toBeDefined();
    expect(demo?.examples).toBeGreaterThanOrEqual(1);

    const overlay = loadSkillOverlays().get("demo");
    expect(overlay).toBeDefined();
    expect(overlay?.fewShot.length).toBeGreaterThanOrEqual(1);
    expect(overlay?.fewShot[0].query).toContain("demo skill");
  });
});
