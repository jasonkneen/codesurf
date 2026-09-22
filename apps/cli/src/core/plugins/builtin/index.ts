// Builtin extension bundle.
//
// Returned by bootstrap at startup. Keep this list in one place so adding a
// new builtin is a single-line change.

import type { PluginModule } from "../api";
import { ampProviderPlugin } from "../native/amp-provider";
import { anthropicProviderPlugin } from "../native/anthropic-provider";
import { askToolsPlugin } from "../native/ask-tools";
import { autoModePlugin } from "../native/auto-mode";
import { bashToolsPlugin } from "../native/bash-tools";
import { claudeAgentProviderPlugin } from "../native/claude-agent-provider";
import { claudePluginsPlugin } from "../native/claude-plugins";
import { codesurfDesktopProviderPlugin } from "../native/codesurf-desktop-provider";
import { codexProviderPlugin } from "../native/codex-provider";
import { computerToolsPlugin } from "../native/computer-tools";
import { contextCommandPlugin } from "../native/context-command";
import { docViewerPlugin } from "../native/doc-viewer";
import { dshPersonaPlugin, dshShellEnvPlugin, dshSkillsPlugin, dshWebToolPlugin } from "../native/dsh-harness";
import { editorCommandPlugin } from "../native/editor-command";
import { fileToolsPlugin } from "../native/file-tools";
import { filesCommandPlugin } from "../native/files-command";
import { footerChromePlugin } from "../native/footer-chrome";
import { fractalProviderPlugin } from "../native/fractal-provider";
import { grepToolPlugin } from "../native/grep-tool";
import { grokCliProviderPlugin } from "../native/grok-provider";
import { hermesGatewayProviderPlugin } from "../native/hermes-gateway-provider";
import { createNativePluginModule } from "../native/host";
import { hostActionsPlugin } from "../native/host-actions";
import { jsWorkflowsPlugin } from "../native/js-workflows";
import { knowledgePlugin } from "../native/knowledge-extensions";
import { lazarProviderPlugin } from "../native/lazar-provider";
import { lightclawProviderPlugin } from "../native/lightclaw-provider";
import { localLlmProviderPlugin } from "../native/local-llm-provider";
import { loopCommandPlugin } from "../native/loop-command";
import { lspToolPlugin } from "../native/lsp-tool";
import { mcpPromptCommandsPlugin } from "../native/mcp-prompt-commands";
import { nerdIconsPlugin } from "../native/nerd-icons";
import { omnigentProviderPlugin } from "../native/omnigent-provider";
import { opencodeProviderPlugin } from "../native/opencode-provider";
import { paymentsToolsPlugin } from "../native/payments-tools";
import { petsPlugin } from "../native/pets";
import { petsExplainerPlugin } from "../native/pets-explainer";
import { planToolsPlugin } from "../native/plan-tools";
import { routingCommandPlugin } from "../native/routing-command";
import { scheduleToolsPlugin } from "../native/schedule-tools";
import { skillsListingPlugin } from "../native/skills-listing";
import { steerCommandPlugin } from "../native/steer-command";
import { subagentCommandsPlugin } from "../native/subagent-commands";
import { subagentsToolsPlugin } from "../native/subagents-tools";
import { telegramToolsPlugin } from "../native/telegram-tools";
import { userWorkflowsPlugin } from "../native/user-workflows";
import { voicePlugin } from "../native/voice";
import { workflowOrchestratorPlugin } from "../native/workflow-orchestrator";
import { workflowPromptsPlugin } from "../native/workflow-prompts";
import { xaiProviderPlugin } from "../native/xai-provider";
import { xaiToolsPlugin } from "../native/xai-tools";

export async function loadBuiltinPlugins(): Promise<PluginModule[]> {
  return [
    // Providers first — so models are in the registry before anything that
    // might consume them (e.g. a future `/models` modal subscribed to the
    // registry during bootstrap).
    createNativePluginModule(xaiProviderPlugin),
    createNativePluginModule(anthropicProviderPlugin),
    createNativePluginModule(claudeAgentProviderPlugin),
    createNativePluginModule(codexProviderPlugin),
    createNativePluginModule(codesurfDesktopProviderPlugin),
    createNativePluginModule(ampProviderPlugin),
    createNativePluginModule(grokCliProviderPlugin),
    createNativePluginModule(lazarProviderPlugin),
    createNativePluginModule(lightclawProviderPlugin),
    createNativePluginModule(hermesGatewayProviderPlugin),
    createNativePluginModule(omnigentProviderPlugin),
    createNativePluginModule(opencodeProviderPlugin),
    createNativePluginModule(fractalProviderPlugin),
    createNativePluginModule(localLlmProviderPlugin),
    // Tool groups.
    createNativePluginModule(bashToolsPlugin),
    createNativePluginModule(fileToolsPlugin),
    createNativePluginModule(grepToolPlugin),
    createNativePluginModule(xaiToolsPlugin),
    createNativePluginModule(lspToolPlugin),
    createNativePluginModule(computerToolsPlugin),
    createNativePluginModule(scheduleToolsPlugin),
    createNativePluginModule(subagentsToolsPlugin),
    createNativePluginModule(telegramToolsPlugin),
    createNativePluginModule(paymentsToolsPlugin),
    createNativePluginModule(planToolsPlugin),
    createNativePluginModule(askToolsPlugin),
    createNativePluginModule(knowledgePlugin),
    createNativePluginModule(voicePlugin),
    // Command bundles.
    createNativePluginModule(workflowPromptsPlugin),
    createNativePluginModule(workflowOrchestratorPlugin),
    createNativePluginModule(userWorkflowsPlugin),
    createNativePluginModule(jsWorkflowsPlugin),
    createNativePluginModule(skillsListingPlugin),
    createNativePluginModule(contextCommandPlugin),
    createNativePluginModule(loopCommandPlugin),
    createNativePluginModule(routingCommandPlugin),
    createNativePluginModule(editorCommandPlugin),
    createNativePluginModule(filesCommandPlugin),
    createNativePluginModule(steerCommandPlugin),
    createNativePluginModule(subagentCommandsPlugin),
    createNativePluginModule(mcpPromptCommandsPlugin),
    createNativePluginModule(petsExplainerPlugin),
    createNativePluginModule(hostActionsPlugin),
    createNativePluginModule(claudePluginsPlugin),
    // UI extensions.
    createNativePluginModule(docViewerPlugin),
    createNativePluginModule(petsPlugin),
    createNativePluginModule(footerChromePlugin),
    createNativePluginModule(nerdIconsPlugin),
    // Third-party Cordis plugins, mounted unmodified from npm.
    createNativePluginModule(dshShellEnvPlugin),
    createNativePluginModule(dshSkillsPlugin),
    createNativePluginModule(dshPersonaPlugin),
    createNativePluginModule(dshWebToolPlugin),
    // Agent loop wrappers.
    createNativePluginModule(autoModePlugin),
  ];
}
