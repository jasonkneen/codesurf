// User workflow discovery — `.claude/workflows/*.md` as prompt sources.
//
// Mirrors the discoverSkills() convention (src/utils/skills.ts) but for the
// Claude Code `workflows/` directory layout: flat markdown files, not
// SKILL.md-per-directory. Scanned roots:
//   - user:    ~/.claude/workflows
//   - project: <projectRoot>/.claude/workflows walking parent dirs up to the
//              git root (nearest project file wins on slug collision, and
//              project beats user — same precedence as skills).
//
// Each `<slug>.md` becomes a candidate slash command `/<slug>` (registered by
// src/core/plugins/builtin/user-workflows.ts via a command resolver, so
// static builtin commands always win). Optional YAML frontmatter `name` /
// `description` is honored; the body (content minus frontmatter) is the
// prompt that gets dispatched.
//
// Non-markdown files are not prompt commands and are surfaced here as
// `unsupported`. `.js`/`.mjs`/`.cjs` workflow scripts are discovered
// separately by `discoverWorkflowScripts` below and executed IN-PROCESS on
// the host (workflow-script-runner.ts) — there is no sandbox. Project scripts
// therefore only load for a trusted workspace, and a user script always
// beats a project script with the same slug.
//
// Discovery is synchronous, best-effort, and re-run on every dispatch — files
// added while the CLI is running are picked up without a restart.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findGitRoot } from "./git-root";
import { getWorkspaceTrustDecision } from "./workspace-trust";

export type WorkflowScope = "project" | "user";

export interface DiscoveredWorkflow {
  /** Slash-command slug: filename minus `.md` (e.g. "escalation-chain"). */
  slug: string;
  /** Display name — frontmatter `name` or the slug. */
  name: string;
  /** Frontmatter `description`, or a default mentioning the source file. */
  description: string;
  /** Prompt body: file content minus the frontmatter block. */
  prompt: string;
  /** Frontmatter `argument-hint` (e.g. "<pr-number>"), shown in the / menu. */
  argumentHint?: string;
  filePath: string;
  scope: WorkflowScope;
}

export interface WorkflowDiscoveryResult {
  workflows: DiscoveredWorkflow[];
  /** Non-.md files found in a workflows dir (no runtime exists to run them). */
  unsupported: string[];
}

/** Test seam: override the user root (defaults to ~/.claude/workflows). */
export interface DiscoverWorkflowsOptions {
  userRoot?: string;
  /** Script discovery only: override the workspace-trust lookup for project scripts. */
  projectTrusted?: boolean;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split optional `--- ... ---` frontmatter from the body. Flat `key: value` only. */
export function parseWorkflowFile(content: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return { body: content.trim() };

  const lines = trimmed.slice(3).split(/\r?\n/).slice(1);
  const end = lines.findIndex((l) => l.trim() === "---");
  if (end < 0) return { body: content.trim() };

  const out: { name?: string; description?: string; argumentHint?: string; body: string } = {
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
  for (const line of lines.slice(0, end)) {
    const nameM = line.match(/^name:\s*(.*)$/);
    if (nameM) out.name = stripQuotes(nameM[1]);
    const descM = line.match(/^description:\s*(.*)$/);
    if (descM) out.description = stripQuotes(descM[1]);
    const hintM = line.match(/^argument-hint:\s*(.*)$/);
    if (hintM) out.argumentHint = stripQuotes(hintM[1]);
  }
  return out;
}

/**
 * Claude Code-style argument substitution for prompt-command bodies:
 *   - `$ARGUMENTS` → the full trailing args string
 *   - `$1`..`$9`   → positional, whitespace-split tokens (missing ⇒ "")
 * Returns the expanded text plus whether any placeholder was present, so the
 * caller can decide how to handle args for files that use none.
 */
export function expandPromptArguments(body: string, rawArgs: string): { text: string; used: boolean } {
  const args = rawArgs.trim();
  const positional = args.length > 0 ? args.split(/\s+/) : [];
  let used = false;
  let text = body.replace(/\$ARGUMENTS\b/g, () => {
    used = true;
    return args;
  });
  text = text.replace(/\$([1-9])/g, (_m, d) => {
    used = true;
    return positional[Number(d) - 1] ?? "";
  });
  return { text, used };
}

function loadWorkflowsFromDir(
  dir: string,
  scope: WorkflowScope,
  result: Map<string, DiscoveredWorkflow>,
  unsupported: string[],
): void {
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const filePath = path.join(dir, e.name);
    if (!e.name.endsWith(".md")) {
      unsupported.push(filePath);
      continue;
    }
    const slug = e.name.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    try {
      const parsed = parseWorkflowFile(fs.readFileSync(filePath, "utf-8"));
      if (!parsed.body) continue;
      result.set(slug, {
        slug,
        name: parsed.name?.trim() || slug,
        description: parsed.description?.trim() || `User workflow from ${filePath}`,
        prompt: parsed.body,
        argumentHint: parsed.argumentHint?.trim() || undefined,
        filePath: path.resolve(filePath),
        scope,
      });
    } catch {
      // unreadable file — skip, never crash discovery
    }
  }
}

function listProjectRoots(projectRoot: string, subdir: string): string[] {
  const start = path.resolve(projectRoot);
  const gitRoot = findGitRoot(start);
  const roots: string[] = [];
  let current = start;

  while (true) {
    roots.push(path.join(current, ".claude", subdir));
    if (gitRoot ? current === gitRoot : path.dirname(current) === current) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots.reverse();
}

function discoverInSubdir(projectRoot: string, subdir: string, userRoot: string): WorkflowDiscoveryResult {
  const bySlug = new Map<string, DiscoveredWorkflow>();
  const unsupported: string[] = [];
  loadWorkflowsFromDir(userRoot, "user", bySlug, unsupported);
  for (const root of listProjectRoots(projectRoot, subdir)) {
    loadWorkflowsFromDir(root, "project", bySlug, unsupported);
  }
  return {
    workflows: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    unsupported,
  };
}

/**
 * Discover user workflows from ~/.claude/workflows and from <projectRoot>
 * upward through parent directories to the git root. Nearest project file
 * overrides user-level and higher-level project files with the same slug.
 */
export function discoverUserWorkflows(projectRoot: string, opts?: DiscoverWorkflowsOptions): WorkflowDiscoveryResult {
  const userRoot = opts?.userRoot ?? path.join(os.homedir(), ".claude", "workflows");
  return discoverInSubdir(projectRoot, "workflows", userRoot);
}

/**
 * Discover Claude Code-style custom slash commands from ~/.claude/commands and
 * project .claude/commands (walked to the git root). Same precedence and file
 * format as workflows — this is the canonical Claude Code `commands/` dir.
 */
export function discoverUserCommands(projectRoot: string, opts?: DiscoverWorkflowsOptions): WorkflowDiscoveryResult {
  const userRoot = opts?.userRoot ?? path.join(os.homedir(), ".claude", "commands");
  return discoverInSubdir(projectRoot, "commands", userRoot);
}

/**
 * Merged view over both `commands/` (canonical) and `workflows/` dirs — the
 * unified set of dynamic markdown slash commands. On slug collision the
 * `commands/` entry wins. Used by the user-workflows builtin to register and
 * enumerate every discovered `/<slug>`.
 */
export function discoverUserPromptCommands(projectRoot: string): WorkflowDiscoveryResult {
  const workflows = discoverUserWorkflows(projectRoot);
  const commands = discoverUserCommands(projectRoot);
  const bySlug = new Map<string, DiscoveredWorkflow>();
  for (const w of workflows.workflows) bySlug.set(w.slug, w);
  for (const c of commands.workflows) bySlug.set(c.slug, c); // commands/ wins
  return {
    workflows: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    unsupported: [...workflows.unsupported, ...commands.unsupported],
  };
}

// ── `.js` workflow scripts ────────────────────────────────────────────────────
//
// Distinct from the markdown prompt-commands above: a `.js` workflow is an
// executable orchestration script (see workflow-script-runner.ts) that drives
// a model chain via an injected `agent()` primitive. Each file exports a
// `meta` object literal describing the command; the body is run in a harness.

/** A phase descriptor from a workflow script's `meta.phases`. */
export interface WorkflowScriptPhase {
  title?: string;
  detail?: string;
  model?: string;
}

export interface WorkflowScript {
  /** Slash-command slug: filename minus its `.js`/`.mjs`/`.cjs` extension. */
  slug: string;
  /** `meta.name` or the slug. */
  name: string;
  /** `meta.description`, or a default mentioning the source file. */
  description: string;
  /** `meta.whenToUse`, shown in `/workflows` detail. */
  whenToUse?: string;
  /** `meta.phases` (for menu/detail display only — execution reads the body). */
  phases?: WorkflowScriptPhase[];
  /** Absolute path to the script file. */
  filePath: string;
  /** Full file source (executed by the runner). */
  source: string;
  scope: WorkflowScope;
}

export interface WorkflowScriptDiscoveryResult {
  scripts: WorkflowScript[];
  /** Project script files not loaded (not read, not evaluated) because the workspace is not trusted. */
  untrusted: string[];
  /** Project script files not loaded because a user script has the same slug. */
  shadowed: string[];
}

const SCRIPT_EXTS = [".js", ".mjs", ".cjs"];

/**
 * Extract the `export const meta = { ... }` object literal from a workflow
 * script and evaluate it. The script body uses top-level `await` + injected
 * free variables, so it can't be imported as a normal ES module — we pull just
 * the meta literal out by string-aware brace balancing and eval it in
 * isolation. Returns `null` when no parseable meta is present.
 */
export function extractWorkflowMeta(source: string): Record<string, unknown> | null {
  const m = source.match(/export\s+const\s+meta\s*=\s*\{/);
  if (!m || m.index === undefined) return null;
  const open = source.indexOf("{", m.index);
  if (open < 0) return null;
  // Balance braces, skipping over string/template/comment content.
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
  if (depth !== 0) return null;
  const objText = source.slice(open, i + 1);
  try {
    // Evaluates the literal, which is code: callers only pass user-owned files
    // or project files from a trusted workspace (see discoverWorkflowScripts).
    const value = new Function(`return (${objText})`)() as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asPhases(value: unknown): WorkflowScriptPhase[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases = value
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      title: typeof p.title === "string" ? p.title : undefined,
      detail: typeof p.detail === "string" ? p.detail : undefined,
      model: typeof p.model === "string" ? p.model : undefined,
    }));
  return phases.length > 0 ? phases : undefined;
}

function loadScriptsFromDir(dir: string, scope: WorkflowScope, bySlug: Map<string, WorkflowScript>): void {
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const ext = SCRIPT_EXTS.find((x) => e.name.endsWith(x));
    if (!ext) continue;
    const slug = e.name.slice(0, -ext.length);
    if (!SLUG_RE.test(slug)) continue;
    const filePath = path.join(dir, e.name);
    try {
      const source = fs.readFileSync(filePath, "utf-8");
      const meta = extractWorkflowMeta(source) ?? {};
      bySlug.set(slug, {
        slug,
        name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : slug,
        description:
          typeof meta.description === "string" && meta.description.trim()
            ? meta.description.trim()
            : `Workflow script from ${filePath}`,
        whenToUse: typeof meta.whenToUse === "string" ? meta.whenToUse.trim() : undefined,
        phases: asPhases(meta.phases),
        filePath: path.resolve(filePath),
        source,
        scope,
      });
    } catch {
      // unreadable — skip, never crash discovery
    }
  }
}

/**
 * A workspace is trusted to run its own scripts on the host when the user
 * chose to run it unsandboxed at the trust prompt, or opted in via
 * CODESURF_TRUST_WORKSPACE. No decision, or a sandbox decision, is untrusted.
 */
export function isWorkspaceTrustedForScripts(projectRoot: string): boolean {
  if (process.env.CODESURF_TRUST_WORKSPACE) return true;
  return getWorkspaceTrustDecision(projectRoot) === "off";
}

function listScriptFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith(".") && SCRIPT_EXTS.some((x) => e.name.endsWith(x)))
      .map((e) => path.resolve(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Discover `.js`/`.mjs`/`.cjs` workflow scripts from ~/.claude/workflows and
 * project .claude/workflows (walked to the git root). Also scans the
 * `commands/` subdir so a script dropped there is found too.
 *
 * Scripts run in-process on the host, and even discovery evaluates a script's
 * `meta` literal, so project scripts (repo-controlled) are neither read nor
 * evaluated unless the workspace is trusted — they are listed in `untrusted`
 * instead. A user script always wins a slug collision; the project file it
 * hides is listed in `shadowed`.
 */
export function discoverWorkflowScripts(
  projectRoot: string,
  opts?: DiscoverWorkflowsOptions,
): WorkflowScriptDiscoveryResult {
  const bySlug = new Map<string, WorkflowScript>();
  const untrusted: string[] = [];
  const shadowed: string[] = [];
  const trusted = opts?.projectTrusted ?? isWorkspaceTrustedForScripts(projectRoot);
  for (const subdir of ["workflows", "commands"]) {
    for (const root of listProjectRoots(projectRoot, subdir)) {
      if (trusted) loadScriptsFromDir(root, "project", bySlug);
      else untrusted.push(...listScriptFiles(root));
    }
  }

  const userBySlug = new Map<string, WorkflowScript>();
  const userRoot = opts?.userRoot ?? path.join(os.homedir(), ".claude", "workflows");
  loadScriptsFromDir(userRoot, "user", userBySlug);
  loadScriptsFromDir(path.join(os.homedir(), ".claude", "commands"), "user", userBySlug);
  for (const [slug, script] of userBySlug) {
    const hidden = bySlug.get(slug);
    if (hidden && hidden.scope === "project") shadowed.push(hidden.filePath);
    bySlug.set(slug, script);
  }

  return { scripts: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)), untrusted, shadowed };
}
