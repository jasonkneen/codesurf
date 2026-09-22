// Detect when an assistant turn claims to have performed an action but made
// zero tool calls. This is the loop-side backstop for the GROUNDING rule in
// MODE_PROMPTS — it catches fabrications even when the prompt is ignored.
//
// Failure mode being caught:
//   model emits "Implemented X" / "Fixed Y" / "Committed Z" as plain text
//   with no edit_file/write_file/bash invocations. The agent loop currently
//   has no enforcement, so the lie reaches the user.
//
// This module is text-only and side-effect free so it can be unit-tested
// without mounting the agent loop.

const ACTION_VERBS = [
  "implemented",
  "committed",
  "fixed",
  "edited",
  "wrote",
  "created",
  "deleted",
  "updated",
  "migrated",
  "merged",
  "pushed",
  "landed",
  "patched",
  "refactored",
  "added",
  "installed",
  "configured",
  "removed",
  "renamed",
  "moved",
  "shipped",
  "applied",
  "completed",
];

// Build patterns once at module load.
const VERBS_GROUP = ACTION_VERBS.join("|");
// 1. First-person past-tense claim, e.g. "I implemented", "We've fixed", "I just committed".
//    Negative lookbehind skips conditional/subordinator prefixes ("if we implemented",
//    "when I committed", "until we fix") which describe hypotheticals or temporal
//    qualifications, not asserted completion.
const FIRST_PERSON_RE = new RegExp(
  String.raw`(?<!\b(?:if|when|until|unless|once|while|whenever|where|after|before)\s)\b(?:I|we)(?:['’]ve|\s+have|\s+just|\s+now)?\s+(${VERBS_GROUP})\b`,
  "i",
);
// 2. Bold or heading-style declaration, e.g. "**Implemented**", "**Fixed.**", "**Done:**".
const BOLD_DECLARATION_RE = new RegExp(String.raw`\*\*(${VERBS_GROUP}|done|fixed)[\s:.\*!]`, "i");
// 3. Sentence-initial declaration, e.g. "Implemented: the new table renderer.", "Fixed.".
const SENTENCE_START_RE = new RegExp(String.raw`(?:^|\n)\s*(${VERBS_GROUP}|done|fixed)[\s.:!]`, "i");

export interface FabricationFinding {
  /** The claim verb / phrase that triggered the detector. */
  matched: string;
  /** Which pattern fired — useful for diagnostics and tuning. */
  source: "first-person" | "bold-declaration" | "sentence-start";
}

/**
 * Returns a finding when the assistant text contains a claim-of-action but
 * the turn produced zero tool calls. Returns null when the turn is grounded
 * (any tool call) or when no claim pattern matched.
 *
 * Conservative by design: the patterns target unambiguous past-tense claims.
 * Future intent ("I will implement") and references to prior commits ("we
 * implemented X in #1234") are intentionally excluded.
 */
export function detectClaimWithoutTool(assistantText: string, toolCallCount: number): FabricationFinding | null {
  if (toolCallCount > 0) return null;
  const text = assistantText ?? "";
  if (text.trim().length === 0) return null;

  const firstPerson = FIRST_PERSON_RE.exec(text);
  if (firstPerson) return { matched: firstPerson[0], source: "first-person" };

  const bold = BOLD_DECLARATION_RE.exec(text);
  if (bold) return { matched: bold[0].trim(), source: "bold-declaration" };

  const sentenceStart = SENTENCE_START_RE.exec(text);
  if (sentenceStart) return { matched: sentenceStart[0].trim(), source: "sentence-start" };

  return null;
}

/** Human-readable warning to surface when fabrication is detected. */
export function formatFabricationWarning(finding: FabricationFinding): string {
  return [
    `\n\n⚠️ Grounding check: this turn claimed an action (${JSON.stringify(finding.matched)})`,
    "but invoked zero tools. The claim is likely fabricated — verify against",
    "git status / file state before trusting it.",
  ].join(" ");
}
