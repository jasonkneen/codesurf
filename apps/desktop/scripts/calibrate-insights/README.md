# Insight Calibration Harness

Measures whether a non-Claude model — Codex, OpenCode, OpenClaw, Hermes — produces
`★ Insight` blocks that match the style and substance Claude produces, when given
the `CODESURF_INSIGHT_CONVENTION` prompt (defined in `src/main/ipc/chat.ts`).

## Why this exists

The CodeSurf convention ships an Insight-section contract to every provider at
session start. Whether each model *actually follows* the contract is an empirical
question. This harness answers it without needing to set up 5 separate model APIs
simultaneously — Claude is the reference, everything else is compared against
captured gold outputs.

## Layout

    fixtures/        Self-contained tasks (.md). Each asks the model to emit
                     an Insight block for a specific CodeSurf scenario.
    gold/            Claude's reference Insight blocks for each fixture.
                     Naming matches fixture filenames 1:1.
    rubric.mjs       Structural + qualitative scoring logic.
    score.mjs        CLI: score a model's output against a fixture's gold.

## How to use

    # Score a model output against a fixture
    node scripts/calibrate-insights/score.mjs fixtures/chat-bubble-radius.md < model-output.md

    # Output is a JSON block with pass/fail per criterion plus an overall score.

## Adding fixtures

1. Create `fixtures/<name>.md` — a self-contained task that prompts an Insight
   block. Keep it short and specific. Don't assume the model has codebase access.
2. Create `gold/<name>.md` — Claude's canonical response. Generate this by asking
   Claude (Opus or Sonnet 4.5) to complete the fixture. Never hand-edit the gold;
   re-generate the whole thing so the voice stays coherent.
3. Never overwrite existing gold files — if Claude's voice drifts across model
   versions, version the new gold with a suffix (`gold/<name>-v2.md`) and update
   `score.mjs` to pick the active one. The old gold stays as historical record.

## What the rubric measures

Structural (mechanical pass/fail):

- Has the literal `★ Insight ─────` framing
- 2–3 bullet points (not 1, not 5+)
- No prose paragraphs outside the bullets
- Fits in ~200 words

Qualitative (heuristic — coarse grep for presence/absence):

- Names a concrete symbol, path, token, or constant from the fixture
- Avoids the 5 anti-patterns (praise, restatement, generic advice, tutorial,
  vague speculation)
- Contains a "because" / "since" / "which is why" connector (signals the
  non-obvious why)

The qualitative heuristics are intentionally coarse. They won't catch a clever
model that game-grabs the required phrases without substance; they *will* catch
a model that emits praise or skips the star framing entirely.

## Scope

This harness doesn't invoke models. It takes captured outputs (pasted from your
preferred chat UI, or piped from a CLI) and scores them. Automatic dispatch
across all 5 providers is a future step — the hard design work is the
fixtures and rubric, and that's all here.
