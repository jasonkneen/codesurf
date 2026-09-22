// Workflow script runner — executes a `.js` workflow's body in a sandboxed
// async harness with four injected globals: `args`, `phase`, `agent`, `log`.
//
// A workflow script (see ~/.claude/workflows/*.js) looks like:
//
//   export const meta = { name, description, phases: [...] }
//   const task = typeof args === "string" ? args : args.task
//   phase("Plan")
//   const plan = await agent("You are the PLANNER...", { model: "claude-fable-5" })
//   ...
//   return { solved, summary, ... }
//
// The body uses top-level `await` + top-level `return` + the free variables
// above, so it is NOT a valid ES module and cannot be `import()`ed. Instead we
// strip the `export const meta = {...}` declaration (and any stray `export`
// keywords), wrap the remainder in an AsyncFunction, and invoke it with the
// four primitives bound.
//
// This module is dependency-free (no codesurf imports) so callers inject the
// real model-call primitive and it stays trivially unit-testable. The host
// extension (js-workflows.ts) wires `runAgent` to a real sub-agent turn.
//
// Trust: the harness is NOT a sandbox. The body runs in this process with
// full host access (globals, dynamic import). Scripts come from ~/.claude
// (user-owned) or, only for a trusted workspace, the project's .claude dirs;
// discoverWorkflowScripts (utils/workflows.ts) enforces that gate.

/** Options a script's `agent(prompt, opts)` call may pass. */
export interface WorkflowAgentOptions {
  /** Model id to run this phase on (e.g. "claude-opus-4-8"). */
  model?: string;
  /** Short label for the sub-agent / activity line. */
  label?: string;
  /** Phase title this call belongs to (display only). */
  phase?: string;
  /** JSON schema: when present the result is parsed from the model's JSON. */
  schema?: unknown;
}

/**
 * The model-call primitive the host injects. Receives the (already
 * schema-augmented) prompt and returns the model's raw text output.
 */
export type WorkflowRunAgent = (prompt: string, opts: WorkflowAgentOptions) => Promise<string>;

export interface RunWorkflowScriptParams {
  /** Full script source (including the `export const meta` block). */
  source: string;
  /** Parsed argument value passed to the script as `args`. */
  args: unknown;
  /** Host model-call primitive. */
  runAgent: WorkflowRunAgent;
  /** Called on each `phase(title)`. */
  onPhase?: (title: string) => void;
  /** Called on each `log(message)`. */
  onLog?: (message: string) => void;
}

/** Remove the `export const meta = {...}` declaration and stray `export`s. */
export function stripWorkflowMeta(source: string): string {
  const m = source.match(/export\s+const\s+meta\s*=\s*\{/);
  let out = source;
  if (m && m.index !== undefined) {
    const open = source.indexOf("{", m.index);
    if (open >= 0) {
      let depth = 0;
      let i = open;
      let quote: string | null = null;
      for (; i < source.length; i++) {
        const c = source[i];
        if (quote) {
          if (c === "\\") {
            i++;
            continue;
          }
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          quote = c;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth === 0) {
        // Drop a trailing semicolon/newline left behind by the declaration.
        let end = i + 1;
        while (end < source.length && (source[end] === ";" || source[end] === "\r")) end++;
        out = source.slice(0, m.index) + source.slice(end);
      }
    }
  }
  // Defensive: neutralise any remaining statement-leading `export ` keywords
  // (a workflow shouldn't have more, but `export` inside a Function body is a
  // syntax error, so strip rather than crash).
  return out.replace(/(^|\n)(\s*)export\s+/g, "$1$2");
}

/** Pull a JSON value out of a model response (fenced ```json block or balanced object). */
export function parseJsonResult(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  // Try the whole candidate first, then a balanced {...} slice.
  const attempts: string[] = [candidate.trim()];
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(candidate.slice(first, last + 1));
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      // try next
    }
  }
  return null;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

/**
 * Execute a workflow script's body and return its `return` value (or
 * `undefined` if it returns nothing). Throws if the script body throws or has
 * a syntax error — callers render that to the transcript.
 */
export async function runWorkflowScript(params: RunWorkflowScriptParams): Promise<unknown> {
  const { source, args, runAgent, onPhase, onLog } = params;
  const body = stripWorkflowMeta(source);

  const agent = async (prompt: string, opts: WorkflowAgentOptions = {}): Promise<unknown> => {
    const schema = opts.schema;
    const fullPrompt = schema
      ? `${prompt}\n\nIMPORTANT: Respond with ONLY a single \`\`\`json fenced code block containing one object that matches this JSON schema. Output no prose before or after the block:\n${JSON.stringify(schema, null, 2)}`
      : prompt;
    const text = await runAgent(fullPrompt, {
      model: opts.model,
      label: opts.label,
      phase: opts.phase,
      schema,
    });
    return schema ? parseJsonResult(text) : text;
  };

  const phase = (title: string): void => {
    onPhase?.(String(title ?? ""));
  };
  const log = (message: string): void => {
    onLog?.(String(message ?? ""));
  };

  const fn = new AsyncFunction("args", "phase", "agent", "log", body);
  return fn(args, phase, agent, log);
}
