// Server scopes: a "user" node serves any folder; a "project" node (`codesurf
// node --project <root>`) serves only its root and folders inside it. Real
// engine node, real WebSocket, real folders; the turn runner is inert because
// only session creation and the info frame are under test.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineNode } from "./engine-node";
import { SessionStreamClient } from "./session-stream";
import { resolveNodeScope } from "./session-workspace";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function* idleRunner() {}

async function startNode(scope?: ConstructorParameters<typeof EngineNode>[0]["scope"]) {
  const node = new EngineNode({ turnRunner: idleRunner, port: 0, scope });
  await node.start();
  const start = Date.now();
  while (node.port() === 0 && Date.now() - start < 3000) await sleep(10);
  const client = new SessionStreamClient(`ws://127.0.0.1:${node.port()}`);
  await client.connect();
  return { node, client };
}

describe("node server scope", () => {
  let root: string;
  let project: string;
  let outside: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "codesurf-node-scope-")));
    project = join(root, "proj");
    outside = join(root, "elsewhere");
    mkdirSync(join(project, "packages", "app"), { recursive: true });
    mkdirSync(outside);
    // A sibling whose name starts with the project's: must not count as inside.
    mkdirSync(join(root, "proj-other"));
    // A link inside the project that points out of it: judged by its realpath.
    symlinkSync(outside, join(project, "escape"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a project server accepts its root and subfolders, rejects anything outside, and says so", async () => {
    const { node, client } = await startNode(resolveNodeScope({ project, name: "proj-server" }));
    try {
      expect(await client.info()).toEqual({ scope: "project", project, name: "proj-server" });

      const inRoot = await client.createSession({ cwd: project });
      const inSub = await client.createSession({ cwd: join(project, "packages", "app") });
      const byDefault = await client.createSession();
      const statuses = await client.listSessions();
      const cwdOf = (id: string) => statuses.find((s) => s.id === id)?.cwd;
      expect(cwdOf(inRoot)).toBe(project);
      expect(cwdOf(inSub)).toBe(join(project, "packages", "app"));
      // No cwd on a project server means its root, not the process's folder.
      expect(cwdOf(byDefault)).toBe(project);

      const refusal = `this is a project server for ${project}`;
      await expect(client.createSession({ cwd: outside })).rejects.toThrow(refusal);
      await expect(client.createSession({ cwd: join(root, "proj-other") })).rejects.toThrow(refusal);
      await expect(client.createSession({ cwd: join(project, "escape") })).rejects.toThrow(refusal);
    } finally {
      client.close();
      await node.close();
    }
  });

  it("a user server serves any valid folder and reports scope user", async () => {
    const { node, client } = await startNode();
    try {
      expect(await client.info()).toEqual({ scope: "user" });
      const id = await client.createSession({ cwd: outside });
      expect((await client.status(id))?.cwd).toBe(outside);
    } finally {
      client.close();
      await node.close();
    }
  });

  it("validates --project and --name", () => {
    expect(resolveNodeScope({})).toEqual({ scope: "user" });
    expect(resolveNodeScope({ name: "  laptop " })).toEqual({ scope: "user", name: "laptop" });
    expect(() => resolveNodeScope({ project: "relative/dir" })).toThrow(/absolute path/);
    expect(() => resolveNodeScope({ project: join(root, "missing") })).toThrow(/does not exist/);
  });
});
