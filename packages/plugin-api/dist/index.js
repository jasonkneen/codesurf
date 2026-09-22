// @codesurf/plugin-api — structural contracts for native CodeSurf plugins.
//
// This package is the boundary. It declares what a plugin may ask of the host
// and nothing about how the host provides it: no imports of the CLI, the TUI,
// the Agent, or any concrete tool. `@codesurf/runtime` implements these
// contracts; plugins depend only on this package and on cordis itself.
//
// Optional React/OpenTUI rendering contracts live in a separate entrypoint
// (`@codesurf/plugin-api/ui`) so a headless plugin never pulls in a renderer
// type graph.
export {};
//# sourceMappingURL=index.js.map