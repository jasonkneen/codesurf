# Provider Controls UI Plan

**Date:** 2026-06-08
**Scope:** `/showcase`, `/models`, provider adapter metadata, and registered provider settings.

## Goal

Make the provider/model controls use the registered provider surface more effectively:

- `/showcase` should reflect the controls that are actually wired.
- `/models` should show useful provider/model capability context, not just names.
- Provider-specific registered settings should be reachable from model selection.

## Todo

- [x] Clean stale `/showcase` copy that still called `ListPicker` and `ToggleSwitch` remaining work.
- [x] Derive showcase model-control examples from the local Anthropic and xAI catalogs instead of hardcoded demo ids.
- [x] Carry adapter metadata into `ModelPickerRow`: transport, connection mode, session strategy, and auth mode.
- [x] Carry model capabilities/context into `ModelPickerRow` for compact display.
- [x] Render selected model details in `/models`: context, tools, vision, reasoning, persistence, transport/session/auth.
- [x] Add a provider settings modal reachable from `/models` with `Tab` when the selected adapter owns registered settings.
- [x] Support boolean toggles, select cycling, and string/number/secret edits through the existing extension settings service.
- [x] Add focused tests for model-row metadata and provider-setting helper behavior.
- [x] Verify with typecheck, build, focused tests, and touched-file Biome checks.

## Verification

- `bun run typecheck`
- `bun run build`
- `bunx vitest run src/ui/model-picker-rows.test.ts src/ui/provider-settings-modal.test.ts`
- `bunx biome check src/ui/ai-output/showcase.tsx src/ui/model-picker-modal.tsx src/ui/model-picker-rows.ts src/ui/model-picker-rows.test.ts src/ui/provider-settings-modal.tsx src/ui/provider-settings-modal.test.ts`

## Notes

- `src/ui/app.tsx` still has unrelated pre-existing Biome findings outside this change: unused parameters, stale hook dependency warnings, and formatting suggestions around paste/file mention helpers.
- The worktree also had unrelated in-flight changes in `src/core/extensions/native/opencode-provider.ts` and `src/core/extensions/builtin/opencode-provider.test.ts`; they were not touched.
