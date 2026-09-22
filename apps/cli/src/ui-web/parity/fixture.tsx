// The P0 parity scene.
//
// Both hosts render THIS module — the terminal through @opentui/react and its
// Zig core, the browser through src/ui-web/opentui-dom. If each side had its own
// copy of the tree, a difference in the output would not tell you whether the
// renderer disagreed or the scenes did. One module removes that ambiguity.
//
// Widgets are the pure `ai-output/` family with their own fixture factories:
// theme in, data in, box/text out. No agent, no fs, no websocket — so any
// difference between the two captures is the renderer's.

import { ApprovalCard, makeExampleApproval } from "../../ui/ai-output/approval-card.js";
import { ChainOfThought, makeExampleThoughts } from "../../ui/ai-output/chain-of-thought.js";
import { makeExamplePlanUpdate, PlanUpdate } from "../../ui/ai-output/plan-update.js";
import { makeExampleSteps, Steps } from "../../ui/ai-output/steps.js";
import { makeExampleThinkingBlock, ThinkingBlock } from "../../ui/ai-output/thinking-block.js";
import { getTheme } from "../../ui/themes/catalog.js";

/**
 * Fixed grid for every capture. Parity is only meaningful at one size.
 *
 * The scene is 61 rows tall, and the viewport must exceed that. Below 61 the
 * terminal host does not clip or scroll — it SHRINKS rows to fit, collapsing
 * some to zero height while still drawing them, so two text rows composite into
 * one cell row. (At 60 rows, ApprovalCard's title and summary land on the same
 * row, the title legible only through the summary's spaces.) CSS flexbox
 * overflows instead, so comparing at a compressed height would report a
 * difference that is really the terminal's overflow behaviour, not the DOM
 * host's fidelity. `parity.test.ts` pins this.
 */
export const PARITY_COLUMNS = 100;
export const PARITY_ROWS = 70;

const t = getTheme("dark");

export function ParityScene() {
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingTop={2}>
      <text fg={t.accent}>
        <b>{"codesurf — P0 web render (fixtures)"}</b>
      </text>
      <box flexDirection="column" gap={2}>
        <Steps t={t} steps={makeExampleSteps()} title="Build plan" />
        <ApprovalCard t={t} request={makeExampleApproval()} />
        <ChainOfThought t={t} thoughts={makeExampleThoughts()} isThinking={true} />
        <PlanUpdate t={t} plan={makeExamplePlanUpdate()} />
        <ThinkingBlock t={t} reasoningText={makeExampleThinkingBlock().reasoningText} />
      </box>
    </box>
  );
}
