// Shared session-resume preface helper.
//
// Used by provider adapters whose upstream subprocess starts a fresh process
// per ProviderSession (Claude Agent SDK, Lazar), so the kernel's restored
// message history needs to be folded into a single user-message preface
// rather than pushed as N separate turns the SDK would respond to one-by-one.
//
// The shape we accept is intentionally permissive — providers pass
// `readonly unknown[]` across the api boundary so we can't import the ai-sdk
// ModelMessage type here without coupling the extension API to ai-sdk.

const TOOL_RESULT_PREVIEW_LIMIT = 2048;

export function previewText(value: unknown, limit = TOOL_RESULT_PREVIEW_LIMIT): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated, ${text.length - limit} more chars]`;
}

interface MaybeMessage {
  role?: string;
  content?: unknown;
}

interface MaybePart {
  type?: string;
  text?: string;
  toolName?: string;
  args?: unknown;
  input?: unknown;
  result?: unknown;
  output?: unknown;
}

export function formatHistoryAsPreface(messages: readonly unknown[]): string {
  if (messages.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    "[Restored conversation context — the following is history from a prior session that was reloaded via /sessions. The user's current message follows after the </restored_context> tag.]",
  );
  lines.push("<restored_context>");
  for (const raw of messages) {
    const msg = raw as MaybeMessage;
    const role = msg.role ?? "unknown";
    const content = msg.content;

    if (typeof content === "string") {
      lines.push(`[${role}]`);
      lines.push(content);
      lines.push("");
      continue;
    }

    if (!Array.isArray(content)) continue;

    lines.push(`[${role}]`);
    for (const part of content as MaybePart[]) {
      const type = part?.type;
      if (type === "text" && typeof part.text === "string") {
        lines.push(part.text);
      } else if (type === "tool-call") {
        const args = part.args ?? part.input;
        lines.push(`[tool call: ${part.toolName ?? "unknown"}] ${previewText(args, 512)}`);
      } else if (type === "tool-result") {
        const result = part.result ?? part.output;
        lines.push(`[tool result: ${part.toolName ?? "unknown"}] ${previewText(result)}`);
      } else if (type === "image") {
        lines.push("[image attachment]");
      } else if (typeof type === "string") {
        lines.push(`[${type}]`);
      }
    }
    lines.push("");
  }
  lines.push("</restored_context>");
  return lines.join("\n");
}
