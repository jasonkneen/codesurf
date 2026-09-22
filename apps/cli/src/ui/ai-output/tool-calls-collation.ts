// Pure types + chip-collation algorithm for tool-calls.tsx.
//
// Lives in a JSX-free `.ts` sibling so vitest can import the algorithm
// without transitively pulling in `@opentui/core` runtime values (Markdown,
// SyntaxStyle, RGBA) — those bring `bun:` URL imports that vitest's default
// node loader can't resolve. The `.tsx` chip components import their
// types/helpers from here and re-export everything for backward compat.
//
// The algorithm itself is documented inline on `deriveChipDisplay` below.

import { loadUserSettings } from "../../utils/settings";

export type ToolCallStatus = "pending" | "running" | "done" | "error";

export interface ToolCallRecord {
  id: string;
  toolName: string;
  status: ToolCallStatus;
  args?: unknown;
  output?: string;
  durationMs?: number;
  error?: string;
  /** Wire-level tool name before friendly renaming (e.g. `read_file`, `skill:opentui`). */
  rawToolName?: string;
  /** Secondary detail when path/pattern heuristics do not apply. */
  detail?: string;
  timestamp?: Date;
  /** Configured or executed hook count — drives `[hooks: n]` in block-list mode. */
  hooksCount?: number;
  /** Skill names associated with this call — drives `[skill: …]` tags. */
  skills?: string[];
}

/** Compact duration shown on finished chips and list rows. */
export function formatChipDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

/** Duration label for one compact chip, or null if it should stay bare. */
export function compactChipDurationLabel(status: ToolCallStatus, durationMs?: number): string | null {
  if (status !== "done" || durationMs === undefined) return null;
  return formatChipDuration(durationMs);
}

/** Duration on a grouped chip: the slowest finished member. */
export function compactGroupDurationLabel(
  calls: readonly Pick<ToolCallRecord, "status" | "durationMs">[],
): string | null {
  let max: number | undefined;
  for (const call of calls) {
    if (call.status !== "done" || call.durationMs === undefined) continue;
    max = max === undefined ? call.durationMs : Math.max(max, call.durationMs);
  }
  return max === undefined ? null : formatChipDuration(max);
}

// ---------------------------------------------------------------------------
// Chip collation — two-tier collapse for noisy tool-call rows.
// ---------------------------------------------------------------------------
//
//   Tier 1 — group by tool name. When a single tool has CHIP_GROUP_THRESHOLD
//            (3) or more `done` chips, those chips merge into one `3xBASH ✓`
//            chip. Tools below the threshold stay as individual chips.
//   Tier 2 — category collapse. When CHIP_MEGA_THRESHOLD (3) or more tier-1
//            group chips exist, they roll up into one chip PER CATEGORY —
//            \`[Tools ×N]\` \`[Files ×N]\` \`[Web ×N]\` — so bulk history compresses
//            into top-level category chips instead of one catch-all. The
//            old behavior (a single mega collapse. When CHIP_MEGA_THRESHOLD (3) or more tier-1 group
//            chips would otherwise render, they all roll up into a single
//            `12xTOOLS ✓` chip whose count is the sum of the grouped chips.
//
// Status escapes: `running`, `error`, and `pending` chips never collapse —
// the user must always see the spinner / red ✗ / queued state. Same applies
// to loose `done` chips (count below the per-tool threshold).
//
// Click any group/mega chip to explode it back to its parts:
//   • mega → its tier-1 group chips
//   • group → its individual chips
// Detail panels (args/output) still belong to individual chips only — to
// inspect a single call inside a collapsed group, drill mega → group →
// individual, then click the individual chip.

export const CHIP_GROUP_THRESHOLD = 3;
export const CHIP_MEGA_THRESHOLD = 3;

export const CATEGORY_ID_PREFIX = "__category:";
export const GROUP_ID_PREFIX = "__group:";

export type CategorizeFn = (toolName: string) => string;

const CATEGORY_BY_TOOL: Record<string, string> = {
  bash: "Shell",
  read_file: "Files",
  read_directory: "Files",
  write_file: "Files",
  edit_file: "Files",
  glob: "Files",
  grep: "Files",
  web_search: "Web",
  web_fetch: "Web",
  read_image: "Media",
};
export const DEFAULT_CATEGORIZE: CategorizeFn = (toolName) => CATEGORY_BY_TOOL[toolName] ?? "Tools";

let categorizeFn: CategorizeFn = DEFAULT_CATEGORIZE;
let categoriesLoaded = false;
function ensureCategoriesLoaded(): void {
  if (categoriesLoaded) return;
  categoriesLoaded = true;
  try {
    const settings = loadUserSettings();
    if (settings.chipCategories) {
      const map = settings.chipCategories;
      categorizeFn = (name) => map[name] ?? DEFAULT_CATEGORIZE(name);
    }
  } catch {
    categorizeFn = DEFAULT_CATEGORIZE;
  }
}
/** Category resolver (tool name → top-level category), honoring user settings. */
export function getCategorize(): CategorizeFn {
  ensureCategoriesLoaded();
  return categorizeFn;
}

export type ChipDisplayItem =
  | { kind: "individual"; call: ToolCallRecord }
  | {
      kind: "group";
      id: string;
      toolName: string;
      calls: ToolCallRecord[];
      /** True when this group is currently exploded — its individual chips
       *  follow it in the item list. The summary chip stays visible so the
       *  user has somewhere to click to re-collapse. */
      expanded: boolean;
    }
  | {
      kind: "category";
      id: string;
      category: string;
      calls: ToolCallRecord[];
      groupCount: number;
      /** True when the category is exploded — its tier-1 group chips follow
       *  it in the item list. The summary chip stays visible so the user has
       *  somewhere to click to re-collapse. */
      expanded: boolean;
    };

/**
 * deriveChipDisplay — pure function that turns a flat call list plus the
 * caller's expansion state into the ordered list of items the chip row should
 * render. Exported so the algorithm can be unit tested without mounting React.
 *
 * Ordering contract:
 *   1. Mega chip OR tier-1 group chips (in first-seen-tool-name order)
 *   2. Loose done chips, in original chronological order
 *   3. Running chips, in original chronological order
 *   4. Errored chips, in original chronological order
 *   5. Pending chips, in original chronological order
 *
 * The "summary first, live action last" order keeps the spinner and any new
 * errors visible at the right edge while bulk history compresses on the left.
 */
export function deriveChipDisplay(calls: ToolCallRecord[], explodedGroups: ReadonlySet<string>): ChipDisplayItem[] {
  const running: ToolCallRecord[] = [];
  const errors: ToolCallRecord[] = [];
  const pending: ToolCallRecord[] = [];
  const done: ToolCallRecord[] = [];
  for (const c of calls) {
    if (c.status === "running") running.push(c);
    else if (c.status === "error") errors.push(c);
    else if (c.status === "pending") pending.push(c);
    else done.push(c);
  }

  // Bucket done chips by tool name — Map insertion order preserves
  // first-seen-tool-name order for deterministic group placement.
  const doneByTool = new Map<string, ToolCallRecord[]>();
  for (const c of done) {
    const list = doneByTool.get(c.toolName);
    if (list) list.push(c);
    else doneByTool.set(c.toolName, [c]);
  }

  // Split into "groupable" (>= per-tool threshold) and "loose" (below).
  const groupable: { toolName: string; calls: ToolCallRecord[] }[] = [];
  const looseIds = new Set<string>();
  for (const [toolName, list] of doneByTool) {
    if (list.length >= CHIP_GROUP_THRESHOLD) {
      groupable.push({ toolName, calls: list });
    } else {
      for (const c of list) looseIds.add(c.id);
    }
  }

  const items: ChipDisplayItem[] = [];
  const categorize = categorizeFn;

  // Bucket groupable tier-1 groups by top-level category (first-seen order).
  const groupsByCategory = new Map<string, typeof groupable>();
  for (const g of groupable) {
    const cat = categorize(g.toolName);
    const list = groupsByCategory.get(cat) ?? [];
    list.push(g);
    groupsByCategory.set(cat, list);
  }

  // Category collapse: when CHIP_MEGA_THRESHOLD (3) or more groupable tools
  // exist, each category with one or more groups rolls up into a
  // `[Category ×N]` chip (`[Tools ×7]` `[Files ×3]` …). One category →
  // one chip; mixed categories → one chip each; below threshold → tier-1
  // groups render normally.
  const categoryActive = groupable.length >= CHIP_MEGA_THRESHOLD;

  if (categoryActive) {
    for (const [cat, groups] of groupsByCategory) {
      const categoryId = `${CATEGORY_ID_PREFIX}${cat}`;
      const categoryExploded = explodedGroups.has(categoryId);
      items.push({
        kind: "category",
        id: categoryId,
        category: cat,
        calls: groups.flatMap((g) => g.calls),
        groupCount: groups.length,
        expanded: categoryExploded,
      });
      if (categoryExploded) {
        // Category explodes into its tier-1 group chips (each expandable).
        for (const g of groups) {
          const groupId = `${GROUP_ID_PREFIX}${g.toolName}`;
          const groupExploded = explodedGroups.has(groupId);
          items.push({ kind: "group", id: groupId, toolName: g.toolName, calls: g.calls, expanded: groupExploded });
          if (groupExploded) {
            for (const c of g.calls) items.push({ kind: "individual", call: c });
          }
        }
      }
    }
  } else {
    // Below the collapse threshold: tier-1 groups render normally.
    for (const g of groupable) {
      const groupId = `${GROUP_ID_PREFIX}${g.toolName}`;
      const groupExploded = explodedGroups.has(groupId);
      items.push({ kind: "group", id: groupId, toolName: g.toolName, calls: g.calls, expanded: groupExploded });
      if (groupExploded) {
        for (const c of g.calls) items.push({ kind: "individual", call: c });
      }
    }
  }

  // Loose done chips, preserving original chronological order from `calls`.
  for (const c of done) {
    if (looseIds.has(c.id)) items.push({ kind: "individual", call: c });
  }
  for (const c of running) items.push({ kind: "individual", call: c });
  for (const c of errors) items.push({ kind: "individual", call: c });
  for (const c of pending) items.push({ kind: "individual", call: c });

  return items;
}
