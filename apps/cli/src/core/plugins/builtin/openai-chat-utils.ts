import type { ProviderTurnInput } from "../api";

export function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; text?: string; image_url?: { url: string } };
    if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
    else if (p?.type === "image_url") parts.push(`[image: ${p.image_url?.url ?? ""}]`);
    else if (typeof p?.type === "string") parts.push(`[${p.type}]`);
  }
  return parts.join("\n");
}

interface ToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export function normalizeOpenAiMessages(
  input: ProviderTurnInput,
): Array<{ role: string; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }> {
  const out: Array<{ role: string; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }> = [];

  for (const raw of input.messages ?? []) {
    const msg = raw as {
      role?: string;
      content?: unknown;
      tool_calls?: ToolCall[];
      tool_call_id?: string;
    };
    if (!msg.role) continue;

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined;
    out.push({
      role: msg.role,
      content: stringifyContent(msg.content),
      tool_calls: toolCalls,
      tool_call_id: typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined,
    });
  }

  const last = out[out.length - 1];
  if (!last || last.role !== "user" || last.content !== input.prompt) {
    out.push({ role: "user", content: input.prompt });
  }

  return out;
}

export function toolsToOpenAi(input: ProviderTurnInput): unknown[] | undefined {
  if (!input.tools || typeof input.tools !== "object") return undefined;
  const tools: unknown[] = [];
  for (const [name, t] of Object.entries(input.tools as Record<string, unknown>)) {
    const toolDef = t as {
      description?: string;
      inputSchema?: {
        jsonSchema?: Record<string, unknown>;
        _def?: { typeName?: string; value?: { properties?: Record<string, unknown>; type?: string } };
      };
      parameters?: Record<string, unknown>;
    };

    let parameters: Record<string, unknown> | undefined =
      toolDef.parameters ?? toolDef.inputSchema?.jsonSchema ?? undefined;
    if (!parameters && toolDef.inputSchema?._def) {
      const def = toolDef.inputSchema._def;
      if (def.typeName === "ZodObject" && def.value) {
        parameters = {
          type: "object",
          properties: def.value.properties ?? {},
        };
      }
    }
    if (!parameters) parameters = { type: "object", properties: {} };

    tools.push({
      type: "function",
      function: {
        name,
        description: toolDef.description ?? "",
        parameters,
      },
    });
  }
  return tools.length > 0 ? tools : undefined;
}
