// Query complexity scorer — suggests a per-turn token budget from the query's
// characteristics. Ported faithfully from OpenJarvis
// learning/routing/complexity.py (score_complexity + token tiers + thinking-
// model adjustment). Pure functions, no dependencies.
//
// Weights mirror upstream: length 0.20, domain 0.25, reasoning 0.25,
// multi-part 0.15, creative 0.15. This is a deterministic heuristic — no data
// dependency, safe to run before any model call. Consumers decide whether to
// act on the suggestion (opt-in); this module only computes it.

export type ComplexityTier = "trivial" | "simple" | "moderate" | "complex" | "very_complex";

export interface ComplexitySignals {
  length: number;
  domain: number;
  hasCode: boolean;
  hasMath: boolean;
  reasoning: number;
  hasReasoning: boolean;
  hasMultiStep: boolean;
  multiPart: number;
  nQuestions: number;
  nSubtasks: number;
  creative: number;
  hasCreative: boolean;
}

export interface ComplexityResult {
  /** 0.0 (trivial) – 1.0 (very complex), rounded to 3dp. */
  score: number;
  tier: ComplexityTier;
  suggestedMaxTokens: number;
  signals: ComplexitySignals;
}

const CODE_PATTERNS =
  /```|`[^`]+`|\bdef\s|\bclass\s|\bimport\s|\bfunction\s|\bconst\s|\bvar\s|\blet\s|\bif\s*\(|->|=>|\{\s*\}|\bfor\s+\w+\s+in\s|#include|System\.out/i;
const MATH_PATTERNS =
  /\bsolve\b|\bintegral\b|\bequation\b|\bproof\b|\bderivative\b|\bmatrix\b|\btheorem\b|\bcalculate\b|\bcompute\b|\bsigma\b|\bsum\b|\blimit\b|\bprobability\b/i;
const REASONING_PATTERNS =
  /\bexplain\b|\banalyze\b|\bcompare\b|\bwhy\b|\bstep[- ]by[- ]step\b|\breason\b|\bthink\b|\bpros\s+and\s+cons\b|\btrade-?\s*offs?\b|\bevaluate\b/i;
// DOTALL in upstream (the `s` flag) so `.*` spans newlines.
const MULTI_STEP_PATTERNS =
  /\bthen\b.*\bthen\b|\bfirst\b.*\bnext\b|\bstep\s*\d|\b(?:and\s+also|additionally|furthermore)\b|\b\d+\.\s/is;
const CREATIVE_PATTERNS =
  /\bwrite\b.*\b(?:essay|story|article|report|poem)\b|\bgenerate\b.*\b(?:code|script|program)\b|\bcreate\b|\bdesign\b|\bdraft\b|\bcompose\b/i;
const THINKING_MODEL_PATTERNS = /qwen3\.5|qwq|deepseek-r1|o1-|o3-|o4-/i;

const TOKEN_TIERS: Record<ComplexityTier, number> = {
  trivial: 1024, // greetings, yes/no, factoid lookups
  simple: 2048, // short answers, definitions
  moderate: 4096, // explanations, summaries
  complex: 8192, // analysis, code generation, multi-step
  very_complex: 16384, // long-form, multi-part reasoning
};

const THINKING_TOKEN_MULTIPLIER = 2;

function countMatches(query: string, re: RegExp): number {
  return (query.match(re) ?? []).length;
}

function countSubTasks(query: string): number {
  const numbered = countMatches(query, /^\s*\d+[.)]\s/gm);
  const bulleted = countMatches(query, /^\s*[-*]\s/gm);
  return numbered + bulleted;
}

/** Score a query's complexity (0..1) and suggest a token budget. */
export function scoreComplexity(query: string): ComplexityResult {
  let score = 0;

  // Length signal (0–0.20)
  const length = query.length;
  let lengthScore: number;
  if (length < 20) lengthScore = 0.0;
  else if (length < 100) lengthScore = 0.3;
  else if (length < 300) lengthScore = 0.6;
  else if (length < 800) lengthScore = 0.8;
  else lengthScore = 1.0;
  score += 0.2 * lengthScore;

  // Domain signal (0–0.25)
  const hasCode = CODE_PATTERNS.test(query);
  const hasMath = MATH_PATTERNS.test(query);
  let domainScore = 0;
  if (hasCode) domainScore = Math.max(domainScore, 0.7);
  if (hasMath) domainScore = Math.max(domainScore, 0.8);
  if (hasCode && hasMath) domainScore = 1.0;
  score += 0.25 * domainScore;

  // Reasoning signal (0–0.25)
  const hasReasoning = REASONING_PATTERNS.test(query);
  const hasMultiStep = MULTI_STEP_PATTERNS.test(query);
  let reasoningScore = 0;
  if (hasReasoning) reasoningScore = 0.6;
  if (hasMultiStep) reasoningScore = Math.max(reasoningScore, 0.8);
  if (hasReasoning && hasMultiStep) reasoningScore = 1.0;
  score += 0.25 * reasoningScore;

  // Question / sub-task count (0–0.15)
  const nQuestions = countMatches(query, /\?/g);
  const nSubtasks = countSubTasks(query);
  const multiPart = nQuestions + nSubtasks;
  let multiScore: number;
  if (multiPart <= 1) multiScore = 0.0;
  else if (multiPart <= 3) multiScore = 0.5;
  else multiScore = 1.0;
  score += 0.15 * multiScore;

  // Creative / generative signal (0–0.15)
  const hasCreative = CREATIVE_PATTERNS.test(query);
  const creativeScore = hasCreative ? 0.7 : 0.0;
  score += 0.15 * creativeScore;

  score = Math.max(0, Math.min(1, score));

  let tier: ComplexityTier;
  if (score < 0.15) tier = "trivial";
  else if (score < 0.3) tier = "simple";
  else if (score < 0.55) tier = "moderate";
  else if (score < 0.8) tier = "complex";
  else tier = "very_complex";

  return {
    score: Math.round(score * 1000) / 1000,
    tier,
    suggestedMaxTokens: TOKEN_TIERS[tier],
    signals: {
      length: lengthScore,
      domain: domainScore,
      hasCode,
      hasMath,
      reasoning: reasoningScore,
      hasReasoning,
      hasMultiStep,
      multiPart: multiScore,
      nQuestions,
      nSubtasks,
      creative: creativeScore,
      hasCreative,
    },
  };
}

/** True if the model name matches a known internal chain-of-thought model. */
export function isThinkingModel(modelName: string): boolean {
  return THINKING_MODEL_PATTERNS.test(modelName);
}

/** Multiply the token budget when the target is a thinking model. */
export function adjustTokensForModel(suggested: number, modelName?: string): number {
  if (modelName && isThinkingModel(modelName)) return suggested * THINKING_TOKEN_MULTIPLIER;
  return suggested;
}
