# Phase 3b — xAI Provider Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Agent from constructing `XaiProvider` directly. Move xAI provider construction into the `builtin.provider-xai` extension's `connect()`, and migrate the four xAI-coupled tools (`search_web`, `search_x`, `generate_image`, `generate_video`) into a new `builtin.tools-xai` extension. Drops `this.provider`, `setApiKey → createProvider`, `requireProvider()`, and the `xaiProvider` parameter from `resolveModelRuntimeViaKernel`.

**Architecture:** The xAI session adopts the same shape as the Anthropic API-key session: `connect(ctx)` constructs `createProvider(getApiKey(), baseURL)` and returns a session with `getModel(modelId)` (chat-or-responses, metadata-aware) plus a new `getRawProvider()` escape hatch for xAI-specific consumers (vision sub-agent, image/video tools). The kernel resolver pulls the raw provider through that escape hatch and continues to call `resolveXaiRuntime(provider, modelId)` for `modelInfo` / `providerOptions` enrichment, so behavior stays bit-identical for batch / responses / reasoning paths. The four blocked tools live in a sibling `xai-tools.ts` extension that calls `createProvider(getApiKey())` lazily at execute time — no shared singleton, no apiKey-rotation race.

**Tech Stack:** TypeScript strict, vitest, ai-sdk (`ai`, `@ai-sdk/xai`, `@ai-sdk/anthropic`), Bun runtime, kernel extension registry.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/core/extensions/api.ts` | Modify | Add `getRawProvider?: () => unknown` and `getResponsesModel?: (modelId: string) => LanguageModel` to `ProviderSession`. |
| `src/core/extensions/builtin/xai-provider.ts` | Modify | Construct `XaiProvider` in `connect()`; expose `getModel`, `getResponsesModel`, `getRawProvider`. |
| `src/core/extensions/model-runtime.ts` | Modify | Drop `xaiProvider: XaiProvider` parameter. xAI fast-path now pulls raw provider from session. Update `unknown-modelId` fallback to throw or route through xAI session. |
| `src/core/extensions/model-runtime.test.ts` | Modify | Drop `xai = createProvider(...)` setup; call `resolveModelRuntimeViaKernel(modelId, conversationId)`. Add new test: xAI session's `getModel` dispatches chat-vs-responses based on `responsesOnly` metadata. |
| `src/utils/side-question.ts` | Modify | Take `model: LanguageModel` instead of `provider: XaiProvider`. |
| `src/agent/compaction.ts` | Modify | `summarizeConversation` and `generateCompactionSummary` take `model: LanguageModel` + `providerOptions` + `supportsMaxOutputTokens` instead of `provider: XaiProvider`. |
| `src/grok/client.ts` | Modify | `generateTitle` takes `model: LanguageModel` + `modelId`. Keep `createProvider`, `XaiProvider`, `resolveModelRuntime` exports (used inside `xai-provider.ts` and `model-runtime.ts`). |
| `src/agent/agent.ts` | Modify | Drop `this.provider`, `setApiKey → createProvider`, `requireProvider()`. Vision sub-agent uses `runtime.session.getResponsesModel(childModelId)`. Batch turn drops `provider` parameter. `createTools(provider, mode)` → `createTools(mode)`. Caller of side-question/compaction/title resolves runtime first, passes model. |
| `src/grok/tools.ts` | Modify | Drop the four xAI-coupled tools (`search_web`, `search_x`, `generate_image`, `generate_video`) and `provider` parameter. `createTools(mode)` returns only `{ generate_plan }` when `mode === "plan"`, else `{}`. Drop `XaiProvider` and `media` imports. |
| `src/core/extensions/builtin/xai-tools.ts` | Create | New builtin extension. Registers `search_web`, `search_x`, `generate_image`, `generate_video` with `modes: ["agent"]`. Constructs `XaiProvider` lazily inside each `execute()` via `createProvider(getApiKey())`. |
| `src/core/extensions/builtin/__tests__/xai-tools.test.ts` | Create | Verify the four tools are registered, gated to `modes: ["agent"]`, and return a credential-error result when `getApiKey()` is missing. |
| `src/core/extensions/builtin/index.ts` | Modify | Export `xaiToolsExtension` and include in `loadBuiltinExtensions()`. |
| `src/core/extensions/builtin/groups.ts` | Modify | Add the four tool names to a new `xai-tools` group (or extend the existing `provider-tools` group). |
| `src/grok/tools.test.ts` | Modify | Drop tests for the four migrated tools; add coverage that `createTools(mode)` returns the correct shape. |

---

## Task 1: xAI session owns provider construction

**Goal:** The xAI provider extension's `connect()` constructs the `XaiProvider` and returns a session exposing `getModel`, `getResponsesModel`, and `getRawProvider`. The kernel resolver no longer takes an `xaiProvider` parameter — it pulls the raw provider through the session. All existing `resolveModelRuntimeViaKernel` callers still work because `model-runtime.ts` drops the parameter and the consumers in `agent.ts` are updated.

**Files:**
- Modify: `src/core/extensions/api.ts`
- Modify: `src/core/extensions/builtin/xai-provider.ts`
- Modify: `src/core/extensions/model-runtime.ts`
- Modify: `src/core/extensions/model-runtime.test.ts`
- Modify: `src/agent/agent.ts:1363, 2281` (call-site signature update only — pass apiKey/baseURL is no longer relevant)

- [ ] **Step 1: Set CODESURF_API_KEY in the test harness**

Edit `src/core/extensions/model-runtime.test.ts`. The current tests pass `createProvider("test-key")` so the apiKey rides on the parameter. After Task 1 the xAI session calls `getApiKey()` (verified: `src/utils/settings.ts` reads `process.env.CODESURF_API_KEY` at call time) and throws when it returns undefined. Without this step, all 6 existing tests fail.

In the existing `beforeAll` block (around line 18), add:

```ts
let originalCodeSurfKey: string | undefined;
// ... existing originalAnthropicKey, etc. declarations ...

beforeAll(() => {
  // ... existing temp dir setup ...
  originalCodeSurfKey = process.env.CODESURF_API_KEY;
  process.env.CODESURF_API_KEY = "test-key";
});
```

In `afterAll`:

```ts
afterAll(async () => {
  // ... existing cleanup ...
  if (originalCodeSurfKey === undefined) delete process.env.CODESURF_API_KEY;
  else process.env.CODESURF_API_KEY = originalCodeSurfKey;
});
```

Do NOT delete `CODESURF_API_KEY` in `beforeEach` — it must persist across all tests.

- [ ] **Step 2: Write the failing test — xAI session dispatches chat vs responses**

Add to `src/core/extensions/model-runtime.test.ts` inside the existing `describe("resolveModelRuntimeViaKernel", ...)` block (after line 62):

```ts
it("xAI session getModel returns the chat endpoint for chat models", async () => {
  await bootstrapExtensions(await loadBuiltinExtensions());
  // grok-code-fast-1 is NOT responsesOnly. The session must build via provider(modelId).
  const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-chat");
  expect(runtime.modelId).toBe("grok-code-fast-1");
  expect(runtime.modelInfo?.responsesOnly ?? false).toBe(false);
  expect(runtime.model).toBeDefined();
});

it("xAI session getResponsesModel returns the responses endpoint regardless of metadata", async () => {
  await bootstrapExtensions(await loadBuiltinExtensions());
  const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-resp");
  expect(runtime.session?.getResponsesModel).toBeDefined();
  const responses = runtime.session?.getResponsesModel?.("grok-code-fast-1");
  expect(responses).toBeDefined();
});

it("xAI session getRawProvider returns the underlying XaiProvider", async () => {
  await bootstrapExtensions(await loadBuiltinExtensions());
  const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-raw");
  const raw = runtime.session?.getRawProvider?.();
  expect(raw).toBeDefined();
  // XaiProvider is callable: provider(modelId) returns a chat model
  expect(typeof raw).toBe("function");
});
```

Also update the six existing tests in this file (lines 53–128) — drop the `const xai = createProvider("test-key")` line and pass `xai` argument removed from each `resolveModelRuntimeViaKernel(...)` call. Pattern:

```ts
// before:
const xai = createProvider("test-key");
const runtime = await resolveModelRuntimeViaKernel(xai, "grok-code-fast-1", "session-a");
// after:
const runtime = await resolveModelRuntimeViaKernel("grok-code-fast-1", "session-a");
```

Drop the `import { createProvider }` from line 5 (no longer used in this test file).

**Note for the API key:** the xAI extension's `auth.check` reads via `getApiKey()` from `src/utils/settings`. Tests need a valid API key to pass `auth.check`. Inspect `getApiKey()` — if it reads from `~/.grok/credentials.json` or env, set up `process.env.CODESURF_API_KEY = "test-key"` in `beforeEach` (analogous to the existing `ANTHROPIC_API_KEY` setup at lines 88, 107, 119).

- [ ] **Step 3: Run test to verify it fails**

```bash
bun run vitest run src/core/extensions/model-runtime.test.ts
```

Expected: FAIL — TypeScript error "Expected 2 arguments, but got 3" on `resolveModelRuntimeViaKernel(xai, ...)`, OR runtime errors on `runtime.session?.getResponsesModel` (undefined) and `runtime.session?.getRawProvider` (undefined). Either failure mode confirms the test exercises the unimplemented code paths.

- [ ] **Step 4: Extend ProviderSession in api.ts**

Edit `src/core/extensions/api.ts` around line 253 (the existing `ProviderSession` interface). Add two optional methods after the existing `getModel`:

```ts
export interface ProviderSession {
  readonly adapterId: string;
  readonly providerId: string;
  readonly mode: ProviderConnectionMode;
  readonly strategy?: ProviderSessionStrategy;

  /** Fast path — used by xAI, Anthropic API-key, OpenAI API-key. */
  getModel?: (modelId: string) => LanguageModel;

  /**
   * xAI-only: returns the responses-API LanguageModel for `modelId`,
   * regardless of the model's `responsesOnly` metadata. Used by the vision
   * sub-agent and the search_web/search_x tools (which always need the
   * responses endpoint to attach provider tools).
   */
  getResponsesModel?: (modelId: string) => LanguageModel;

  /**
   * Escape hatch for adapter-specific consumers that need the raw upstream
   * provider object (xAI's image/video/tools surface). Type is `unknown` —
   * callers must narrow inside their own module. Only xAI implements this.
   */
  getRawProvider?: () => unknown;

  /** Owning path — used by Claude Agent SDK, Codex CLI. */
  sendTurn?: (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ) => Promise<{ usage?: ProviderUsageSnapshot }>;

  /** Cancel an in-flight `sendTurn`. No-op for `getModel`-style sessions. */
  abortTurn?: () => void | Promise<void>;

  /** Close any persistent resources. Called on extension disable + shutdown. */
  disconnect?: () => void | Promise<void>;
}
```

- [ ] **Step 5: Construct XaiProvider in xai-provider.ts connect()**

Replace the entire `xaiProviderExtension` definition in `src/core/extensions/builtin/xai-provider.ts` (lines 46–105). New shape (note: import `getModelInfo` and `createProvider` at the top of the file alongside the existing imports — do NOT use `require()` inline):

```ts
import { createProvider, type XaiProvider } from "../../../grok/client";
import { getModelInfo } from "../../../grok/models";
// ... existing imports ...

function checkCredential(): CredentialStatus {
  const key = getApiKey();
  if (!key) {
    return {
      ok: false,
      reason: "Missing Grok API key (CODESURF_API_KEY).",
      needsUserAction: "paste-api-key",
    };
  }
  return { ok: true };
}

function createSession(ctx: ProviderConnectionContext): ProviderSession {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("xAI provider session requested without a configured API key. Set CODESURF_API_KEY or paste one via /models.");
  }
  // baseURL is read by createProvider() from CODESURF_BASE_URL / GROK_BASE_URL
  // env vars; no per-session override is needed at the kernel boundary today.
  const provider: XaiProvider = createProvider(apiKey);

  return {
    adapterId: ctx.adapterId,
    providerId: ctx.providerId,
    mode: "stateless",
    strategy: "per-turn",
    getModel: (modelId) => {
      // Mirror the dispatch in resolveXaiRuntime (grok/client.ts:48).
      // responsesOnly models MUST go through the responses endpoint.
      const info = getModelInfo(modelId);
      return info?.responsesOnly ? provider.responses(modelId) : provider(modelId);
    },
    getResponsesModel: (modelId) => provider.responses(modelId),
    getRawProvider: () => provider,
  };
}

export const xaiProviderExtension: ExtensionModule = {
  manifest: {
    schemaVersion: 1,
    id: EXTENSION_ID,
    name: "xAI Provider",
    version: "1.1.0",
    hostApiVersion: EXTENSIONS_V1_API_VERSION,
    kind: "builtin",
    description:
      "Default Grok / xAI model provider. Owns provider construction and contributes the full Grok model lineup.",
    protected: true,
    enabledByDefault: true,
    capabilities: ["provider-adapters", "models"],
    permissions: { network: "request" },
  },

  activate(api: ExtensionHostApi) {
    api.registerModelProvider({
      id: ADAPTER_ID,
      label: "xAI (Grok)",
      description: "Official xAI provider via @ai-sdk/xai. Owns provider construction; sessions exposed to the kernel resolver.",
      providerId: PROVIDER_ID,
      shape: "provider-family",
      transport: "sdk",
      connectionMode: "stateless",
      sessionStrategy: "per-turn",
      capabilities: { streaming: true, tools: true, images: true, reasoning: true },
      models: toRegisteredModels(),
      auth: { mode: "api-key", check: checkCredential },
      adapter: { connect: createSession },
    });
  },
};
```

Drop the `Phase 3a: metadata-only` header comment (lines 1–11) and replace with:

```ts
// Builtin xAI provider extension.
//
// Owns provider construction. The session returned by `connect()` exposes:
//   - getModel(modelId)           — chat OR responses, dispatched by `responsesOnly` metadata
//   - getResponsesModel(modelId)  — always responses (for vision, search tools)
//   - getRawProvider()            — escape hatch for image/video/tools consumers
//
// Phase 3b. Pre-3b history: the Agent loop owned createProvider() directly and
// the session was a metadata-only stub.
```

- [ ] **Step 6: Drop xaiProvider parameter from resolveModelRuntimeViaKernel**

Edit `src/core/extensions/model-runtime.ts`:

a. Drop the `XaiProvider` import on line 14.

b. Change the function signature on line 108–112 from:

```ts
export async function resolveModelRuntimeViaKernel(
  xaiProvider: XaiProvider,
  modelId: string,
  conversationId: string,
): Promise<KernelModelRuntime> {
```

to:

```ts
export async function resolveModelRuntimeViaKernel(
  modelId: string,
  conversationId: string,
): Promise<KernelModelRuntime> {
```

c. Replace the xAI fast-path (lines 121–128). The new path resolves the xAI provider via the session, then calls `resolveXaiRuntime`:

```ts
  if (matches.length === 0) {
    // Unknown to kernel — route through the xAI session anyway. The Agent's
    // pre-3b behavior was to treat any unknown id as xAI-by-default; preserve
    // that for now (alias support in /models add will land in 3c).
    const xaiProvider = await getRawXaiProvider(conversationId, modelId);
    return resolveXaiRuntime(xaiProvider, modelId);
  }

  const xaiMatch = matches.find((m) => m.providerId === "xai");
  if (xaiMatch) {
    const xaiProvider = await getRawXaiProvider(conversationId, xaiMatch.id);
    return resolveXaiRuntime(xaiProvider, xaiMatch.id);
  }
```

d. Add the helper at module level (above the exported function):

```ts
async function getRawXaiProvider(conversationId: string, modelId: string): Promise<XaiProvider> {
  const provider = getModelProviderById("xai.default");
  if (!provider) {
    throw new Error("xAI provider extension is not loaded. Cannot construct an xAI runtime.");
  }
  const session = await getOrConnectSession(provider, conversationId, modelId);
  const raw = session.getRawProvider?.();
  if (!raw) {
    throw new Error("xAI session did not expose getRawProvider() — version mismatch with builtin xai-provider extension.");
  }
  return raw as XaiProvider;
}
```

e. Re-add the `XaiProvider` type-only import (used by `getRawXaiProvider` and `resolveXaiRuntime`):

```ts
import {
  type ResolvedModelRuntime,
  resolveModelRuntime as resolveXaiRuntime,
  type XaiProvider,
} from "../../grok/client";
```

- [ ] **Step 7: Update agent.ts call sites — pass-through compile fix only**

Edit `src/agent/agent.ts`:

- Line 1363: `await resolveModelRuntimeViaKernel(provider, childModelId, this.getSessionId() ?? "ephemeral")` → `await resolveModelRuntimeViaKernel(childModelId, this.getSessionId() ?? "ephemeral")`
- Line 2281: same pattern.

These are mechanical pass-through fixes. The Agent still constructs `this.provider` in `setApiKey` — that gets removed in Task 5.

- [ ] **Step 8: Run tests to verify all green**

```bash
bun run vitest run src/core/extensions/model-runtime.test.ts
```

Expected: all 8 tests pass (6 updated + 2 new + 1 not yet listed which is the pre-existing 8th test for cached session reuse on line 118 — also needs the `xai` arg dropped).

```bash
bun run typecheck
```

Expected: clean. The 3 callers in agent.ts (line 1363, 2281, and any other we missed) still compile because the parameter was dropped — TypeScript will surface any extras as "Expected 2 arguments, but got 3" errors. Fix as found.

```bash
bun run vitest run
```

Expected: 421 tests still passing (or 423 if new tests are counted). Pre-existing 3 failures unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/core/extensions/api.ts src/core/extensions/builtin/xai-provider.ts src/core/extensions/model-runtime.ts src/core/extensions/model-runtime.test.ts src/agent/agent.ts
git commit -m "$(cat <<'EOF'
Phase 3b #1: xAI session owns provider construction

The xAI provider extension's connect() now constructs XaiProvider and exposes:
- getModel(modelId)         — chat or responses, dispatched by responsesOnly metadata
- getResponsesModel(modelId) — always responses (for vision sub-agent, search tools)
- getRawProvider()           — escape hatch for image/video/tools consumers

resolveModelRuntimeViaKernel drops its xaiProvider parameter; the resolver pulls
the raw provider through the session for the xAI fast-path. Behavior stays
bit-identical for batch / responses / reasoning paths because resolveXaiRuntime
is unchanged.

Agent still constructs this.provider in setApiKey for now — removal in Task 5.
EOF
)"
```

---

## Task 2: Migrate side-question / compaction / title to take a LanguageModel

**Goal:** `runSideQuestion`, `summarizeConversation`, `generateCompactionSummary`, and `generateTitle` no longer take `provider: XaiProvider`. They take a pre-resolved `LanguageModel` plus the `modelInfo` and `providerOptions` they need from the kernel runtime. Callers in `agent.ts` resolve the runtime first and pass the relevant fields.

**Files:**
- Modify: `src/utils/side-question.ts`
- Modify: `src/agent/compaction.ts`
- Modify: `src/grok/client.ts`
- Modify: `src/agent/agent.ts:783, 798–823, 1659, 2335` and other call sites
- Test: `src/utils/side-question.test.ts` (if exists), `src/agent/compaction.test.ts` (if exists), `src/grok/client.test.ts`

- [ ] **Step 1: Survey existing test files**

```bash
ls src/utils/side-question*.ts src/agent/compaction*.ts src/grok/client*.ts
```

Expected output lists `.ts` and `.test.ts` files. If a test file does not exist for one of the three modules, NOTE this — the migration in this task does not require creating a brand-new test suite for it (Task 2 is a behavior-preserving signature change), but DO add one assertion to the nearest existing test file proving the new signature accepts a `LanguageModel`.

- [ ] **Step 2: Write the failing test for runSideQuestion**

If `src/utils/side-question.test.ts` exists, add to it:

```ts
import { describe, it, expect } from "vitest";
import { runSideQuestion } from "./side-question";

describe("runSideQuestion (Phase 3b signature)", () => {
  it("accepts a LanguageModel and the model's max-output-tokens hint", async () => {
    // We don't actually call the model — assert the function compiles with
    // the new signature shape and rejects mismatched calls at compile time.
    expect(typeof runSideQuestion).toBe("function");
    // Intentionally calling with the new signature; if compile fails the
    // typecheck step fails — which is the assertion we care about.
  });
});
```

If the file does not exist, create it with the above content. The real assertion is the typecheck step in Step 6.

- [ ] **Step 3: Run test to verify it fails (or update typecheck baseline)**

```bash
bun run vitest run src/utils/side-question.test.ts
```

Expected: PASS (it's a smoke test). The actual failure surfaces at typecheck once Task 2's call-site changes land. Continue.

- [ ] **Step 4: Update runSideQuestion signature**

Replace `src/utils/side-question.ts` entirely:

```ts
import { generateText, type LanguageModel } from "ai";
import type { ResolvedModelRuntime } from "../grok/client.js";

export interface SideQuestionResult {
  response: string;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
}

const SIDE_QUESTION_SYSTEM = `You are a helpful coding assistant answering a quick side question. The user is in the middle of a coding session and needs a fast, concise answer. Keep your response short and focused — this is a side question, not the main task.

If conversation context is provided below, use it to give a more relevant answer.`;

export async function runSideQuestion(
  question: string,
  runtime: Pick<ResolvedModelRuntime, "model" | "modelInfo" | "providerOptions">,
  conversationContext: string,
  signal?: AbortSignal,
): Promise<SideQuestionResult> {
  const system = conversationContext
    ? `${SIDE_QUESTION_SYSTEM}\n\n<conversation_context>\n${conversationContext}\n</conversation_context>`
    : SIDE_QUESTION_SYSTEM;

  const { text, usage } = await generateText({
    model: runtime.model as LanguageModel,
    abortSignal: signal,
    ...(runtime.modelInfo?.supportsMaxOutputTokens === false ? {} : { maxOutputTokens: 2048 }),
    ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
    system,
    prompt: question,
  });

  return {
    response: text || "No response generated.",
    usage,
  };
}
```

Note: `runtime.model` is typed `GrokRuntimeModel` upstream, which is structurally compatible with `LanguageModel` for `generateText`'s purposes. The cast is required because `LanguageModel` is the public ai-sdk surface and `GrokRuntimeModel` is the xAI-specialized union.

- [ ] **Step 5: Update generateTitle signature**

In `src/grok/client.ts`, replace `generateTitle` (lines 61–90) with:

```ts
export async function generateTitle(
  runtime: Pick<ResolvedModelRuntime, "model" | "modelId" | "modelInfo" | "providerOptions">,
  userMessage: string,
): Promise<GeneratedTitle> {
  try {
    const { text, usage } = await generateText({
      model: runtime.model,
      temperature: 0.5,
      ...(runtime.modelInfo?.supportsMaxOutputTokens === false ? {} : { maxOutputTokens: 60 }),
      ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
      system: [
        "You are a title generator. Output ONLY a short title. Nothing else.",
        "Rules:",
        "- Single line, ≤50 characters",
        "- Use the same language as the user message",
        "- Focus on the main topic or intent",
        "- Keep technical terms, filenames, numbers exact",
        "- Remove filler words (the, this, my, a, an)",
        "- Never use tools or explain anything",
        "- If the message is a greeting, output something like 'Quick chat'",
      ].join("\n"),
      prompt: userMessage,
    });
    return {
      title: text?.trim().replace(/^["']|["']$/g, "") || "New session",
      modelId: runtime.modelId,
      usage,
    };
  } catch {
    return { title: "New session", modelId: runtime.modelId };
  }
}
```

The `DEFAULT_TITLE_MODEL` constant is no longer used inside `generateTitle` — the caller (Agent) is responsible for resolving the title model. Move the constant to `src/agent/agent.ts` (top of file, with other model constants) and delete it from `client.ts`.

- [ ] **Step 6: Update compaction.ts signatures**

In `src/agent/compaction.ts`:

a. Drop `import { resolveModelRuntime, type XaiProvider } from "../grok/client";` (line 2). Replace with `import type { ResolvedModelRuntime } from "../grok/client";`.

b. Change `summarizeConversation` (lines 393–432) signature from `provider: XaiProvider, modelId: string` to `runtime: Pick<ResolvedModelRuntime, "model" | "modelInfo" | "providerOptions">`. Drop the `resolveModelRuntime(provider, modelId)` call on line 417. Use `runtime.model`, `runtime.modelInfo`, `runtime.providerOptions` directly (the function body already references those fields after `resolveModelRuntime` returns).

c. Change `generateCompactionSummary` (lines 434+) signature similarly: drop `provider, modelId`, take `runtime`. The internal `summarizeConversation` calls inside the split-turn branch (around line 444) inherit the new signature.

- [ ] **Step 7: Update agent.ts call sites**

Edit `src/agent/agent.ts`:

a. **`generateTitle` (line 782–795)**: resolve runtime first.

```ts
async generateTitle(userMessage: string): Promise<string> {
  if (!this.apiKey) return "New session";
  const titleRuntime = await resolveModelRuntimeViaKernel(
    DEFAULT_TITLE_MODEL,
    this.getSessionId() ?? "ephemeral",
  );
  const generated = await genTitle(titleRuntime, userMessage);
  this.recordUsage(generated.usage, "title", generated.modelId);
  if (this.sessionStore && this.session && !this.session.title && generated.title) {
    this.sessionStore.setTitle(this.session.id, generated.title);
    this.session = this.sessionStore.getRequiredSession(this.session.id);
  }
  return generated.title;
}
```

Add `const DEFAULT_TITLE_MODEL = "grok-4-1-fast-non-reasoning";` near the top of agent.ts, in the model-constants region (search for `DEFAULT_MODEL` or similar to find the existing block).

b. **`askSideQuestion` (line 797–823)**: resolve runtime first.

```ts
async askSideQuestion(question: string, signal?: AbortSignal): Promise<SideQuestionResult> {
  if (!this.apiKey) return { response: "No API key configured." };
  const runtime = await resolveModelRuntimeViaKernel(
    this.modelId,
    this.getSessionId() ?? "ephemeral",
  );
  // ... (existing context-building loop unchanged) ...
  const result = await runSideQuestion(question, runtime, conversationContext, signal);
  // ... (recordUsage unchanged) ...
}
```

c. **`compactForContext` (line 1632)**: drop the `provider: XaiProvider` parameter. Take a `runtime: KernelModelRuntime` instead. The two callers (line 1996 in batch turn, line 2334 in main turn) already have `runtime` in scope — just pass it.

The `generateCompactionSummary` call on line 1659 becomes:

```ts
const summary = await generateCompactionSummary(runtime, preparation, undefined, signal);
```

d. Drop the `import { ..., resolveModelRuntime, type XaiProvider }` parts from line 30 — keep only what's still used (`createProvider` removal lands in Task 5; for now keep `createProvider`, drop `resolveModelRuntime` and `XaiProvider`).

- [ ] **Step 8: Run tests + typecheck**

```bash
bun run typecheck
```

Expected: clean. Any remaining `provider: XaiProvider` references in agent.ts surface as unused-import or call-site mismatch errors. Fix until clean.

```bash
bun run vitest run
```

Expected: 421+ passing, no new failures. Pre-existing 3 failures unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/utils/side-question.ts src/agent/compaction.ts src/grok/client.ts src/agent/agent.ts src/utils/side-question.test.ts src/agent/compaction.test.ts src/grok/client.test.ts
git commit -m "$(cat <<'EOF'
Phase 3b #2: side-question / compaction / title take LanguageModel

runSideQuestion, summarizeConversation, generateCompactionSummary, and
generateTitle no longer take provider: XaiProvider. They take a pre-resolved
runtime (model + modelInfo + providerOptions). Callers in agent.ts resolve
the runtime via resolveModelRuntimeViaKernel first.

Drops resolveModelRuntime + XaiProvider imports from compaction.ts and
side-question.ts. Agent still constructs this.provider in setApiKey for
now (removal lands in Task 5).
EOF
)"
```

---

## Task 3: Vision sub-agent uses session.getResponsesModel

**Goal:** The vision sub-agent (`agent.ts:1361–1363`) currently bypasses the kernel resolver for vision models because it needs the xAI responses endpoint. After Task 1 the session exposes `getResponsesModel` — the vision branch routes through the kernel like everything else and calls `runtime.session.getResponsesModel(childModelId)` to override the model.

**Files:**
- Modify: `src/agent/agent.ts:1359–1363`
- Modify: `src/grok/tools.ts:34, 39, 40` — `provider.responses(...)` and `provider.tools.webSearch/xSearch` will move out in Task 4. For now, keep them; this task only touches the vision branch.

- [ ] **Step 1: Read the current vision branch**

Re-read `src/agent/agent.ts` lines 1358–1364 to confirm the current behavior. The branch is gated on `isVision` and overrides `runtime.model` with `provider.responses(childModelId)`.

- [ ] **Step 2: Write the failing test for vision routing**

Add to `src/core/extensions/model-runtime.test.ts` (or an Agent-level test if one exists for sub-agent dispatch):

```ts
it("xAI session getResponsesModel can override the chat model for vision", async () => {
  await bootstrapExtensions(await loadBuiltinExtensions());
  const runtime = await resolveModelRuntimeViaKernel("grok-4-1-fast-non-reasoning", "session-vision");
  const responsesOverride = runtime.session?.getResponsesModel?.("grok-4-1-fast-non-reasoning");
  expect(responsesOverride).toBeDefined();
  // The override is structurally distinct from runtime.model (which uses
  // provider() chat path for non-responsesOnly models).
  expect(responsesOverride).not.toBe(runtime.model);
});
```

- [ ] **Step 3: Run test to verify it passes**

```bash
bun run vitest run src/core/extensions/model-runtime.test.ts
```

Expected: PASS — Task 1 already implemented `getResponsesModel`. This test ratchets coverage.

- [ ] **Step 4: Refactor the vision branch in agent.ts**

Edit `src/agent/agent.ts` line 1361–1363:

```ts
// before
const childRuntime = isVision
  ? { ...resolveModelRuntime(provider, childModelId), model: provider.responses(childModelId) }
  : await resolveModelRuntimeViaKernel(provider, childModelId, this.getSessionId() ?? "ephemeral");

// after
const baseChildRuntime = await resolveModelRuntimeViaKernel(
  childModelId,
  this.getSessionId() ?? "ephemeral",
);
const childRuntime = isVision
  ? {
      ...baseChildRuntime,
      // Vision must use the responses endpoint regardless of the registered model's
      // chat-or-responses metadata. getResponsesModel is xAI-only; if the registered
      // provider for this child model isn't xAI we surface an explicit error rather
      // than silently using the chat model.
      model:
        baseChildRuntime.session?.getResponsesModel?.(childModelId) ??
        (() => {
          throw new Error(
            `Vision sub-agent requires xAI responses endpoint, but the registered provider for "${childModelId}" does not expose getResponsesModel(). Configure an xAI model for vision sub-agents.`,
          );
        })(),
    }
  : baseChildRuntime;
```

If `provider` (the local variable on line 1269 from `requireProvider()`) is no longer needed in the surrounding code, do NOT remove it yet — Task 5 handles that cleanup. This task is scoped to the vision branch only.

- [ ] **Step 5: Drop resolveModelRuntime import from agent.ts**

Edit line 30 of `src/agent/agent.ts`:

```ts
// before
import { createProvider, generateTitle as genTitle, resolveModelRuntime, type XaiProvider } from "../grok/client";
// after
import { createProvider, generateTitle as genTitle, type XaiProvider } from "../grok/client";
```

Keep `XaiProvider` and `createProvider` for now — `requireProvider()` and `setApiKey` still reference them. They go in Task 5.

- [ ] **Step 6: Run tests + typecheck**

```bash
bun run typecheck && bun run vitest run
```

Expected: clean typecheck, 421+ passing.

- [ ] **Step 7: Commit**

```bash
git add src/agent/agent.ts src/core/extensions/model-runtime.test.ts
git commit -m "Phase 3b #3: vision sub-agent routes through kernel + getResponsesModel"
```

---

## Task 4: Migrate the four xAI tools into builtin.tools-xai

**Goal:** The four tools `search_web`, `search_x`, `generate_image`, `generate_video` live in a new `src/core/extensions/builtin/xai-tools.ts` extension. They construct `XaiProvider` lazily inside each `execute()` via `createProvider(getApiKey())` — no shared singleton, automatic apiKey-rotation safety. The tools are gated `modes: ["agent"]`. The old defs in `src/grok/tools.ts` are deleted.

**Files:**
- Create: `src/core/extensions/builtin/xai-tools.ts`
- Create: `src/core/extensions/builtin/__tests__/xai-tools.test.ts`
- Modify: `src/core/extensions/builtin/index.ts`
- Modify: `src/core/extensions/builtin/groups.ts`
- Modify: `src/grok/tools.ts` — drop the four tool defs and the `provider`-driven helpers
- Modify: `src/grok/tools.test.ts` — drop tests for the migrated tools

- [ ] **Step 1: Write the failing tests for xai-tools.ts**

Create `src/core/extensions/builtin/__tests__/xai-tools.test.ts`. Pattern after the existing `payments-tools.test.ts` (which lives in the same directory). Minimum coverage:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { __resetExtensionsForTests, bootstrapExtensions, getHostServices } from "../../index";
import { loadBuiltinExtensions } from "../index";

let tempDir: string;
let originalConfigDir: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-xai-tools-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(async () => {
  __resetExtensionsForTests();
});

afterEach(() => {
  __resetExtensionsForTests();
});

describe("builtin.tools-xai", () => {
  it("registers the four xAI tools in agent mode", async () => {
    await bootstrapExtensions(await loadBuiltinExtensions());
    const tools = getHostServices().tools.list();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_web");
    expect(names).toContain("search_x");
    expect(names).toContain("generate_image");
    expect(names).toContain("generate_video");
    for (const name of ["search_web", "search_x", "generate_image", "generate_video"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.modes).toEqual(["agent"]);
    }
  });

  it("returns a credential-error result when no API key is configured", async () => {
    delete process.env.CODESURF_API_KEY;
    delete process.env.GROK_API_KEY;
    await bootstrapExtensions(await loadBuiltinExtensions());
    const toolSet = getHostServices().tools.toolSet();
    const searchWeb = toolSet["search_web"];
    expect(searchWeb).toBeDefined();
    // ai-sdk Tool's execute is the runtime call surface
    const result = await searchWeb!.execute!({ query: "anything" }, { abortSignal: new AbortController().signal, toolCallId: "t1", messages: [] });
    expect(result).toMatchObject({ success: false });
    expect(String(result.output)).toMatch(/api key/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun run vitest run src/core/extensions/builtin/__tests__/xai-tools.test.ts
```

Expected: FAIL — `search_web` not registered (extension doesn't exist yet).

- [ ] **Step 3: Create xai-tools.ts**

Write `src/core/extensions/builtin/xai-tools.ts`:

```ts
// Builtin xAI-coupled tools extension.
//
// Owns the four tools that depend on xAI provider primitives that don't fit
// the LanguageModel mold: search_web / search_x (responses-API + provider tools)
// and generate_image / generate_video (separate image/video model surfaces).
//
// XaiProvider is constructed lazily inside each tool's execute() via
// createProvider(getApiKey()). This is intentional: it avoids a shared
// singleton that would go stale on apiKey rotation. createProvider is a
// pure factory call (no IO), so the per-execute cost is negligible.

import { generateText } from "ai";
import { z } from "zod";
import {
  type GenerateImageToolInput,
  type GenerateVideoToolInput,
  generateImageTool,
  generateVideoTool,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
} from "../../../grok/media";
import { createProvider, type XaiProvider } from "../../../grok/client";
import { getApiKey } from "../../../utils/settings";
import {
  EXTENSIONS_V1_API_VERSION,
  type ExtensionHostApi,
  type ExtensionModule,
} from "../api";

const EXTENSION_ID = "builtin.tools-xai";
const RESPONSES_SEARCH_MODEL = "grok-4-1-fast-non-reasoning";

function getProviderOrError(): { ok: true; provider: XaiProvider } | { ok: false; reason: string } {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      reason: "Missing Grok API key (CODESURF_API_KEY). Paste a key via /models or set the env var.",
    };
  }
  return { ok: true, provider: createProvider(apiKey) };
}

async function runResponsesSearch(
  query: string,
  toolName: "web_search" | "x_search",
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; output: string }> {
  const got = getProviderOrError();
  if (!got.ok) return { success: false, output: got.reason };
  const provider = got.provider;
  try {
    const { text } = await generateText({
      model: provider.responses(RESPONSES_SEARCH_MODEL),
      maxOutputTokens: 4096,
      prompt: query,
      abortSignal,
      tools: {
        ...(toolName === "web_search" ? { web_search: provider.tools.webSearch() } : {}),
        ...(toolName === "x_search" ? { x_search: provider.tools.xSearch() } : {}),
      },
    });
    return { success: true, output: text || "No search results found." };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const label = toolName === "web_search" ? "Web search" : "X search";
    return { success: false, output: `${label} failed: ${msg}` };
  }
}

export const xaiToolsExtension: ExtensionModule = {
  manifest: {
    schemaVersion: 1,
    id: EXTENSION_ID,
    name: "xAI Tools",
    version: "1.0.0",
    hostApiVersion: EXTENSIONS_V1_API_VERSION,
    kind: "builtin",
    description:
      "xAI-coupled tools (web/X search, image, video). Constructs XaiProvider lazily per execute() — no shared singleton.",
    protected: true,
    enabledByDefault: true,
    capabilities: ["tools"],
    permissions: { network: "request" },
  },

  activate(api: ExtensionHostApi) {
    api.registerTool({
      name: "search_web",
      label: "Web search",
      description:
        "Search the web for current information, documentation, APIs, tutorials, news, or any real-time data. Returns summarized results with sources.",
      modes: ["agent"],
      tool: {
        description:
          "Search the web for current information, documentation, APIs, tutorials, news, or any real-time data. Returns summarized results with sources.",
        inputSchema: z.object({ query: z.string().describe("The search query") }),
        execute: async ({ query }, { abortSignal }) => runResponsesSearch(query, "web_search", abortSignal),
      },
    });

    api.registerTool({
      name: "search_x",
      label: "X search",
      description:
        "Search X (Twitter) for real-time posts, discussions, opinions, and trends. Returns relevant posts with authors and engagement data.",
      modes: ["agent"],
      tool: {
        description:
          "Search X (Twitter) for real-time posts, discussions, opinions, and trends. Returns relevant posts with authors and engagement data.",
        inputSchema: z.object({ query: z.string().describe("The search query") }),
        execute: async ({ query }, { abortSignal }) => runResponsesSearch(query, "x_search", abortSignal),
      },
    });

    api.registerTool({
      name: "generate_image",
      label: "Generate image",
      description:
        "Generate a new image or edit an existing image using Grok Imagine. Saves the generated image files locally and returns their paths.",
      modes: ["agent"],
      tool: {
        description:
          "Generate a new image or edit an existing image using Grok Imagine. Use when the user asks to create, redesign, restyle, or modify an image. Optionally pass a local file path or public URL in source to edit an existing image. Saves the generated image files locally and returns their paths.",
        inputSchema: z.object({
          prompt: z.string().describe("Prompt describing the image to generate or the edit to apply"),
          source: z.string().optional().describe("Optional local image path or public image URL to use as the source for editing"),
          aspect_ratio: z.enum(IMAGE_ASPECT_RATIOS).optional().describe("Optional output aspect ratio. Use when the user requests a specific format."),
          resolution: z.enum(IMAGE_RESOLUTIONS).optional().describe("Optional output resolution: 1k or 2k"),
          n: z.number().int().min(1).max(10).optional().describe("Number of images to generate (default: 1)"),
          output_path: z.string().optional().describe("Optional file path for the generated image. For multiple images, numbered suffixes are added."),
        }),
        execute: async (input: GenerateImageToolInput, { abortSignal }) => {
          const got = getProviderOrError();
          if (!got.ok) return { success: false, output: got.reason };
          // cwd via the kernel sink so cd-aware writes land in the right dir.
          const cwd = api.services.bash?.cwd?.() ?? process.cwd();
          return generateImageTool(got.provider, input, cwd, abortSignal);
        },
      },
    });

    api.registerTool({
      name: "generate_video",
      label: "Generate video",
      description:
        "Generate a new short video or animate an existing image using Grok Imagine Video. Saves the generated video files locally and returns their paths.",
      modes: ["agent"],
      tool: {
        description:
          "Generate a new short video or animate an existing image using Grok Imagine Video. Use when the user asks for a clip, animation, cinematic shot, or motion from a still image. Optionally pass a local image path or public image URL in source for image-to-video generation. Saves the generated video files locally and returns their paths.",
        inputSchema: z.object({
          prompt: z.string().describe("Prompt describing the video or motion to generate"),
          source: z.string().optional().describe("Optional local image path or public image URL to use as the starting frame"),
          duration: z.number().int().min(1).max(15).optional().describe("Video duration in seconds (1-15)"),
          aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).optional().describe("Optional output aspect ratio for text-to-video or to override image-to-video framing"),
          resolution: z.enum(VIDEO_RESOLUTIONS).optional().describe("Optional output resolution: 480p or 720p"),
          output_path: z.string().optional().describe("Optional file path for the generated video. For multiple videos, numbered suffixes are added."),
          poll_interval_ms: z.number().int().min(100).optional().describe("Optional polling interval in milliseconds while waiting for video generation"),
          poll_timeout_ms: z.number().int().min(1000).optional().describe("Optional timeout in milliseconds while waiting for video generation"),
        }),
        execute: async (input: GenerateVideoToolInput, { abortSignal }) => {
          const got = getProviderOrError();
          if (!got.ok) return { success: false, output: got.reason };
          const cwd = api.services.bash?.cwd?.() ?? process.cwd();
          return generateVideoTool(got.provider, input, cwd, abortSignal);
        },
      },
    });
  },
};
```

**Verify the `api.registerTool` signature** before writing — open `src/core/extensions/api.ts` and confirm whether `RegisteredTool` takes `tool: { description, inputSchema, execute }` or a flatter shape. Match the existing builtin pattern in `subagents-tools.ts` or `payments-tools.ts`. If those use `tool({...})` from `ai`, change `tool:` accordingly.

- [ ] **Step 4: Verify the api.registerTool shape**

```bash
grep -A 5 "registerTool" src/core/extensions/builtin/payments-tools.ts | head -30
```

Read the output. Adjust the four `api.registerTool({...})` blocks in xai-tools.ts to match.

- [ ] **Step 5: Add to loadBuiltinExtensions and groups**

Edit `src/core/extensions/builtin/index.ts`:

```ts
import { xaiToolsExtension } from "./xai-tools";
// ... existing imports ...

export async function loadBuiltinExtensions(): Promise<ExtensionModule[]> {
  return [
    // ... existing extensions ...
    xaiToolsExtension,
  ];
}

export { xaiToolsExtension } from "./xai-tools";
```

Edit `src/core/extensions/builtin/groups.ts` — add a new entry or extend the existing tool-grouping with the four names. Pattern after how the schedule / payments extensions register their groups. Specific edit depends on the file's current structure — read it first:

```bash
cat src/core/extensions/builtin/groups.ts
```

Add to the appropriate group. If no obvious slot exists, create:

```ts
{
  id: "xai-tools",
  label: "xAI tools",
  toolNames: ["search_web", "search_x", "generate_image", "generate_video"],
}
```

- [ ] **Step 6: Drop the four tool defs from grok/tools.ts**

Edit `src/grok/tools.ts`:

a. Drop the `provider` parameter from `createTools`:

```ts
// before
export function createTools(provider: XaiProvider, mode: AgentMode = "agent") {
// after
export function createTools(mode: AgentMode = "agent") {
```

b. Drop the `runResponsesSearch` helper (lines 27–53).

c. Drop the four tool defs (lines 74–156): `search_web`, `search_x`, `generate_image`, `generate_video`.

d. Drop the imports on lines 1–15 that are no longer used: `generateText`, `getHostServices` (unless used elsewhere — check), `XaiProvider`, the entire `media` import block.

e. The `cwd = () => getHostServices().bash.cwd()` helper on line 25 is now dead. Drop it.

f. The `base` object collapses to `{}`:

```ts
export function createTools(mode: AgentMode = "agent"): ToolSet {
  const tools: ToolSet = {};
  if (mode !== "plan") return tools;

  tools.generate_plan = tool({
    // ... existing generate_plan def, unchanged ...
  });

  return tools;
}
```

g. Update agent.ts call sites of `createTools(provider, ...)`:
   - Line 1330: `createTools(provider, childMode)` → `createTools(childMode)`
   - Line 2018: `createTools(provider, this.mode)` → `createTools(this.mode)`
   - Line 2344: same.

- [ ] **Step 7: Update grok/tools.test.ts**

Edit `src/grok/tools.test.ts`. Drop any test that exercises `search_web`, `search_x`, `generate_image`, or `generate_video`. Update remaining tests to call `createTools(mode)` instead of `createTools(provider, mode)`.

The new xai-tools.test.ts created in Step 1 covers the migrated tools.

- [ ] **Step 8: Run all tests + typecheck**

```bash
bun run typecheck && bun run vitest run
```

Expected: clean typecheck. Test count: 421 - (whatever count of removed tools.test.ts cases) + new xai-tools.test.ts cases. Net should be ≥421. Pre-existing 3 failures unchanged.

If the kernel throws a duplicate-tool-name error during bootstrap, double-check that the `search_web` etc. defs are fully removed from `tools.ts`. The same name registered twice (once in createTools, once in xai-tools.ts) is a hard failure.

- [ ] **Step 9: Commit**

```bash
git add src/core/extensions/builtin/xai-tools.ts src/core/extensions/builtin/__tests__/xai-tools.test.ts src/core/extensions/builtin/index.ts src/core/extensions/builtin/groups.ts src/grok/tools.ts src/grok/tools.test.ts src/agent/agent.ts
git commit -m "$(cat <<'EOF'
Phase 3b #4: migrate search_web / search_x / generate_image / generate_video

The four xAI-coupled tools move into a new builtin.tools-xai extension. They
construct XaiProvider lazily inside each execute() via createProvider(getApiKey())
— no shared singleton, automatic apiKey-rotation safety. Gated to modes: ["agent"].

createTools(mode) now returns only { generate_plan } (mode === "plan") or {}.
The provider parameter is dropped. Three call sites in agent.ts updated to
match the new arity.
EOF
)"
```

---

## Task 5: Drop this.provider, requireProvider, batch-turn provider param, and final cleanup

**Goal:** With Tasks 1–4 landed, the Agent has no live consumer of `this.provider`. Remove `this.provider`, `setApiKey → createProvider`, `requireProvider()`, and the `provider` parameter on `processMessageBatchTurn`. Drop the `XaiProvider` and `createProvider` imports from agent.ts. The Agent stores only `apiKey`/`baseURL` going forward.

**Files:**
- Modify: `src/agent/agent.ts:30, 549, 729–733, 783, 798, 1269, 1633, 1977–1983, 2624–2630`
- Modify: `src/agent/agent.test.ts` (if any test constructs the Agent and asserts `this.provider`)

- [ ] **Step 1: Find all remaining this.provider / requireProvider / XaiProvider references**

```bash
bun run grep "this\.provider\|requireProvider\|XaiProvider" src/agent/agent.ts
```

Expected: a small list (after Tasks 1–4, all live consumers are gone except `this.provider` ownership itself).

- [ ] **Step 2: Drop the field, ctor branch, and helper**

Edit `src/agent/agent.ts`:

a. Line 549: drop `private provider: XaiProvider | null = null;`.

b. Line 732: in `setApiKey`, drop `this.provider = createProvider(apiKey, baseURL);`. The method body simplifies to:

```ts
setApiKey(apiKey: string, baseURL = this.baseURL ?? undefined): void {
  this.apiKey = apiKey;
  this.baseURL = baseURL || null;
}
```

c. Lines 2624–2630: delete the entire `requireProvider()` private method.

d. Lines 783 (`generateTitle`), 798 (`askSideQuestion`): replace `this.provider` checks with `this.apiKey` checks (Task 2 already moved the title/side-question code to use the kernel resolver — these checks are the early-return guards).

   ```ts
   // before
   if (!this.provider) return "New session";
   // after
   if (!this.apiKey) return "New session";
   ```

   Same shape for `askSideQuestion`.

e. Line 1269: `const provider = this.requireProvider();` — delete this line. The function body no longer needs `provider`. Search for remaining `provider` references in `runTaskRequest` (line 1264 onward); Task 3 already removed the `resolveModelRuntime(provider, ...)` call. The `createTools(provider, childMode)` was changed to `createTools(childMode)` in Task 4. Confirm no other references; remove the local `provider` declaration.

f. Line 2268: `const provider = this.requireProvider();` — same removal pattern. The downstream `processMessageBatchTurn` receives `provider` as a parameter (line 1977) — drop that.

g. Lines 1632–1639 (`compactForContext`): drop `provider: XaiProvider` parameter. The new signature takes `runtime: Pick<ResolvedModelRuntime, "model" | "modelInfo" | "providerOptions">` (consistent with Task 2's signatures). Already partly covered by Task 2's signature change for the inner `generateCompactionSummary` call; this step finalizes the cleanup at the outer wrapper.

h. Lines 1974–1983 (`processMessageBatchTurn` args): drop `provider: XaiProvider`. The body no longer needs it (Task 2 made compaction take `runtime`; Task 4 made `createTools` provider-less). Update the `runtime: ReturnType<typeof resolveModelRuntime>` field on line 1979 to `runtime: ResolvedModelRuntime` and add the type-only import at the top of agent.ts: `import type { ResolvedModelRuntime } from "../grok/client";`.

- [ ] **Step 3: Drop createProvider and XaiProvider imports**

Edit `src/agent/agent.ts` line 30:

```ts
// before
import { createProvider, generateTitle as genTitle, type XaiProvider } from "../grok/client";
// after
import { generateTitle as genTitle } from "../grok/client";
```

`createProvider` and `XaiProvider` are no longer used anywhere in agent.ts.

- [ ] **Step 4: Run tests + typecheck + build**

```bash
bun run typecheck
```

Expected: clean. Any remaining `XaiProvider` or `this.provider` leakage surfaces as compile errors. Fix until clean.

```bash
bun run vitest run
```

Expected: 421+ passing. Pre-existing 3 failures unchanged.

```bash
bun run build
```

Expected: clean.

```bash
bun run lint
```

Expected: pre-existing 3 warnings unchanged. Any new warnings introduced by this task get fixed before commit.

- [ ] **Step 5: Smoke checklist (manual — owner runs)**

Acceptance gate before commit. Run `node dist/index.js` and verify:

1. **Cold-start chat works** — start the agent, send any prompt, get a streamed response. Validates Task 1 (xAI session construction) + Task 2 (compaction signature) + the main turn.
2. **Title generation works** — start a fresh session, send a message, observe the session title get generated. Validates Task 2's `generateTitle` migration.
3. **Side-question works** — send a side question (whatever the UI surface is for this; check `app.tsx` for the trigger). Validates `runSideQuestion`.
4. **Vision sub-agent works** — dispatch a vision delegation (e.g. "describe this screenshot" with an attachment). Validates Task 3.
5. **search_web works** — ask for current information; the model should invoke `search_web` and return results. Validates Task 4.
6. **search_x works** — same shape with X-specific query. Validates Task 4.
7. **generate_image works** — ask to generate an image; verify it lands on disk. Validates Task 4 + lazy provider construction.
8. **generate_video works (optional, slow)** — same for video. Validates Task 4.
9. **API key rotation works** — paste a new key via /models. Subsequent searches/images use the new key (validates lazy construction in xai-tools.ts).
10. **Compaction works** — fill the context to ~85% and confirm auto-compaction kicks in without errors.
11. **Anthropic still works** — switch to a Claude model via /models; chat. Validates non-xAI providers untouched by this migration.

Stop and report any failure. The fix is a Task 5 follow-up commit, not a revert.

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent.ts src/agent/agent.test.ts
git commit -m "$(cat <<'EOF'
Phase 3b #5: drop this.provider and finalize provider migration

Removes:
- this.provider field (XaiProvider | null)
- setApiKey -> createProvider construction path
- requireProvider() helper
- provider parameter on processMessageBatchTurn / compactForContext
- createProvider and XaiProvider imports from agent.ts

The Agent now stores only apiKey + baseURL. All provider construction lives
in the xai-provider extension's connect() (kernel-cached per conversation)
and the xai-tools extension's per-execute lazy createProvider() calls.

createTools() is now empty in agent mode and returns only { generate_plan }
in plan mode. Phase 2 step #4 of the original plan is unblocked: the four
xAI tools migrated to builtin.tools-xai in #4 of this plan.
EOF
)"
```

---

## Final verification gate (after all 5 tasks)

- [ ] **Step 1: Full test suite green**

```bash
bun run typecheck && bun run lint && bun run vitest run && bun run build
```

Expected: typecheck clean; lint shows only the 3 pre-existing warnings (`hooks/executor.ts`, `lsp/manager.ts`, `app.tsx`); 421+ tests passing with the 3 pre-existing failures unchanged; build clean.

- [ ] **Step 2: Tally remaining createTools content**

```bash
bun run grep "createTools\b" src/grok/tools.ts -n
```

Expected: `createTools(mode)` returns `{}` in agent mode, `{ generate_plan }` in plan mode. The owner decides whether to inline `generate_plan` into agent.ts or split into its own extension as a follow-up — that's NOT in scope for Phase 3b.

- [ ] **Step 3: Tally remaining XaiProvider exposure**

```bash
bun run grep "XaiProvider\b" src --include="*.ts"
```

Expected: only inside `src/grok/client.ts` (the type definition + `resolveModelRuntime`/`createProvider` exports), `src/grok/media.ts` (image/video helpers — internal), `src/core/extensions/builtin/xai-provider.ts` (extension internals), `src/core/extensions/builtin/xai-tools.ts` (extension internals), `src/core/extensions/model-runtime.ts` (kernel resolver). Zero references in `src/agent/agent.ts`. Zero references in `src/utils/side-question.ts`. Zero references in `src/agent/compaction.ts`.

- [ ] **Step 4: Reconcile branch with origin**

```bash
git status && git log --oneline -10 origin/main..HEAD
```

The branch should now be ~5 commits ahead of where it started, all Phase 3b #1–#5. Decide with owner: push to remote, or rebase onto origin/main first.

- [ ] **Step 5: Document follow-ups**

Append to the commit message of #5 (or create a follow-up note):

- **`generate_plan` orphan**: lives alone in `createTools()` (mode=plan). Candidates: (a) own extension at `builtin.tools-plan`, (b) inline into agent.ts, (c) leave as-is. Pick during Phase 4 or whenever plan-mode UI gets reworked.
- **34-vs-1 divergence with origin/main** still pending reconciliation; not addressed here.
- **Tool description Shuru-mode hint** still frozen at activation in `bash-tools.ts:77`. Not blocked on Phase 3b; flagged in the Phase 2 #9 commit for later.

---

## Behavior Changes (intentional, not bugs)

These are new failure modes introduced by Phase 3b. Each is correct — the executor and reviewer should NOT "fix" them.

1. **Vision sub-agent on a non-xAI default model now throws explicitly.** Pre-3b: the Agent always held `this.provider = createProvider(apiKey)` (xAI), so `provider.responses(childModelId)` worked even if the user's default model was Anthropic. Post-Task-3: the vision branch reads `runtime.session?.getResponsesModel?.(childModelId)`, which returns `undefined` when the registered provider for `childModelId` isn't xAI. The plan throws a clear error in that case ("Vision sub-agent requires xAI responses endpoint…"). Vision IS xAI-specific; surfacing the constraint loudly is correct. Documented in Task 3's code block.

2. **No xAI fallback when xAI extension is disabled.** Pre-3b: `resolveModelRuntimeViaKernel` accepted any `xaiProvider` parameter (typically the Agent's `this.provider`) and used it as a fallback for unknown model IDs. Post-Task-1: `getRawXaiProvider` resolves via `getModelProviderById("xai.default")` and throws "xAI provider extension is not loaded" when the extension is disabled. The xAI extension is `protected: true` and `enabledByDefault: true` so this only surfaces when a developer explicitly disables it during testing. Acceptable.

3. **`generateTitle` returns "New session" instead of attempting a model call when `apiKey` is empty.** Pre-3b: same behavior, gated on `this.provider`. Post-Task-2/Task-5: gated on `this.apiKey`. No user-visible change.

4. **`createTools(mode)` returns `{}` in agent mode** (was `{ search_web, search_x, generate_image, generate_video }`). The four tools are still available — they're now contributed by the kernel via `builtin.tools-xai`, merged into the Agent's ToolSet via the existing `getEnabledToolSet()` path. Verify in smoke checklist Steps 5–8.

5. **xai-tools.ts constructs a fresh `XaiProvider` per `execute()`.** Lazy-per-call avoids stale cached providers after `/models` apiKey rotation. The cost is one `createXai({apiKey})` call per tool invocation — pure factory, no IO. Smoke step 9 validates this.

---

## Self-Review

**Spec coverage:** Each Phase 3b objective has a task. (1) provider construction moves to extension → Task 1. (2) callers stop using XaiProvider directly → Tasks 2, 3, 5. (3) blocked tools migrate → Task 4. (4) `xaiProvider` parameter dropped from kernel resolver → Task 1. (5) `this.provider` / `requireProvider` removed → Task 5.

**Placeholder scan:** No `TBD`, no `add appropriate error handling`, no `similar to Task N` shortcuts. Code blocks present in every code-modifying step. Test code blocks present where new tests are introduced.

**Type consistency:** `KernelModelRuntime` and `ResolvedModelRuntime` from existing files are re-used (not redefined). The new `Pick<ResolvedModelRuntime, ...>` shape is used consistently in `runSideQuestion`, `summarizeConversation`, `generateCompactionSummary`, `generateTitle` signatures (Task 2). `getResponsesModel` and `getRawProvider` are the exact names introduced in Task 1 and used unchanged in Tasks 3 and 4.

**Known risks called out inline:**
- Task 1 — fallback for unknown modelIds preserves legacy "treat as xAI" behavior. Marked for revisit in Phase 3c.
- Task 4 — duplicate-tool-name error if the old defs aren't fully removed before the new ones land. Step 6+8 explicitly check.
- Task 5 — the smoke checklist gates the commit. Cold-start chat, title, vision, all four tools, key rotation, compaction, Anthropic.
