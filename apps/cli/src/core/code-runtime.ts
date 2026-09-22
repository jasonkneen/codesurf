// Engine host for the DSH worker code runtime.
//
// Phase 1: one lazily-initialized cordis root context hosts the published
// @deepseek-ai/dsh-code-runtime-worker-thread backend. A fresh worker executes
// each model-written program; budgets and hostile-peer discipline come from the
// package itself (containment, not a security boundary — same trust posture as
// the shell tool). Node >= 22.6 required (node:module.stripTypeScriptTypes).

import { Context } from "@deepseek-ai/cordis";
import type { CodeRunRequest, CodeRunResult, CodeRuntime } from "@deepseek-ai/dsh-code-runtime";
import { WorkerThreadCodeRuntime } from "@deepseek-ai/dsh-code-runtime-worker-thread";

/** Host-service surface for the code runtime (injected via PluginHostServices). */
export interface CodeRuntimeFacade {
  run(request: CodeRunRequest): Promise<CodeRunResult>;
}

let pending: Promise<CodeRuntime> | null = null;
let hostContext: Context | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Get the engine's code-runtime service, starting it on first use (async). */
export function getCodeRuntimeService(): Promise<CodeRuntime> {
  if (!pending) {
    pending = (async () => {
      const ctx = new Context();
      ctx.plugin(WorkerThreadCodeRuntime, {});
      hostContext = ctx;
      // Class plugins register their service asynchronously; wait for it.
      const deadline = Date.now() + 5000;
      let runtime: CodeRuntime | undefined;
      while (Date.now() < deadline) {
        runtime = (ctx as unknown as { codeRuntime?: CodeRuntime }).codeRuntime;
        if (runtime?.run) return runtime;
        await sleep(10);
      }
      throw new Error("code runtime failed to start");
    })();
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/** Stop the shared runtime (tests/teardown). Idempotent. */
export async function disposeCodeRuntimeService(): Promise<void> {
  if (pending) {
    await pending.catch(() => undefined);
    pending = null;
  }
  if (hostContext) {
    void (hostContext as unknown as { stop?: () => Promise<void> }).stop?.();
    hostContext = null;
  }
}
