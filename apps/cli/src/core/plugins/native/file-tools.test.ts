// Tests for the file-tools extension's edit-approval flow.
//
// Covers:
//   1. Manifest + tool registration shape (smoke)
//   2. needsApproval default behaviour (editApproval=accept-all → returns false)
//   3. needsApproval under ask-always (returns true)
//   4. Session "accept all" override bypasses approval globally
//   5. Per-path "accept this path" override bypasses approval for that path only
//   6. resetEditApprovalSession() clears both overrides
//   7. computeEditPreview produces correct diffs for write_file new + edit_file
//   8. /edits status / /edits ask / /edits auto slash-command branches

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeEditPreview } from "../../../tools/file";
import { loadEditApprovalMode, saveEditApprovalMode } from "../../../utils/settings";
import {
  getEditApprovalSessionState,
  markAcceptAllThisSession,
  markPathApprovedThisSession,
  resetEditApprovalSession,
  shouldAutoApproveEdit,
} from "../builtin/file-tools-approval";
import { __resetPluginsForTests, bootstrapPlugins, getRegistrySnapshot, setCwdProvider } from "../index";
import { getHostServices } from "../loader";
import { setBashSink } from "../sinks";
import { fileToolsPlugin } from "./file-tools";
import { createNativePluginModule } from "./host";

let tempDir: string;
let originalHome: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-file-tools-test-"));
  originalHome = process.env.HOME;
  // Settings file lives under ~/.grok — point HOME at the tempdir so we don't
  // mutate the real user's editApproval flag during tests.
  process.env.HOME = tempDir;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  __resetPluginsForTests();
  resetEditApprovalSession();
  // Always start each test from a known-good persistent default.
  saveEditApprovalMode("accept-all");
});

afterEach(() => {
  __resetPluginsForTests();
  setCwdProvider(null);
  resetEditApprovalSession();
});

describe("file-tools extension manifest", () => {
  it("registers manifest with both capabilities and protected=true", async () => {
    expect(fileToolsPlugin.manifest.id).toBe("builtin.tools.file");
    expect(fileToolsPlugin.manifest.protected).toBe(true);
    expect(fileToolsPlugin.manifest.capabilities).toEqual(expect.arrayContaining(["tools", "commands"]));
  });

  it("registers all three tools and the /edits command", async () => {
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);
    const snap = getRegistrySnapshot();
    const toolNames = snap.tools.map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file"]));
    const editsCmd = snap.commands.find((c) => c.name === "/edits");
    expect(editsCmd).toBeTruthy();
    expect(editsCmd?.argsHint).toBe("[ask|auto|status]");
  });
});

describe("shouldAutoApproveEdit decision logic", () => {
  it("returns true when persistent mode is accept-all and no overrides", () => {
    saveEditApprovalMode("accept-all");
    expect(shouldAutoApproveEdit("/tmp/anything")).toBe(true);
  });

  it("returns false when persistent mode is ask-always and no overrides", () => {
    saveEditApprovalMode("ask-always");
    expect(shouldAutoApproveEdit("/tmp/anything")).toBe(false);
  });

  it("markAcceptAllThisSession overrides ask-always globally", () => {
    saveEditApprovalMode("ask-always");
    expect(shouldAutoApproveEdit("/tmp/a")).toBe(false);
    markAcceptAllThisSession();
    expect(shouldAutoApproveEdit("/tmp/a")).toBe(true);
    expect(shouldAutoApproveEdit("/tmp/b")).toBe(true);
  });

  it("markPathApprovedThisSession overrides ask-always for that path only", () => {
    saveEditApprovalMode("ask-always");
    markPathApprovedThisSession("/tmp/permitted");
    expect(shouldAutoApproveEdit("/tmp/permitted")).toBe(true);
    expect(shouldAutoApproveEdit("/tmp/different")).toBe(false);
  });

  it("resetEditApprovalSession clears both overrides", () => {
    saveEditApprovalMode("ask-always");
    markAcceptAllThisSession();
    markPathApprovedThisSession("/tmp/x");
    resetEditApprovalSession();
    const snap = getEditApprovalSessionState();
    expect(snap.acceptAll).toBe(false);
    expect(snap.approvedPaths).toEqual([]);
    expect(shouldAutoApproveEdit("/tmp/x")).toBe(false);
  });
});

describe("computeEditPreview", () => {
  let workdir: string;
  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-edit-preview-"));
  });
  afterAll(() => {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {}
  });

  it("returns a new-file preview for write_file when file does not exist", () => {
    const target = path.join(workdir, "fresh.txt");
    const preview = computeEditPreview("write_file", { path: target, content: "hello\n" }, workdir);
    expect(preview).not.toBeNull();
    expect(preview?.isNew).toBe(true);
    expect(preview?.additions).toBeGreaterThanOrEqual(1);
    expect(preview?.removals).toBe(0);
    expect(preview?.absolutePath).toBe(target);
    // The file must not have been touched.
    expect(fs.existsSync(target)).toBe(false);
  });

  it("returns a non-new preview for write_file on an existing file with changes", () => {
    const target = path.join(workdir, "existing.txt");
    fs.writeFileSync(target, "one\ntwo\n");
    const preview = computeEditPreview("write_file", { path: target, content: "one\ntwo\nthree\n" }, workdir);
    expect(preview?.isNew).toBe(false);
    expect(preview?.additions).toBeGreaterThanOrEqual(1);
    expect(preview?.noop).toBe(false);
  });

  it("returns a noop preview when write_file produces identical content", () => {
    const target = path.join(workdir, "noop.txt");
    fs.writeFileSync(target, "same\n");
    const preview = computeEditPreview("write_file", { path: target, content: "same\n" }, workdir);
    expect(preview?.noop).toBe(true);
    expect(preview?.additions).toBe(0);
    expect(preview?.removals).toBe(0);
  });

  it("returns a valid preview for edit_file unique replacement", () => {
    const target = path.join(workdir, "edit.txt");
    fs.writeFileSync(target, "foo\nbar\nbaz\n");
    const preview = computeEditPreview("edit_file", { path: target, old_string: "bar", new_string: "BAR" }, workdir);
    expect(preview?.noop).toBe(false);
    expect(preview?.additions).toBeGreaterThanOrEqual(1);
    expect(preview?.removals).toBeGreaterThanOrEqual(1);
    // File must remain unchanged on disk.
    expect(fs.readFileSync(target, "utf-8")).toBe("foo\nbar\nbaz\n");
  });

  it("returns a warning preview for edit_file when old_string is missing", () => {
    const target = path.join(workdir, "missing.txt");
    fs.writeFileSync(target, "abc\n");
    const preview = computeEditPreview(
      "edit_file",
      { path: target, old_string: "NOT_THERE", new_string: "X" },
      workdir,
    );
    expect(preview).not.toBeNull();
    expect(preview?.patch).toContain("not found");
  });

  it("returns null for edit_file when the target does not exist", () => {
    const target = path.join(workdir, "gone.txt");
    const preview = computeEditPreview("edit_file", { path: target, old_string: "x", new_string: "y" }, workdir);
    expect(preview).toBeNull();
  });
});

describe("write_file/edit_file needsApproval gating", () => {
  let workdir: string;
  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-needs-approval-"));
  });
  afterAll(() => {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {}
  });

  it("write_file returns false from needsApproval when mode=accept-all", async () => {
    setCwdProvider(() => workdir);
    saveEditApprovalMode("accept-all");
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);
    const snap = getRegistrySnapshot();
    const wf = snap.tools.find((t) => t.name === "write_file");
    expect(wf?.tool).toBeTruthy();
    const aiTool = wf!.tool as { needsApproval?: (i: unknown) => boolean | Promise<boolean> };
    expect(aiTool.needsApproval).toBeTypeOf("function");
    const r = await aiTool.needsApproval!({ path: "anything.txt", content: "x" });
    expect(r).toBe(false);
  });

  it("edit_file returns true from needsApproval when mode=ask-always with no overrides", async () => {
    setCwdProvider(() => workdir);
    saveEditApprovalMode("ask-always");
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);
    const snap = getRegistrySnapshot();
    const ef = snap.tools.find((t) => t.name === "edit_file");
    const aiTool = ef!.tool as { needsApproval?: (i: unknown) => boolean | Promise<boolean> };
    const r = await aiTool.needsApproval!({ path: "x.txt", old_string: "a", new_string: "b" });
    expect(r).toBe(true);
  });

  it("edit_file returns false after markPathApprovedThisSession for the matching abs path", async () => {
    setCwdProvider(() => workdir);
    saveEditApprovalMode("ask-always");
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);
    const snap = getRegistrySnapshot();
    const ef = snap.tools.find((t) => t.name === "edit_file");
    const aiTool = ef!.tool as { needsApproval?: (i: unknown) => boolean | Promise<boolean> };
    // Pre-approve the file (using an absolute path so the resolver doesn't need cwd magic).
    const abs = path.join(workdir, "ok.txt");
    markPathApprovedThisSession(abs);
    const r = await aiTool.needsApproval!({ path: abs, old_string: "a", new_string: "b" });
    expect(r).toBe(false);
  });
});

describe("write-path policy through the registered tools", () => {
  let workdir: string;
  let outsideDir: string;
  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-write-policy-ws-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-write-policy-out-"));
  });
  afterAll(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
  afterEach(() => {
    setBashSink(null);
  });

  type ExecTool = {
    needsApproval?: (i: unknown) => boolean | Promise<boolean>;
    execute: (i: unknown, o: unknown) => Promise<{ success: boolean; output: string }>;
  };
  const toolNamed = (name: string) => getRegistrySnapshot().tools.find((t) => t.name === name)!.tool as ExecTool;

  it("asks before writing outside the workspace even under accept-all", async () => {
    setCwdProvider(() => workdir);
    saveEditApprovalMode("accept-all");
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);

    const writeTool = toolNamed("write_file");
    expect(await writeTool.needsApproval!({ path: "inside.txt", content: "x" })).toBe(false);
    expect(await writeTool.needsApproval!({ path: path.join(outsideDir, "out.txt"), content: "x" })).toBe(true);
    const editTool = toolNamed("edit_file");
    expect(
      await editTool.needsApproval!({ path: path.join(outsideDir, "out.txt"), old_string: "a", new_string: "b" }),
    ).toBe(true);
  });

  it("uses the live bash sandbox mode to refuse writes outside the workspace", async () => {
    setCwdProvider(() => workdir);
    // Settings say nothing about Shuru; only the live shell is sandboxed.
    setBashSink({ getSandboxMode: () => "shuru" } as never);
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);

    const target = path.join(outsideDir, "escaped.txt");
    const result = await toolNamed("write_file").execute(
      { path: target, content: "x" },
      { toolCallId: "t1", messages: [] },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("sandbox mode");
    expect(fs.existsSync(target)).toBe(false);

    const inside = await toolNamed("write_file").execute(
      { path: "kept.txt", content: "x" },
      { toolCallId: "t2", messages: [] },
    );
    expect(inside.success).toBe(true);
  });
});

describe("/edits slash command", () => {
  it("status branch shows current mode", async () => {
    saveEditApprovalMode("accept-all");
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);
    const snap = getRegistrySnapshot();
    const cmd = snap.commands.find((c) => c.name === "/edits");
    expect(cmd).toBeTruthy();
    const appendAssistant = vi.fn();
    vi.spyOn(getHostServices().chat, "appendAssistant").mockImplementation(appendAssistant);
    cmd!.handler({ args: "status" } as Parameters<NonNullable<typeof cmd>["handler"]>[0]);
    expect(appendAssistant).toHaveBeenCalledTimes(1);
    const arg = appendAssistant.mock.calls[0]?.[0] as string;
    expect(arg).toContain("accept-all");
  });

  it("ask branch writes ask-always to settings", async () => {
    saveEditApprovalMode("accept-all");
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);
    const snap = getRegistrySnapshot();
    const cmd = snap.commands.find((c) => c.name === "/edits");
    const appendAssistant = vi.fn();
    vi.spyOn(getHostServices().chat, "appendAssistant").mockImplementation(appendAssistant);
    cmd!.handler({ args: "ask" } as Parameters<NonNullable<typeof cmd>["handler"]>[0]);
    expect(loadEditApprovalMode()).toBe("ask-always");
    expect(appendAssistant.mock.calls[0]?.[0]).toContain("ask-always");
  });

  it("auto branch writes accept-all to settings", async () => {
    saveEditApprovalMode("ask-always");
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);
    const snap = getRegistrySnapshot();
    const cmd = snap.commands.find((c) => c.name === "/edits");
    const appendAssistant = vi.fn();
    vi.spyOn(getHostServices().chat, "appendAssistant").mockImplementation(appendAssistant);
    cmd!.handler({ args: "auto" } as Parameters<NonNullable<typeof cmd>["handler"]>[0]);
    expect(loadEditApprovalMode()).toBe("accept-all");
    expect(appendAssistant.mock.calls[0]?.[0]).toContain("accept-all");
  });

  it("unknown subcommand prints usage", async () => {
    await bootstrapPlugins([createNativePluginModule(fileToolsPlugin)]);
    const snap = getRegistrySnapshot();
    const cmd = snap.commands.find((c) => c.name === "/edits");
    const appendAssistant = vi.fn();
    vi.spyOn(getHostServices().chat, "appendAssistant").mockImplementation(appendAssistant);
    cmd!.handler({ args: "wtf" } as Parameters<NonNullable<typeof cmd>["handler"]>[0]);
    expect(appendAssistant.mock.calls[0]?.[0]).toContain("Usage:");
  });
});
