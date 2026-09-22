/**
 * Narrow an unknown caught value to a human-readable message.
 *
 * Replaces the `catch (err: any) { … err.message … }` pattern: with `strict`
 * (and `useUnknownInCatchVariables`) a bare `catch (err)` types `err` as
 * `unknown`, so accessing `.message` needs narrowing. This helper centralises
 * that so catch clauses stay one line and never reintroduce `any`.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return String(err)
}
