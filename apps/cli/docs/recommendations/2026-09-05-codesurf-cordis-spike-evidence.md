# Cordis Phase 1 tooling spike — executed evidence (2026-09-05)

Executed in a detached scratch worktree (`.worktrees/cordis-spike`, base `3383e20`, own `node_modules`) during the resumed Claude Code session. Nothing here is in the main checkout yet; the spike exists to settle the build/resolution questions the plan raises in "1. First implementable slice" before the packages are created for real.

## Dependency

`bun add @deepseek-ai/cordis@4.0.2` resolves from the npm registry (`lib/index.js`, `lib/types/index.d.ts`, `src/`), pulling `@deepseek-ai/cosmokit` and `@standard-schema/spec`. The optional peer dependencies `cordis-plugin-loader` / `cordis-plugin-include` are not needed. zod v4 (already a root dependency) satisfies `Plugin.Config` as a Standard Schema.

## Configuration that passed every check

| Check | Command (from the worktree root) | Result |
| --- | --- | --- |
| Package + root build via project references | `bunx tsc -b` | pass |
| Root typecheck (existing script shape) | `bunx tsc --noEmit -p tsconfig.json` | pass (root `rootDir: ./src` sees only the packages' emitted `.d.ts`) |
| Root build (existing `build` script) | `bunx tsc -p tsconfig.json` | pass |
| Bun runtime resolution | `bun run src/spike.ts` | resolves both packages to `packages/*/src/index.ts` through the `"bun"` export condition |
| Vitest (Node) with aliases to package sources | `bunx vitest run -c vitest.spike.config.ts src/spike.test.ts` | 14/14 pass |
| Vitest (Node) without aliases | `bunx vitest run src/spike.test.ts` | 14/14 pass, resolving `packages/*/dist` (requires a prior `tsc -b`) |
| Bun-native tests | `bun test src/spike.bun.test.ts` | 14/14 pass |
| Biome over the packages | `bunx biome check packages/*/src` | clean |

Working pieces:

- Root `package.json`: `"@codesurf/plugin-api": "workspace:*"`, `"@codesurf/runtime": "workspace:*"`, `"@deepseek-ai/cordis": "4.0.2"` (workspaces already include `packages/*`).
- Root `tsconfig.json`: unchanged compiler options plus `"references": [{ "path": "./packages/plugin-api" }, { "path": "./packages/runtime" }]`.
- Each package: `tsconfig.json` with `composite: true`, `declaration`, `declarationMap`, `sourceMap`, `outDir ./dist`, `rootDir ./src`, `module ESNext`, `moduleResolution Bundler`, `types: ["node"]`; `package.json` with `"type": "module"`, `main ./dist/index.js`, `types ./dist/index.d.ts`, and `exports["."] = { "bun": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }`; `@codesurf/runtime` depends on `@codesurf/plugin-api` (workspace) and `@deepseek-ai/cordis`; `@codesurf/plugin-api` depends only on `@deepseek-ai/cordis` (for the `Context` augmentation).
- Vitest: an alias map `@codesurf/plugin-api → packages/plugin-api/src/index.ts`, `@codesurf/runtime → packages/runtime/src/index.ts` removes the build-before-test dependency; the existing `bun:sqlite`/`@opentui/*` shims are unaffected.
- The Context augmentation in plugin-api (`declare module "@deepseek-ai/cordis" { interface Context { demo: DemoService } }`) is carried transitively into the root program through runtime's emitted `.d.ts`; `root.demo` typechecks in `src/` with only `@codesurf/runtime` imported.
- A single `@deepseek-ai/cordis` instance is shared: `Object.getPrototypeOf(runtime.DemoService) === Service` from the root's import, so `instanceof Service` holds across package boundaries.

## Cordis 4.0.2 semantics observed (14 executed assertions in `src/spike.test.ts`)

- `ctx.plugin(plugin, config)` returns a thenable **Fiber** (not a Promise) with `dispose()`, `await()`, `restart()`, `update()`, `state`, `name`, `uid`, `ctx`. `apply` runs after a microtask, so the fiber is `LOADING` synchronously and `ACTIVE` after `await fiber`. `FiberState` is a `const enum` (PENDING 0, LOADING 1, ACTIVE 2, FAILED 3, DISPOSED 4, UNLOADING 5); use literals at runtime.
- Two `new Context()` roots are fully isolated: services provided on one are invisible on the other and `rootB.registry.has(plugin)` is false.
- `fiber.dispose()` returns a Promise that **awaits async effect disposers** before resolving; synchronously `fiber.uid` is already null but the registration is still visible until the disposer finishes. Status events fire `ACTIVE→UNLOADING` then `UNLOADING→DISPOSED` on `internal/status`. A second `dispose()` returns `undefined` and runs nothing twice. `ctx.effect` on a disposed fiber throws `CordisError` with code `INACTIVE_EFFECT`. The root stays `ACTIVE`.
- Remount after dispose creates a fresh runtime record (`uid` changes); `fiber.restart()` unloads and reloads in place.
- A plugin whose `inject` names a missing service stays `PENDING` (awaiting it resolves immediately, it does not block); `root.provide(name, value)` activates it; the returned unprovide function (awaited) unloads the dependent back to `PENDING`.
- `ctx.isolate("demo")` yields a scope where the root's service is invisible; mounting a second service instance inside the scope activates dependents there without touching the root.
- An `apply()` that throws makes `await fiber` reject with that error, sets `FAILED`, logs through `ctx.logger` (buffer entry of type `error`), emits **no** `internal/error` event, and leaves the root usable. `fiber.dispose()` on a failed fiber moves it to `DISPOSED`.
- `Config` (zod v4 object schema) is validated **before** `apply`: bad config rejects `await fiber` with `ValidationError` (a `TypeError`, message `invalid config:` with `at <path>`), state `FAILED`, `apply` never called; `ctx.plugin()` itself does not throw synchronously. Valid config reaches `apply` as the schema **output** (defaults applied). `fiber.update(config)` re-validates and restarts. `undefined` config against an object schema is a `ValidationError`.
- Disposal order: disposers registered by **separate** `ctx.effect` calls are started in reverse order but run **concurrently** (`Promise.all`), so an async disposer can finish after a later-registered sync one; disposers yielded by **one generator effect** run in reverse **and sequentially**, awaiting async ones. Plugins that need strict reverse teardown must collect their disposers in a single generator effect.
- A `Service` subclass mounted via `ctx.plugin(ServiceClass)` is provided one microtask later and removed on fiber dispose; constructing it directly against the root (`new DemoService(root)`) provides it synchronously because the root fiber is already `ACTIVE`.
- `root.fiber.dispose()` unloads every mounted plugin (awaited) and leaves the root `ACTIVE` (it behaves as a restart).

## Gotchas for the implementation

- cordis types `config` from `apply`'s parameter (the schema output type), so call sites relying on schema defaults need an explicit cast or a separate input type.
- `packages/*/dist` must exist for any Node consumer that does not alias to sources (vitest without the alias, `tsc --noEmit` at the root). Build order: `tsc -b` at the root before the existing `tsc` build, or make `build`/`typecheck` scripts run `tsc -b` first.
- The daemon package (`@codesurf/daemon`, `noEmit`, run as TypeScript by Bun) is unaffected by the references; it is not listed in them.
