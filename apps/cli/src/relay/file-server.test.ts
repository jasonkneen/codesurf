import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleFileRequest, resolveRealSafePath, resolveSafePath } from "./file-server";

describe("resolveSafePath", () => {
  const root = "/workspace";

  it("accepts a path under the root", () => {
    expect(resolveSafePath("/workspace/src/a.ts", [root])).toBe(join(root, "src/a.ts"));
  });

  it("rejects path traversal", () => {
    expect(resolveSafePath("/workspace/../etc/passwd", [root])).toBeNull();
    expect(resolveSafePath("/etc/passwd", [root])).toBeNull();
  });

  it("rejects relative and empty paths", () => {
    expect(resolveSafePath("", [root])).toBeNull();
    expect(resolveSafePath("src/a.ts", [root])).toBeNull();
  });
});

describe("handleFileRequest", () => {
  it("serves a file under the root and 403s one outside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codesurf-files-"));
    const inside = join(dir, "ok.txt");
    writeFileSync(inside, "hello-files");
    const server = createServer((req, res) => handleFileRequest(req, res, [dir]));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const port = address.port;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(inside)}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello-files");
      // No wildcard CORS: an unlisted page cannot read the body.
      expect(ok.headers.get("access-control-allow-origin")).toBeNull();

      const denied = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent("/etc/passwd")}`);
      expect(denied.status).toBe(403);

      const headOk = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(inside)}`, {
        method: "HEAD",
      });
      expect(headOk.status).toBe(200);
      expect(await headOk.text()).toBe("");

      const missing = join(dir, "nope.txt");
      const headMissing = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent(missing)}`, {
        method: "HEAD",
      });
      expect(headMissing.status).toBe(404);

      const headDenied = await fetch(`http://127.0.0.1:${port}/files?path=${encodeURIComponent("/etc/passwd")}`, {
        method: "HEAD",
      });
      expect(headDenied.status).toBe(403);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function serve(roots: string[], allowedOrigins: string[] = []) {
  const server = createServer((req, res) => handleFileRequest(req, res, roots, { allowedOrigins }));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe("file-server hardening (H2)", () => {
  it("refuses a symlink inside a root that points outside it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "codesurf-secret-"));
    const root = mkdtempSync(join(tmpdir(), "codesurf-root-"));
    writeFileSync(join(outside, ".env"), "SECRET=1");
    symlinkSync(join(outside, ".env"), join(root, "leak.txt"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "ok.txt"), "fine");
    const { server, base } = await serve([root]);
    try {
      expect(resolveRealSafePath(join(root, "leak.txt"), [root])).toBeNull();
      const leak = await fetch(`${base}/files?path=${encodeURIComponent(join(root, "leak.txt"))}`);
      expect(leak.status).toBe(403);
      expect(await leak.text()).not.toContain("SECRET");
      // Real files under a root reached through a symlinked tmpdir (macOS /var -> /private/var) still serve.
      const ok = await fetch(`${base}/files?path=${encodeURIComponent(join(root, "sub", "ok.txt"))}`);
      expect(ok.status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("echoes CORS only for an allowed origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "codesurf-cors-"));
    writeFileSync(join(root, "a.txt"), "a");
    const { server, base } = await serve([root], ["http://localhost:5173"]);
    const url = `${base}/files?path=${encodeURIComponent(join(root, "a.txt"))}`;
    try {
      const allowed = await fetch(url, { headers: { origin: "http://localhost:5173" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      const other = await fetch(url, { headers: { origin: "https://evil.example" } });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
