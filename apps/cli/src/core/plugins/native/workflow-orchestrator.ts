// Native Cordis plugin: the `/workflow` slash command.
//
// Converted from the V1 `activate(api)` builtin to an ordinary Cordis module
// (`name`, `inject`, `apply`). It imports only `@codesurf/plugin-api` — no host
// loader, no `PluginHostApi`, no concrete tool — and registers its command
// through `ctx.effect`, so disposing the fiber removes it.
//
// What it captures (unchanged from V1):
//
//   Claude Code's Workflow tool runs a deterministic JS orchestration script
//   that fans subagents out and in — agent()/parallel()/pipeline()/phase()/
//   log(), schema-forced structured output, a concurrency cap, a token budget,
//   barrier-vs-pipeline semantics, and resume/journal. This plugin encodes that
//   exact process and its quality patterns (adversarial verify,
//   perspective-diverse verify, judge panel, loop-until-dry, multi-modal sweep,
//   completeness critic, no-silent-caps) into a single prompt.
//
// How it runs here:
//
//   CodeSurf has no JS-sandbox workflow runtime, but it DOES have the real
//   `task` foreground sub-agent tool and the `delegate` background tool (see
//   `subagents-tools.ts`). So `/workflow <task>` instructs the agent to adopt
//   the Claude Code workflow orchestration process and execute it for real
//   using those primitives: independent steps fan out as parallel `task`
//   calls in a single turn, multi-stage work pipelines item-by-item, and
//   findings are adversarially verified before synthesis. The faithful spec is
//   the process; the existing subagent tools are the engine.
//
// The command is a prompt command: `buildPrompt` weaves the user's trailing
// args into the spec and the host bridge hands the result to `chat.dispatch`,
// exactly as V1's `registerPromptCommand` did.
//
// `displayText` is load-bearing, not cosmetic. The dispatched prompt is ~6.4KB,
// so without it the user's own transcript bubble AND the auto-generated session
// title would both be the whole orchestration manual. V1 passed
// `displayText: ctx => "/workflow …"` and `loader.ts` forwarded it as
// `chat.dispatch(prompt, { displayText })`; `PromptCommandSpec.displayText` now
// carries the same resolver through `native/host.ts`, so both surfaces still
// read `/workflow audit auth`. `workflow-orchestrator.test.ts` pins that end to
// end, through the real host bridge as well as the spec.

import type {
  CodesurfPlugin,
  CommandInvocation,
  PluginContext,
  PluginManifest,
  PromptCommandSpec,
} from "@codesurf/plugin-api";

// ── The faithful Workflow process spec ──────────────────────────────────────
//
// This is the operating manual: what a workflow IS, the orchestration
// primitives and their exact semantics, and the quality patterns to compose.
// It is intentionally verbatim-faithful to Claude Code's Workflow tool so the
// process is preserved, then grounded in CodeSurf's actual subagent tools so
// it is executable here. Carried over byte-for-byte from the V1 builtin.

const WORKFLOW_SPEC = `# Workflow orchestration process (captured from Claude Code)

A workflow structures work across many sub-agents — to be **comprehensive**
(decompose and cover in parallel), to be **confident** (independent
perspectives and adversarial checks before committing), or to take on **scale**
one context can't hold (migrations, audits, broad sweeps). The orchestration
shape — what fans out, what verifies, what synthesizes — is the whole point.

## Orchestration primitives and their exact semantics

In Claude Code these are script functions; here you enact them with real tool
calls. The semantics are what matter — preserve them exactly.

- **agent(prompt)** — spawn one sub-agent for a focused task. In CodeSurf this
  is a \`task\` tool call. Without a schema it returns the agent's final text;
  with a schema the agent is forced to return a validated structured object.
  A skipped/failed agent yields null — filter those out before using results.
- **parallel(thunks)** — run tasks concurrently. This is a **BARRIER**: it
  awaits ALL tasks before returning. In CodeSurf, fan out by issuing multiple
  independent \`task\` calls in a SINGLE turn, then wait for every result.
  A failed task resolves to null, never rejects — filter nulls before use.
- **pipeline(items, stage1, stage2, ...)** — run each item through all stages
  INDEPENDENTLY, with **NO barrier between stages**. Item A can be in stage 3
  while item B is still in stage 1. Wall-clock = slowest single-item chain,
  not sum-of-slowest-per-stage. This is the DEFAULT for multi-stage work.
- **phase(title)** — label a stage so progress is legible. Announce phases in
  your narration ("Phase: Review", "Phase: Verify").
- **log(message)** — emit a progress line to the user as work proceeds.
- **budget** — scale depth to the work. More breadth/verification for "be
  thorough / audit this"; less for a quick check.

### The rule that matters most: pipeline by default, barrier only when needed

DEFAULT to pipeline. A **barrier** (wait for ALL of stage N-1 before stage N)
is correct ONLY when stage N genuinely needs cross-item context from the whole
prior stage:
- dedup/merge across the full result set before expensive downstream work,
- early-exit if the total count is zero ("0 findings → skip verification"),
- stage N's prompt references "the other findings" for comparison.

A barrier is NOT justified by "I need to flatten/map/filter first" (do that
between stages without synchronizing), nor "the stages feel separate", nor
"it's cleaner". Barrier latency is real: if the slowest finder takes 3× the
fastest, a barrier wastes the fast finders' idle time. When in doubt: pipeline.

### Structured output

When a stage must return data the next stage consumes, force structure: tell
the sub-agent to return a strict JSON object with named fields, and validate it
before using it. Don't parse prose when you need data.

### Concurrency and scale

Run independent sub-agents concurrently, but cap in-flight agents to a sane
number (~8–16). You can queue a large item list; only a handful run at once.
If you ever bound coverage (top-N, sampling, no-retry), say so explicitly —
**never silently truncate**, because that reads as "covered everything".

## Quality patterns — compose these, don't just fan out

- **Adversarial verify**: for each finding, spawn independent skeptics PROMPTED
  TO REFUTE it; kill the finding unless it survives a majority. Stops
  plausible-but-wrong findings from shipping.
- **Perspective-diverse verify**: when a finding can fail in more than one way,
  give each verifier a distinct lens (correctness, security, performance,
  does-it-reproduce) instead of N identical skeptics.
- **Judge panel**: generate N independent attempts from different angles
  (MVP-first, risk-first, user-first), score them with parallel judges, then
  synthesize from the winner while grafting the best ideas from runners-up.
- **Loop-until-dry**: for unknown-size discovery (bugs, edge cases), keep
  spawning finders until K consecutive rounds surface nothing new. Dedup each
  round against everything seen so far — not just confirmed results — or it
  never converges.
- **Multi-modal sweep**: parallel agents each searching a DIFFERENT way
  (by-container, by-content, by-entity, by-time). Each is blind to the others;
  use when one search angle won't find everything.
- **Completeness critic**: a final agent that asks "what's missing — a modality
  not run, a claim unverified, a source unread?" What it finds is the next
  round of work.

## The canonical multi-stage shape (pipeline + verify)

1. **Decompose** the task into independent dimensions/items.
2. **Review/find** — one sub-agent per dimension (parallel \`task\` calls),
   each returning structured findings.
3. **Verify** — as each dimension's findings come back, adversarially verify
   them (don't wait for all dimensions). Keep only findings that survive.
4. **Synthesize** — merge the confirmed results into one answer, noting any
   coverage you deliberately bounded.

Scale to the ask: "find any bugs" → a few finders, single-vote verify.
"thoroughly audit this" → a larger finder pool, 3–5 vote adversarial pass, and
a synthesis stage. These patterns are a toolkit, not a script — compose what
fits (tournament brackets, self-repair loops, staged escalation, etc.).

## Executing this in CodeSurf

You have the real primitives: \`task\` (foreground sub-agent) and \`delegate\`
(read-only background agent). To run a workflow:
- Fan out a parallel stage by emitting multiple \`task\` calls in one turn.
- Pipeline by feeding one stage's structured result into the next \`task\`
  without waiting on sibling items.
- Verify with additional \`task\` calls before you trust a finding.
- Narrate phases and progress so the user can follow the fan-out.
Use \`delegate\` only for read-only research you want to run in the background.`;

/** Build the dispatched prompt. Byte-identical to the V1 `buildWorkflowPrompt`. */
function buildWorkflowPrompt(invocation: CommandInvocation): string {
  const task = invocation.args.trim();
  const header = task
    ? `Run the following task as a multi-agent workflow:\n\n<task>\n${task}\n</task>\n\n`
    : `The user wants to run a task as a multi-agent workflow but did not specify one. Ask them, in one line, what task to orchestrate — then stop and wait.\n\n`;

  return `${header}Adopt and execute the workflow orchestration process below. First write a short PLAN: the phases, what fans out in parallel, what pipelines, and how findings get verified before synthesis. Then execute it using CodeSurf's real sub-agent tools (\`task\` for foreground fan-out, \`delegate\` for read-only background research), narrating each phase. Finish with a synthesized result and an explicit note of any coverage you deliberately bounded.\n\n---\n\n${WORKFLOW_SPEC}`;
}

/**
 * Build the transcript header. Byte-identical to the V1 `displayText` closure:
 * the trimmed task after the command name, or the bare command when absent.
 */
export function buildWorkflowDisplayText(invocation: CommandInvocation): string {
  const task = invocation.args.trim();
  return task ? `/workflow ${task}` : "/workflow";
}

/**
 * The registered spec. Annotated so a typo in any field is a type error rather
 * than a silently-ignored extra property. V1 passed no `aliases` and no
 * `hidden`; both stay absent so the slash menu row is identical.
 */
const workflowCommand: PromptCommandSpec = {
  name: "/workflow",
  description: "Run a task as a multi-agent workflow (Claude Code orchestration process).",
  argsHint: "<task to orchestrate>",
  buildPrompt: buildWorkflowPrompt,
  displayText: buildWorkflowDisplayText,
};

const manifest: PluginManifest = {
  id: "builtin.commands.workflow-orchestrator",
  name: "Workflow Orchestrator",
  version: "1.0.0",
  description:
    "Captures Claude Code's Workflow orchestration process as the /workflow command — fan-out, pipeline vs barrier, adversarial verify, synthesis — executed via CodeSurf's real sub-agent tools.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands"],
};

export const workflowOrchestratorPlugin: CodesurfPlugin = {
  name: "codesurf-workflow-orchestrator",
  manifest,
  inject: ["contributions"],
  apply(ctx: PluginContext) {
    ctx.effect(() => ctx.contributions.registerPromptCommand(workflowCommand));
  },
};
