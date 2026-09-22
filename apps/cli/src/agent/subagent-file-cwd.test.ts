// The file tools must resolve relative paths against the CHILD's cwd during a
// sub-agent run, not the parent's.
//
// `subagent-bash-isolation.test.ts` proves the bash half: a child's `cd` cannot
// move the parent. This proves the other half — before the fix, a child whose
// shell had been `cd`-ed into a subdirectory still read and wrote through
// `services.workspace.cwd()`, i.e. the parent's (drifting) cwd, so the two
// halves of one sub-agent disagreed about where "here" was.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileToolDefinitions } from "../core/plugins/native/file-tools";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-filecwd-"));
  tempDirs.push(dir);
  return fs.realpathSync(dir);
}

/** Minimal hooks stand-in: `wrapExecute` passes the handler straight through. */
const passthroughHooks = () =>
  ({
    wrapExecute: (_name: string, handler: unknown) => handler,
  }) as never;

type ExecutableTool = { execute: (args: Record<string, unknown>) => Promise<{ success: boolean; output?: string }> };

function toolsFor(cwd: () => string) {
  const defs = createFileToolDefinitions({ cwd, hooks: passthroughHooks });
  const byName = new Map(defs.map((def) => [def.name, def.tool as unknown as ExecutableTool]));
  return {
    read: byName.get("read_file")!,
    write: byName.get("write_file")!,
  };
}

describe("file tools honour the cwd provider they are built with", () => {
  it("writes and reads relative paths under the provided cwd, not process.cwd()", async () => {
    const parent = makeTempDir();
    const child = path.join(parent, "nested");
    fs.mkdirSync(child);

    // A child bash that has `cd`-ed into `nested`.
    const { write, read } = toolsFor(() => child);
    await write.execute({ path: "note.txt", content: "from the child" });

    expect(fs.existsSync(path.join(child, "note.txt"))).toBe(true);
    expect(fs.existsSync(path.join(parent, "note.txt"))).toBe(false);

    const result = await read.execute({ path: "note.txt" });
    expect(result.output ?? "").toContain("from the child");
  });

  it("follows the provider when the cwd moves, rather than capturing it once", async () => {
    const parent = makeTempDir();
    const child = path.join(parent, "nested");
    fs.mkdirSync(child);

    // The definitions are built once per turn but the shell can `cd` mid-run,
    // so the accessor must be read at execute time.
    let current = parent;
    const { write } = toolsFor(() => current);

    await write.execute({ path: "a.txt", content: "one" });
    current = child;
    await write.execute({ path: "b.txt", content: "two" });

    expect(fs.existsSync(path.join(parent, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(child, "b.txt"))).toBe(true);
    expect(fs.existsSync(path.join(parent, "b.txt"))).toBe(false);
  });
});
