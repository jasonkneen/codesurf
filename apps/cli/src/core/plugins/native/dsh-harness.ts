// deepseek-harness plugins, running inside CodeSurf.
//
// Seven Cordis plugins installed from npm and used byte for byte as published.
// Nothing here edits or re-implements them; this file only supplies the host
// side of the contract they were written against.
//
// They are authored in Cordis's FUNCTIONAL form (`export const name` /
// `export const inject` / `export function apply`) where CodeSurf's own plugins
// use the object form. Both are Cordis 4.0.2, which is why they interoperate.
//
// Each one is a separate CodeSurf plugin so it lists and toggles independently
// in /plugins. Each provides the services its harness plugin injects, scoped to
// its own fiber, and mounts the foreign plugin as a CHILD — so disabling the
// CodeSurf plugin disposes the harness plugin and everything it registered.
//
// What each needs, and what that demonstrates:
//
//   shell-env         inject: []               activates with no host support
//   skill-badge       inject: ['skills']       host supplies a service
//   skill-filesystem  inject: ['skills']       two plugins share one service
//   persona           inject: ['systemPrompt'] host supplies a service AND
//                                              validated config
//
// The rest of the harness (~30 plugins) injects `agents`, `llm`, `tools`,
// `webServer` and similar. Those would mount and sit PENDING here until such
// services exist — Cordis behaving correctly, not failing.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { Service } from "@deepseek-ai/cordis";
import { tool } from "ai";
import { z } from "zod";
import { CODESURF_EXTERNAL_GROUP } from "../builtin/groups";

// ── Harness service shapes ───────────────────────────────────────────────────
// Structural: the packages do not re-export these through their published
// entrypoints, so they are declared here against what the plugins actually call.

interface HarnessSkillCandidate {
  name: string;
  description: string;
  invocation?: { modelInvocable: boolean; userInvocable: boolean };
}

interface HarnessSkillDefinition {
  name: string;
  description: string;
  content: string;
}

interface HarnessSkillProvider {
  name: string;
  list(): Promise<HarnessSkillCandidate[]>;
  get(candidate: HarnessSkillCandidate): Promise<HarnessSkillDefinition>;
}

interface PromptSection {
  name: string;
  order: number;
  text: string;
  complete?: boolean;
}

/** Cordis gives a Service the CALLING fiber's context on `this.ctx`. */
type CallerContext = { ctx: { effect(cb: () => () => void): void } };

/**
 * What the host passes to a provider factory.
 *
 * Matches `SkillProviderControl` in `@deepseek-ai/dsh-skill`: `signal` aborts
 * when that exact registration is disposed, and `invalidate` tells the host to
 * drop cached catalogues. `skill-filesystem` uses both — it starts directory
 * watchers in its constructor — while `skill-badge` ignores the argument.
 */
interface SkillProviderControl {
  readonly signal: AbortSignal;
  readonly invalidate: () => void;
}

/**
 * The `skills` registry harness skill plugins register against.
 *
 * Two details are load-bearing, both learned by getting them wrong:
 *
 *  - the factory is called ONCE at registration, not on every read. Calling it
 *    per read constructed a fresh `FileSystemSkillProvider` — and a fresh set
 *    of filesystem watchers — every time anything listed skills.
 *  - registration is scoped to the CALLING fiber, because these plugins
 *    register without an explicit `ctx.effect` and rely on the host for that.
 *    Disposal also aborts the control signal, which is how a provider knows to
 *    stop watching.
 */
export class HarnessSkillsService extends Service {
  private entries: Array<{ provider: HarnessSkillProvider; abort: AbortController }> = [];

  constructor(ctx: unknown) {
    super(ctx as never, "skills");
  }

  registerProvider(create: (control: SkillProviderControl) => HarnessSkillProvider): () => void {
    const abort = new AbortController();
    // CodeSurf keeps no skill catalogue of its own, so `invalidate` is a real
    // no-op rather than a missing capability dressed up as one.
    const provider = create({ signal: abort.signal, invalidate: () => {} });
    const entry = { provider, abort };
    this.entries.push(entry);

    const remove = () => {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
      abort.abort();
    };
    (this as unknown as CallerContext).ctx.effect(() => remove);
    return remove;
  }

  providers(): HarnessSkillProvider[] {
    return this.entries.map((entry) => entry.provider);
  }

  async list(): Promise<HarnessSkillCandidate[]> {
    const listed = await Promise.all(
      this.providers().map((provider) => provider.list().catch(() => [] as HarnessSkillCandidate[])),
    );
    return listed.flat();
  }

  async read(name: string): Promise<HarnessSkillDefinition | null> {
    for (const provider of this.providers()) {
      const candidate = (await provider.list().catch(() => [])).find((entry) => entry.name === name);
      if (candidate) return provider.get(candidate);
    }
    return null;
  }
}

/** The `systemPrompt` registry the persona preset writes its section into. */
export class HarnessSystemPromptService extends Service {
  sections: PromptSection[] = [];

  constructor(ctx: unknown) {
    super(ctx as never, "systemPrompt");
  }

  /** Stable ordering slots the harness asks for by name. */
  getSectionOrder(name: string): number {
    return name === "DEPLOYMENT_PERSONA" ? 100 : 500;
  }

  section(spec: PromptSection): () => void {
    this.sections.push(spec);
    return () => {
      this.sections = this.sections.filter((entry) => entry !== spec);
    };
  }

  suppressRuntimeContext(): void {
    // CodeSurf assembles its own prompt; recorded as a no-op rather than
    // pretending to honour it.
  }
}

// No `declare module` here on purpose: the harness packages already augment
// `Context` with `skills` and `systemPrompt` using their own service types.
// Re-declaring them with these host-side stand-ins is a type conflict, and the
// adapters below hold their instances directly anyway.

// ── Adapters ─────────────────────────────────────────────────────────────────

function harnessManifest(id: string, name: string, pkg: string, description: string): PluginManifest {
  return {
    id: `external.${id}`,
    name,
    version: "0.0.1-rc",
    description: `${description} Mounted unmodified from ${pkg}.`,
    group: CODESURF_EXTERNAL_GROUP,
    // Harness demo/debug surface: opt in from /plugins.
    enabledByDefault: false,
    protected: false,
    capabilities: ["commands"],
  };
}

interface ChildFiber {
  dispose(): Promise<void>;
  ctx: Record<string, unknown>;
  state: number;
}

/**
 * Mount a foreign Cordis plugin as a child fiber of this one, and hand back a
 * handle to it.
 *
 * The plugin is loaded LAZILY. These packages start filesystem watchers and
 * pull in schema machinery, and importing them from the catalog module made
 * simply listing the built-ins cost seconds — the catalog is already the
 * dominant startup cost, so nothing that only matters once a plugin activates
 * belongs on that path.
 *
 * The handle matters because Cordis enforces `inject`: this plugin cannot read
 * a service off its OWN context that it did not declare, and it cannot declare
 * one that its own child provides without deadlocking. Reading through the
 * child's context is the way to see what the child provided.
 */
function mountChild(
  ctx: PluginContext,
  load: () => Promise<unknown>,
  config?: unknown,
): { current: ChildFiber | null } {
  const handle: { current: ChildFiber | null } = { current: null };
  ctx.effect(async () => {
    const plugin = await load();
    const fiber = (ctx as unknown as { plugin(p: unknown, c?: unknown): ChildFiber }).plugin(plugin, config);
    handle.current = fiber;
    return () => {
      handle.current = null;
      void fiber.dispose();
    };
  });
  return handle;
}

export const dshShellEnvPlugin: CodesurfPlugin = {
  name: "codesurf-dsh-shell-env",
  manifest: harnessManifest(
    "dsh-shell-env",
    "DSH — shell-env",
    "@deepseek-ai/dsh-shell-env",
    "Registry of trusted DSH_* shell variables. Injects nothing, so it activates with no host support at all.",
  ),
  inject: ["contributions", "chat"],
  apply(ctx: PluginContext) {
    const child = mountChild(ctx, () => import("@deepseek-ai/dsh-shell-env"));

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/dsh-env",
        description: "Show the DSH_* variables the harness shell-env plugin registered.",
        handler: () => {
          const fiber = child.current;
          if (!fiber) {
            ctx.chat.appendAssistant("`shell-env` is not mounted.");
            return;
          }
          // Read through the CHILD's context: it provides `shellEnv`, and
          // Cordis will not let this plugin read a service it did not inject.
          let listed: unknown[] = [];
          try {
            const registry = fiber.ctx.shellEnv as { list?: () => unknown[] } | undefined;
            listed = registry?.list?.() ?? [];
          } catch {
            // The child provides it but this scope may not read it; the state
            // below is still the honest answer.
          }
          ctx.chat.appendAssistant(
            [
              "`@deepseek-ai/dsh-shell-env` — a harness plugin with `inject: []`, so it",
              "activates on the CodeSurf runtime with no host support at all.",
              "",
              `Fiber state: ${fiber.state === 2 ? "ACTIVE" : String(fiber.state)}`,
              `Provides \`ctx.shellEnv\`: ${fiber.ctx.shellEnv ? "yes" : "no"}`,
              listed.length > 0
                ? `\nManaged variables (${listed.length}):\n\n\`\`\`json\n${JSON.stringify(listed, null, 2)}\n\`\`\``
                : "\nNo other plugin has contributed DSH_* variables to it.",
            ].join("\n"),
          );
        },
      }),
    );
  },
};

export const dshSkillsPlugin: CodesurfPlugin = {
  name: "codesurf-dsh-skills",
  manifest: harnessManifest(
    "dsh-skills",
    "DSH — skill-badge + skill-filesystem",
    "@deepseek-ai/dsh-skill-badge and @deepseek-ai/dsh-skill-filesystem",
    "Two harness skill providers sharing one host-supplied `skills` service.",
  ),
  inject: ["contributions", "chat"],
  apply(ctx: PluginContext) {
    const skills = new HarnessSkillsService(ctx);

    mountChild(ctx, () => import("@deepseek-ai/dsh-skill-badge"));
    mountChild(ctx, () => import("@deepseek-ai/dsh-skill-filesystem"));

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/dsh-skills",
        description: "List the skills contributed by the harness skill plugins, and show one.",
        argsHint: "[skill-name]",
        handler: async ({ args }) => {
          const candidates = await skills.list();
          if (candidates.length === 0) {
            ctx.chat.appendAssistant("No harness skill providers are registered.");
            return;
          }

          const wanted = args.trim();
          if (!wanted) {
            ctx.chat.appendAssistant(
              [
                `${skills.providers().length} provider(s) registered on the host \`skills\` service:`,
                "",
                ...candidates.map((c) => `• **${c.name}** — ${c.description}`),
                "",
                "Run `/dsh-skills <name>` to print one.",
              ].join("\n"),
            );
            return;
          }

          const definition = await skills.read(wanted);
          ctx.chat.appendAssistant(
            definition
              ? `**${definition.name}**\n\n\`\`\`markdown\n${definition.content.trim()}\n\`\`\``
              : `No harness skill named \`${wanted}\`.`,
          );
        },
      }),
    );
  },
};

export const dshPersonaPlugin: CodesurfPlugin = {
  name: "codesurf-dsh-persona",
  manifest: harnessManifest(
    "dsh-persona",
    "DSH — persona",
    "@deepseek-ai/dsh-persona",
    "System-prompt persona preset. Its config is validated by Cordis BEFORE apply runs, so a bad value fails the mount rather than the turn.",
  ),
  inject: ["contributions", "chat"],
  apply(ctx: PluginContext) {
    const prompt = new HarnessSystemPromptService(ctx);

    // Config is a schemastery schema on the plugin: Cordis validates it before
    // `apply` is called. Omitting `text` rejects the mount outright.
    mountChild(ctx, () => import("@deepseek-ai/dsh-persona"), {
      text: "You are running inside CodeSurf, via a deepseek-harness persona preset.",
    });

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/dsh-persona",
        description: "Show the system-prompt section the harness persona plugin registered.",
        handler: () => {
          ctx.chat.appendAssistant(
            prompt.sections.length > 0
              ? prompt.sections.map((s) => `**${s.name}** (order ${s.order})\n\n> ${s.text}`).join("\n\n")
              : "The persona plugin registered no sections.",
          );
        },
      }),
    );
  },
};

// ── The interactive one: a harness TOOL the CodeSurf agent can call ──────────
//
// `@deepseek-ai/dsh-tool-web` registers a model-facing `web_fetch` tool against
// `ctx.tools`, and `@deepseek-ai/dsh-web-fetch-http` supplies the HTTP provider
// behind it. Bridging that into CodeSurf's tool registry means the agent can
// call a deepseek-harness tool mid-conversation — the plugin stops being a
// status readout and starts doing work.
//
// The one wrinkle is a genuine name collision: CodeSurf ALREADY owns a `tools`
// service, with a completely different shape (enable/disable, wrapExecute).
// Constructing the harness registry on the root throws
// `service "tools" has been registered`. `ctx.isolate("tools")` is Cordis's
// answer — inside that scope the root's `tools` is invisible, so the harness
// plugins bind to the registry below while CodeSurf's own stays untouched.

interface HarnessParameter {
  type?: string;
  required?: boolean;
  description?: string;
}

interface HarnessToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, HarnessParameter>;
  output?: { render?(args: unknown, value: unknown): Array<{ type: string; text: string }> };
  execute(args: unknown, execution: { signal?: AbortSignal }): Promise<unknown>;
}

/** The harness `tools` registry, isolated from CodeSurf's service of the same name. */
class HarnessToolsService extends Service {
  definitions: HarnessToolDefinition[] = [];
  private presentation: string | null = null;

  constructor(ctx: unknown) {
    super(ctx as never, "tools");
  }

  register(definition: HarnessToolDefinition): () => void {
    this.definitions.push(definition);
    const remove = () => {
      this.definitions = this.definitions.filter((entry) => entry !== definition);
    };
    (this as unknown as CallerContext).ctx.effect(() => remove);
    return remove;
  }

  /**
   * How tools are presented to the model — `agent-tool-presentation` sets this.
   *
   * Scoped to the caller like every other registration here: without it the
   * mode outlived the plugin that chose it, which a disable ought to undo.
   */
  presentAs(mode: string): () => void {
    const previous = this.presentation;
    this.presentation = mode;
    const restore = () => {
      this.presentation = previous;
    };
    (this as unknown as CallerContext).ctx.effect(() => restore);
    return restore;
  }

  presentationMode(): string | null {
    return this.presentation;
  }
}

/** The `web` service: providers register here, tools fetch through it. */
class HarnessWebService extends Service {
  private provider: {
    id: string;
    available(): boolean;
    fetch(req: unknown, signal?: AbortSignal): Promise<unknown>;
  } | null = null;

  constructor(ctx: unknown) {
    super(ctx as never, "web");
  }

  registerFetchProvider(provider: NonNullable<typeof this.provider>): () => void {
    this.provider = provider;
    const remove = () => {
      this.provider = null;
    };
    (this as unknown as CallerContext).ctx.effect(() => remove);
    return remove;
  }

  providerId(): string | null {
    return this.provider?.id ?? null;
  }

  fetch(request: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.provider) throw new Error("No web fetch provider is registered.");
    return this.provider.fetch(request, signal);
  }
}

/**
 * Harness parameter declarations → a zod schema the AI SDK can use.
 *
 * Two shapes exist and both must work. The harness SOURCE declares a flat map
 * (`{ url: { type: "string", required: true } }`), but the PUBLISHED package
 * normalises it to a JSON Schema object (`{ type: "object", properties: {...},
 * required: ["url"] }`). Reading the published form as if it were flat produced
 * a schema whose fields were literally `type`, `properties` and `required` — so
 * the tool advertised nonsense parameters and could not be called.
 */
function toInputSchema(parameters: Record<string, HarnessParameter> | undefined) {
  const source = parameters as
    | (Record<string, HarnessParameter> & {
        type?: string;
        properties?: Record<string, HarnessParameter>;
        required?: string[];
      })
    | undefined;

  const isJsonSchema = source?.type === "object" && typeof source.properties === "object";
  const fields: Record<string, HarnessParameter> = isJsonSchema
    ? (source?.properties ?? {})
    : ((source ?? {}) as Record<string, HarnessParameter>);
  const requiredList = isJsonSchema && Array.isArray(source?.required) ? new Set(source.required) : null;

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const base =
      spec.type === "number" || spec.type === "integer"
        ? z.number()
        : spec.type === "boolean"
          ? z.boolean()
          : z.string();
    const described = spec.description ? base.describe(spec.description) : base;
    const required = requiredList ? requiredList.has(key) : spec.required === true;
    shape[key] = required ? described : described.optional();
  }
  return z.object(shape);
}

export const dshWebToolPlugin: CodesurfPlugin = {
  name: "codesurf-dsh-web-tool",
  manifest: {
    ...harnessManifest(
      "dsh-web-tool",
      "DSH — web_fetch tool",
      "@deepseek-ai/dsh-tool-web and @deepseek-ai/dsh-web-fetch-http",
      "Gives the agent a real `web_fetch` tool implemented entirely by harness plugins. Ask it to read a URL and the fetch runs through deepseek-harness code.",
    ),
    capabilities: ["tools", "commands"],
  },
  inject: ["contributions", "chat"],
  apply(ctx: PluginContext) {
    // Every service name this stack provides gets isolated, not just `tools`:
    //   `tools`        collides with CodeSurf's own service
    //   `systemPrompt` collides with the persona plugin above
    //   `web`          is isolated pre-emptively, for the same reason
    // Inside this scope the root's versions are invisible, so the harness binds
    // to the registries below and CodeSurf's own stay untouched.
    const isolate = (context: PluginContext, name: string) =>
      (context as unknown as { isolate(n: string): PluginContext }).isolate(name);
    const scope = isolate(isolate(isolate(ctx, "tools"), "systemPrompt"), "web");
    const tools = new HarnessToolsService(scope);
    const web = new HarnessWebService(scope);
    new HarnessSystemPromptService(scope);

    // One ordered effect: mount both harness plugins, WAIT for them, then
    // republish what they registered. Separate effects raced — the republish
    // ran before the async mounts finished and found an empty registry, so the
    // agent silently got no tool.
    ctx.effect(async () => {
      const [httpPlugin, webToolPlugin, presentationPlugin] = await Promise.all([
        import("@deepseek-ai/dsh-web-fetch-http"),
        import("@deepseek-ai/dsh-tool-web"),
        import("@deepseek-ai/dsh-agent-tool-presentation"),
      ]);
      // Call `plugin` ON the scope. Pulling the method off the Cordis proxy and
      // re-binding it with `.call` silently mounts against the wrong context —
      // the plugins activated but registered into nothing.
      const mount = scope as unknown as { plugin(p: unknown, c?: unknown): ChildFiber };
      const httpFiber = mount.plugin(httpPlugin);
      const toolFiber = mount.plugin(webToolPlugin, { search: false, fetch: true });
      // `ptc` mode needs a TypeScript code runtime this deployment does not
      // compose, and the plugin correctly REFUSES that config at mount rather
      // than failing at the first prompt. `native` is the mode that applies.
      const presentationFiber = mount.plugin(presentationPlugin, { mode: "native" });
      await Promise.all([httpFiber, toolFiber, presentationFiber]);

      const released = tools.definitions.map((definition) =>
        ctx.contributions.registerTool({
          name: definition.name,
          description: definition.description,
          group: "dsh",
          tool: tool({
            description: definition.description,
            inputSchema: toInputSchema(definition.parameters),
            execute: async (args, options) => {
              const value = await definition.execute(args, { signal: options?.abortSignal });
              const rendered = definition.output?.render?.(args, value);
              const text = rendered?.map((part) => part.text).join("\n");
              return { success: true, output: text ?? JSON.stringify(value) };
            },
          }),
        }),
      );

      // The harness registers its own guidance ("use web_fetch to retrieve a
      // specific URL…") into `ctx.systemPrompt`. That service is isolated here,
      // so without this the text went nowhere and the model was never told the
      // tool existed — it kept reaching for whatever fetch tool it already knew.
      const prompt = (scope as unknown as { systemPrompt: HarnessSystemPromptService }).systemPrompt;
      const promptReleases = prompt.sections.map((section) =>
        ctx.contributions.registerPromptSection({
          id: section.name,
          title: "DeepSeek Harness tooling",
          body: [
            section.text,
            "",
            "This tool comes from the deepseek-harness plugins installed in CodeSurf.",
            "Prefer it when the user asks for a URL to be fetched or mentions dsh.",
          ].join("\n"),
          order: section.order,
        }),
      );

      return () => {
        for (const release of promptReleases) release();
        for (const release of released) release();
        void presentationFiber.dispose();
        void toolFiber.dispose();
        void httpFiber.dispose();
      };
    });

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/dsh-web",
        description: "Show the harness-provided web tooling wired into the agent.",
        handler: () => {
          ctx.chat.appendAssistant(
            [
              "Harness web stack, mounted in an isolated `tools` scope:",
              "",
              `• fetch provider: \`${web.providerId() ?? "none"}\` (from @deepseek-ai/dsh-web-fetch-http)`,
              `• agent tools: ${tools.definitions.map((d) => `\`${d.name}\``).join(", ") || "none"} (from @deepseek-ai/dsh-tool-web)`,
              `• tool presentation: \`${tools.presentationMode() ?? "unset"}\` (from @deepseek-ai/dsh-agent-tool-presentation)`,
              "",
              "These are registered into CodeSurf's tool registry, so just ask me to",
              "read a URL — the fetch runs through deepseek-harness code.",
            ].join("\n"),
          );
        },
      }),
    );
  },
};
