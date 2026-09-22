// Vitest-only stub for `@opentui/react` (see opentui-core.ts for rationale —
// the underlying @opentui/core is Bun-native and cannot load under Node).
// Provides the hooks src/ imports at runtime with inert defaults; extend if a
// new runtime import appears (vitest fails loudly on missing exports).

export function useTerminalDimensions(): { width: number; height: number } {
  return { width: 80, height: 24 };
}

export function useKeyboard(_handler: (key: unknown) => void): void {
  // Inert: no terminal input under vitest.
}

export function useRenderer(): Record<string, unknown> | null {
  return null;
}
