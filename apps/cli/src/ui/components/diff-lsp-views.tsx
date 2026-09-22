import type { ToolResult } from "../../types/index";
import type { Theme } from "../theme";
import { LoadingSpinner } from "./loading-spinner.js";

const MAX_LSP_RESULT_LINES = 10;

export function LspResultView({
  t,
  operation,
  filePath,
  position,
  content,
}: {
  t: Theme;
  operation: string;
  filePath: string;
  position: string;
  content: string;
}) {
  const body = content.trim();
  const lines = body.split("\n");
  const truncated = lines.length > MAX_LSP_RESULT_LINES;
  const visible = truncated ? lines.slice(0, MAX_LSP_RESULT_LINES).join("\n") : body;
  const label = `${operation} ${filePath}${position}`;

  return (
    <box paddingLeft={5} marginTop={0} flexShrink={0}>
      <box flexDirection="column">
        <box backgroundColor={t.diffHeader} paddingLeft={1} paddingRight={1}>
          <text>
            <span style={{ fg: t.primary }}>{"lsp"}</span>
            <span style={{ fg: t.textDim }}>{" · "}</span>
            <span style={{ fg: t.diffHeaderFg }}>{label}</span>
          </text>
        </box>
        <box backgroundColor={t.mdCodeBlockBg} paddingLeft={1} paddingRight={1}>
          <text fg={t.mdCodeBlockFg}>{visible}</text>
        </box>
        {truncated && (
          <box backgroundColor={t.diffSeparator} paddingLeft={1}>
            <text fg={t.diffSeparatorFg}>
              {"⌃  "}
              {lines.length - MAX_LSP_RESULT_LINES}
              {" more lines"}
            </text>
          </box>
        )}
      </box>
    </box>
  );
}

export function LspDiagnosticsView({
  t,
  diagnostics,
}: {
  t: Theme;
  diagnostics: NonNullable<ToolResult["lspDiagnostics"]>;
}) {
  const files = diagnostics.slice(0, 3);
  return (
    <box paddingLeft={5} marginTop={1}>
      <box flexDirection="column">
        <box>
          <text fg={t.textMuted}>{"LSP diagnostics"}</text>
        </box>
        {files.map((entry) => (
          <box key={`${entry.serverId}:${entry.filePath}`} flexDirection="column">
            <text fg={t.textDim}>{`${entry.serverId} • ${entry.filePath}`}</text>
            {entry.diagnostics.slice(0, 5).map((diagnostic, index) => (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics may not include stable ids
                key={`${entry.serverId}:${entry.filePath}:${index}`}
                fg={diagnostic.severity === 1 ? t.diffRemovedFg : diagnostic.severity === 2 ? t.primary : t.textMuted}
              >
                {`${formatLspSeverity(diagnostic.severity)} ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`}
              </text>
            ))}
          </box>
        ))}
      </box>
    </box>
  );
}

function formatLspSeverity(severity?: number): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "issue";
  }
}

export function ShimmerText({ t, text }: { t: Theme; text: string }) {
  return (
    <box paddingLeft={3} marginTop={1}>
      <text>
        <span style={{ fg: t.textMuted }}>
          <LoadingSpinner />
        </span>
        <span style={{ fg: t.textMuted }}> {text}</span>
      </text>
    </box>
  );
}
