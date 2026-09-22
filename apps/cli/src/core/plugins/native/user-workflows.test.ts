// Parity acceptance for the native user-commands plugin, which replaced the V1
// `activate(api)` builtin of the same manifest id in the catalog.
//
// Mirrors the V1 builtin's suite (resolver matching, dispatch-time
// re-discovery, args forwarding, the `displayText` transcript header, the
// /commands listing) against a real Cordis root with fake HostBindings, and
// adds what the V1 shape could not express: the manifest identity and that
// disposing the fiber removes both contributions. Discovery is mocked so
// nothing depends on the machine's real ~/.claude/commands.

import type {
  ChatDispatchOptions,
  CommandResolverSpec,
  ListingCommandSpec,
  PluginManifest,
} from "@codesurf/plugin-api";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDiscoveryResult } from "../../../utils/workflows";
import { buildPromptWithArgs, parseWorkflowInput, userWorkflowsPlugin } from "./user-workflows";

const discoverMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/workflows", () => ({
  discoverUserPromptCommands: discoverMock,
  // Keep the real-shaped substitution but force the fallback path in tests:
  // bodies here use no $ARGUMENTS/$N, so `used` is false and the handler
  // appends the "Additional input" block (asserted below).
  expandPromptArguments: (body: string) => ({ text: body, used: false }),
}));

function discovery(overrides?: Partial<WorkflowDiscoveryResult>): WorkflowDiscoveryResult {
  return {
    workflows: [
      {
        slug: "deploy",
        name: "deploy",
        description: "Deploy the app",
        prompt: "Deploy the application step by step.",
        filePath: "/home/u/.claude/workflows/deploy.md",
        scope: "user",
      },
    ],
    unsupported: [],
    ...overrides,
  };
}

interface Harness {
  root: Context;
  resolvers: Array<{ spec: CommandResolverSpec; manifest: PluginManifest }>;
  listings: Array<{ spec: ListingCommandSpec; manifest: PluginManifest }>;
  released: string[];
  appended: string[];
  dispatched: string[];
  dispatchOptions: Array<ChatDispatchOptions | undefined>;
  cwds: string[];
}

function bootHarness(overrides: Partial<HostBindings> = {}): Harness {
  const resolvers: Harness["resolvers"] = [];
  const listings: Harness["listings"] = [];
  const released: string[] = [];
  const appended: string[] = [];
  const dispatched: string[] = [];
  const dispatchOptions: Harness["dispatchOptions"] = [];
  const cwds: string[] = [];
  const bindings: HostBindings = {
    registerCommandResolver: (spec, manifest) => {
      resolvers.push({ spec, manifest });
      return () => released.push("resolver");
    },
    registerListingCommand: (spec, manifest) => {
      listings.push({ spec, manifest });
      return () => released.push(`listing:${spec.name}`);
    },
    appendAssistant: (text) => appended.push(text),
    dispatchPrompt: async (prompt, options) => {
      dispatched.push(prompt);
      dispatchOptions.push(options);
    },
    cwd: () => {
      cwds.push("/project");
      return "/project";
    },
    ...overrides,
  };
  return {
    root: createCodesurfRoot(bindings),
    resolvers,
    listings,
    released,
    appended,
    dispatched,
    dispatchOptions,
    cwds,
  };
}

beforeEach(() => {
  discoverMock.mockReset();
  discoverMock.mockReturnValue(discovery());
});

describe("parseWorkflowInput", () => {
  it("splits slug and rest", () => {
    expect(parseWorkflowInput("/deploy now please")).toEqual({ slug: "deploy", rest: "now please" });
    expect(parseWorkflowInput("/deploy")).toEqual({ slug: "deploy", rest: "" });
  });

  it("rejects non-slash and empty input", () => {
    expect(parseWorkflowInput("deploy")).toBeNull();
    expect(parseWorkflowInput("/")).toBeNull();
  });
});

describe("buildPromptWithArgs", () => {
  it("appends an additional-input block when the body uses no placeholder", () => {
    const wf = discovery().workflows[0];
    if (!wf) throw new Error("fixture missing");
    expect(buildPromptWithArgs(wf, "")).toBe("Deploy the application step by step.");
    expect(buildPromptWithArgs(wf, "  to staging  ")).toBe(
      "Deploy the application step by step.\n\nAdditional input from the user:\nto staging",
    );
  });
});

describe("native user-commands plugin — identity", () => {
  it("keeps the V1 manifest identity byte-for-byte", () => {
    expect(userWorkflowsPlugin.manifest.id).toBe("builtin.commands.user-workflows");
    expect(userWorkflowsPlugin.manifest.name).toBe("User Commands");
    expect(userWorkflowsPlugin.manifest.version).toBe("2.0.0");
    expect(userWorkflowsPlugin.manifest.description).toBe(
      "Markdown slash commands from ~/.claude/commands and project .claude/commands (and legacy .claude/workflows) as dynamic /<name> commands, with $ARGUMENTS substitution and /commands to list them.",
    );
    expect(userWorkflowsPlugin.manifest.enabledByDefault).toBe(true);
    expect(userWorkflowsPlugin.manifest.protected).toBe(false);
    expect(userWorkflowsPlugin.manifest.hidden).toBeUndefined();
    expect(userWorkflowsPlugin.manifest.group).toBeUndefined();
    expect(userWorkflowsPlugin.manifest.capabilities).toEqual(["commands"]);
  });

  it("registers exactly one resolver and one listing command, attributed to the manifest", async () => {
    const h = bootHarness();
    const fiber = mountPlugin(h.root, userWorkflowsPlugin);
    await fiber;

    expect(h.resolvers).toHaveLength(1);
    expect(h.resolvers[0]?.spec.label).toBe("User commands (.claude/commands)");
    expect(h.resolvers[0]?.manifest.id).toBe("builtin.commands.user-workflows");

    expect(h.listings).toHaveLength(1);
    const listing = h.listings[0]?.spec;
    expect(listing?.name).toBe("/commands");
    expect(listing?.aliases).toEqual(["/workflows"]);
    expect(listing?.description).toBe(
      "List markdown slash commands from ~/.claude/commands and project .claude/commands.",
    );
    expect(listing?.argsHint).toBeUndefined();
    expect(h.listings[0]?.manifest.id).toBe("builtin.commands.user-workflows");

    await fiber.dispose();
  });

  it("removes both contributions when the fiber is disposed", async () => {
    const h = bootHarness();
    const fiber = mountPlugin(h.root, userWorkflowsPlugin);
    await fiber;
    expect(h.released).toEqual([]);

    await fiber.dispose();
    expect(h.released).toContain("resolver");
    expect(h.released).toContain("listing:/commands");
    expect(h.released).toHaveLength(2);
  });
});

describe("native user-commands plugin — resolver", () => {
  async function bootResolver(overrides: Partial<HostBindings> = {}) {
    const h = bootHarness(overrides);
    const fiber = mountPlugin(h.root, userWorkflowsPlugin);
    await fiber;
    const spec = h.resolvers[0]?.spec;
    if (!spec) throw new Error("resolver not registered");
    return { ...h, fiber, resolver: spec };
  }

  it("resolves a discovered slug and dispatches the file body", async () => {
    const h = await bootResolver();
    const match = h.resolver.resolve("/deploy");
    expect(match).not.toBeNull();
    expect(match?.command.name).toBe("/deploy");
    // V1 built the dispatch-path command without frontmatter metadata.
    expect(match?.command.description).toBe("User command: deploy");
    expect(match?.command.argsHint).toBeUndefined();

    await match?.command.handler({ args: match.args });
    expect(h.dispatched).toEqual(["Deploy the application step by step."]);
    expect(h.appended).toEqual([]);
    await h.fiber.dispose();
  });

  // The V1 builtin dispatched with a `displayText` so the user bubble, the
  // generated session title and the queue banner showed the typed command
  // rather than the whole expanded .md body. Both V1 cases, verbatim.
  it("dispatches the typed command as the transcript header", async () => {
    const h = await bootResolver();

    const bare = h.resolver.resolve("/deploy");
    await bare?.command.handler({ args: bare?.args ?? "" });
    expect(h.dispatched[0]).toBe("Deploy the application step by step.");
    expect(h.dispatchOptions[0]).toEqual({ displayText: "/deploy" });

    const withArgs = h.resolver.resolve("/deploy to staging");
    await withArgs?.command.handler({ args: withArgs?.args ?? "" });
    expect(h.dispatched[1]).toBe("Deploy the application step by step.\n\nAdditional input from the user:\nto staging");
    expect(h.dispatchOptions[1]).toEqual({ displayText: "/deploy to staging" });

    await h.fiber.dispose();
  });

  it("appends extra args as additional input", async () => {
    const h = await bootResolver();
    const match = h.resolver.resolve("/deploy to staging");
    expect(match?.args).toBe("to staging");
    await match?.command.handler({ args: match?.args ?? "" });
    expect(h.dispatched[0]).toContain("Deploy the application step by step.");
    expect(h.dispatched[0]).toContain("Additional input from the user:\nto staging");
    await h.fiber.dispose();
  });

  it("returns null for slugs with no matching workflow file", async () => {
    const h = await bootResolver();
    expect(h.resolver.resolve("/nonexistent")).toBeNull();
    expect(h.resolver.resolve("plain text")).toBeNull();
    await h.fiber.dispose();
  });

  it("fails loudly when the file disappears between resolve and dispatch", async () => {
    const h = await bootResolver();
    const match = h.resolver.resolve("/deploy");
    discoverMock.mockReturnValue(discovery({ workflows: [] }));
    await match?.command.handler({ args: "" });
    expect(h.dispatched).toEqual([]);
    expect(h.appended).toEqual([
      'Command "/deploy" no longer resolves to a .md file under ~/.claude/commands, .claude/commands, or .claude/workflows.',
    ]);
    await h.fiber.dispose();
  });

  it("discovers against the agent cwd, not process.cwd()", async () => {
    const h = await bootResolver();
    h.resolver.resolve("/deploy");
    expect(discoverMock).toHaveBeenCalledWith("/project");
    expect(h.cwds).toContain("/project");
    await h.fiber.dispose();
  });

  it("enumerates the same set with frontmatter description and argument hint", async () => {
    discoverMock.mockReturnValue(
      discovery({
        workflows: [
          {
            slug: "review",
            name: "review",
            description: "Review a PR",
            prompt: "Review it.",
            argumentHint: "<pr-number>",
            filePath: "/home/u/.claude/commands/review.md",
            scope: "project",
          },
        ],
      }),
    );
    const h = await bootResolver();
    const listed = h.resolver.enumerate?.() ?? [];
    expect(listed.map((c) => c.name)).toEqual(["/review"]);
    expect(listed[0]?.description).toBe("Review a PR");
    expect(listed[0]?.argsHint).toBe("<pr-number>");

    // enumerate() is independent of resolve(), but its commands dispatch too —
    // through the same builder, so they carry the same transcript header.
    await listed[0]?.handler({ args: "" });
    expect(h.dispatched).toEqual(["Review it."]);
    expect(h.dispatchOptions).toEqual([{ displayText: "/review" }]);
    await h.fiber.dispose();
  });
});

describe("native user-commands plugin — /commands listing", () => {
  async function render(overrides: Partial<HostBindings> = {}) {
    const h = bootHarness(overrides);
    const fiber = mountPlugin(h.root, userWorkflowsPlugin);
    await fiber;
    const spec = h.listings[0]?.spec;
    if (!spec) throw new Error("listing not registered");
    const out = spec.render({ args: "" });
    await fiber.dispose();
    return out;
  }

  it("lists discovered workflows with scope and description", async () => {
    const out = await render();
    expect(out).toBe("Commands (1):\n• /deploy [user] — Deploy the app");
  });

  it("includes the argument hint when the file declares one", async () => {
    discoverMock.mockReturnValue(
      discovery({
        workflows: [
          {
            slug: "review",
            name: "review",
            description: "Review a PR",
            prompt: "Review it.",
            argumentHint: "<pr-number>",
            filePath: "/home/u/.claude/commands/review.md",
            scope: "project",
          },
        ],
      }),
    );
    const out = await render();
    expect(out).toContain("• /review <pr-number> [project] — Review a PR");
  });

  it("explains unsupported non-md files", async () => {
    discoverMock.mockReturnValue(discovery({ unsupported: ["/home/u/.claude/workflows/escalation-chain.js"] }));
    const out = await render();
    expect(out).toContain("escalation-chain.js");
    expect(out).toContain(
      "1 non-markdown file(s) (e.g. .js workflow scripts) — run these via /<name> (see /workflow-scripts):",
    );
  });

  it("shows guidance when nothing is found", async () => {
    discoverMock.mockReturnValue({ workflows: [], unsupported: [] });
    const out = await render();
    expect(out).toBe(
      [
        "No markdown commands found.",
        "Drop a <name>.md file into ~/.claude/commands (or <project>/.claude/commands) and run it with /<name>.",
        "Use $ARGUMENTS or $1..$9 in the body to interpolate typed args.",
      ].join("\n"),
    );
  });
});
