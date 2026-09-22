// Parity acceptance for the converted `js-workflows` built-in.
//
// The V1 entry registered a command resolver and a `/workflow-scripts` listing
// command, and subscribed to the host's user-interrupt event. None of those
// land in `contributions.listCommands()` — that only tracks `registerCommand` —
// so the specs are captured through fake `HostBindings` and driven directly,
// which is also how their disposal is proven.
//
// `$HOME` is redirected to an empty temp dir for every test: `discoverWorkflow
// Scripts` always scans `~/.claude/workflows` and `~/.claude/commands` with no
// opt-out, and this machine has real scripts there that would otherwise leak
// into the "none found" and enumeration assertions.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandResolverSpec, CommandSpec, ListingCommandSpec, PluginManifest } from "@codesurf/plugin-api";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsWorkflowsPlugin, parseScriptInput } from "./js-workflows";

const DEMO_SCRIPT = `export const meta = {
  name: "Demo",
  description: "Demo workflow script",
  phases: [{ title: "Plan", model: "claude-opus-4-8" }, { title: "Ship" }],
};
phase("Plan");
log("thinking");
const answer = await agent("do the thing", { model: "sonnet", label: "demo-plan", phase: "Plan" });
return { answer };
`;

const TWO_CALL_SCRIPT = `export const meta = { name: "Abortme", description: "Two sub-agent calls" };
const a = await agent("first");
const b = await agent("second");
return { a, b };
`;

const BAIL_SCRIPT = `export const meta = { name: "Bail", description: "Throws after an aborted phase" };
await agent("first");
const b = await agent("second");
if (b === "") throw new Error("nothing came back");
return b;
`;

const originalHome = process.env.HOME;
const originalTrust = process.env.CODESURF_TRUST_WORKSPACE;
let homeDir = "";
let projectDir = "";

/** Everything the fakes captured while the plugin was mounted. */
interface Harness {
  root: Context;
  appended: string[];
  resolvers: CommandResolverSpec[];
  listings: ListingCommandSpec[];
  interruptListeners: Array<() => void>;
  manifests: PluginManifest[];
  releaseResolver: ReturnType<typeof vi.fn>;
  releaseListing: ReturnType<typeof vi.fn>;
  releaseInterrupt: ReturnType<typeof vi.fn>;
}

function boot(overrides: Partial<HostBindings> = {}): Harness {
  const appended: string[] = [];
  const resolvers: CommandResolverSpec[] = [];
  const listings: ListingCommandSpec[] = [];
  const interruptListeners: Array<() => void> = [];
  const manifests: PluginManifest[] = [];
  const releaseResolver = vi.fn();
  const releaseListing = vi.fn();
  const releaseInterrupt = vi.fn();

  const root = createCodesurfRoot({
    appendAssistant: (text) => appended.push(text),
    cwd: () => projectDir,
    registerCommandResolver: (spec, manifest) => {
      resolvers.push(spec);
      manifests.push(manifest);
      return releaseResolver;
    },
    registerListingCommand: (spec, manifest) => {
      listings.push(spec);
      manifests.push(manifest);
      return releaseListing;
    },
    onUserInterrupt: (listener) => {
      interruptListeners.push(listener);
      return releaseInterrupt;
    },
    ...overrides,
  });

  return {
    root,
    appended,
    resolvers,
    listings,
    interruptListeners,
    manifests,
    releaseResolver,
    releaseListing,
    releaseInterrupt,
  };
}

function writeScript(name: string, source: string): string {
  const dir = path.join(projectDir, ".claude", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, source, "utf-8");
  return file;
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-jsw-home-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-jsw-proj-"));
  // A `.git` marker stops the project-root walk here instead of climbing to `/`.
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  process.env.HOME = homeDir;
  // Project scripts run in-process on the host, so discovery only loads them
  // for a trusted workspace.
  process.env.CODESURF_TRUST_WORKSPACE = "1";
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTrust === undefined) delete process.env.CODESURF_TRUST_WORKSPACE;
  else process.env.CODESURF_TRUST_WORKSPACE = originalTrust;
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("js-workflows — manifest identity", () => {
  it("carries the V1 manifest byte-for-byte", () => {
    expect(jsWorkflowsPlugin.manifest.id).toBe("builtin.commands.js-workflows");
    expect(jsWorkflowsPlugin.manifest.name).toBe("JS Workflows");
    expect(jsWorkflowsPlugin.manifest.version).toBe("1.0.0");
    expect(jsWorkflowsPlugin.manifest.description).toBe(
      "Executable `.js` workflow scripts from ~/.claude/workflows and project .claude/workflows as dynamic /<name> commands. Each script drives a model chain via an injected agent() primitive.",
    );
    expect(jsWorkflowsPlugin.manifest.enabledByDefault).toBe(true);
    expect(jsWorkflowsPlugin.manifest.protected).toBe(false);
    expect(jsWorkflowsPlugin.manifest.hidden).toBeUndefined();
    expect(jsWorkflowsPlugin.manifest.group).toBeUndefined();
    expect(jsWorkflowsPlugin.manifest.capabilities).toEqual(["commands"]);
  });
});

describe("js-workflows — parseScriptInput", () => {
  it("splits slug from the rest, and rejects non-slash input", () => {
    expect(parseScriptInput("/demo")).toEqual({ slug: "demo", rest: "" });
    expect(parseScriptInput("  /demo  fix the bug  ")).toEqual({ slug: "demo", rest: "fix the bug" });
    expect(parseScriptInput("demo")).toBeNull();
    expect(parseScriptInput("/")).toBeNull();
  });
});

describe("js-workflows — registrations", () => {
  it("registers the resolver and the listing command under the plugin's manifest", async () => {
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    expect(h.resolvers).toHaveLength(1);
    expect(h.resolvers[0]?.label).toBe("JS workflow scripts (.claude/workflows/*.js)");
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0]?.name).toBe("/workflow-scripts");
    expect(h.listings[0]?.description).toBe("List executable .js workflow scripts and their model chains.");
    expect(h.listings[0]?.argsHint).toBeUndefined();
    expect(h.listings[0]?.aliases).toBeUndefined();
    expect(h.interruptListeners).toHaveLength(1);
    expect(new Set(h.manifests.map((m) => m.id))).toEqual(new Set(["builtin.commands.js-workflows"]));

    await fiber.dispose();
  });

  it("releases the resolver, the listing and the interrupt subscription on disposal", async () => {
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;
    expect(h.releaseResolver).not.toHaveBeenCalled();

    await fiber.dispose();
    expect(h.releaseResolver).toHaveBeenCalledTimes(1);
    expect(h.releaseListing).toHaveBeenCalledTimes(1);
    expect(h.releaseInterrupt).toHaveBeenCalledTimes(1);
  });
});

describe("js-workflows — resolver and enumeration", () => {
  it("resolves a discovered script and ignores everything else", async () => {
    writeScript("demo.js", DEMO_SCRIPT);
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;
    const resolver = h.resolvers[0];
    if (!resolver) throw new Error("resolver not registered");

    const match = resolver.resolve("/demo fix the bug");
    expect(match?.args).toBe("fix the bug");
    expect(match?.command.name).toBe("/demo");
    // Resolve builds the command without a description, so the fallback shows.
    expect(match?.command.description).toBe("Workflow script: demo");
    expect(match?.command.argsHint).toBe("[task]");

    expect(resolver.resolve("/nope")).toBeNull();
    expect(resolver.resolve("plain text")).toBeNull();

    await fiber.dispose();
  });

  it("enumerates scripts with their meta description", async () => {
    writeScript("demo.js", DEMO_SCRIPT);
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    const commands = h.resolvers[0]?.enumerate?.() ?? [];
    expect(commands.map((c) => c.name)).toEqual(["/demo"]);
    expect(commands[0]?.description).toBe("Demo workflow script");
    expect(commands[0]?.argsHint).toBe("[task]");

    await fiber.dispose();
  });

  it("re-scans on every dispatch so a new file works without a restart", async () => {
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;
    const resolver = h.resolvers[0];
    if (!resolver) throw new Error("resolver not registered");

    expect(resolver.resolve("/demo")).toBeNull();
    writeScript("demo.js", DEMO_SCRIPT);
    expect(resolver.resolve("/demo")?.command.name).toBe("/demo");

    await fiber.dispose();
  });
});

describe("js-workflows — /workflow-scripts listing", () => {
  it("prints the empty-state text when nothing is found", async () => {
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    expect(h.listings[0]?.render({ args: "" })).toBe(
      [
        "No workflow scripts found.",
        "Drop a <name>.js file (exporting `const meta = { name, description, phases }`) into",
        "~/.claude/workflows (or <project>/.claude/workflows) and run it with /<name>.",
      ].join("\n"),
    );

    await fiber.dispose();
  });

  it("lists scripts with scope, description and the phase chain", async () => {
    writeScript("demo.js", DEMO_SCRIPT);
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    expect(h.listings[0]?.render({ args: "" })).toBe(
      [
        "Workflow scripts (1):",
        "• /demo [project] — Demo workflow script",
        "    chain: Plan(claude-opus-4-8) → Ship",
      ].join("\n"),
    );

    await fiber.dispose();
  });

  it("explains a project script skipped because the workspace is untrusted", async () => {
    delete process.env.CODESURF_TRUST_WORKSPACE;
    writeScript("demo.js", DEMO_SCRIPT);
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    const listing = h.listings[0]?.render({ args: "" }) ?? "";
    expect(listing).toContain("No workflow scripts found.");
    expect(listing).toContain("workspace not trusted");
    expect(listing).toContain("demo.js");

    await fiber.dispose();
  });
});

describe("js-workflows — execution", () => {
  it("streams the run banner, phases, logs and the rendered result", async () => {
    writeScript("demo.js", DEMO_SCRIPT);
    const runTask = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({ output: "sub-agent said hi" }));
    const h = boot({ runTask });
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    const match = h.resolvers[0]?.resolve("/demo fix the bug");
    if (!match) throw new Error("did not resolve");
    await match.command.handler({ args: match.args });

    expect(h.appended).toEqual([
      "▶ Running workflow /demo fix the bug",
      "▶ Phase: Plan",
      "  thinking",
      '✓ Workflow /demo complete:\n```json\n{\n  "answer": "sub-agent said hi"\n}\n```',
    ]);

    // The per-call model override and the label/phase-derived description are
    // forwarded verbatim to the sub-agent request.
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask.mock.calls[0]?.[0]).toMatchObject({
      agent: "general",
      description: "demo-plan",
      prompt: "do the thing",
      model: "sonnet",
    });

    await fiber.dispose();
  });

  it("degrades a failed sub-agent phase into its error text instead of crashing", async () => {
    writeScript("demo.js", DEMO_SCRIPT);
    const h = boot({
      runTask: async () => {
        throw new Error("child exploded");
      },
    });
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    const match = h.resolvers[0]?.resolve("/demo");
    await match?.command.handler({ args: "" });

    expect(h.appended[0]).toBe("▶ Running workflow /demo");
    expect(h.appended.at(-1)).toContain('"answer": "Sub-agent failed: child exploded"');

    await fiber.dispose();
  });

  it("reports a script body that throws as a failed workflow", async () => {
    writeScript("boom.js", 'export const meta = { name: "Boom" };\nthrow new Error("body broke");\n');
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    const match = h.resolvers[0]?.resolve("/boom");
    await match?.command.handler({ args: "" });

    expect(h.appended.at(-1)).toBe("✗ Workflow /boom failed: body broke");

    await fiber.dispose();
  });

  it("explains a script that vanished between enumeration and dispatch", async () => {
    const file = writeScript("demo.js", DEMO_SCRIPT);
    const h = boot();
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    const command = h.resolvers[0]?.enumerate?.()[0] as CommandSpec;
    fs.rmSync(file);
    await command.handler({ args: "" });

    expect(h.appended).toEqual([
      'Workflow "/demo" no longer resolves to a .js file under ~/.claude/workflows or project .claude/workflows.',
    ]);

    await fiber.dispose();
  });

  it("aborts remaining phases when the user interrupts", async () => {
    writeScript("abortme.js", TWO_CALL_SCRIPT);
    // Assigned by the executor below, which runs synchronously on the first
    // `runTask` call; the no-op initializer keeps the type callable.
    let releaseFirst: () => void = () => {};
    const runTask = vi.fn(
      () =>
        new Promise<{ output: string }>((resolve) => {
          releaseFirst = () => resolve({ output: "one" });
        }),
    );
    const h = boot({ runTask });
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    const match = h.resolvers[0]?.resolve("/abortme");
    if (!match) throw new Error("did not resolve");
    const running = match.command.handler({ args: "" });
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1));

    // Esc: the interrupt listener aborts the in-flight run's controller.
    for (const listener of h.interruptListeners) listener();
    releaseFirst();
    await running;

    // The second `agent()` call short-circuits to "" without another sub-agent
    // turn — the whole point of the interrupt wiring.
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(h.appended.at(-1)).toBe('✓ Workflow /abortme complete:\n```json\n{\n  "a": "one",\n  "b": ""\n}\n```');

    await fiber.dispose();
  });

  it("reports an interrupted workflow when the aborted body throws", async () => {
    writeScript("bail.js", BAIL_SCRIPT);
    let releaseFirst: () => void = () => {};
    const runTask = vi.fn(
      () =>
        new Promise<{ output: string }>((resolve) => {
          releaseFirst = () => resolve({ output: "one" });
        }),
    );
    const h = boot({ runTask });
    const fiber = mountPlugin(h.root, jsWorkflowsPlugin);
    await fiber;

    const match = h.resolvers[0]?.resolve("/bail");
    if (!match) throw new Error("did not resolve");
    const running = match.command.handler({ args: "" });
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1));

    for (const listener of h.interruptListeners) listener();
    releaseFirst();
    await running;

    // V1 quirk kept deliberately: the interrupted line only appears when the
    // script body itself throws after the abort, because `agent()` swallows the
    // abort into "" rather than rejecting.
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(h.appended.at(-1)).toBe("✗ Workflow /bail interrupted.");

    await fiber.dispose();
  });
});
