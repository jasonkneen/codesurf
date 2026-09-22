# CodeSurf index, verification and remaining storage review

2026-09-05. Product sources are unchanged. Full production reads in this slice:

- `src/storage/card-id.ts`, `src/storage/index.ts`, `src/storage/migrations.ts`, `src/storage/prompt-history.ts`, `src/storage/tile-state.ts`, `src/storage/traces.ts`, `src/storage/usage.ts`.
- `src/code-index/types.ts`, `src/code-index/chunker.ts`, `src/code-index/embeddings.ts`, `src/code-index/semantic-index.ts`, `src/code-index/vector-store.ts`.
- `src/verify/environment.ts`, `src/verify/evidence.ts`, `src/verify/orchestrator.ts`, `src/verify/retry.ts`, `src/verify/checkpoint.ts`, `src/verify/entrypoint.ts`, `src/verify/recipes.ts`.

Selected knowledge-extension and Agent callers were traced; those files are not claimed fully reviewed by this report. Test files were searched selectively, not completely read. No production database, embedding endpoint, browser or verification VM was started.

## I1 — P2: Structural chunking drops the entire preamble

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/code-index/chunker.ts`. Text before the first recognized declaration — imports, configuration, shebangs, comments, decorators — is retained as its own chunk with correct line coordinates, so every non-whitespace region of a file is searchable. Regression: `src/code-index/chunker.test.ts`.

`chunker.ts:76–105` starts chunks at the first recognized declaration. Imports, configuration statements and comments before it are absent from every returned chunk. The fallback only runs when no structural chunks exist. Executed direct import of `chunkCode` with an import followed by one exported function returned one chunk with `preambleRetained:false`. Search cannot retrieve the lost code.

Repair: retain the prefix as a chunk or attach it to the first declaration without losing line coordinates. Test import/config-only prefixes, shebangs, decorators and comments, with coverage of every non-whitespace input region.

## I2 — P2: Cancelled or failed refresh reports overall success

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/code-index/semantic-index.ts` and `src/core/extensions/native/knowledge-extensions.ts`. An `AbortSignal` is threaded from the caller through refresh, backend construction and `embedBatch`, cancellation is re-checked after embedding and before rows are committed, and a cancelled or failed refresh reports a distinct outcome instead of `success: true`. Regression: `src/code-index/semantic-index.test.ts`.

`semantic-index.ts:179–194` catches per-backend errors, including the abort raised by `throwIfAborted`, then always returns `success:true` and emits done. A VM executing the transpiled actual source with a mocked backend/store and an already-aborted signal returned `{"success":true,"backendError":"Semantic refresh aborted"}`. No disk store or network was used.

Backend construction and `embedBatch` also have no signal parameter; refresh does not check cancellation after embedding and before committing rows. `knowledge-extensions.ts:362–370,503–509` does not forward a signal to this otherwise cancellable API. Repair the complete caller-to-backend lifetime, preserve a distinct cancellation outcome, and compute aggregate success from completed work. Test abort before initialization, during embedding, and immediately before commit.

## I3 — P2: Partial embedding responses permanently mark incomplete files current

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/code-index/embeddings.ts` and `semantic-index.ts`. A response must carry exactly one finite vector per input, with consistent dimensions and correct index mapping, before the file's stored revision is updated, so an omitted, duplicated or out-of-range row leaves the file due for a retry instead of marking it current with missing chunks. Regression: `src/code-index/embeddings.test.ts` and `semantic-index.test.ts`.

`embeddings.ts:136–143` sorts response rows but does not validate input count or exact index correspondence. `semantic-index.ts:145–155` pairs these by array position, drops absent vectors, then commits the full file hash. If an endpoint returns fewer rows, chunks can be missing or paired with the wrong text; subsequent refresh skips that unchanged hash at line 124. This is source-supported; no endpoint was invoked.

Require exactly one valid finite vector per input with consistent dimensions and correct index mapping before changing the file's stored revision. Test omitted/duplicate/out-of-range indices and incomplete responses; a retry must retain or restore all chunks.

## I4 — P2: Concurrent store initialization lacks ownership

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/code-index/semantic-index.ts` and `vector-store.ts`. Initialization is shared through an in-flight entry so concurrent status, refresh and search calls cannot create competing stores for one directory, mutation is serialized, and the backend identity in the settings key now includes the endpoint as well as the model, so changing endpoint no longer reuses the previous endpoint's embeddings. Regression: `src/code-index/semantic-index.test.ts` and `vector-store.test.ts`.

`semantic-index.ts:240–250` caches only after asynchronous initialization. Concurrent status/refresh/search can initialize separate `SemanticVectorStore` instances for the same directory. Each has its own metadata object; `vector-store.ts:51–92,163–167` writes whole-file metadata without cross-instance coordination. This permits stale metadata publication and table-creation races. Settings key stores only backend ID/model ID, so changing an OpenAI-compatible endpoint while retaining a model name also reuses embeddings from the former endpoint.

Use an in-flight initialization entry, context-owned store lifetime and a backend identity including endpoint/model configuration. Serialize mutation or use a transactional metadata store. Test concurrent first access, backend change and clear during pending initialization. These interleavings are source findings, not executed database reproductions.

## I5 — Performance: Structural line lookup is quadratic

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/code-index/chunker.ts`. A monotonic line cursor replaces the two scans from offset zero per declaration, so the same fixture is linear rather than quadratic in declaration count; the regression asserts chunk and line output identical to the previous algorithm. Regression: `src/code-index/chunker.test.ts`.

`chunker.ts:95–96,147–153` scans from offset zero twice per declaration. A file with many small declarations repeatedly traverses the same prefix. Replace this with a monotonic line cursor or precomputed offsets after establishing a matching-output benchmark. This is an algorithmic finding; measurements below characterize only this function, not overall TUI latency.

Executed with Bun in this checkout: fixture lines `export const valueN = N;`, joined with newlines; one small warmup, three runs per size, median elapsed `performance.now()` duration. No network or filesystem in the measured call.

| Declarations / returned chunks | UTF-8 bytes | Median ms |
| --- | --- | --- |
| 1,000 | 28,779 | 21.79 |
| 2,000 | 59,779 | 76.58 |
| 4,000 | 121,779 | 318.05 |

This is a before-change baseline on one machine, not an after-change speedup claim. Preserve the same fixture and returned chunk/line metadata when comparing a future implementation.

## V1 — P1: Verification checkpoint preparation cannot be cancelled or bounded

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/verify/checkpoint.ts`, `orchestrator.ts` and `entrypoint.ts`, and wired at the caller in `src/agent/agent.ts`. One cancellation lifetime is threaded through preparation into the checkpoint list, create and delete subprocesses, which are killed on abort with bounded escalation and a timeout, the signal is re-checked after every await before further effects, and captured stdout and stderr tails are bounded while progress output is preserved. Regression: `src/verify/checkpoint-lifecycle.test.ts` (`verify checkpoint cancellation and bounds (V1)`).

`orchestrator.ts:66,80` passes abort only to recipe detection, not checkpoint creation. `checkpoint.ts:11–68,212–239` neither accepts an AbortSignal nor applies a timeout to list/create/delete subprocesses. Its stdout/stderr strings grow without a bound during installation. Once a checkpoint starts, cancelling the parent cannot terminate it through this API; a stalled installer can hold verification indefinitely.

Thread one cancellation lifetime through preparation and process ownership, check it after every await before further effects, and bound captured log tails. Preserve useful progress output. Test deferred checkpoint creation plus abort, descendants that ignore SIGTERM, and large log output. No Shuru process was launched for this finding.

## V2 — P2: Checkpoint identity omits the base environment

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/verify/checkpoint.ts`. The checkpoint key includes the base environment (`verifyBaseFrom`/`from`) and the dependency-affecting settings, so changing the base image rebuilds instead of reusing the old environment; concurrent creators of the same name share one create, and a failed attempt cleans up only the resource it owned. Regression: `src/verify/checkpoint-lifecycle.test.ts` (`verify checkpoint identity and coordination (V2)`).

`checkpoint.ts:93–131` hashes recipe and selected manifest contents but not `verifyBaseFrom`, `from`, or relevant runtime settings. Creation consumes those settings at `173–195`; lookup reuses the same name regardless. Changing the base checkpoint can therefore reuse the old environment without rebuilding it. Concurrent creation of the same name also has no lock; failure cleanup deletes by that name without establishing ownership.

Include dependency-affecting environment inputs in the key and coordinate creators; cleanup must only remove a resource owned by the failed attempt. Test identical project recipe with two base images and concurrent create failure/success. Source-only finding.

## V3 — P2: Verification prompts contradict CLI/no-smoke recipes

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/verify/entrypoint.ts`. The runtime phases are generated from the recipe's `smokeKind` and the observed capabilities — an unambiguous smoke target, a start command, host browser availability — so a `cli` or `none` recipe is never instructed to start a server or run browser QA, and the evidence and browser guidance follow the same rules. Regression: `src/verify/entrypoint.test.ts`.

`entrypoint.ts:99–124` unconditionally mandates starting a server and browser QA, including asserting host browser availability. Later `evidence.ts` may say CLI verification is appropriate or browser checks should be skipped. A correct `smokeKind:"cli"` or `"none"` recipe still receives both instructions. Generate phases from the recipe and observed capabilities; test CLI, library, HTTP and ambiguous-port prompts. No browser or model behavior was exercised.

## S1 — P3: Peer status convenience API removes omitted fields

**Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/storage/tile-state.ts`. `setPeerStatus` merges only the keys it was given instead of assigning explicit `undefined` over them, so an omitted task or file list is preserved while an explicit empty value still clears it. Regression: `src/storage/tile-state.test.ts`.

`tile-state.ts:137–142` supplies explicit undefined task/files values to `updateState`; `Object.assign` at line 129 overwrites existing values and JSON serialization removes the fields. Executed actual `TileStateStore` in a new temporary directory: save a task/files, call `setPeerStatus(id,"working")`, reload; both fields were absent. The temporary fixture was removed. No in-tree production caller of this convenience method was found, so this is a public API defect rather than a demonstrated current UI regression.

Merge only supplied keys and test omitted values preserve data while explicit empty/null values clear it according to the contract. The fixed shared `state.json.tmp` also merits multi-process coordination review before simultaneous writers are supported; no concurrent-write reproduction was performed here.

## Other reviewed surfaces

No additional defect was promoted from migrations, usage recording, trace serialization or prompt-history SQL in this slice. SQL writes are parameterized and migration/trace operations use transactions. This is a source-review disposition, not a claim of exhaustive runtime correctness. Verify network policy is hardcoded broader than supplied settings in both entrypoint and orchestrator; its intended policy should be decided explicitly during service extraction rather than inferred from a generic settings merge.
