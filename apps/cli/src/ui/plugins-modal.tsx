import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { PluginListEntry } from "../core/plugins";
import { useIcon } from "../core/plugins";
import { ToggleSwitch } from "./controls/toggle-switch";
import type { Theme } from "./theme";

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export interface PluginsRow {
  extension: PluginListEntry;
  kind: "group" | "extension";
  depth: number;
  expanded?: boolean;
  members?: PluginListEntry[];
  parentGroupId?: string;
}

type HostPluginGroup = NonNullable<PluginListEntry["group"]>;

const BUILTIN_EXTENSION_GROUPS = {
  core: {
    id: "codesurf.core",
    name: "Core Plugins",
    description: "Protected runtime capabilities required by the app.",
    order: -100,
  },
  providers: {
    id: "codesurf.providers",
    name: "CodeSurf Providers",
    description: "Model and agent providers shipped with CodeSurf.",
    order: 10,
  },
  workflows: {
    id: "codesurf.workflows",
    name: "Workflows & Agents",
    description: "Planning, routing, orchestration, and agent workflow plugins.",
    order: 20,
  },
  integrations: {
    id: "codesurf.integrations",
    name: "Integrations",
    description: "External service, transport, and account integrations.",
    order: 30,
  },
  interface: {
    id: "codesurf.interface",
    name: "Interface",
    description: "Screens, chrome, indicators, icons, and interaction surfaces.",
    order: 40,
  },
  tools: {
    id: "codesurf.tools",
    name: "Tools & Commands",
    description: "Tooling and slash-command plugins.",
    order: 50,
  },
  knowledge: {
    id: "codesurf.knowledge",
    name: "Knowledge",
    description: "Knowledge, skills, and contextual assistance plugins.",
    order: 60,
  },
  utilities: {
    id: "codesurf.utilities",
    name: "Utilities",
    description: "Supporting built-in plugins.",
    order: 70,
  },
} satisfies Record<string, HostPluginGroup>;

function matchesQuery(ext: Pick<PluginListEntry, "id" | "title" | "description">, query: string): boolean {
  return (
    ext.id.toLowerCase().includes(query) ||
    ext.title.toLowerCase().includes(query) ||
    (ext.description?.toLowerCase().includes(query) ?? false)
  );
}

function inferredBuiltinGroup(ext: PluginListEntry): HostPluginGroup | undefined {
  if (ext.group) return ext.group;
  if (ext.source !== "builtin" || !ext.id.startsWith("builtin.")) return undefined;

  const id = ext.id.toLowerCase();
  if (ext.protected) return BUILTIN_EXTENSION_GROUPS.core;
  if (id.startsWith("builtin.provider-") || ext.models > 0) return BUILTIN_EXTENSION_GROUPS.providers;
  if (/(workflow|workflows|loop|auto-mode|subagent|agent|routing|plan)/.test(id)) {
    return BUILTIN_EXTENSION_GROUPS.workflows;
  }
  if (/(telegram|payments|schedule|mcp|lsp)/.test(id)) return BUILTIN_EXTENSION_GROUPS.integrations;
  if (/(knowledge|skills|context)/.test(id)) return BUILTIN_EXTENSION_GROUPS.knowledge;
  if (/(\.ui\.|footer|icons|voice|pets|viewer|editor|files)/.test(id)) {
    return BUILTIN_EXTENSION_GROUPS.interface;
  }
  if (ext.tools > 0 || ext.commands > 0 || id.includes(".tools") || id.includes(".commands")) {
    return BUILTIN_EXTENSION_GROUPS.tools;
  }
  return BUILTIN_EXTENSION_GROUPS.utilities;
}

function rankExtension(ext: PluginListEntry): number {
  if (ext.protected) return 0;
  if (ext.enabled) return 1;
  return 2;
}

function groupSummary(group: NonNullable<PluginListEntry["group"]>, members: PluginListEntry[]): PluginListEntry {
  const toggleable = members.filter((member) => !member.protected);
  const protectedGroup = toggleable.length === 0;
  const enabled = protectedGroup
    ? members.every((member) => member.enabled)
    : toggleable.every((member) => member.enabled);
  const active = members.some((member) => member.active);
  const source = members.every((member) => member.source === "builtin") ? "builtin" : "user";
  const commands = members.reduce((sum, member) => sum + member.commands, 0);
  const tools = members.reduce((sum, member) => sum + member.tools, 0);
  const models = members.reduce((sum, member) => sum + member.models, 0);
  const failed = members.find((member) => member.error || member.status === "failed");

  return {
    id: group.id,
    title: group.name,
    description: group.description,
    source,
    enabled,
    active,
    status: failed ? "failed" : active ? "active" : "inactive",
    protected: protectedGroup,
    hidden: false,
    commands,
    tools,
    models,
    error: failed?.error,
  };
}

export function buildExtensionsRows(
  extensions: PluginListEntry[],
  query: string,
  expandedGroupIds: ReadonlySet<string> = new Set(),
): PluginsRow[] {
  const q = query.trim().toLowerCase();
  const visible = extensions.filter((ext) => !ext.hidden);

  const groupBuckets = new Map<
    string,
    { group: NonNullable<PluginListEntry["group"]>; members: Array<{ ext: PluginListEntry; index: number }> }
  >();
  const ungrouped: Array<{ ext: PluginListEntry; index: number }> = [];

  visible.forEach((ext, index) => {
    const group = inferredBuiltinGroup(ext);
    if (!group) {
      ungrouped.push({ ext, index });
      return;
    }
    const bucket = groupBuckets.get(group.id) ?? { group, members: [] };
    bucket.members.push({ ext, index });
    groupBuckets.set(group.id, bucket);
  });

  const topLevel: Array<{
    row: PluginsRow;
    index: number;
    rank: number;
    order: number;
    childRows?: PluginsRow[];
  }> = [];

  for (const item of ungrouped) {
    if (q && !matchesQuery(item.ext, q)) continue;
    topLevel.push({
      row: { kind: "extension", extension: item.ext, depth: 0 },
      index: item.index,
      rank: rankExtension(item.ext),
      order: 0,
    });
  }

  for (const bucket of groupBuckets.values()) {
    const members = bucket.members.map((item) => item.ext);
    const summary = groupSummary(bucket.group, members);
    const groupMatches = q ? matchesQuery(summary, q) : false;
    const matchingMembers = q ? bucket.members.filter((item) => matchesQuery(item.ext, q)) : bucket.members;
    if (q && !groupMatches && matchingMembers.length === 0) continue;

    const expanded = q.length > 0 || expandedGroupIds.has(bucket.group.id);
    const childSource = groupMatches ? bucket.members : matchingMembers;
    const childRows = expanded
      ? childSource.map(({ ext }) => ({
          kind: "extension" as const,
          extension: ext,
          depth: 1,
          parentGroupId: bucket.group.id,
        }))
      : [];

    topLevel.push({
      row: {
        kind: "group",
        extension: summary,
        depth: 0,
        expanded,
        members,
      },
      index: Math.min(...bucket.members.map((item) => item.index)),
      rank: rankExtension(summary),
      order: bucket.group.order ?? 0,
      childRows,
    });
  }

  // Stable sort: protected first, then enabled, then the rest. Group order is
  // a secondary presentation hint; registration order still breaks ties.
  return topLevel
    .sort((a, b) => {
      const diff = a.rank - b.rank;
      if (diff !== 0) return diff;
      const orderDiff = a.order - b.order;
      return orderDiff !== 0 ? orderDiff : a.index - b.index;
    })
    .flatMap((item) => [item.row, ...(item.childRows ?? [])]);
}

function formatCounts(ext: PluginListEntry): string {
  const parts: string[] = [];
  if (ext.tools > 0) parts.push(`${ext.tools} tool${ext.tools === 1 ? "" : "s"}`);
  if (ext.commands > 0) parts.push(`${ext.commands} cmd${ext.commands === 1 ? "" : "s"}`);
  if (ext.models > 0) parts.push(`${ext.models} model${ext.models === 1 ? "" : "s"}`);
  return parts.join(" · ") || "—";
}

/**
 * The type badge on a plugin row.
 *
 * Three kinds share this list and a user needs to tell them apart: CodeSurf's
 * own native plugins, third-party Cordis plugins mounted from npm, and Claude
 * Code plugins discovered on disk. Labelling them all "builtin" hid where a
 * command actually came from.
 */
function pluginKind(ext: PluginListEntry): string {
  if (ext.id.startsWith("external.")) return "cordis";
  if (ext.id === "builtin.claude-plugins") return "claude";
  return ext.source === "builtin" ? "builtin" : "user";
}

function formatExtensionStatus(ext: PluginListEntry): string {
  const source = pluginKind(ext);
  const status = ext.status ?? (ext.active ? "active" : "inactive");
  if (ext.error || status === "failed") return `${source} · failed`;
  if (status === "activating") return `${source} · activating`;
  return source;
}

export function ExtensionsBrowserModal({
  t,
  width,
  height,
  selectedIndex,
  searchQuery,
  rows,
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  searchQuery: string;
  rows: PluginsRow[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  const pluginsIcon = useIcon("extensions");
  const searchIcon = useIcon("search");
  const hintIcon = useIcon("hint");

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;
    listRef.current?.scrollChildIntoView(`ext-${selected.extension.id}`);
  }, [rows, selectedIndex]);

  // Chrome is 9 rows, not 7 — the same undercount that made /agents render an
  // empty box: border (2) + panel padding (2) + title (1) + search block (2) +
  // footer (1) + the scrollbox's paddingTop (1). Each plugin row is two lines
  // (name, then description), hence `* 2`.
  const PLUGIN_ROW_LINES = 2;
  const CHROME_ROWS = 9;
  // A floor as well as a cap. Sizing purely to content left a filtered list of
  // one or two rows with a viewport barely taller than a single line, so the
  // match scrolled half out of view and looked like it had not rendered.
  const MIN_LIST_LINES = 8;
  const itemCount = Math.max(rows.length, 1);
  const contentHeight = itemCount * PLUGIN_ROW_LINES + CHROME_ROWS;
  const maxHeight = Math.floor(height * 0.68);
  const panelHeight = Math.min(Math.max(contentHeight, MIN_LIST_LINES + CHROME_ROWS), maxHeight);
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={bottomAlignedModalTop(height, panelHeight)}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(96, width - 4)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={t.accent}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>
              {pluginsIcon ? `${pluginsIcon} ` : ""}
              {"Plugins"}
            </b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>
            {searchIcon ? `${searchIcon} ` : ""}
            {searchQuery || <span style={{ fg: t.textMuted }}>{"Search plugins..."}</span>}
          </text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {rows.length === 0 ? (
            <box paddingLeft={2} paddingRight={2}>
              <text fg={t.textMuted}>{searchQuery ? "No plugins match your search." : "No plugins registered."}</text>
            </box>
          ) : (
            rows.map((row, idx) => {
              const selected = idx === selectedIndex;
              const ext = row.extension;
              const enabled = ext.enabled;
              const enabledColor = enabled ? t.diffAddedFg : selected ? t.selected : t.text;
              const disclosure = row.kind === "group" ? (row.expanded ? "▾" : "▸") : row.depth > 0 ? " " : "";
              const countLabel =
                row.kind === "group" && row.members
                  ? `${row.members.filter((member) => member.enabled).length}/${row.members.length} on`
                  : null;
              const rowBg = selected ? t.selectedBg : t.backgroundPanel;
              return (
                <box
                  key={`${row.kind}-${ext.id}`}
                  id={`ext-${ext.id}`}
                  // Explicitly column: without it the name row and the
                  // description row laid out side by side on ONE line and
                  // painted over each other, which read as garbled text.
                  flexDirection="column"
                  backgroundColor={rowBg}
                  paddingLeft={2 + row.depth * 2}
                  paddingRight={2}
                >
                  {/*
                    Every `<text>` carries its OWN opaque background, not just
                    the row box. Without it the transcript behind the modal
                    shows through the gaps between sibling texts in a flex row
                    and the line renders as two strings interleaved.
                  */}
                  <box flexDirection="row" justifyContent="space-between">
                    <box flexDirection="row" gap={1}>
                      {disclosure ? (
                        <text fg={selected ? t.accent : t.textMuted} bg={rowBg}>
                          {disclosure}
                        </text>
                      ) : null}
                      <ToggleSwitch t={t} value={enabled} selected={selected} disabled={ext.protected} />
                      <text fg={enabledColor} bg={rowBg}>
                        {ext.title}
                        {ext.protected ? <span style={{ fg: t.textMuted }}>{" (protected)"}</span> : null}
                        {countLabel ? <span style={{ fg: t.textMuted }}>{`  ${countLabel}`}</span> : null}
                      </text>
                    </box>
                    <text fg={enabled ? t.diffAddedFg : t.textMuted} bg={rowBg}>
                      {formatExtensionStatus(ext)}
                    </text>
                  </box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={t.textMuted} bg={rowBg}>
                      {ext.error ? ext.error : (ext.description ?? ext.id)}
                    </text>
                    <text fg={t.textMuted} bg={rowBg}>
                      {formatCounts(ext)}
                    </text>
                  </box>
                </box>
              );
            })
          )}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.textMuted }}>{hintIcon ? `${hintIcon} ` : ""}</span>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"toggle  ·  "}</span>
            <span style={{ fg: t.primary }}>{"←/→ "}</span>
            <span style={{ fg: t.textMuted }}>{"collapse/expand  ·  "}</span>
            <span style={{ fg: t.primary }}>{"type "}</span>
            <span style={{ fg: t.textMuted }}>{"filter  ·  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}
