// ArtifactList — files produced/updated/deleted during an agent run, each
// annotated with a status pill. Ported from termcast's artifact-list.tsx.

import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

export type ArtifactStatus = "new" | "updated" | "generated" | "deleted";

export interface ArtifactItem {
  path: string;
  status: ArtifactStatus;
  note?: string;
}

function statusColor(t: Theme, status: ArtifactStatus): string {
  switch (status) {
    case "new":
      return t.diffAddedFg;
    case "updated":
      return t.accent;
    case "generated":
      return t.accent;
    case "deleted":
      return t.diffRemovedFg;
  }
}

export function ArtifactList({
  t,
  title = "artifacts",
  artifacts,
  onSelect,
}: {
  t: Theme;
  title?: string;
  artifacts: ArtifactItem[];
  /** Called when an artifact row is clicked — caller decides whether to
   *  open the file, copy the path, or focus the diff panel. */
  onSelect?: (path: string) => void;
}) {
  if (artifacts.length === 0) return null;
  return (
    <AgentPanel t={t} title={title} meta={`${artifacts.length} item${artifacts.length > 1 ? "s" : ""}`}>
      <box flexDirection="column">
        {artifacts.map((artifact) => (
          <box
            key={artifact.path}
            flexDirection="row"
            height={1}
            onMouseDown={onSelect ? () => onSelect(artifact.path) : undefined}
          >
            <box width={12} flexShrink={0}>
              <PanelPill t={t} label={artifact.status} fg={t.background} bg={statusColor(t, artifact.status)} />
            </box>
            <text fg={t.text} wrapMode="none">
              {artifact.path}
            </text>
            {artifact.note && (
              <>
                <box flexGrow={1} />
                <text fg={t.textMuted} wrapMode="none">
                  {artifact.note}
                </text>
              </>
            )}
          </box>
        ))}
      </box>
    </AgentPanel>
  );
}

export function makeExampleArtifacts(): ArtifactItem[] {
  return [
    { path: "src/core/input-focus.tsx", status: "new", note: "focus coordinator" },
    {
      path: "src/modules/input/area.tsx",
      status: "updated",
      note: "textarea restore logic",
    },
    {
      path: "src/extensions/loader.tsx",
      status: "updated",
      note: "disabled extension skip",
    },
    { path: "report.md", status: "generated", note: "verification summary" },
  ];
}
