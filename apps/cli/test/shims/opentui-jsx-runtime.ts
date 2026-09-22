// Vitest-only stub for @opentui/react's JSX runtime (tsconfig sets
// jsxImportSource to @opentui/react, so every .tsx file imports
// `@opentui/react/jsx-dev-runtime`). Components are never actually rendered
// under vitest — TUI rendering tests are Bun-native — so plain element
// objects are enough for module graphs to load.

export const Fragment = Symbol.for("opentui.stub.fragment");

function element(type: unknown, props: unknown, key?: unknown): Record<string, unknown> {
  return { type, props, key };
}

export function jsx(type: unknown, props: unknown, key?: unknown): Record<string, unknown> {
  return element(type, props, key);
}

export const jsxs = jsx;

export function jsxDEV(type: unknown, props: unknown, key?: unknown): Record<string, unknown> {
  return element(type, props, key);
}
