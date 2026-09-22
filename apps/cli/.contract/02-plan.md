# Plan

| ID | Goal | Outputs | Acceptance criteria | Dependencies |
|----|------|---------|---------------------|--------------|
| T1 | Add test execution to CI. | `.github/workflows/typecheck.yml` | CI has a `bun run test` step after typecheck and before binary build. | None |
| T2 | Bound the mentions file-index cache. | `src/core/extensions/loader.ts` | `mentionsIndexByCwd` evicts old cwd entries above a fixed max and refreshes recency on hit. | None |
| T3 | Reduce sink-management boilerplate safely. | `src/core/extensions/loader.ts` | Sink clearing is centralized enough to remove repeated sink-reset drift without changing host-service behavior. | T2 |
| T4 | Add extension API version tolerance. | `src/core/extensions/manifest.ts` and tests if needed | Manifest validation accepts compatible V1 patch/minor versions and still rejects incompatible majors. | None |
| T5 | Remove model-runtime `any` casts if feasible. | `src/core/extensions/model-runtime.ts` | Existing `biome-ignore noExplicitAny` suppressions in this file are removed or explicitly deferred with evidence. | None |
| T6 | Decompose `agent.ts` incrementally. | `src/agent/*` | A coherent helper/subsystem is extracted from `agent.ts`, imports compile, and behavior is unchanged. | T1-T5 |
