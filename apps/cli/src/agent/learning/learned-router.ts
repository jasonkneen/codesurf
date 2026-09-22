// Learned model routing — picks the best-performing model for a query class
// from accumulated trace data. Ported from OpenJarvis
// learning/routing/learned_router.py (the composite-score policy update).
//
// Pure function: the caller supplies the trace samples (already filtered to a
// query class), so this stays free of the storage layer and is unit-testable.
// The composite per trace mirrors upstream: 0.6 * outcome + 0.4 * feedback,
// where outcome is 1 for success / 0 otherwise and missing feedback defaults
// to 0.5 (neutral). A model must have >= minSamples observations to qualify.

export interface RouterTraceSample {
  model: string;
  outcome: "success" | "failure" | "cancelled" | null;
  feedback: number | null;
}

export interface ModelChoice {
  model: string;
  /** Mean composite score across this model's samples (0..1). */
  score: number;
  samples: number;
}

export const DEFAULT_MIN_SAMPLES = 5;

function composite(sample: RouterTraceSample): number {
  const outcomeScore = sample.outcome === "success" ? 1 : 0;
  const feedback = sample.feedback ?? 0.5;
  return 0.6 * outcomeScore + 0.4 * feedback;
}

function completedSamples(samples: RouterTraceSample[]): RouterTraceSample[] {
  // A human cancellation is useful evidence in the trace store, but it says
  // nothing about a model's quality and must not count toward routing gates.
  return samples.filter((sample) => sample.outcome !== "cancelled");
}

/**
 * Pick the highest-scoring model among samples, requiring at least
 * `minSamples` observations per model. Returns null when no model clears the
 * sample threshold (the caller then falls back to the user's selected model).
 */
export function pickBestModel(
  samples: RouterTraceSample[],
  minSamples: number = DEFAULT_MIN_SAMPLES,
): ModelChoice | null {
  const byModel = new Map<string, number[]>();
  for (const sample of completedSamples(samples)) {
    const arr = byModel.get(sample.model) ?? [];
    arr.push(composite(sample));
    byModel.set(sample.model, arr);
  }

  let best: ModelChoice | null = null;
  for (const [model, composites] of byModel) {
    if (composites.length < minSamples) continue;
    const mean = composites.reduce((a, b) => a + b, 0) / composites.length;
    if (!best || mean > best.score) {
      best = { model, score: mean, samples: composites.length };
    }
  }
  return best;
}

export interface ModelStanding extends ModelChoice {
  /** True when this model cleared the `minSamples` threshold. */
  qualified: boolean;
}

/**
 * Full standings for a query class: every observed model ranked by mean
 * composite score (desc), each tagged with whether it cleared `minSamples`.
 * `pickBestModel` is the head of the qualified subset. Used by the `/routing`
 * inspector to show the learned data the router acts on, including the
 * below-threshold models the router still ignores.
 */
export function rankModels(samples: RouterTraceSample[], minSamples: number = DEFAULT_MIN_SAMPLES): ModelStanding[] {
  const byModel = new Map<string, number[]>();
  for (const sample of completedSamples(samples)) {
    const arr = byModel.get(sample.model) ?? [];
    arr.push(composite(sample));
    byModel.set(sample.model, arr);
  }

  const standings: ModelStanding[] = [];
  for (const [model, composites] of byModel) {
    const mean = composites.reduce((a, b) => a + b, 0) / composites.length;
    standings.push({
      model,
      score: mean,
      samples: composites.length,
      qualified: composites.length >= minSamples,
    });
  }
  standings.sort((a, b) => b.score - a.score);
  return standings;
}
