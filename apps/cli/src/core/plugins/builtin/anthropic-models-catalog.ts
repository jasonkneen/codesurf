// Single source of truth for the Anthropic Claude model lineup.
//
// Three provider extensions (anthropic API-key, claude-agent SDK, claude-skills) each register their own RegisteredModel entries for the same set of
// upstream models. Before this module, the IDs / context windows / aliases
// lived in three separate copies that drifted on every Claude release (audit
// §1: "Anthropic model catalog duplicated 3× across providers"). Each
// provider now reads from this catalog and layers on its own label /
// description (one is `via @ai-sdk/anthropic`, another `via
// @anthropic-ai/claude-agent-sdk`, etc.).
//
// Add a new Claude release in ONE place — here — then update each provider's
// label/description override map if its phrasing differs.

export interface AnthropicModelCoreSpec {
  /** Canonical model id (e.g. "claude-opus-4-7"). */
  id: string;
  /** Total context window for this model. */
  contextWindow: number;
  /** Short, family-level aliases (e.g. "opus", "sonnet"). May be empty. */
  aliases: string[];
  /** Whether the model supports extended thinking / reasoning. */
  reasoning: boolean;
  /** Whether the model supports vision input. */
  images: boolean;
}

/** Indicative per-million-token pricing in USD (input/output). */
export interface AnthropicModelPricing {
  inputPrice: number;
  outputPrice: number;
}

export const ANTHROPIC_MODELS: AnthropicModelCoreSpec[] = [
  {
    id: "claude-fable-5-1",
    contextWindow: 1_000_000,
    aliases: ["claude-fable", "fable"],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-fable-5",
    contextWindow: 1_000_000,
    aliases: [],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-opus-5-5",
    contextWindow: 1_000_000,
    // Newest Opus takes the bare family aliases; older ones keep only their full id.
    aliases: ["claude-opus", "opus"],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-opus-5",
    contextWindow: 1_000_000,
    aliases: [],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-opus-4-8",
    contextWindow: 1_000_000,
    aliases: [],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-opus-4-7",
    contextWindow: 1_000_000,
    aliases: [],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-opus-4-6",
    contextWindow: 1_000_000,
    aliases: [],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-sonnet-5",
    contextWindow: 1_000_000,
    aliases: ["claude-sonnet", "sonnet"],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-sonnet-4-6",
    contextWindow: 1_000_000,
    aliases: [],
    reasoning: true,
    images: true,
  },
  {
    id: "claude-haiku-4-5",
    contextWindow: 200_000,
    aliases: ["claude-haiku", "haiku"],
    reasoning: true,
    images: true,
  },
];

/** Indicative pricing keyed by canonical model id. Drift is acceptable here —
 *  the displayed numbers are advisory only. */
export const ANTHROPIC_MODEL_PRICING: Record<string, AnthropicModelPricing> = {
  "claude-fable-5-1": { inputPrice: 10, outputPrice: 50 },
  "claude-fable-5": { inputPrice: 10, outputPrice: 50 },
  "claude-opus-5-5": { inputPrice: 5, outputPrice: 25 },
  "claude-opus-5": { inputPrice: 5, outputPrice: 25 },
  "claude-opus-4-8": { inputPrice: 5, outputPrice: 25 },
  "claude-opus-4-7": { inputPrice: 5, outputPrice: 25 },
  "claude-opus-4-6": { inputPrice: 5, outputPrice: 25 },
  "claude-sonnet-5": { inputPrice: 3, outputPrice: 15 },
  "claude-sonnet-4-6": { inputPrice: 3, outputPrice: 15 },
  "claude-haiku-4-5": { inputPrice: 1, outputPrice: 5 },
};
