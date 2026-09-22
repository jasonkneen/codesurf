import type { ChatEntry, SubagentStatus, ToolResult } from "../../types/index";
import { formatSubagentName } from "../../utils/subagent-display";
import { truncate } from "../../utils/text";
import { Markdown } from "../markdown";
import type { LocalFileLinkTarget } from "../markdown-links";
import type { Theme } from "../theme";
import { LoadingSpinner } from "./loading-spinner.js";

const USER_MSG_COLLAPSED_LINES = 5;

export function UserMessageContent({ content, t, expanded }: { content: string; t: Theme; expanded: boolean }) {
  const lines = content.split("\n");
  const isLong = lines.length > USER_MSG_COLLAPSED_LINES;

  if (!isLong) {
    return <text fg={t.text}>{content}</text>;
  }

  if (expanded) {
    return (
      <>
        <text fg={t.text}>{content}</text>
        <box marginTop={1}>
          <text fg={t.textDim}>
            {"ctrl+e "}
            <span style={{ fg: t.textMuted }}>{"collapse"}</span>
          </text>
        </box>
      </>
    );
  }

  const preview = lines.slice(0, USER_MSG_COLLAPSED_LINES).join("\n");
  const hiddenCount = lines.length - USER_MSG_COLLAPSED_LINES;
  return (
    <>
      <text fg={t.text}>{preview}</text>
      <box marginTop={1}>
        <text fg={t.textDim}>
          {"ctrl+e "}
          <span style={{ fg: t.textMuted }}>{`expand (${hiddenCount} more lines)`}</span>
        </text>
      </box>
    </>
  );
}

function compactTaskLabel(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 3) return label.trim() || "Working";
  return `${words.slice(0, 3).join(" ")}...`;
}

function truncateLine(s: string, n: number): string {
  return truncate(s.replace(/\s+/g, " ").trim(), n);
}

export function InlineTool({
  t,
  pending: _pending,
  children,
}: {
  t: Theme;
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <box paddingLeft={3}>
      <text fg={t.textMuted}>
        {"→ "}
        {children}
      </text>
    </box>
  );
}

export function SubagentTaskLine({
  t,
  agent,
  label,
  pending,
}: {
  t: Theme;
  agent: string;
  label: string;
  pending: boolean;
}) {
  const displayLabel = compactTaskLabel(label);
  const displayAgent = formatSubagentName(agent);

  return (
    <box paddingLeft={3}>
      <text>
        {pending ? (
          <span style={{ fg: t.subagentAccent }}>
            <LoadingSpinner />
          </span>
        ) : null}
        {pending ? " " : ""}
        <span style={{ fg: t.subagentAccent }}>
          <b>{`${displayAgent}: ${displayLabel}`}</b>
        </span>
      </text>
    </box>
  );
}

export function DelegationTaskLine({
  t,
  label,
  pending,
  id,
}: {
  t: Theme;
  label: string;
  pending: boolean;
  id?: string;
}) {
  const displayLabel = compactTaskLabel(label);

  return (
    <box paddingLeft={3}>
      <text>
        {pending ? (
          <span style={{ fg: t.subagentAccent }}>
            <LoadingSpinner />
          </span>
        ) : (
          <span style={{ fg: t.subagentAccent }}>{"◆"}</span>
        )}{" "}
        <span style={{ fg: t.subagentAccent }}>
          <b>{"Background"}</b>
        </span>
        <span style={{ fg: t.textMuted }}>
          {" — "}
          {displayLabel}
        </span>
        {id ? <span style={{ fg: t.textDim }}>{`  (${id})`}</span> : null}
      </text>
    </box>
  );
}

export function SubagentActivity({ t, status }: { t: Theme; status: SubagentStatus }) {
  return (
    <box paddingLeft={5}>
      <text fg={t.textMuted}>
        {"→ "}
        {truncateLine(status.detail, 100)}
      </text>
    </box>
  );
}

export function TaskResultView({ t, entry }: { t: Theme; entry: ChatEntry }) {
  const task = entry.toolResult?.task;
  if (!task) return null;

  return (
    <box gap={0}>
      <SubagentTaskLine t={t} agent={task.agent} label={task.description} pending={false} />
      <box paddingLeft={5}>
        <text fg={t.text}>
          {formatSubagentName(task.agent)}
          {": "}
          {truncateLine(task.summary, 90)}
        </text>
      </box>
    </box>
  );
}

export function DelegationResultView({ t, entry }: { t: Theme; entry: ChatEntry }) {
  const delegation = entry.toolResult?.delegation;
  if (!delegation) return null;

  return <DelegationTaskLine t={t} label={delegation.description} pending={false} id={delegation.id} />;
}

function parseDelegationList(content: string): { id: string; status: string; label: string }[] {
  const items: { id: string; status: string; label: string }[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/`([^`]+)`\s+\[(\w+)]\s+(.*)/);
    if (match) {
      items.push({ id: match[1], status: match[2], label: match[3].trim() });
    }
  }
  return items;
}

export function DelegationListView({ t, content }: { t: Theme; content: string }) {
  const items = parseDelegationList(content);

  if (items.length === 0) {
    return (
      <InlineTool t={t} pending={false}>
        {"No background delegations"}
      </InlineTool>
    );
  }

  return (
    <box paddingLeft={3} gap={0}>
      {items.map((item) => {
        const statusColor =
          item.status === "complete"
            ? "#8adf8a"
            : item.status === "running"
              ? t.subagentAccent
              : item.status === "error"
                ? "#df8a8a"
                : t.textMuted;

        return (
          <box key={item.id}>
            <text>
              <span style={{ fg: statusColor }}>{"◆ "}</span>
              <span style={{ fg: t.text }}>{item.id}</span>
              <span style={{ fg: statusColor }}>{` ${item.status}`}</span>
              <span style={{ fg: t.textMuted }}>
                {" — "}
                {truncateLine(item.label, 60)}
              </span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

export function BackgroundProcessLine({ t, id, pid, command }: { t: Theme; id: number; pid: number; command: string }) {
  return (
    <box paddingLeft={3}>
      <text>
        <span style={{ fg: t.subagentAccent }}>{"◆ "}</span>
        <span style={{ fg: t.subagentAccent }}>
          <b>{"Background process"}</b>
        </span>
        <span style={{ fg: t.textMuted }}>{` id:${id} pid:${pid}`}</span>
        <span style={{ fg: t.textDim }}>
          {" — "}
          {truncateLine(command, 60)}
        </span>
      </text>
    </box>
  );
}

export function ProcessLogsView({ t, content }: { t: Theme; content: string }) {
  const lines = content.split("\n");
  const header = lines[0] || "";
  const body = lines.slice(1).join("\n").trim();

  return (
    <box paddingLeft={3} gap={0}>
      <text fg={t.textMuted}>
        {"→ "}
        {header}
      </text>
      {body ? (
        <box paddingLeft={2} marginTop={0}>
          <box backgroundColor={t.mdCodeBlockBg} paddingLeft={1} paddingRight={1}>
            <text fg={t.mdCodeBlockFg}>{truncateBlock(body, 15)}</text>
          </box>
        </box>
      ) : null}
    </box>
  );
}

export function ToolTextOutputView({
  t,
  label,
  content,
  onOpenFileLink,
}: {
  t: Theme;
  label: string;
  content: string;
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
}) {
  return (
    <box gap={0}>
      <InlineTool t={t} pending={false}>
        {label}
      </InlineTool>
      <box paddingLeft={5} marginTop={1} flexShrink={0}>
        <Markdown content={content} t={t} onOpenFileLink={onOpenFileLink} />
      </box>
    </box>
  );
}

export function MediaAutoOpenView({ t, label }: { t: Theme; label: string; toolResult: ToolResult }) {
  // Note: auto-open logic can be added back later if needed
  return (
    <box gap={0}>
      <InlineTool t={t} pending={false}>
        {label}
      </InlineTool>
    </box>
  );
}

export function MediaToolResultView({
  t,
  label,
  toolResult,
  onOpenFileLink,
}: {
  t: Theme;
  label: string;
  toolResult: ToolResult;
  onOpenFileLink?: (target: LocalFileLinkTarget) => void;
}) {
  const media = toolResult.media ?? [];

  return (
    <box gap={0}>
      <InlineTool t={t} pending={false}>
        {label}
      </InlineTool>
      {toolResult.output ? (
        <box paddingLeft={5} marginTop={1} flexShrink={0}>
          <Markdown content={toolResult.output} t={t} raw onOpenFileLink={onOpenFileLink} />
        </box>
      ) : null}
      {media.length > 0 ? (
        <box paddingLeft={5} marginTop={toolResult.output ? 1 : 0} flexDirection="column">
          {media.map((asset) => (
            <box
              key={`${asset.path}-${asset.url ?? ""}-${asset.sourcePath ?? ""}-${asset.sourceUrl ?? ""}`}
              flexDirection="column"
            >
              <text fg={t.text}>{asset.path}</text>
              {asset.url ? <text fg={t.textMuted}>{`url: ${asset.url}`}</text> : null}
              {asset.sourcePath ? <text fg={t.textMuted}>{`source: ${asset.sourcePath}`}</text> : null}
              {asset.sourceUrl ? <text fg={t.textMuted}>{`source_url: ${asset.sourceUrl}`}</text> : null}
            </box>
          ))}
        </box>
      ) : null}
    </box>
  );
}

function truncateBlock(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}
