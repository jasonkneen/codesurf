// Broad query classification for the learning loop. Ported from OpenJarvis
// learning/routing/_utils.py:classify_query. Pure function, no dependencies.
//
// The class is stored on each trace (traces.query_class) and is the bucket key
// for per-class model routing and few-shot mining later. Keep the categories
// and order identical to upstream so accumulated data stays comparable.

export type QueryClass = "code" | "math" | "short" | "long" | "general";

const CODE_RE = /```|`[^`]+`|\bdef\s|\bclass\s|\bimport\s|\bfunction\s/i;
const MATH_RE = /\bsolve\b|\bintegral\b|\bequation\b|\bcalculate\b|\bcompute\b/i;

/** Classify a query into a broad routing category. */
export function classifyQuery(query: string): QueryClass {
  if (CODE_RE.test(query)) return "code";
  if (MATH_RE.test(query)) return "math";
  if (query.length < 50) return "short";
  if (query.length > 500) return "long";
  return "general";
}
