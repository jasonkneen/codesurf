// TaskInspector — compact overview of a running task's owner / elapsed /
// current step / last tool / next action, plus control pills. Ported from
// termcast's task-inspector.tsx.

import type { Theme } from "../theme";
import { AgentPanel, PanelPill } from "./panel-frame";

export type InspectorStatus = "idle" | "running" | "blocked" | "done" | "error";

export interface TaskInspectorData {
  title: string;
  status: InspectorStatus;
  owner?: string;
  elapsed?: string;
  currentStep?: string;
  lastTool?: string;
  nextAction?: string;
  controls?: string[];
}

function statusColor(t: Theme, status: InspectorStatus): string {
  switch (status) {
    case "running":
      return t.accent;
    case "blocked":
      return t.accent;
    case "done":
      return t.diffAddedFg;
    case "error":
      return t.diffRemovedFg;
    default:
      return t.textMuted;
  }
}

export function TaskInspector({
  t,
  task,
  onControl,
}: {
  t: Theme;
  task: TaskInspectorData;
  /** Clicking a control pill (Stop / Retry / Open diff / …) fires this. */
  onControl?: (label: string) => void;
}) {
  const meta = [task.owner ? `owner ${task.owner}` : undefined, task.elapsed ? `elapsed ${task.elapsed}` : undefined]
    .filter((v): v is string => Boolean(v))
    .join("  ");
  return (
    <AgentPanel
      t={t}
      title="task inspector"
      meta={meta || undefined}
      statusLabel={task.status}
      statusColor={statusColor(t, task.status)}
    >
      <box flexDirection="column">
        <text fg={t.text}>
          <b>{task.title}</b>
        </text>
        {(task.owner || task.elapsed) && (
          <box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
            {task.owner && <PanelPill t={t} label={`owner: ${task.owner}`} />}
            {task.elapsed && <PanelPill t={t} label={`elapsed: ${task.elapsed}`} />}
          </box>
        )}
        {task.currentStep && <text fg={t.text}>{`current: ${task.currentStep}`}</text>}
        {task.lastTool && <text fg={t.textMuted}>{`last tool: ${task.lastTool}`}</text>}
        {task.nextAction && <text fg={t.textMuted}>{`next: ${task.nextAction}`}</text>}
        {task.controls && task.controls.length > 0 && (
          <box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
            {task.controls.map((control) => (
              <PanelPill
                key={control}
                t={t}
                label={control}
                onSelect={onControl ? () => onControl(control) : undefined}
              />
            ))}
          </box>
        )}
      </box>
    </AgentPanel>
  );
}

export function makeExampleTaskInspector(): TaskInspectorData {
  return {
    title: "Refactor extension loading and focus recovery",
    status: "running",
    owner: "main agent",
    elapsed: "4m 12s",
    currentStep: "Reconciling popup teardown and textarea focus restoration",
    lastTool: "apply_patch on src/modules/input/area.tsx",
    nextAction: "Verify keyboard flow and restart behavior",
    controls: ["Stop", "Retry", "Open diff", "View logs"],
  };
}
