// ToolCallBlockList — Grok Build-style status-glyph rows for committed tool
// calls when `render.toolCalls.panel` is enabled. Each line shows the tool,
// path/detail, and optional hook + skill tags.

import { memo, useEffect, useMemo, useState } from "react";
import { useIcon } from "../../core/plugins";
import type { Theme } from "../theme";
import type { ToolCallRecord, ToolCallStatus } from "./tool-calls-collation";

const BULLET = "◆";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i;

/** Default visible rows before the top collapses into "N more". */
export const BLOCK_LIST_VISIBLE_MAX = 8;

function argRecord(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

function argString(args: unknown, key: string): string {
  const rec = argRecord(args);
  const v = rec?.[key];
  return typeof v === "string" ? v : "";
}

function argNumber(args: unknown, key: string): number | undefined {
  const rec = argRecord(args);
  const v = rec?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Short hint from tool output — e.g. "(no matches)" for empty grep results. */
export function formatOutputHint(toolName: string, output?: string): string | undefined {
  if (!output) return undefined;
  const trimmed = output.trim();
  if (!trimmed) return "(no output)";

  const lower = trimmed.toLowerCase();
  if (lower.includes("no matches") || lower === "found 0 matches") return "(no matches)";
  if (toolName === "grep" || toolName === "Grep") {
    const m = trimmed.match(/found\s+(\d+)\s+match/i);
    if (m && m[1] === "0") return "(no matches)";
  }
  return undefined;
}

/** Parse `Found 4 matches` + file headers into `(4 matches in 3 files)`. */
export function parseGrepMatchSummary(output?: string): string | undefined {
  if (!output) return undefined;
  const trimmed = output.trim();
  if (/no matches found/i.test(trimmed)) return "(no matches)";

  const found = trimmed.match(/Found (\d+) match/i);
  if (!found) return undefined;
  const matchCount = Number(found[1]);
  if (matchCount === 0) return "(no matches)";

  const files = new Set<string>();
  for (const line of trimmed.split("\n")) {
    if (/^[^\s].*:$/.test(line) && !line.startsWith("Found") && !line.startsWith("(")) {
      files.add(line.slice(0, -1));
    }
  }
  const fileCount = files.size;
  if (fileCount > 0) {
    return `(${matchCount} match${matchCount === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"})`;
  }
  return `(${matchCount} match${matchCount === 1 ? "" : "es"})`;
}

/** Parse `[path: lines 701-750 of 7351]` from read_file output. */
export function parseReadRangeFromOutput(output?: string): { start: number; end: number; total?: number } | undefined {
  if (!output) return undefined;
  const m = output.match(/lines\s+(\d+)-(\d+)\s+of\s+(\d+)/i);
  if (!m) return undefined;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

function formatReadRange(range: { start: number; end: number; total?: number }, includeTotal = false): string {
  const base = range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
  return includeTotal && range.total ? `${base} of ${range.total}` : base;
}

export function formatThoughtLabel(durationMs: number): string {
  const secs = Math.max(0.1, durationMs / 1000);
  const text = secs < 10 ? secs.toFixed(1) : String(Math.round(secs));
  return `Thought for ${text}s`;
}

/** Insert synthetic Thought rows when consecutive tools are separated by a gap. */
export function expandBlockListRecords(records: ToolCallRecord[], thoughtGapMs = 1_000): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const cur = records[i]!;
    if (i > 0) {
      const prev = records[i - 1]!;
      const prevTs = prev.timestamp?.getTime();
      const curTs = cur.timestamp?.getTime();
      if (prevTs !== undefined && curTs !== undefined) {
        const gap = curTs - prevTs;
        if (gap >= thoughtGapMs) {
          out.push({
            id: `thought-${prev.id}-${cur.id}`,
            toolName: "Thought",
            rawToolName: "reasoning",
            status: "done",
            durationMs: gap,
            timestamp: cur.timestamp,
          });
        }
      }
    }
    out.push(cur);
  }
  return out;
}

export function collapseBlockListCalls(
  calls: ToolCallRecord[],
  maxVisible = BLOCK_LIST_VISIBLE_MAX,
): { hiddenCount: number; visible: ToolCallRecord[] } {
  if (calls.length <= maxVisible) return { hiddenCount: 0, visible: calls };
  const hiddenCount = calls.length - maxVisible;
  return { hiddenCount, visible: calls.slice(-maxVisible) };
}

function formatSearchLabel(record: ToolCallRecord): string {
  const pattern = argString(record.args, "pattern");
  const scope = argString(record.args, "path");
  const hint = parseGrepMatchSummary(record.output) ?? formatOutputHint(record.rawToolName ?? "grep", record.output);
  let label = `Search "${pattern}"`;
  if (scope) label += ` in ${scope}`;
  if (hint) label += ` ${hint}`;
  return label;
}

function formatReadLabel(record: ToolCallRecord): string {
  const path =
    argString(record.args, "path") || argString(record.args, "file_path") || argString(record.args, "filePath");
  const imageSuffix = IMAGE_EXT_RE.test(path) ? " (image)" : "";

  const startLine = argNumber(record.args, "start_line");
  const endLine = argNumber(record.args, "end_line");
  if (startLine !== undefined || endLine !== undefined) {
    const start = startLine ?? 1;
    const end = endLine ?? start;
    return `Read ${formatReadRange({ start, end })} in "${path}"${imageSuffix}`;
  }

  const range = parseReadRangeFromOutput(record.output);
  if (range) return `Read ${formatReadRange(range)} in "${path}"${imageSuffix}`;

  return `Read "${path}"${imageSuffix}`;
}

/** Primary label after the bullet: `Read "path"`, `Search "pattern" in src`, etc. */
export function formatBlockListLabel(record: ToolCallRecord): string {
  const raw = record.rawToolName ?? record.toolName;
  const name = record.toolName;

  if (name === "Thought" || raw === "reasoning") {
    return formatThoughtLabel(record.durationMs ?? 1_000);
  }

  if (name.startsWith("skill:")) {
    return `Skill ${name.slice("skill:".length)}`;
  }

  if (raw === "skills_loaded" || name === "Skills") {
    const skills = record.skills;
    if (skills && skills.length > 0) return `Skills ${skills.join(", ")}`;
    return "Skills loaded";
  }

  if (raw === "grep" || name === "Grep") {
    return formatSearchLabel(record);
  }

  const path =
    argString(record.args, "path") || argString(record.args, "file_path") || argString(record.args, "filePath");
  if (path && (raw === "read_file" || name === "Read")) {
    return formatReadLabel(record);
  }
  if (path) {
    const verb =
      name === "Write" || raw === "write_file" ? "Write" : name === "Edit" || raw === "edit_file" ? "Edit" : "Read";
    return `${verb} "${path}"`;
  }

  const pattern = argString(record.args, "pattern");
  if (pattern) {
    const hint = formatOutputHint(raw, record.output);
    const base = `${name} "${pattern}"`;
    return hint ? `${base} ${hint}` : base;
  }

  const command = argString(record.args, "command");
  if (command) return `${name} ${command}`;

  const query = argString(record.args, "query") || argString(record.args, "search_term");
  if (query) return `${name} "${query}"`;

  const url = argString(record.args, "url");
  if (url) return `${name} ${url}`;

  if (record.detail) return `${name} ${record.detail}`;

  return name;
}

export function formatBlockListMeta(record: ToolCallRecord): string {
  if (record.toolName === "Thought" || record.rawToolName === "reasoning") return "";

  const parts: string[] = [];
  if (record.skills && record.skills.length > 0 && !record.toolName.startsWith("skill:")) {
    const label = record.skills.length === 1 ? "skill" : "skills";
    parts.push(`[${label}: ${record.skills.join(", ")}]`);
  }
  const hooks = record.hooksCount ?? 0;
  if (hooks > 0) parts.push(`[hooks: ${hooks}]`);
  return parts.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatDurationMs(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(2)}s`;
}

function useBrailleFrame(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0]!;
}

export function formatBlockListStatusGlyph(
  status: ToolCallStatus,
  icons: { check?: string | null; error?: string | null },
  runningFrame = SPINNER_FRAMES[0]!,
): string {
  switch (status) {
    case "running":
      return runningFrame;
    case "done":
      return icons.check || "✓";
    case "error":
      return icons.error || "✗";
    default:
      return BULLET;
  }
}

function statusColor(t: Theme, status: ToolCallStatus): string {
  switch (status) {
    case "running":
      return t.accent;
    case "done":
      return t.diffAddedFg;
    case "error":
      return t.diffRemovedFg;
    default:
      return t.textMuted;
  }
}

function formatStructuredOutputEnvelope(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const output = typeof value.output === "string" ? value.output.trimEnd() : "";
  const meta: string[] = [];

  if (typeof value.exitCode === "number") meta.push(`exit ${value.exitCode}`);
  if (typeof value.status === "string" && value.status) meta.push(value.status);
  const duration = formatDurationMs(value.durationMs);
  if (duration) meta.push(duration);

  if (output) return meta.length > 0 ? `${output}\n${meta.join(" · ")}` : output;
  if (meta.length > 0) return meta.join(" · ");
  return undefined;
}

export function formatBlockListExpandedDetail(record: ToolCallRecord): string {
  const raw = (record.error || record.output || "").trim();
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    const envelope = formatStructuredOutputEnvelope(parsed);
    if (envelope) return envelope;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

export function ToolCallBlockRow({
  t,
  record,
  expanded: controlledExpanded,
  onToggle,
}: {
  t: Theme;
  record: ToolCallRecord;
  expanded?: boolean;
  onToggle?: (id: string) => void;
}) {
  // Uncontrolled fallback so each row can expand on its own when the list
  // owner doesn't thread expansion state.
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const effectiveToggle = onToggle ?? (() => setLocalExpanded((v) => !v));

  const label = formatBlockListLabel(record);
  const meta = formatBlockListMeta(record);
  const runningFrame = useBrailleFrame(record.status === "running");
  const checkIcon = useIcon("check");
  const errorIcon = useIcon("error");
  const statusGlyph = formatBlockListStatusGlyph(record.status, { check: checkIcon, error: errorIcon }, runningFrame);
  const glyphColor = statusColor(t, record.status);

  // The collapsed line shows just `tool + path/detail` (single line, clipped).
  // A row has "more" to reveal when it carries output or an error.
  const detail = formatBlockListExpandedDetail(record);
  const clickable = detail.length > 0;

  return (
    <box
      width="100%"
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      onMouseDown={clickable ? () => effectiveToggle(record.id) : undefined}
    >
      <box width="100%" flexDirection="row" alignItems="flex-start" flexShrink={0} gap={1} overflow="hidden">
        <box width={1} flexShrink={0}>
          <text fg={glyphColor} wrapMode="none">
            {statusGlyph}
          </text>
        </box>
        <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <text fg={t.textMuted} wrapMode={expanded ? "word" : "none"}>
            {label}
            {meta ? ` ${meta}` : ""}
          </text>
        </box>
      </box>
      {expanded && clickable ? (
        <box width="100%" paddingLeft={2} flexShrink={0} overflow="hidden">
          <text fg={record.error ? t.diffRemovedFg : t.textDim} wrapMode="word">
            {detail}
          </text>
        </box>
      ) : null}
    </box>
  );
}

export const ToolCallBlockList = memo(function ToolCallBlockList({
  t,
  calls,
  maxVisible = BLOCK_LIST_VISIBLE_MAX,
}: {
  t: Theme;
  calls: ToolCallRecord[];
  maxVisible?: number;
}) {
  const { hiddenCount, visible } = useMemo(() => {
    const expanded = expandBlockListRecords(calls);
    return collapseBlockListCalls(expanded, maxVisible);
  }, [calls, maxVisible]);

  if (calls.length === 0) return null;

  return (
    <box width="100%" flexDirection="column" gap={0} overflow="hidden">
      {hiddenCount > 0 ? (
        <text fg={t.textMuted} wrapMode="none">
          {`${hiddenCount} more`}
        </text>
      ) : null}
      {visible.map((call) => (
        <ToolCallBlockRow key={call.id} t={t} record={call} />
      ))}
    </box>
  );
});
