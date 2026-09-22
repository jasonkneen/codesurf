// ParallelAgents — dashboard showing concurrent subagent steps with per-step
// task, tool count, duration, and optional scratch-pad detail lines. Ported
// from termcast's parallel-agents.tsx.

import type { Theme } from "../theme";
import { AgentPanel } from "./panel-frame";

export type ParallelAgentStepStatus = "done" | "running" | "pending" | "error";

export interface ParallelAgentStep {
  id: string;
  title: string;
  task: string;
  agent: string;
  model?: string;
  status: ParallelAgentStepStatus;
  tools?: number;
  duration?: string;
  detailLines?: string[];
}

export interface ParallelAgentsData {
  title?: string;
  summary?: string;
  progressLabel?: string;
  toolsLabel?: string;
  steps: ParallelAgentStep[];
}

function stepGlyph(status: ParallelAgentStepStatus): string {
  switch (status) {
    case "done":
      return "✓";
    case "running":
      return "●";
    case "error":
      return "!";
    default:
      return "○";
  }
}

function stepColor(t: Theme, status: ParallelAgentStepStatus): string {
  switch (status) {
    case "done":
      return t.diffAddedFg;
    case "running":
      return t.accent;
    case "error":
      return t.diffRemovedFg;
    default:
      return t.textMuted;
  }
}

export function ParallelAgents({
  t,
  run,
  selectedId,
}: {
  t: Theme;
  run: ParallelAgentsData;
  /** Highlights one step. Set when the widget doubles as a keyboard-navigable
   *  picker (the running-subagents popup); omit for read-only dashboards. */
  selectedId?: string;
}) {
  return (
    <AgentPanel
      t={t}
      title={run.title ?? "subagent parallel"}
      meta={run.summary}
      statusLabel={run.progressLabel}
      statusColor={t.accent}
    >
      <box flexDirection="column">
        {run.toolsLabel && (
          <box marginBottom={1}>
            <text fg={t.textMuted}>{run.toolsLabel}</text>
          </box>
        )}
        {run.steps.map((step, index) => (
          <box
            key={step.id}
            flexDirection="column"
            border={index < run.steps.length - 1 ? ["bottom"] : undefined}
            borderColor={t.border}
            paddingBottom={1}
            marginBottom={1}
          >
            <box flexDirection="row" overflow="hidden">
              <text fg={selectedId === step.id ? t.primary : stepColor(t, step.status)} wrapMode="none">
                <b>{`${selectedId === step.id ? "▸" : stepGlyph(step.status)} Step ${index + 1}: ${step.agent}`}</b>
              </text>
              {step.model && (
                <text fg={t.textMuted} wrapMode="none">
                  {` (${step.model})`}
                </text>
              )}
              {step.tools !== undefined && (
                <text fg={t.textMuted} wrapMode="none">
                  {` | ${step.tools} tools`}
                </text>
              )}
              {step.duration && (
                <text fg={t.textMuted} wrapMode="none">
                  {` | ${step.duration}`}
                </text>
              )}
            </box>
            <box paddingLeft={2} marginTop={1}>
              <text fg={t.text}>
                <b>task:</b>
              </text>
              <text fg={t.textMuted}>{` ${step.task}`}</text>
            </box>
            {step.detailLines && step.detailLines.length > 0 && (
              <box flexDirection="column" paddingLeft={4} marginTop={1}>
                {step.detailLines.map((line, detailIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: detail lines per step are positional and stable
                  <text key={`${step.id}-${detailIndex}`} fg={t.textMuted}>
                    {line}
                  </text>
                ))}
              </box>
            )}
          </box>
        ))}
      </box>
    </AgentPanel>
  );
}

export function makeExampleParallelAgents(): ParallelAgentsData {
  return {
    title: "subagent parallel (3)",
    summary: "parallel 3/3",
    progressLabel: "3/3 done",
    toolsLabel: "160 tools, 38k tok, 10m44s",
    steps: [
      {
        id: "step-1",
        title: "Step 1",
        task: "In /Users/jkneen/Documents/GitHub/flows/workflow/simple, fix the remaining TypeScript errors in execute and routing files only.",
        agent: "code",
        model: "claude-sonnet-4-5",
        status: "done",
        tools: 45,
        duration: "4m27s",
      },
      {
        id: "step-2",
        title: "Step 2",
        task: "Fix the remaining TypeScript and UI compatibility errors in canvas and selector surfaces only.",
        agent: "code",
        model: "claude-sonnet-4-5",
        status: "running",
        tools: 50,
        duration: "10m44s",
        detailLines: [
          "grep: /Users/jkneen/Documents/GitHub/flows/workflow/simple/src",
          "The Button component does not have an `icon-xs` size variant. Let me change it to `icon-sm`.",
          "Found another error in your target files. Let me remove the unsupported Sandpack options.",
        ],
      },
      {
        id: "step-3",
        title: "Step 3",
        task: "Fix the remaining TypeScript or SDK API mismatch errors in the resend and provider plugins only.",
        agent: "code",
        model: "claude-sonnet-4-5",
        status: "done",
        tools: 65,
        duration: "7m35s",
      },
    ],
  };
}
