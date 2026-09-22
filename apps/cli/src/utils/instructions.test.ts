import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function importLoadCustomInstructions(mockedHome?: string) {
  vi.resetModules();
  vi.doUnmock("os");

  if (mockedHome) {
    process.env.HOME = mockedHome;
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os");
      return {
        ...actual,
        homedir: () => mockedHome,
      };
    });
  }

  const mod = await import("./instructions");
  return mod.loadCustomInstructions;
}

const originalHome = process.env.HOME;
const originalConfigDir = process.env.CODESURF_CONFIG_DIR;

function restoreConfigDir(): void {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
}

describe("loadCustomInstructions", () => {
  beforeEach(() => {
    // loadCustomInstructions now reads persisted steering prefs from the
    // extensions config dir; clear any ambient override so the persona-order
    // assertions below stay deterministic.
    delete process.env.CODESURF_CONFIG_DIR;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    restoreConfigDir();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("os");
  });

  it("returns null when no instruction files exist", async () => {
    const home = makeTempDir("grok-home-");
    const cwd = makeTempDir("grok-cwd-");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBeNull();
  });

  it("loads global plus repo-chain AGENTS files in order", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    const cwd = path.join(repoRoot, "pkg", "feature");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    fs.mkdirSync(cwd, { recursive: true });

    writeFile(path.join(home, ".grok", "AGENTS.md"), "global instructions");
    writeFile(path.join(repoRoot, "AGENTS.md"), "root instructions");
    writeFile(path.join(repoRoot, "pkg", "AGENTS.md"), "pkg instructions");
    writeFile(path.join(repoRoot, "pkg", "feature", "AGENTS.md"), "feature instructions");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBe(
      ["global instructions", "root instructions", "pkg instructions", "feature instructions"].join("\n\n"),
    );
  });

  it("prefers AGENTS.override.md over AGENTS.md in the same directory", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    const cwd = path.join(repoRoot, "nested");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    fs.mkdirSync(cwd, { recursive: true });

    writeFile(path.join(repoRoot, "AGENTS.md"), "root instructions");
    writeFile(path.join(repoRoot, "nested", "AGENTS.md"), "nested base instructions");
    writeFile(path.join(repoRoot, "nested", "AGENTS.override.md"), "nested override instructions");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBe(["root instructions", "nested override instructions"].join("\n\n"));
  });

  it("loads persona prelude (SOUL/IDENTITY/USER/TOOLS) before AGENTS.md", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    writeFile(path.join(repoRoot, "SOUL.md"), "soul text");
    writeFile(path.join(repoRoot, "IDENTITY.md"), "identity text");
    writeFile(path.join(repoRoot, "USER.md"), "user text");
    writeFile(path.join(repoRoot, "TOOLS.md"), "tools text");
    writeFile(path.join(repoRoot, "AGENTS.md"), "agents text");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(repoRoot)).toBe(
      ["soul text", "identity text", "user text", "tools text", "agents text"].join("\n\n"),
    );
  });

  it("loads persona postlude, MEMORY, and scratch after AGENTS.md", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    writeFile(path.join(repoRoot, "AGENTS.md"), "agents text");
    writeFile(path.join(repoRoot, "DREAMING.md"), "dreaming text");
    writeFile(path.join(repoRoot, "HEARTBEAT.md"), "heartbeat text");
    writeFile(path.join(repoRoot, ".agent-memory", "MEMORY.md"), "memory text");
    writeFile(path.join(repoRoot, ".agent-memory", ".scratch.md"), "scratch text");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(repoRoot)).toBe(
      ["agents text", "dreaming text", "heartbeat text", "memory text", "# Agent Memory Scratch\n\nscratch text"].join(
        "\n\n",
      ),
    );
  });

  it("loads the full persona stack in canonical order", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    writeFile(path.join(repoRoot, "SOUL.md"), "soul");
    writeFile(path.join(repoRoot, "IDENTITY.md"), "identity");
    writeFile(path.join(repoRoot, "USER.md"), "user");
    writeFile(path.join(repoRoot, "TOOLS.md"), "tools");
    writeFile(path.join(repoRoot, "AGENTS.md"), "agents");
    writeFile(path.join(repoRoot, "DREAMING.md"), "dreaming");
    writeFile(path.join(repoRoot, "HEARTBEAT.md"), "heartbeat");
    writeFile(path.join(repoRoot, ".agent-memory", "MEMORY.md"), "memory");
    writeFile(path.join(repoRoot, ".agent-memory", ".scratch.md"), "scratch");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(repoRoot)).toBe(
      [
        "soul",
        "identity",
        "user",
        "tools",
        "agents",
        "dreaming",
        "heartbeat",
        "memory",
        "# Agent Memory Scratch\n\nscratch",
      ].join("\n\n"),
    );
  });

  it("skips empty persona files", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    writeFile(path.join(repoRoot, "SOUL.md"), "");
    writeFile(path.join(repoRoot, "IDENTITY.md"), "   \n  ");
    writeFile(path.join(repoRoot, "AGENTS.md"), "agents");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(repoRoot)).toBe("agents");
  });

  it("loads global persona files from ~/.grok/", async () => {
    const home = makeTempDir("grok-home-");
    const cwd = makeTempDir("grok-cwd-");

    writeFile(path.join(home, ".grok", "SOUL.md"), "global soul");
    writeFile(path.join(home, ".grok", "IDENTITY.md"), "global identity");
    writeFile(path.join(home, ".grok", "AGENTS.md"), "global agents");
    writeFile(path.join(home, ".grok", "HEARTBEAT.md"), "global heartbeat");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBe(
      ["global soul", "global identity", "global agents", "global heartbeat"].join("\n\n"),
    );
  });

  it("compacts oversized HEARTBEAT history in the hot instruction path", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    writeFile(
      path.join(repoRoot, "HEARTBEAT.md"),
      [
        "# HEARTBEAT",
        "## State",
        "current state",
        "## Done",
        "x".repeat(60_000),
        "## Pending",
        "- [ ] current follow-up",
      ].join("\n\n"),
    );
    const loadCustomInstructions = await importLoadCustomInstructions(home);
    const loaded = loadCustomInstructions(repoRoot) ?? "";

    // Tight to the HEARTBEAT_MAX_CHARS budget (18_000) — the kept content is
    // tiny (~tens of bytes after dropping `## Done`) plus the omission marker,
    // so the total must sit well under the budget. Catches regressions that
    // would silently widen the budget.
    expect(loaded.length).toBeLessThan(18_000);
    expect(loaded).toContain("current state");
    expect(loaded).toContain("current follow-up");
    expect(loaded).toContain("completed-history sections omitted");
    expect(loaded).not.toContain("x".repeat(1_000));
  });

  it("middle-truncates an oversized SCRATCH file under the SCRATCH budget", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    // Layout: head ... filler ... MIDDLE-MARKER ... filler ... tail.
    // After middle-truncation, head + tail survive, MIDDLE-MARKER is dropped.
    const head = "SCRATCH-HEAD-MARKER";
    const tail = "SCRATCH-TAIL-MARKER";
    const middle = "SCRATCH-MIDDLE-MARKER-DROPPED";
    const filler = "z".repeat(10_000);
    writeFile(path.join(repoRoot, ".agent-memory", ".scratch.md"), `${head}\n${filler}\n${middle}\n${filler}\n${tail}`);
    const loadCustomInstructions = await importLoadCustomInstructions(home);
    const loaded = loadCustomInstructions(repoRoot) ?? "";

    // SCRATCH_MAX_CHARS is 8_000; loaded includes the "# Agent Memory Scratch"
    // banner prefix from loadDirectorySegments, so allow a small overhead.
    expect(loaded.length).toBeLessThan(8_500);
    expect(loaded).toContain(head);
    expect(loaded).toContain(tail);
    expect(loaded).toContain("compacted");
    // The middle marker must be dropped — proves the head/tail split actually
    // discards the middle of the file rather than keeping it intact.
    expect(loaded).not.toContain(middle);
  });

  it("keeps recent MEMORY update entries while omitting archival sections", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));

    const updates = Array.from(
      { length: 20 },
      (_, i) => `- **2026-05-${String(i + 1).padStart(2, "0")}** — update ${i + 1}`,
    );
    writeFile(
      path.join(repoRoot, ".agent-memory", "MEMORY.md"),
      [
        "# MEMORY",
        "## Owner",
        "owner facts",
        "## Project",
        "project facts",
        "## Huge Archive",
        "y".repeat(90_000),
        "## Update log",
        updates.join("\n"),
      ].join("\n\n"),
    );
    const loadCustomInstructions = await importLoadCustomInstructions(home);
    const loaded = loadCustomInstructions(repoRoot) ?? "";

    // Tight to MEMORY_MAX_CHARS (32_000). Same reasoning as the HEARTBEAT
    // assertion above — catches budget widening regressions.
    expect(loaded.length).toBeLessThan(32_000);
    expect(loaded).toContain("owner facts");
    expect(loaded).toContain("project facts");
    expect(loaded).toContain("update 20");
    expect(loaded).not.toContain("2026-05-01");
    expect(loaded).toContain("archival sections omitted");
    expect(loaded).not.toContain("y".repeat(1_000));
  });

  it("layers global persona then repo persona then AGENTS chain", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    const cwd = path.join(repoRoot, "pkg");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    fs.mkdirSync(cwd, { recursive: true });

    writeFile(path.join(home, ".grok", "SOUL.md"), "global soul");
    writeFile(path.join(home, ".grok", "AGENTS.md"), "global agents");

    writeFile(path.join(repoRoot, "IDENTITY.md"), "repo identity");
    writeFile(path.join(repoRoot, "AGENTS.md"), "repo agents");
    writeFile(path.join(repoRoot, ".agent-memory", "MEMORY.md"), "repo memory");

    writeFile(path.join(cwd, "AGENTS.md"), "pkg agents");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBe(
      ["global soul", "global agents", "repo identity", "repo agents", "repo memory", "pkg agents"].join("\n\n"),
    );
  });
});

const STEER_HEADER = [
  "# Active Steering Preferences",
  "",
  "Honor these steering selections (set via `/steer`) for this session:",
];

describe("loadCustomInstructions — steering preferences", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = makeTempDir("steer-cfg-");
    process.env.CODESURF_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    restoreConfigDir();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("os");
  });

  function writeSteering(settings: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(configDir, "extensions.json"),
      JSON.stringify({ enabled: null, disabled: [], tools: {}, settings }, null, 2),
    );
  }

  it("returns the steering block alone when only prefs are set", async () => {
    const home = makeTempDir("grok-home-");
    const cwd = makeTempDir("grok-cwd-");
    writeSteering({ "steer.scope": "Tight fix", "steer.risk": "Low" });
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(cwd)).toBe(
      [...STEER_HEADER, "- Scope of change: Tight fix", "- Risk tolerance: Low"].join("\n"),
    );
  });

  it("appends the steering block after persona/AGENTS segments", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    writeFile(path.join(repoRoot, "AGENTS.md"), "agents text");
    writeSteering({ "steer.verify": "Full" });
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(repoRoot)).toBe(
      ["agents text", [...STEER_HEADER, "- Verification depth: Full"].join("\n")].join("\n\n"),
    );
  });

  it("omits steering when no prefs are persisted", async () => {
    const home = makeTempDir("grok-home-");
    const repoRoot = makeTempDir("grok-repo-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    writeFile(path.join(repoRoot, "AGENTS.md"), "agents text");
    const loadCustomInstructions = await importLoadCustomInstructions(home);

    expect(loadCustomInstructions(repoRoot)).toBe("agents text");
  });
});
