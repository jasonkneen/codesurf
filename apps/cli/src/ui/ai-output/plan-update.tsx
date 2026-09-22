// PlanUpdate — a titled + summarized list of plan items with status icons.
// Ported verbatim from termcast's plan-update.tsx with the useTheme hook
// swapped for a Theme prop.

import type { Theme } from "../theme";

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  label: string;
  status: PlanItemStatus;
}

export interface PlanUpdateData {
  title?: string;
  summary?: string;
  items: PlanItem[];
}

const PLAN_ICON: Record<PlanItemStatus, string> = {
  pending: "□",
  in_progress: "◌",
  completed: "✓",
};

/** `3/7` completion counter for the panel header. */
export function formatPlanProgress(items: PlanItem[]): string {
  const done = items.filter((item) => item.status === "completed").length;
  return `${done}/${items.length}`;
}

/** True once every item is complete — the panel's terminal state. */
export function isPlanComplete(items: PlanItem[]): boolean {
  return items.length > 0 && items.every((item) => item.status === "completed");
}

function statusColor(t: Theme, status: PlanItemStatus): string {
  switch (status) {
    case "completed":
      return t.diffAddedFg;
    case "in_progress":
      return t.accent;
    default:
      return t.textMuted;
  }
}

export function PlanUpdate({ t, plan }: { t: Theme; plan: PlanUpdateData }) {
  const complete = isPlanComplete(plan.items);
  const title = plan.title ?? (complete ? "Plan complete" : "Updated Plan");
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1}>
      <box flexDirection="row" height={1}>
        <text fg={complete ? t.diffAddedFg : t.primary} wrapMode="none">
          <b>{title}</b>
        </text>
        <text fg={t.textMuted} wrapMode="none">
          {`  ${formatPlanProgress(plan.items)}`}
        </text>
      </box>
      {plan.summary && (
        <box paddingLeft={2} marginTop={1}>
          <text fg={t.textMuted}>{plan.summary}</text>
        </box>
      )}
      <box flexDirection="column" paddingLeft={2} marginTop={1}>
        {plan.items.map((item, index) => (
          // Labels can repeat; plan rows are positional, so key by index.
          // biome-ignore lint/suspicious/noArrayIndexKey: plan items have no stable id and duplicate labels are allowed
          <box key={index} flexDirection="row" height={1}>
            <box width={2} flexShrink={0}>
              <text fg={statusColor(t, item.status)} wrapMode="none">
                {PLAN_ICON[item.status]}
              </text>
            </box>
            <text fg={item.status === "pending" ? t.textMuted : t.text}>
              {item.status === "in_progress" ? <b>{item.label}</b> : item.label}
            </text>
          </box>
        ))}
      </box>
    </box>
  );
}

export function makeExamplePlanUpdate(): PlanUpdateData {
  return {
    summary:
      "Executing the cleanup plan in parallel: core correctness locally, popup/store cleanup and input/action cleanup via subagents.",
    items: [
      {
        label: "Fix core state, session, and pending-turn correctness",
        status: "in_progress",
      },
      {
        label: "Fix popup lifecycle and module-level subscription leaks",
        status: "completed",
      },
      {
        label: "Fix slash/action behavior drift and argument handling",
        status: "completed",
      },
      {
        label: "Restore type/lint safety where feasible and verify",
        status: "pending",
      },
    ],
  };
}
