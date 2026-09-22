// Showcase — full-screen scrollable tour of every agent-output widget.
// Renders each widget with its makeExample* factory data so users can see
// what's available and what the output panes look like. Triggered by the
// /showcase slash command. Esc closes.
//
// First wave: Steps, ToolCalls, ThinkingBlock (both states), PlanUpdate,
// ApprovalCard. More will slot in here as we port them from termcast.

import type { ScrollBoxRenderable } from "@opentui/core";
import { useRef, useState } from "react";
import { ANTHROPIC_MODELS } from "../../core/plugins/builtin/anthropic-models-catalog";
import { MODELS } from "../../grok/models";
import { CodeBlock } from "../ai-elements/code-block";
import { Conversation, ConversationContent, ConversationEmptyState } from "../ai-elements/conversation";
import { Loader } from "../ai-elements/loader";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "../ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../ai-elements/reasoning";
import { Shimmer } from "../ai-elements/shimmer";
import { Source, Sources, SourcesContent, SourcesTrigger } from "../ai-elements/sources";
import { Suggestion, Suggestions } from "../ai-elements/suggestion";
import { ListPicker } from "../controls/list-picker";
import { ToggleSwitch } from "../controls/toggle-switch";
import { makeExampleRunningAgentRows, runningAgentRowsToParallelAgents } from "../running-agents";
import type { Theme } from "../theme";
import { ActivityStatus, makeExampleActivity } from "./activity-status";
import { AgentRoster, makeExampleAgentRoster } from "./agent-roster";
import { ApprovalCard, makeExampleApproval } from "./approval-card";
import { ArtifactList, makeExampleArtifacts } from "./artifact-list";
import { ChainOfThought, makeExampleThoughts } from "./chain-of-thought";
import { DiffReview, makeExampleDiffFiles } from "./diff-review";
import { FileNavigator, makeExampleFileNavigator } from "./file-navigator";
import { ImageViewer, makeExampleImageViewer } from "./image-viewer";
import { InterruptBar, makeExampleInterruptBar } from "./interrupt-bar";
import { makeExampleParallelAgents, ParallelAgents } from "./parallel-agents";
import { makeExamplePermissionPrompt, PermissionPrompt } from "./permission-prompt";
import { makeExamplePlanUpdate, PlanUpdate } from "./plan-update";
import { makeExampleQuestionnaireTabs, QuestionnaireTabs } from "./questionnaire-tabs";
import { makeExampleSteps, Steps } from "./steps";
import { makeExampleTaskInspector, TaskInspector } from "./task-inspector";
import { makeExampleTextEditor, TextEditor } from "./text-editor";
import { makeExampleThinkingBlock, ThinkingBlock } from "./thinking-block";
import { makeExampleManyToolCalls, makeExampleToolCalls, ToolCalls, ToolChipGroup } from "./tool-calls";

function SectionHeader({ t, title }: { t: Theme; title: string }) {
  return (
    <box marginTop={1} marginBottom={0} border={["top"]} borderColor={t.border}>
      <text fg={t.primary} wrapMode="none">
        <b>{` ${title} `}</b>
      </text>
    </box>
  );
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function ShowcaseModal({ t, width, height }: { t: Theme; width: number; height: number }) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  const panelWidth = Math.min(Math.max(60, width - 4), width);
  const panelHeight = Math.min(Math.max(20, height - 4), height);
  const overlayBg = "#000000cc" as string;

  const thinkingExample = makeExampleThinkingBlock();

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
        width={panelWidth}
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
          <text fg={t.primary} wrapMode="none">
            <b>{"Component Showcase"}</b>
            <span style={{ fg: t.textMuted }}>{"  termcast agent-output widgets"}</span>
          </text>
          <text fg={t.textMuted} wrapMode="none">
            {"esc"}
          </text>
        </box>

        <scrollbox ref={listRef} flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <SectionHeader t={t} title="Steps" />
          <Steps t={t} steps={makeExampleSteps()} title="Build plan" />

          <SectionHeader t={t} title="Tool calls" />
          <ToolCalls t={t} calls={makeExampleToolCalls()} />

          <SectionHeader t={t} title="Tool chips — collated" />
          <ToolChipGroup t={t} calls={makeExampleManyToolCalls()} />

          <SectionHeader t={t} title="Plan update" />
          <PlanUpdate t={t} plan={makeExamplePlanUpdate()} />

          <SectionHeader t={t} title="Thinking — streaming" />
          <ThinkingBlock
            t={t}
            thinkingText="Thinking"
            reasoningText={thinkingExample.reasoningText}
            isThinking={true}
          />

          <SectionHeader t={t} title="Thinking — done" />
          <ThinkingBlock
            t={t}
            thinkingText="Thinking"
            reasoningText={thinkingExample.reasoningText}
            isThinking={false}
            collapsed={false}
          />

          <SectionHeader t={t} title="Approval" />
          <ApprovalCard t={t} request={makeExampleApproval()} />

          <SectionHeader t={t} title="Activity status" />
          <ActivityStatus t={t} activity={makeExampleActivity()} />

          <SectionHeader t={t} title="Interrupt bar" />
          <InterruptBar t={t} bar={makeExampleInterruptBar()} />

          <SectionHeader t={t} title="Permission prompt" />
          <PermissionPrompt t={t} prompt={makeExamplePermissionPrompt()} />

          <SectionHeader t={t} title="Chain of thought" />
          <ChainOfThought t={t} thoughts={makeExampleThoughts()} isThinking={true} />

          <SectionHeader t={t} title="Task inspector" />
          <TaskInspector t={t} task={makeExampleTaskInspector()} />

          <SectionHeader t={t} title="Artifact list" />
          <ArtifactList t={t} artifacts={makeExampleArtifacts()} />

          <SectionHeader t={t} title="File navigator" />
          <FileNavigator t={t} file={makeExampleFileNavigator()} />

          <SectionHeader t={t} title="Diff review" />
          <DiffReview
            t={t}
            files={makeExampleDiffFiles()}
            summary="Review each file and apply the accepted set."
            statusLabel="triage"
          />

          <SectionHeader t={t} title="Agent roster" />
          <AgentRoster t={t} roster={makeExampleAgentRoster()} />

          <SectionHeader t={t} title="Parallel agents" />
          <ParallelAgents t={t} run={makeExampleParallelAgents()} />

          <SectionHeader t={t} title="Parallel agents — live running subagents" />
          <ParallelAgents
            t={t}
            run={runningAgentRowsToParallelAgents(makeExampleRunningAgentRows(), Date.now())}
            selectedId="__inline__"
          />

          <SectionHeader t={t} title="Questionnaire tabs" />
          <QuestionnaireTabs t={t} tabs={makeExampleQuestionnaireTabs()} />

          <SectionHeader t={t} title="Text editor" />
          <TextEditor t={t} {...makeExampleTextEditor()} editorHeight={8} />

          <SectionHeader t={t} title="Image viewer" />
          <ImageViewer t={t} attachment={makeExampleImageViewer()} />

          <SectionHeader t={t} title="ai-elements · Message" />
          <Message t={t} from="user">
            <MessageContent>
              <MessageResponse>{"Can you refactor the streaming response renderer?"}</MessageResponse>
            </MessageContent>
          </Message>
          <Message t={t} from="assistant">
            <MessageContent>
              <MessageResponse>
                {
                  "Sure — I'll split the streaming branch out so the markdown renderer only remounts when the width changes. Here's the key helper:"
                }
              </MessageResponse>
              <CodeBlock
                t={t}
                language="ts"
                code={`function normalizeStreamingMarkdown(content: string) {\n  const fences = content.match(/\\\`\\\`\\\`/g);\n  const open = fences && fences.length % 2 === 1;\n  return open ? content + '\\n\\\`\\\`\\\`' : content;\n}`}
              />
            </MessageContent>
            <MessageActions>
              <MessageAction label="copy" />
              <MessageAction label="regenerate" />
              <MessageAction label="rate" />
            </MessageActions>
          </Message>

          <SectionHeader t={t} title="ai-elements · Reasoning" />
          <Reasoning t={t} isStreaming={false} duration={3}>
            <ReasoningTrigger />
            <ReasoningContent>
              {
                "The streaming renderer was remounting on every token because the `streaming` key included a timestamp. Fix: include only `markdownWidth` in the key so the element is stable across tokens but snaps once the terminal reports its real width."
              }
            </ReasoningContent>
          </Reasoning>

          <SectionHeader t={t} title="ai-elements · Sources" />
          <Sources t={t}>
            <SourcesTrigger count={3} />
            <SourcesContent>
              <Source title="Vercel ai-elements docs" href="https://ai-sdk.dev/elements" />
              <Source title="OpenTUI Renderable reference" />
              <Source title="xterm.js headless" href="https://xtermjs.org" />
            </SourcesContent>
          </Sources>

          <SectionHeader t={t} title="ai-elements · Suggestions" />
          <Suggestions>
            <Suggestion t={t} suggestion="Refactor the store" />
            <Suggestion t={t} suggestion="Add a Redis cache" />
            <Suggestion t={t} suggestion="Write the migration" />
            <Suggestion t={t} suggestion="Review the PR" />
          </Suggestions>

          <SectionHeader t={t} title="ai-elements · Loader + Shimmer" />
          <box flexDirection="row" gap={4} paddingLeft={2}>
            <Loader t={t} />
            <Shimmer t={t}>{"assistant is thinking"}</Shimmer>
          </box>

          <SectionHeader t={t} title="controls · ListPicker" />
          <ShowcaseListPicker t={t} />

          <SectionHeader t={t} title="controls · ToggleSwitch" />
          <ShowcaseToggles t={t} />

          <SectionHeader t={t} title="ai-elements · Conversation empty state" />
          <box height={10} alignSelf="stretch">
            <Conversation t={t}>
              <ConversationContent>
                <ConversationEmptyState
                  title="Nothing here yet"
                  description="Send a message to start the conversation."
                />
              </ConversationContent>
            </Conversation>
          </box>

          <box paddingTop={2} paddingBottom={1}>
            <text fg={t.textMuted} wrapMode="none">
              {
                "Provider/model controls now reuse ListPicker and ToggleSwitch; remaining showcase gaps are prompt-input and tool details."
              }
            </text>
          </box>
        </scrollbox>

        <box flexShrink={0} paddingLeft={2} paddingRight={2}>
          <text>
            <span style={{ fg: t.primary }}>{"↑↓ "}</span>
            <span style={{ fg: t.textMuted }}>{"scroll  \u00b7  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

// ── Inline showcase helpers (need local state for the picker + toggles) ──────

const LIST_PICKER_ITEMS = [
  ...ANTHROPIC_MODELS.slice(0, 3).map((model) => ({
    id: model.id,
    label: model.id,
    hint: `anthropic · ${model.contextWindow >= 1_000_000 ? "1M" : `${Math.round(model.contextWindow / 1_000)}K`} ctx`,
  })),
  ...MODELS.slice(0, 2).map((model) => ({
    id: model.id,
    label: model.id,
    hint: `xai · ${model.reasoning ? "reasoning" : "fast"}`,
  })),
];

function ShowcaseListPicker({ t }: { t: Theme }) {
  const [idx, setIdx] = useState(0);
  return (
    <ListPicker
      t={t}
      title="Pick a model"
      items={LIST_PICKER_ITEMS}
      selectedIndex={idx}
      onSelectIndex={setIdx}
      getKey={(item) => item.id}
      renderItem={({ item, selected }) => (
        <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor={selected ? t.accent : undefined}>
          <text fg={selected ? t.background : t.text} wrapMode="none">
            {selected ? <b>{item.label}</b> : item.label}
          </text>
          <box flexGrow={1} />
          <text fg={selected ? t.background : t.textMuted} wrapMode="none">
            {item.hint}
          </text>
        </box>
      )}
      maxVisibleItems={5}
    />
  );
}

function ShowcaseToggles({ t }: { t: Theme }) {
  const [options, setOptions] = useState({
    autocommit: true,
    streamReasoning: false,
    verbose: false,
    telemetry: true,
  });
  const rows: Array<{ key: keyof typeof options; label: string; disabled?: boolean }> = [
    { key: "autocommit", label: "Auto-commit after each turn" },
    { key: "streamReasoning", label: "Stream reasoning deltas live" },
    { key: "verbose", label: "Verbose tool output" },
    { key: "telemetry", label: "Send anonymous telemetry" },
  ];
  return (
    <box flexDirection="column" paddingLeft={2} gap={0}>
      {rows.map((row) => (
        <box
          key={row.key}
          flexDirection="row"
          height={1}
          gap={2}
          onMouseDown={() => setOptions((prev) => ({ ...prev, [row.key]: !prev[row.key] }))}
        >
          <ToggleSwitch t={t} value={options[row.key]} disabled={row.disabled} />
          <text fg={t.text} wrapMode="none">
            {row.label}
          </text>
        </box>
      ))}
    </box>
  );
}
