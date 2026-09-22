// ChainOfThought — live reasoning trace with done / active / pending buckets.
// Ported from termcast's chain-of-thought.tsx. Spinner + animated LoadingBar
// are replaced with static glyphs to keep the port lean; if the animated
// variant becomes important we can swap in grok's `ShimmerText`.

import { useState } from "react";
import type { Theme } from "../theme";

export type ThoughtStatus = "done" | "active" | "pending";

export interface Thought {
  id: string;
  text: string;
  status: ThoughtStatus;
  detail?: string;
}

export function ChainOfThought({
  t,
  thoughts,
  isThinking,
  collapsed: initialCollapsed = false,
}: {
  t: Theme;
  thoughts: Thought[];
  isThinking: boolean;
  collapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const activeThought = thoughts.find((th) => th.status === "active");
  const doneThoughts = thoughts.filter((th) => th.status === "done");
  const pendingThoughts = thoughts.filter((th) => th.status === "pending");
  const chipBg = isThinking ? t.accent : t.textDim;
  const chipGlyph = isThinking ? "◌" : "✓";
  const hasThoughts = thoughts.length > 0;
  const stepLabel = hasThoughts ? `${doneThoughts.length}/${thoughts.length} steps` : "waiting";

  return (
    <box flexDirection="column" paddingRight={1} marginBottom={1}>
      <box
        flexDirection="row"
        height={1}
        marginBottom={collapsed ? 0 : 1}
        onMouseDown={hasThoughts ? () => setCollapsed((c) => !c) : undefined}
      >
        <box flexDirection="row" flexShrink={0} height={1} paddingLeft={1} paddingRight={1} backgroundColor={chipBg}>
          <text fg={t.background} bg={chipBg} wrapMode="none">
            <b>{"THINKING"}</b>
          </text>
          <text fg={t.background} bg={chipBg} wrapMode="none">
            <b>{` ${chipGlyph}`}</b>
          </text>
        </box>
        <text fg={t.textMuted} wrapMode="none">
          {" "}
        </text>
        <text fg={t.textMuted} wrapMode="none">
          {stepLabel}
        </text>
        <box flexGrow={1} />
        {hasThoughts && (
          <text fg={t.textMuted} wrapMode="none">
            {collapsed ? "click to expand" : "click to collapse"}
          </text>
        )}
      </box>
      {!collapsed &&
        doneThoughts.map((thought) => (
          <box
            key={thought.id}
            flexDirection="column"
            onMouseDown={
              thought.detail ? () => setExpandedId((prev) => (prev === thought.id ? null : thought.id)) : undefined
            }
          >
            <box flexDirection="row" height={1}>
              <box width={3} flexShrink={0}>
                <text fg={t.diffAddedFg} wrapMode="none">
                  {"  ✓"}
                </text>
              </box>
              <box width={1} flexShrink={0} />
              <text fg={t.textMuted} wrapMode="none">
                {thought.text}
              </text>
              {thought.detail && (
                <text fg={t.textMuted} wrapMode="none">
                  {expandedId === thought.id ? "  [-]" : "  [+]"}
                </text>
              )}
            </box>
            {expandedId === thought.id && thought.detail && (
              <box paddingLeft={4} marginBottom={1}>
                <text fg={t.textMuted} wrapMode="none">
                  {thought.detail}
                </text>
              </box>
            )}
          </box>
        ))}
      {activeThought && (
        <box flexDirection="column" marginBottom={1}>
          <box flexDirection="row" height={1}>
            <box width={3} flexShrink={0}>
              <text fg={t.accent} wrapMode="none">
                {"  ◌"}
              </text>
            </box>
            <box width={1} flexShrink={0} />
            <text fg={t.accent} wrapMode="none">
              <b>{activeThought.text}</b>
            </text>
          </box>
        </box>
      )}
      {!collapsed &&
        pendingThoughts.map((thought) => (
          <box key={thought.id} flexDirection="row" height={1}>
            <box width={3} flexShrink={0}>
              <text fg={t.textMuted} wrapMode="none">
                {"  ○"}
              </text>
            </box>
            <box width={1} flexShrink={0} />
            <text fg={t.textMuted} wrapMode="none">
              {thought.text}
            </text>
          </box>
        ))}
    </box>
  );
}

export function makeExampleThoughts(): Thought[] {
  return [
    {
      id: "t1",
      text: "Understand the user request and identify scope",
      status: "done",
      detail: "Request is to implement an extension system with event bus, registry, and manifest discovery.",
    },
    {
      id: "t2",
      text: "Check existing file structure for relevant context",
      status: "done",
      detail: "Found core/types.tsx, extensions/registry.tsx. Extension loader pattern matches pi-mono.",
    },
    {
      id: "t3",
      text: "Design the ExtensionAPI surface — on(), register*()",
      status: "done",
    },
    {
      id: "t4",
      text: "Write extension loader and context factory",
      status: "active",
      detail: "Currently generating loader.tsx — wiring api.on() subscriptions to the live event bus...",
    },
    {
      id: "t5",
      text: "Build built-in extensions using the same API",
      status: "pending",
    },
    {
      id: "t6",
      text: "Write the hello-world example extension",
      status: "pending",
    },
    {
      id: "t7",
      text: "Update package.json with agent manifest",
      status: "pending",
    },
  ];
}
