// Enforced dependency direction for the workspace packages.
//
// The migration plan's acceptance matrix says decoupled packages cannot be
// claimed by "moving files while retaining host-relative imports". This test is
// that gate: it reads the package sources and fails if the boundary is crossed,
// so the direction survives future edits rather than depending on reviewer
// vigilance.
//
// Direction: plugin-api -> (cordis only); runtime -> plugin-api, cordis; host
// code may depend on both. Nothing in either package may reach into `src/`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_API = path.join(PACKAGES_DIR, "plugin-api");
const RUNTIME = path.join(PACKAGES_DIR, "runtime");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(path.join(dir, "src"));
  return out;
}

/** Every module specifier imported by a file, including type-only imports. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) specifiers.push(match[1]);
  }
  // `declare module "x"` augmentations are a dependency too.
  for (const match of source.matchAll(/declare\s+module\s+["']([^"']+)["']/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function allImports(dir: string): Array<{ file: string; specifier: string }> {
  return sourceFiles(dir).flatMap((file) =>
    importsOf(file).map((specifier) => ({ file: path.relative(PACKAGES_DIR, file), specifier })),
  );
}

describe("workspace package boundaries", () => {
  it("plugin-api depends on nothing but cordis, except React types in the ui entrypoint", () => {
    const offenders = allImports(PLUGIN_API).filter(
      ({ file, specifier }) =>
        !specifier.startsWith("@deepseek-ai/cordis") &&
        !specifier.startsWith(".") &&
        // The optional rendering entrypoint may name React's types; the import
        // is type-only, so the package still ships no React dependency and a
        // headless plugin importing the main entry never sees it.
        !(file.endsWith("src/ui.ts") && specifier === "react"),
    );
    expect(offenders).toEqual([]);
  });

  it("runtime depends only on plugin-api and cordis", () => {
    const allowed = ["@codesurf/plugin-api", "@deepseek-ai/cordis"];
    const offenders = allImports(RUNTIME).filter(
      ({ specifier }) =>
        !specifier.startsWith(".") &&
        // Node builtins are the platform, not a dependency: they add nothing to
        // package.json and cannot drag the host in. The rule this guards is
        // "no third-party packages, no reaching into src/".
        !specifier.startsWith("node:") &&
        !allowed.some((name) => specifier.startsWith(name)),
    );
    expect(offenders).toEqual([]);
  });

  it("neither package reaches into the host's src/ tree", () => {
    const offenders = [...allImports(PLUGIN_API), ...allImports(RUNTIME)].filter(
      ({ specifier }) => /(^|\/)\.\.\/\.\.\/src\//.test(specifier) || specifier.includes("/src/"),
    );
    expect(offenders).toEqual([]);
  });

  it("no package source imports host UI, the Agent, or a concrete tool", () => {
    // The named things the plan calls out. A structural contract is fine; an
    // import of the implementation is not.
    const forbidden = ["@opentui", "react", "ai", "zod", "../../src", "bun:sqlite"];
    const offenders = [...allImports(PLUGIN_API), ...allImports(RUNTIME)].filter(
      ({ file, specifier }) =>
        forbidden.some((name) => specifier === name || specifier.startsWith(`${name}/`)) &&
        !(file.endsWith("src/ui.ts") && specifier === "react"),
    );
    expect(offenders).toEqual([]);
  });

  it("declares its dependencies in package.json rather than relying on hoisting", () => {
    const readDeps = (dir: string) => {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      return Object.keys(manifest.dependencies ?? {});
    };
    expect(readDeps(PLUGIN_API)).toEqual(["@deepseek-ai/cordis"]);
    expect(readDeps(RUNTIME).sort()).toEqual(["@codesurf/plugin-api", "@deepseek-ai/cordis"]);
  });

  it("exposes a bun/types/default export map so Bun, Node and tsc all resolve it", () => {
    for (const dir of [PLUGIN_API, RUNTIME]) {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      const entry = manifest.exports?.["."];
      expect(Object.keys(entry)).toEqual(["bun", "types", "default"]);
      // Order matters: "bun" must precede "default" or Bun takes the built file.
      expect(entry.bun).toBe("./src/index.ts");
      expect(entry.types).toBe("./dist/index.d.ts");
      expect(entry.default).toBe("./dist/index.js");
    }
  });
});
