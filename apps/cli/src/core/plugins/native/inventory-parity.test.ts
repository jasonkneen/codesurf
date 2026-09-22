// The compatibility claim, enforced.
//
// `docs/recommendations/2026-09-05-codesurf-plugin-inventory.md` is the
// pre-conversion snapshot of all 48 built-ins: source, stable id, enabled-by-
// default, protected, declared capabilities. Those values key persisted state —
// the id keys a user's enable/disable opt-out, the defaults decide what happens
// on a config that has never recorded a preference — so the conversion's whole
// compatibility claim is "none of this moved".
//
// Reading the doc rather than restating them here is deliberate: a frozen copy
// in this file could drift from the record it is supposed to be checking, and a
// reviewer would have no way to tell which one was wrong.
//
// The table's Source column was repointed from `builtin/` to `native/` when the
// conversion completed; every other column is the original snapshot.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBuiltinPlugins } from "../builtin/index";

const INVENTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/recommendations/2026-09-05-codesurf-plugin-inventory.md",
);

interface InventoryRow {
  source: string;
  id: string;
  enabledByDefault: boolean | null;
  protected: boolean | null;
}

/** `absent` in the table means the manifest omitted the flag, not `false`. */
function flag(cell: string): boolean | null {
  if (cell === "true") return true;
  if (cell === "false") return false;
  return null;
}

function readInventory(): InventoryRow[] {
  const doc = readFileSync(INVENTORY, "utf8");
  const pattern = /\|\s*(src\/core\/plugins\/[^ |]+)\s*\|\s*"(builtin\.[^"]+)"\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|/g;
  return [...doc.matchAll(pattern)].map((match) => ({
    source: match[1] as string,
    id: match[2] as string,
    enabledByDefault: flag(match[3] as string),
    protected: flag(match[4] as string),
  }));
}

describe("catalog parity with the pre-conversion inventory", () => {
  it("still ships exactly the 48 stable ids the inventory recorded", async () => {
    const inventory = readInventory();
    expect(inventory).toHaveLength(48);

    // The inventory is a snapshot of the 48 built-ins that existed BEFORE the
    // Cordis conversion. What this guards is that none of them has been LOST or
    // renamed — not that the catalog has stopped growing. Asserting equality
    // instead would make the test fail every time a plugin is legitimately
    // added, which trains people to update the number without reading it.
    const live = new Set((await loadBuiltinPlugins()).map((module) => module.manifest.id));
    const missing = inventory.map((row) => row.id).filter((id) => !live.has(id));
    expect(missing).toEqual([]);
  });

  it("keeps every enabled-by-default and protected flag, which decide what a fresh config activates", async () => {
    const modules = await loadBuiltinPlugins();
    const byId = new Map(modules.map((module) => [module.manifest.id, module.manifest]));

    for (const row of readInventory()) {
      const manifest = byId.get(row.id);
      expect(manifest, `${row.id} is in the inventory but not in the catalog`).toBeDefined();
      // Compare EFFECTIVE values. The table records `absent` where a manifest
      // omitted a flag, and the loader reads both `absent` and `false` as
      // false, so a manifest that gained an explicit `protected: false` is a
      // declaration difference and not a behaviour one. Asserting on absence
      // would fail a harmless, correct declaration.
      // (One exists today: `builtin.tools.lsp`.)
      expect(manifest?.enabledByDefault ?? false, `${row.id} enabledByDefault`).toBe(row.enabledByDefault ?? false);
      expect(manifest?.protected ?? false, `${row.id} protected`).toBe(row.protected ?? false);
    }
  });

  it("points every inventory row at a file that exists", async () => {
    // The Source column is how a reader gets from the record to the code.
    for (const row of readInventory()) {
      const full = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..", row.source);
      expect(() => readFileSync(full, "utf8"), `${row.source} (for ${row.id})`).not.toThrow();
    }
  });
});
