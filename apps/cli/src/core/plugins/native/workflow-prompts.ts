// Native Cordis plugin: the canned workflow slash commands.
//
// Converted from the V1 `activate(api)` builtin to an ordinary Cordis module
// (`name`, `manifest`, `inject`, `apply`). It reaches the host only through
// `@codesurf/plugin-api` services — `contributions` to register and `workspace`
// to read the agent's cwd — and every registration is owned by `ctx.effect`, so
// unmounting the fiber removes all five commands.
//
// Behaviour is the V1 builtin's, unchanged: `/review`, `/verify`,
// `/commit-push`, `/commit-pr` and `/dream` each build a canned prompt and hand
// it to the agent. `/verify` is still the only one that needs runtime context —
// it reads the agent's directory, which may have drifted from `process.cwd()`.
//
// The prompt bodies stay in the pure-data module they already lived in
// (`../builtin/workflow-prompts-text`); it holds no host API and is imported,
// not duplicated. `buildVerifyPrompt` likewise stays in `src/verify`, where the
// rest of the verify flow reads it.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { buildVerifyPrompt } from "../../../verify/entrypoint";
import { COMMIT_PR_PROMPT, COMMIT_PUSH_PROMPT, DREAM_PROMPT, REVIEW_PROMPT } from "../builtin/workflow-prompts-text";

const manifest: PluginManifest = {
  id: "builtin.commands.workflows",
  name: "Workflow Prompts",
  version: "1.0.0",
  description:
    "Canned slash commands for repository-wide workflows: /review, /verify, /commit-push, /commit-pr, /dream.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands"],
};

export const workflowPromptsPlugin: CodesurfPlugin = {
  name: "codesurf-workflow-prompts",
  manifest,
  inject: ["contributions", "workspace"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerPromptCommand({
        name: "/review",
        description: "Review uncommitted repository changes and produce a report.",
        buildPrompt: () => REVIEW_PROMPT,
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerPromptCommand({
        name: "/verify",
        description: "Verify the project locally via the verify sub-agent flow.",
        // Built at invocation time: the recipe is inferred from whatever
        // directory the agent is in when the user runs the command.
        buildPrompt: () => buildVerifyPrompt(ctx.workspace.cwd()),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerPromptCommand({
        name: "/commit-push",
        description: "Commit current changes and push the branch.",
        buildPrompt: () => COMMIT_PUSH_PROMPT,
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerPromptCommand({
        name: "/commit-pr",
        description: "Commit current changes, push, and open a pull request.",
        buildPrompt: () => COMMIT_PR_PROMPT,
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerPromptCommand({
        name: "/dream",
        description: "Run an idle-time DREAMING consolidation pass.",
        // Assumes a DREAMING.md in the repository, which most do not have:
        // typed dispatch still works, but it stays out of the menu.
        hidden: true,
        buildPrompt: () => DREAM_PROMPT,
      }),
    );
  },
};
