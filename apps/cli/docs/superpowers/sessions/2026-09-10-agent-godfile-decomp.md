# agent.ts god-file decomposition plan (Cordis Phase 1)

Goal: reduce src/agent/agent.ts (2723 lines) into bounded modules with stable
public surface, keeping typecheck + agent tests green after every slice.

Safety rules (from lessons learned):
- NEVER full-file write agent.ts (write tool truncates >~1200 lines) — use targeted
  edit/sed only, small surgical hunks.
- Do NOT run biome --write on agent.ts (known mis-analysis; --no-verify for its commits).
- One slice at a time; typecheck (bunx tsc --noEmit) + agent test suite green before commit.

Slices:
- S1 (IN PROGRESS, subagent 24d66aa0): prompt builders (findCustomSubagent,
  formatCustomSubagentsPromptSection, buildSystemPrompt, buildSubagentPrompt,
  formatSandboxPromptSection, lines 246-506) -> src/agent/prompts.ts.
- S2: Agent class surface — split large cohesive method groups into Mixin/mixin-style
  modules under src/agent/ (e.g. agent-hooks.ts for the hook dispatch surface, agent-turns.ts
  for runTask/runDelegation/turn-loop glue), merging back via class-declaration augmentation or
  plain helper modules called by Agent. Prefer FULL-STANDALONE helper modules over mixins for
  testability. Candidate groupings by line spans to be confirmed against the class layout.
- S3: constants + option resolution (MAX_*, VISION_MODEL/COMPUTER_MODEL/DEFAULT_TITLE_MODEL,
  ADAPTIVE_ROUTING_*, mode selection helpers getModeSpecificModelSelection wrapper) -> src/agent/constants.ts
  or config.ts.
- S4: final pass — agent.ts under ~600 lines, module map documented here, re-run perf bench.

Perf note (re-measured 2026-09-10): cordis eager import adds ~200ms to agent module graph
(startup import 215->426ms median). Treat cordis lazy-load as a SEPARATE follow-up, not part
of the mechanical decomposition.

## COMPLETE (2026-09-10) — 15 verified slices

agent.ts: 2723 -> 296 lines (-2427, 89%). agent.ts is now the composition root only
(imports + class declaration + private fields + constructor). Logic lives in:

11 mixins (src/agent/mixins/): accessors, session-lifecycle, notifications, context,
telemetry, subagent, turn-engine, batch, runtime, turn-control, session-admin.
3 support modules: prompts.ts, constants.ts, types.ts.

Mixin chain (bottom-up): Accessors -> SessionLifecycle -> Notifications -> Context ->
Telemetry -> Subagent -> TurnEngine -> Batch -> Runtime -> TurnControl -> SessionAdmin -> Agent.

Every slice gated: tsc + build + biome clean; src/agent 206/206; full suite 2052/2059
(only the 7 pre-existing/env codesurf-desktop daemon failures).

The review's S2 (behavior-owner split) and S4 (<600-line target) are now met (296).
