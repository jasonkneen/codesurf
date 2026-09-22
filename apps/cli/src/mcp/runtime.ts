import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSet } from "ai";
import type { McpServerConfig } from "../utils/settings";
import { commandExists } from "./command-exists";
import { validateMcpServerConfig } from "./validate";

// Roots support — INTENTIONALLY UNIMPLEMENTED.
//
// MCP defines a "roots" capability whereby the client advertises filesystem
// roots (workspace folders) and serves `roots/list` requests from the
// server. `@ai-sdk/mcp`'s `MCPClientConfig.capabilities` field accepts a
// roots advertisement, but the SDK's own doc-comment notes: "It is up to
// the client application to handle the requests properly. This parameter
// just helps surface the request from the server." There is no
// `setRequestHandler` / `setNotificationHandler` / underlying-client
// accessor on the wrapped `MCPClient`, so we cannot respond to `roots/list`
// without dropping down to raw `@modelcontextprotocol/sdk` Client and
// re-implementing tool conversion. Implications:
//
//   - Servers that depend on roots discovery will not see any roots from us.
//   - Revisit when `@ai-sdk/mcp` exposes a request-handler API, or when a
//     real consumer justifies the architectural rework.

function mcpToolPrefix(server: McpServerConfig): string {
  return `mcp_${server.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * Servers whose ids collide — literally, or once `mcpToolPrefix` has
 * sanitised them (`a.b` and `a_b` both become `mcp_a_b`) — would silently
 * overwrite each other's tool registrations and client handles. Returns a
 * reason for every member of a colliding group so all of them can be rejected
 * before any is started; servers not in a collision are absent from the map.
 */
export function findMcpServerIdCollisions(servers: McpServerConfig[]): Map<McpServerConfig, string> {
  const byPrefix = new Map<string, McpServerConfig[]>();
  for (const server of servers) {
    const prefix = mcpToolPrefix(server);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), server]);
  }

  const reasons = new Map<McpServerConfig, string>();
  for (const [prefix, group] of byPrefix) {
    if (group.length < 2) continue;
    for (const server of group) {
      const others = group.filter((other) => other !== server);
      const sameId = others.find((other) => other.id === server.id);
      reasons.set(
        server,
        sameId
          ? `duplicate server id "${server.id}" (also used by "${sameId.label}"); fix the ids before enabling both`
          : `server id "${server.id}" collides with "${others[0]?.label}" (id "${others[0]?.id}"): both map to tool prefix "${prefix}"`,
      );
    }
  }
  return reasons;
}

/** Bytes of server stderr retained for diagnostics; older output is dropped. */
const MCP_STDERR_TAIL_CHARS = 2_000;

export interface StdioTransportHandle {
  transport: StdioClientTransport;
  /** Most recent stderr output from the server process, bounded. */
  stderrTail: () => string;
}

/**
 * Build a stdio transport whose stderr is always drained.
 *
 * The SDK pipes the child's stderr into a PassThrough that nobody reads
 * unless the caller does. A verbose server then fills the pipe buffer and
 * blocks on its next stderr write — before it has answered `initialize` or
 * a tool call — so connection and discovery stall, and because servers are
 * set up sequentially one noisy server delays every later one. Attaching the
 * drain here (the PassThrough exists from construction) keeps the pipe
 * flowing and keeps a bounded tail for error messages.
 */
export function createStdioTransport(
  server: Pick<McpServerConfig, "command" | "args" | "env" | "cwd">,
): StdioTransportHandle {
  const transport = new StdioClientTransport({
    command: server.command ?? "",
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    stderr: "pipe",
  });
  let tail = "";
  const stream = transport.stderr;
  if (stream) {
    stream.on("data", (chunk: Buffer | string) => {
      tail = `${tail}${chunk.toString()}`.slice(-MCP_STDERR_TAIL_CHARS);
    });
    stream.on("error", () => {
      /* diagnostics only; never let a stderr stream error surface as a crash */
    });
  }
  return { transport, stderrTail: () => tail };
}

function toRemoteTransport(server: McpServerConfig) {
  if (server.transport === "stdio") {
    throw new Error("stdio servers are connected through createStdioTransport()");
  }
  return {
    type: server.transport,
    url: server.url ?? "",
    headers: server.headers,
  } as const;
}

/**
 * Minimal, spec-aligned summary of an MCP resource. Mirrors the fields we care
 * about from the protocol's `resources/list` response so callers don't need to
 * depend on @ai-sdk/mcp internals.
 */
export interface McpResourceSummary {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * Minimal, spec-aligned summary of an MCP prompt. Mirrors the fields we care
 * about from the protocol's `prompts/list` response.
 */
export interface McpPromptSummary {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/**
 * Minimal, spec-aligned representation of a single content chunk inside an
 * MCP resource read result. Either `text` or `blob` will be set depending on
 * whether the server returned text or binary contents.
 */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourceReadResult {
  contents: McpResourceContent[];
}

/**
 * Minimal, spec-aligned representation of one rendered prompt message. We
 * flatten multi-block content into a single string for the v1 slash-command
 * UX; richer payloads (images, embeds) can be added later when there's a
 * concrete consumer.
 */
export interface McpPromptMessage {
  role: "user" | "assistant";
  text: string;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

export interface McpToolBundle {
  tools: ToolSet;
  /** Server ids in the order they were connected. */
  serverIds: string[];
  /** How many tools each connected server contributed, keyed by `server.id`. */
  toolCountsByServerId: Map<string, number>;
  /**
   * Lazy: list resources advertised by a connected server. Returns `[]` if the
   * server is unknown or doesn't support `resources/list`. Each call performs
   * a fresh RPC — callers should cache the result if they need it across
   * multiple reads.
   */
  listResources(serverId: string): Promise<McpResourceSummary[]>;
  /**
   * Lazy: list prompts advertised by a connected server. Same caveats as
   * `listResources`.
   */
  listPrompts(serverId: string): Promise<McpPromptSummary[]>;
  /**
   * Read a single resource from a connected server. Returns `null` if the
   * server is unknown, the URI is not advertised, or the call throws.
   */
  readResource(serverId: string, uri: string): Promise<McpResourceReadResult | null>;
  /**
   * Render a prompt with optional arguments. Returns `null` if the server is
   * unknown, the prompt is not advertised, or the call throws.
   */
  getPrompt(serverId: string, name: string, args?: Record<string, unknown>): Promise<McpPromptResult | null>;
  errors: string[];
  close(): Promise<void>;
}

type RawResource = { uri?: unknown; name?: unknown; description?: unknown; mimeType?: unknown };
type RawPrompt = {
  name?: unknown;
  description?: unknown;
  arguments?: Array<{ name?: unknown; description?: unknown; required?: unknown }>;
};
type RawResourceContent = {
  uri?: unknown;
  mimeType?: unknown;
  text?: unknown;
  blob?: unknown;
};
type RawPromptContentBlock = { type?: unknown; text?: unknown };
type RawPromptMessage = { role?: unknown; content?: unknown };

export function toResourceSummary(resource: RawResource): McpResourceSummary | null {
  const uri = typeof resource.uri === "string" ? resource.uri : null;
  const name = typeof resource.name === "string" ? resource.name : null;
  if (!uri || !name) return null;
  return {
    uri,
    name,
    description: typeof resource.description === "string" ? resource.description : undefined,
    mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
  };
}

export function toResourceContent(content: RawResourceContent): McpResourceContent | null {
  const uri = typeof content.uri === "string" ? content.uri : null;
  if (!uri) return null;
  const text = typeof content.text === "string" ? content.text : undefined;
  const blob = typeof content.blob === "string" ? content.blob : undefined;
  if (text === undefined && blob === undefined) return null;
  return {
    uri,
    mimeType: typeof content.mimeType === "string" ? content.mimeType : undefined,
    text,
    blob,
  };
}

/**
 * Flatten an MCP prompt message's content (which may be a single content
 * block or an array of them) into a single text string. Non-text content
 * blocks (images, audio, embedded resources) are dropped — the v1 slash
 * command UX only renders text. Returns `null` if no text is present.
 */
export function toPromptMessage(message: RawPromptMessage): McpPromptMessage | null {
  const role = message.role === "user" || message.role === "assistant" ? message.role : null;
  if (!role) return null;
  const blocks: RawPromptContentBlock[] = Array.isArray(message.content)
    ? (message.content as RawPromptContentBlock[])
    : message.content && typeof message.content === "object"
      ? [message.content as RawPromptContentBlock]
      : [];
  const text = blocks
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
  if (text.length === 0) return null;
  return { role, text };
}

export function toPromptSummary(prompt: RawPrompt): McpPromptSummary | null {
  const name = typeof prompt.name === "string" ? prompt.name : null;
  if (!name) return null;
  const args = Array.isArray(prompt.arguments)
    ? prompt.arguments
        .map((arg) => {
          const argName = typeof arg.name === "string" ? arg.name : null;
          if (!argName) return null;
          return {
            name: argName,
            description: typeof arg.description === "string" ? arg.description : undefined,
            required: typeof arg.required === "boolean" ? arg.required : undefined,
          };
        })
        .filter((arg): arg is NonNullable<typeof arg> => arg !== null)
    : undefined;
  return {
    name,
    description: typeof prompt.description === "string" ? prompt.description : undefined,
    arguments: args,
  };
}

function hasConfiguredPath(server: McpServerConfig): boolean {
  return Object.keys(server.env ?? {}).some((key) => key.toUpperCase() === "PATH");
}

export async function buildMcpToolSet(servers: McpServerConfig[]): Promise<McpToolBundle> {
  const tools: ToolSet = {};
  const errors: string[] = [];
  const clients: MCPClient[] = [];
  // Per-server client handle so listResources / listPrompts can run on demand.
  const clientsByServerId = new Map<string, MCPClient>();
  const serverIds: string[] = [];
  const toolCountsByServerId = new Map<string, number>();

  const enabledServers = servers.filter((server) => server.enabled);
  const collisions = findMcpServerIdCollisions(enabledServers);

  for (const server of enabledServers) {
    const validation = validateMcpServerConfig(server);
    if (!validation.ok) {
      errors.push(`${server.label}: ${validation.error}`);
      continue;
    }

    const collision = collisions.get(server);
    if (collision) {
      errors.push(`${server.label}: ${collision}`);
      continue;
    }

    // Pre-flight: stdio servers fail with an opaque ENOENT if the command does
    // not resolve. Check it the way the transport will spawn it — against the
    // server's own cwd and PATH — so the user gets a clear message.
    if (
      server.transport === "stdio" &&
      server.command &&
      !commandExists(server.command, { cwd: server.cwd, env: server.env })
    ) {
      const searched = `${server.cwd ? `cwd ${server.cwd} and ` : ""}${hasConfiguredPath(server) ? "the server's configured PATH" : "PATH"}`;
      errors.push(`${server.label}: command not found (searched ${searched}): ${server.command}`);
      continue;
    }

    const stdio = server.transport === "stdio" ? createStdioTransport(server) : null;
    try {
      const client = await createMCPClient({
        transport: stdio ? stdio.transport : toRemoteTransport(server),
        name: `codesurf-${server.id}`,
        version: "1.0.0",
      });
      clients.push(client);
      clientsByServerId.set(server.id, client);
      serverIds.push(server.id);

      const mcpTools = await client.tools();
      const prefix = mcpToolPrefix(server);
      let toolCount = 0;

      for (const [name, tool] of Object.entries(mcpTools)) {
        const prefixedName = `${prefix}__${name}`;
        if (Object.hasOwn(tools, prefixedName)) {
          errors.push(
            `${server.label}: tool "${name}" skipped; "${prefixedName}" is already registered by another server`,
          );
          continue;
        }
        tools[prefixedName] = {
          ...tool,
          description: `[MCP ${server.label}] ${tool.description ?? name}`,
        };
        toolCount += 1;
      }
      toolCountsByServerId.set(server.id, toolCount);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stderrTail = stdio?.stderrTail().trim();
      errors.push(
        stderrTail ? `${server.label}: ${message}\n  stderr: ${stderrTail.slice(-400)}` : `${server.label}: ${message}`,
      );
    }
  }

  async function listResources(serverId: string): Promise<McpResourceSummary[]> {
    const client = clientsByServerId.get(serverId);
    if (!client) return [];
    try {
      const result = await client.listResources();
      const list = Array.isArray(result?.resources) ? (result.resources as RawResource[]) : [];
      return list.map(toResourceSummary).filter((r): r is McpResourceSummary => r !== null);
    } catch {
      return [];
    }
  }

  async function listPrompts(serverId: string): Promise<McpPromptSummary[]> {
    const client = clientsByServerId.get(serverId);
    if (!client) return [];
    try {
      const result = await client.experimental_listPrompts();
      const list = Array.isArray(result?.prompts) ? (result.prompts as RawPrompt[]) : [];
      return list.map(toPromptSummary).filter((p): p is McpPromptSummary => p !== null);
    } catch {
      return [];
    }
  }

  async function readResource(serverId: string, uri: string): Promise<McpResourceReadResult | null> {
    const client = clientsByServerId.get(serverId);
    if (!client) return null;
    try {
      const result = await client.readResource({ uri });
      const list = Array.isArray(result?.contents) ? (result.contents as RawResourceContent[]) : [];
      const contents = list.map(toResourceContent).filter((c): c is McpResourceContent => c !== null);
      return { contents };
    } catch {
      return null;
    }
  }

  async function getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<McpPromptResult | null> {
    const client = clientsByServerId.get(serverId);
    if (!client) return null;
    try {
      const result = await client.experimental_getPrompt({ name, arguments: args });
      const description = typeof result?.description === "string" ? result.description : undefined;
      const rawMessages = Array.isArray(result?.messages) ? (result.messages as RawPromptMessage[]) : [];
      const messages = rawMessages.map(toPromptMessage).filter((m): m is McpPromptMessage => m !== null);
      return { description, messages };
    } catch {
      return null;
    }
  }

  return {
    tools,
    serverIds,
    toolCountsByServerId,
    listResources,
    listPrompts,
    readResource,
    getPrompt,
    errors,
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
  };
}
