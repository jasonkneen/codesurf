// @codesurf/plugin-api/ui — optional rendering contracts.
//
// A separate entrypoint on purpose. These are the only contracts that need a
// renderer type, so a headless plugin — a provider, a tool, a command — imports
// `@codesurf/plugin-api` and never pulls React into its type graph. Only a
// plugin that actually draws something imports this.
//
// The import below is type-only: nothing here exists at runtime, and the
// package still ships no React dependency.
export {};
//# sourceMappingURL=ui.js.map