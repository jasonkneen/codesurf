import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findGitRoot } from "./git-root";

export type SkillScope = "project" | "user";

export interface DiscoveredSkill {
  name: string;
  description: string;
  skillMdPath: string;
  rootDir: string;
  scope: SkillScope;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\n/g, "\n");
  }
  return t;
}

/** Minimal YAML frontmatter key extraction for flat `key: value` and optional `|` / `>` blocks after description. */
function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const lines = raw.split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameM = line.match(/^name:\s*(.*)$/);
    if (nameM) {
      const rest = nameM[1].trim();
      out.name = stripQuotes(rest);
      continue;
    }
    const descM = line.match(/^description:\s*(.*)$/);
    if (descM) {
      const rest = descM[1].trim();
      if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
        i++;
        const block: string[] = [];
        while (i < lines.length) {
          const L = lines[i];
          if (L.match(/^[a-zA-Z0-9_-]+:\s/) && !/^\s/.test(L)) break;
          if (/^\s/.test(L) || (block.length > 0 && L === "")) {
            block.push(L.replace(/^\s+/, ""));
            i++;
          } else if (block.length > 0) {
            break;
          } else {
            break;
          }
        }
        i--;
        out.description = block.join("\n").trim();
      } else {
        out.description = stripQuotes(rest);
      }
    }
  }
  return out;
}

function extractFrontmatter(fileContent: string): { frontmatter: string; ok: boolean } {
  const trimmed = fileContent.trimStart();
  if (!trimmed.startsWith("---")) return { frontmatter: "", ok: false };
  const afterFirst = trimmed.slice(3).split(/\r?\n/);
  const restLines = afterFirst.slice(1);
  const end = restLines.findIndex((l) => l.trim() === "---");
  if (end < 0) return { frontmatter: "", ok: false };
  return { frontmatter: restLines.slice(0, end).join("\n"), ok: true };
}

function loadSkillFromDir(rootDir: string, scope: SkillScope): DiscoveredSkill | null {
  const skillMdPath = path.join(rootDir, "SKILL.md");
  try {
    if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile()) return null;
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const { frontmatter, ok } = extractFrontmatter(content);
    if (!ok) return null;
    const meta = parseSkillFrontmatter(frontmatter);
    const name = meta.name?.trim();
    const description = meta.description?.trim();
    if (!name || !description) return null;
    return {
      name,
      description,
      skillMdPath: path.resolve(skillMdPath),
      rootDir: path.resolve(rootDir),
      scope,
    };
  } catch {
    return null;
  }
}

function listSkillDirectories(skillsRoot: string): string[] {
  try {
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) return [];
    const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    const dirs: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      dirs.push(path.join(skillsRoot, e.name));
    }
    return dirs.sort();
  } catch {
    return [];
  }
}

function listProjectSkillRoots(projectRoot: string): string[] {
  const start = path.resolve(projectRoot);
  const gitRoot = findGitRoot(start);
  const roots: string[] = [];
  let current = start;

  while (true) {
    roots.push(path.join(current, ".agents", "skills"));
    if (gitRoot ? current === gitRoot : path.dirname(current) === current) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots.reverse();
}

/**
 * Discover Agent Skills under ~/.agents/skills and from <projectRoot> upward through
 * parent directories to the git root. The nearest project-level skill overrides
 * user-level and higher-level project skills with the same `name` (frontmatter).
 */
export function discoverSkills(projectRoot: string): DiscoveredSkill[] {
  const userRoot = path.join(os.homedir(), ".agents", "skills");

  const byName = new Map<string, DiscoveredSkill>();

  for (const dir of listSkillDirectories(userRoot)) {
    const s = loadSkillFromDir(dir, "user");
    if (s) byName.set(s.name, s);
  }
  for (const skillsRoot of listProjectSkillRoots(projectRoot)) {
    for (const dir of listSkillDirectories(skillsRoot)) {
      const s = loadSkillFromDir(dir, "project");
      if (s) byName.set(s.name, s);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const SKILLS_INSTRUCTIONS = `AGENT SKILLS (optional):
The following <available_skills> list specialized workflows. Use them when they might help the user's request — not only on exact keyword matches.
If a skill's description fits the task or could improve consistency, read that skill's instructions first using read_file with the path from <location>, then follow the SKILL.md body.
Paths inside a skill (scripts/, references/, assets/) are relative to the skill directory (the folder containing SKILL.md); prefer absolute paths in tool calls.`;

/** OpenCode-style XML catalog plus activation instructions for read_file. Returns null if no skills. */
/** Per-skill learned few-shot examples (structural type to avoid importing the
 *  overlay module here — keeps this function pure/testable). */
export interface SkillPromptOverlays {
  get(name: string): { fewShot: Array<{ query: string; result: string }> } | undefined;
}

function truncateForPrompt(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── Progressive skill disclosure ──────────────────────────────────────────────
//
// Injecting every skill's full description does not scale. Measured on a real
// install: 258 skills => 134,354 chars => ~33,600 tokens in EVERY request. That
// is ~96% of the controllable system-prompt weight (all 50 builtin tool schemas
// together are ~1,300 tokens), and it is what makes a cold "hello" take 10-16s
// while the model ingests it.
//
// So the catalog is tiered by what the turn actually needs:
//   greeting / chit-chat  -> nothing at all        (~0 tokens)
//   real request          -> top-N full + a name-only index for the rest (~4k)
//
// The model can still reach any indexed skill: names are listed, and the
// instructions tell it how to read a SKILL.md by name. Nothing is hidden, it is
// just not all pre-loaded.

/** Words that mean "the user is not asking for work yet". */
const GREETING_PATTERNS =
  /^(hi|hey|hello|yo|sup|howdy|morning|afternoon|evening|good\s+(morning|afternoon|evening)|thanks|thank\s+you|ta|cheers|ok|okay|k|cool|nice|great|got\s+it|understood|yes|no|yep|nope|sure)\b/i;

/** Tokens too common to carry signal when matching a request to a skill. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "this",
  "that",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "as",
  "it",
  "its",
  "i",
  "you",
  "we",
  "my",
  "me",
  "can",
  "could",
  "would",
  "should",
  "do",
  "does",
  "did",
  "please",
  "help",
  "need",
  "want",
  "make",
  "get",
  "use",
  "using",
  "how",
  "what",
  "why",
  "when",
  "add",
  "new",
  "up",
  "out",
  "so",
  "not",
  "all",
  "any",
  "some",
  "more",
  "just",
  "now",
  "also",
  "into",
  "about",
]);

export interface SkillSelection {
  /** Full <skill> entries — description + location. */
  full: DiscoveredSkill[];
  /** Name-only entries the model can ask for by name. */
  indexed: DiscoveredSkill[];
}

export interface SelectSkillsOptions {
  /** How many full descriptions to include. Default 10. */
  maxFull?: number;
  /** Force full disclosure regardless of the message (e.g. an explicit /skills flow). */
  forceAll?: boolean;
}

function keywordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+.#-]+/)) {
    const w = raw.replace(/^[-.]+|[-.]+$/g, "");
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

/**
 * Is this message just the user saying hello / acknowledging, rather than
 * asking for work? Such turns need no skill catalog at all.
 */
export function isConversationalOpener(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return true;
  // Anything long enough to describe a task is treated as a request, even if it
  // happens to open with "hi".
  if (trimmed.length > 80) return false;
  if (!GREETING_PATTERNS.test(trimmed)) return false;
  // "hi, can you fix the parser" opens like a greeting but is a request. Look
  // for a verb-ish payload beyond the greeting itself.
  const rest = trimmed
    .replace(GREETING_PATTERNS, "")
    .replace(/[^a-z0-9\s]/gi, " ")
    .trim();
  return keywordsOf(rest).size === 0;
}

/**
 * Choose which skills get full descriptions for this turn.
 *
 * Scoring is deliberately cheap (set intersection on keywords, no model call):
 * a name match counts double since skill names are highly specific.
 */
export function selectSkillsForPrompt(
  skills: DiscoveredSkill[],
  userMessage: string,
  options: SelectSkillsOptions = {},
): SkillSelection {
  if (options.forceAll) return { full: skills, indexed: [] };
  if (skills.length === 0) return { full: [], indexed: [] };
  // Nothing to work on yet — keep the turn as light as possible.
  if (isConversationalOpener(userMessage)) return { full: [], indexed: skills };

  const maxFull = options.maxFull ?? 10;
  const wanted = keywordsOf(userMessage);
  if (wanted.size === 0) return { full: [], indexed: skills };

  const scored = skills.map((skill) => {
    const nameWords = keywordsOf(skill.name.replace(/[-_]/g, " "));
    const descWords = keywordsOf(skill.description);
    let score = 0;
    for (const w of wanted) {
      if (nameWords.has(w)) score += 2;
      else if (descWords.has(w)) score += 1;
    }
    return { skill, score };
  });

  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  const full = hits.slice(0, maxFull).map((s) => s.skill);
  const fullNames = new Set(full.map((s) => s.name));
  return { full, indexed: skills.filter((s) => !fullNames.has(s.name)) };
}

const TIERED_INSTRUCTIONS = `AGENT SKILLS (optional):
<available_skills> lists skills whose instructions are shown in full — read the <location> SKILL.md before using one.
<other_skills> lists the NAMES of every other installed skill. If one of those names looks relevant to the request, read its SKILL.md at ~/.agents/skills/<name>/SKILL.md (user scope) or the project's skills directory, then follow it.
Paths inside a skill (scripts/, references/, assets/) are relative to the folder containing SKILL.md; prefer absolute paths in tool calls.`;

/**
 * Render a tiered catalog. Returns null when there is nothing to say, so a
 * greeting turn carries no skills section whatsoever.
 */
export function formatSkillsTiered(selection: SkillSelection, overlays?: SkillPromptOverlays): string | null {
  const { full, indexed } = selection;
  if (full.length === 0 && indexed.length === 0) return null;
  const sections: string[] = [TIERED_INSTRUCTIONS];
  if (full.length > 0) {
    const body = formatSkillsForPrompt(full, overlays);
    // Reuse the detailed renderer but drop its own instruction header.
    if (body) sections.push(body.slice(body.indexOf("<available_skills>")));
  }
  if (indexed.length > 0) {
    const names = indexed.map((s) => escapeXml(s.name)).join(", ");
    sections.push(`<other_skills>\n${names}\n</other_skills>`);
  }
  return sections.join("\n\n");
}

export function formatSkillsForPrompt(skills: DiscoveredSkill[], overlays?: SkillPromptOverlays): string | null {
  if (skills.length === 0) return null;
  const parts = skills.map((s) => {
    const overlay = overlays?.get(s.name);
    let examples = "";
    if (overlay && overlay.fewShot.length > 0) {
      const rows = overlay.fewShot
        .map(
          (ex) =>
            `      <example>\n        <query>${escapeXml(truncateForPrompt(ex.query, 200))}</query>\n        <result>${escapeXml(truncateForPrompt(ex.result, 400))}</result>\n      </example>`,
        )
        .join("\n");
      examples = `\n    <learned_examples>\n${rows}\n    </learned_examples>`;
    }
    return `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.skillMdPath)}</location>${examples}\n  </skill>`;
  });
  return `${SKILLS_INSTRUCTIONS}\n\n<available_skills>\n${parts.join("\n")}\n</available_skills>`;
}

/** Options for `formatSkillsForChat`. */
export interface FormatSkillsOptions {
  /** When true, include the SKILL.md path on a dim continuation line under each row. Default: false. */
  showPaths?: boolean;
  /** Case-insensitive substring filter against `name` or `description`. Default: "" (no filter). */
  filter?: string;
  /**
   * Width to fit the listing into. Defaults to 100 (a sane non-TTY default);
   * the slash-command caller passes `process.stdout.columns` when available.
   */
  terminalWidth?: number;
}

/** Parse the raw arg string passed to `/skills`. */
export function parseSkillsCommandArgs(raw: string): { showPaths: boolean; filter: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { showPaths: false, filter: "" };
  const tokens = trimmed.split(/\s+/);
  // Only the first token toggles paths-mode; later tokens form the filter.
  // This keeps `paths` available as a substring filter when not first
  // (e.g. `/skills foo paths` → filter "foo paths").
  if (tokens[0] === "paths") {
    return { showPaths: true, filter: tokens.slice(1).join(" ") };
  }
  return { showPaths: false, filter: tokens.join(" ") };
}

function homeRelativePath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** Plain-text listing for /skills slash command in the TUI. */
export function formatSkillsForChat(
  skills: DiscoveredSkill[],
  projectRoot: string,
  opts: FormatSkillsOptions = {},
): string {
  const { showPaths = false, filter = "", terminalWidth = 100 } = opts;

  if (skills.length === 0) {
    return [
      "No Agent Skills found.",
      "",
      `Add skills under ${path.join(projectRoot, ".agents", "skills", "<name>", "SKILL.md")} or ~/.agents/skills/<name>/SKILL.md`,
      "Install manually or use scripts such as skills.sh; see https://agentskills.io",
    ].join("\n");
  }

  const filterLower = filter.toLowerCase();
  const filtered = filter
    ? skills.filter(
        (s) => s.name.toLowerCase().includes(filterLower) || s.description.toLowerCase().includes(filterLower),
      )
    : skills;

  if (filtered.length === 0) {
    return `No skills match "${filter}" (of ${skills.length} total).`;
  }

  const NAME_HEADER = "Name";
  const SCOPE_HEADER = "Scope";
  const DESC_HEADER = "Description";

  const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
  const pad = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length));
  const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);

  // Auto-size name and scope columns to their content; description fills what remains.
  const nameWidth = Math.max(NAME_HEADER.length, ...filtered.map((s) => s.name.length));
  const scopeWidth = Math.max(SCOPE_HEADER.length, ...filtered.map((s) => s.scope.length));
  const SEP = "  "; // double-space between columns
  const overhead = nameWidth + SEP.length + scopeWidth + SEP.length;
  const descWidth = Math.max(20, terminalWidth - overhead - 1);

  const header = `${pad(NAME_HEADER, nameWidth)}${SEP}${pad(SCOPE_HEADER, scopeWidth)}${SEP}${DESC_HEADER}`;
  const sep = `${"-".repeat(nameWidth)}${SEP}${"-".repeat(scopeWidth)}${SEP}${"-".repeat(Math.min(DESC_HEADER.length, descWidth))}`;

  const lines: string[] = [];
  for (const s of filtered) {
    const desc = truncate(oneLine(s.description), descWidth);
    lines.push(`${pad(s.name, nameWidth)}${SEP}${pad(s.scope, scopeWidth)}${SEP}${desc}`);
    if (showPaths) lines.push(`  ${homeRelativePath(s.skillMdPath)}`);
  }

  const headLine = filter
    ? `Agent Skills (${filtered.length} of ${skills.length}, filter: "${filter}")`
    : `Agent Skills (${filtered.length})`;

  return [headLine, "", header, sep, ...lines].join("\n");
}
