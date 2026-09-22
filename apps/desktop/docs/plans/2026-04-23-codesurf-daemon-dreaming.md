# CodeSurf Daemon Dreaming Implementation Plan

> For Hermes: implement in small controlled bursts without touching unrelated dirty files.

Goal: add a daemon-owned dreaming service backed by a new repo package (`packages/codesurf-dreaming`) that can consolidate recent workspace sessions into generated CodeSurf memory and make that memory available to future chat runs.

Architecture:
- Core logic lives in `packages/codesurf-dreaming` as a plain ESM package consumed by `bin/codesurfd.mjs`.
- The daemon owns run state, locking, provider execution, cancellation, and persistent run records.
- Dream output is written to project-local generated memory at `<workspace>/.codesurf/DREAMING.md` and layered into `bin/memory-loader.mjs` as local-only context.
- Electron main only acts as a client/controller through `src/main/daemon/client.ts` and thin IPC/preload bridges.

Planned bursts:
1. Add failing daemon tests for manual dreaming run/status plus memory-loader inclusion.
2. Create `packages/codesurf-dreaming` with storage, prompt building, session harvesting, and provider-run abstraction.
3. Wire daemon routes in `bin/codesurfd.mjs` and daemon client methods in `src/main/daemon/client.ts`.
4. Add thin `dreaming:*` IPC/preload/env seams so the main app can call the daemon service.
5. Run targeted daemon tests and a repo build to verify nothing else regressed.

Out of scope for this burst:
- automatic background triggering from chat/job completion
- renderer UI surfaces for dreaming runs
- dashboard unification with generic daemon chat jobs
- remote-daemon dream orchestration
