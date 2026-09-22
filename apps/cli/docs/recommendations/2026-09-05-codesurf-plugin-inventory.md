# CodeSurf built-in migration inventory

Source snapshot: HEAD `3383e20`, 2026-09-05. Extracted from the 48 imports and literal manifests in `src/core/extensions/builtin/index.ts`; no extension modules were executed. This is declared metadata, not a runtime contribution or lifecycle parity test.

**Update 2026-09-05: all 48 are converted.** The Source column has been
repointed from `builtin/` to `native/` so the paths still resolve; every other
column is the original snapshot and is what each conversion was held to. Stable
IDs, defaults and declared capabilities are unchanged from this table — that is
the compatibility claim, and the clean-config boot counts are the check on it.

Preserve stable IDs and defaults; validate dynamic commands, aliases, models, settings and owned resources during any future change. Missing flags are recorded as absent, not inferred.

| Source | Stable ID | Enabled by default | Protected | Declared capabilities |
| --- | --- | --- | --- | --- |
| src/core/plugins/native/amp-provider.ts | "builtin.provider-amp" | false | false | ["provider-adapters", "models", "settings"] |
| src/core/plugins/native/anthropic-provider.ts | "builtin.provider-anthropic" | true | false | ["provider-adapters", "models"] |
| src/core/plugins/native/ask-tools.ts | "builtin.tools.ask" | true | absent | ["tools"] |
| src/core/plugins/native/auto-mode.ts | "builtin.auto-mode" | true | false | ["tools", "commands", "status-indicators"] |
| src/core/plugins/native/bash-tools.ts | "builtin.tools.bash" | true | true | ["tools"] |
| src/core/plugins/native/claude-agent-provider.ts | "builtin.provider-claude-agent" | true | false | ["provider-adapters", "models", "settings"] |
| src/core/plugins/native/codesurf-desktop-provider.ts | "builtin.provider-codesurf-desktop" | false | false | ["provider-adapters", "models", "settings"] |
| src/core/plugins/native/codex-provider.ts | "builtin.provider-codex" | false | false | ["provider-adapters", "models", "settings"] |
| src/core/plugins/native/computer-tools.ts | "builtin.tools.computer" | true | absent | ["tools"] |
| src/core/plugins/native/context-command.ts | "builtin.commands.context" | true | false | ["commands"] |
| src/core/plugins/native/doc-viewer.tsx | "builtin.ui.doc-viewer" | true | false | ["screens"] |
| src/core/plugins/native/editor-command.tsx | "builtin.commands.editor" | true | false | ["commands", "screens"] |
| src/core/plugins/native/file-tools.ts | "builtin.tools.file" | true | true | ["tools", "commands"] |
| src/core/plugins/native/files-command.tsx | "builtin.commands.files" | true | false | ["commands", "screens"] |
| src/core/plugins/native/footer-chrome.tsx | "builtin.footer-chrome" | true | false | ["commands", "settings", "status-indicators"] |
| src/core/plugins/native/fractal-provider.ts | "builtin.provider-fractal" | false | false | ["provider-adapters", "models", "settings", "commands"] |
| src/core/plugins/native/grep-tool.ts | "builtin.tools.grep" | true | absent | ["tools"] |
| src/core/plugins/native/grok-provider.ts | "builtin.provider-grok-cli" | false | false | ["provider-adapters", "models", "settings"] |
| src/core/plugins/native/hermes-gateway-provider.ts | "builtin.provider-hermes-gateway" | false | false | ["provider-adapters", "models", "settings", "commands"] |
| src/core/plugins/native/host-actions.ts | "builtin.commands.host-actions" | true | true | ["commands"] |
| src/core/plugins/native/js-workflows.ts | "builtin.commands.js-workflows" | true | false | ["commands"] |
| src/core/plugins/native/knowledge-extensions.ts | "builtin.knowledge" | true | false | ["commands", "tools", "settings", "mentions"] |
| src/core/plugins/native/lazar-provider.ts | "builtin.provider-lazar" | false | false | ["provider-adapters", "models", "settings"] |
| src/core/plugins/native/lightclaw-provider.ts | "builtin.provider-lightclaw" | false | false | ["provider-adapters", "models", "settings"] |
| src/core/plugins/native/local-llm-provider.ts | "builtin.provider-local-llm" | false | false | ["provider-adapters", "models", "settings"] |
| src/core/plugins/native/loop-command.ts | "builtin.commands.loop" | true | false | ["commands", "tools", "status-indicators"] |
| src/core/plugins/native/lsp-tool.ts | "builtin.tools.lsp" | true | absent | ["tools"] |
| src/core/plugins/native/mcp-prompt-commands.ts | "builtin.mcp" | true | false | ["commands", "tools"] |
| src/core/plugins/native/nerd-icons.ts | "builtin.icons.nerd-fonts" | false | absent | ["commands", "settings"] |
| src/core/plugins/native/omnigent-provider.ts | "builtin.provider-omnigent" | false | false | ["provider-adapters", "models", "settings", "commands"] |
| src/core/plugins/native/opencode-provider.ts | "builtin.provider-opencode-sdk" | false | false | ["provider-adapters", "models", "settings", "commands"] |
| src/core/plugins/native/payments-tools.ts | "builtin.tools.payments" | true | absent | ["tools", "commands"] |
| src/core/plugins/native/pets.tsx | "builtin.ui.pets" | true | false | ["commands", "screens"] |
| src/core/plugins/native/pets-explainer.ts | "builtin.commands.pets-explainer" | false | false | ["commands"] |
| src/core/plugins/native/plan-tools.ts | "builtin.tools.plan" | true | true | ["tools"] |
| src/core/plugins/native/routing-command.ts | "builtin.commands.routing" | true | false | ["commands"] |
| src/core/plugins/native/schedule-tools.ts | "builtin.tools.schedule" | true | absent | ["tools"] |
| src/core/plugins/native/skills-listing.tsx | "builtin.commands.skills" | true | false | ["commands", "screens", "settings"] |
| src/core/plugins/native/steer-command.tsx | "builtin.commands.steer" | true | false | ["commands", "screens", "settings"] |
| src/core/plugins/native/subagent-commands.ts | "builtin.commands.subagents" | true | false | ["commands"] |
| src/core/plugins/native/subagents-tools.ts | "builtin.tools.subagents" | true | absent | ["tools"] |
| src/core/plugins/native/telegram-tools.ts | "builtin.tools.telegram" | true | absent | ["tools"] |
| src/core/plugins/native/user-workflows.ts | "builtin.commands.user-workflows" | true | false | ["commands"] |
| src/core/plugins/native/voice.ts | "builtin.voice" | true | absent | ["commands", "settings", "status-indicators"] |
| src/core/plugins/native/workflow-orchestrator.ts | "builtin.commands.workflow-orchestrator" | true | false | ["commands"] |
| src/core/plugins/native/workflow-prompts.ts | "builtin.commands.workflows" | true | false | ["commands"] |
| src/core/plugins/native/xai-provider.ts | "builtin.provider-xai" | true | true | ["provider-adapters", "models"] |
| src/core/plugins/native/xai-tools.ts | "builtin.tools-xai" | true | absent | ["tools"] |

Total: 48 catalog imports and 48 unique manifest IDs.
