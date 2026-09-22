import { getModelInfo } from "../grok/models";

export function applyModelConstraints(system: string, modelId: string): string {
  const modelInfo = getModelInfo(modelId);
  if (modelInfo?.supportsClientTools !== false) {
    return system;
  }

  return [
    system,
    "",
    "MODEL CONSTRAINTS:",
    "- The selected model does not support client-side CLI tool calls in this environment.",
    "- Do not call bash, read_file, lsp, write_file, edit_file, task, delegate, delegation, or MCP tools.",
    "- Answer directly using only the conversation context already provided.",
  ].join("\n");
}
