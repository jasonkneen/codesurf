import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, resolve } from "path";
import { findGitRoot } from "./git-root.js";

const REFRESH_TTL_MS = 30_000;
const MAX_INDEXED_FILES = 5000;
const execFileAsync = promisify(execFile);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".flac",
  ".ogg",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".pyc",
  ".class",
  ".wasm",
]);

function isBinaryPath(filePath: string): boolean {
  const ext = filePath.lastIndexOf(".");
  if (ext === -1) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(ext).toLowerCase());
}

/**
 * Drop symlinks: a committed link can point anywhere on disk (~/.ssh, .env of
 * another project), and listed files are read into prompts and embeddings.
 * `find -type f` already skips them; `git ls-files` does not.
 */
async function withoutSymlinks(baseDir: string, files: string[]): Promise<string[]> {
  const keep = await Promise.all(
    files.map(async (file) => {
      try {
        return !(await lstat(resolve(baseDir, file))).isSymbolicLink();
      } catch {
        return false;
      }
    }),
  );
  return files.filter((_, i) => keep[i]);
}

interface CollectedFiles {
  files: string[];
  /** More files matched than MAX_INDEXED_FILES; `files` is a prefix of the full list. */
  truncated: boolean;
}

async function collectFiles(cwd: string): Promise<CollectedFiles> {
  const gitRoot = findGitRoot(cwd);
  try {
    // stderr is piped (captured into err.stderr on throw) rather than
    // inherited — the previous default would leak git/find warnings to the
    // user's TTY through Ink's screen, producing garbled output. We log
    // captured stderr on failure so the warning isn't lost entirely.
    const result = gitRoot
      ? await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
          cwd: gitRoot,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 5000,
        })
      : await execFileAsync(
          "find",
          [
            ".",
            "-type",
            "f",
            "-not",
            "-path",
            "*/node_modules/*",
            "-not",
            "-path",
            "*/.git/*",
            "-not",
            "-path",
            "*/dist/*",
          ],
          {
            cwd,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5000,
          },
        );
    const raw = String(result.stdout ?? "");
    // git output is NUL-separated (-z): names with newlines or quoting-worthy
    // bytes come through verbatim instead of C-quoted/split.
    const all = (gitRoot ? raw.split("\0") : raw.split("\n").map((l) => l.trim()))
      .map((l) => (l.startsWith("./") ? l.slice(2) : l))
      .filter((l) => l.length > 0 && !isBinaryPath(l));
    const files = await withoutSymlinks(gitRoot ?? cwd, all.slice(0, MAX_INDEXED_FILES));
    return { files, truncated: all.length > MAX_INDEXED_FILES };
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[file-index] collectFiles failed (cwd=${gitRoot ?? cwd}): ${message}${stderr ? `\n${stderr}` : ""}`);
    return { files: [], truncated: false };
  }
}

const QUERY_STOPWORDS = new Set([
  "the",
  "and",
  "but",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "these",
  "those",
  "what",
  "when",
  "where",
  "which",
  "while",
  "why",
  "how",
  "who",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "does",
  "did",
  "doing",
  "done",
  "you",
  "your",
  "our",
  "their",
  "they",
  "its",
  "his",
  "her",
  "him",
  "she",
  "all",
  "any",
  "some",
  "such",
  "than",
  "then",
  "too",
  "very",
  "just",
  "also",
  "about",
  "above",
  "after",
  "before",
  "below",
  "between",
  "during",
  "over",
  "under",
  "again",
  "further",
  "once",
  "only",
  "own",
  "same",
  "so",
  "not",
  "can",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "use",
  "uses",
  "used",
  "using",
  "via",
  "within",
  "across",
]);

function tokenizePath(filePath: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Split on path separators, dots, dashes, underscores, and camelCase
  // boundaries so `src/auth-manager.ts` -> ["src","auth","manager","ts"].
  const lowered = filePath.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  for (const raw of lowered.split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    if (raw.length < 3) continue;
    if (QUERY_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function scoreMatch(filePath: string, query: string): number {
  const lowerPath = filePath.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerPath.includes(lowerQuery)) return -1;

  let score = 0;
  const name = basename(filePath).toLowerCase();

  if (name === lowerQuery) score += 100;
  else if (name.startsWith(lowerQuery)) score += 60;
  else if (name.includes(lowerQuery)) score += 30;

  if (lowerPath.startsWith(lowerQuery)) score += 20;

  const idx = lowerPath.indexOf(lowerQuery);
  score -= idx * 0.1;

  score -= filePath.length * 0.05;

  return score;
}

export class FileIndex {
  private files: string[] = [];
  private listTruncated = false;
  private cwd: string;
  private baseDir: string;
  private lastRefresh = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.baseDir = findGitRoot(cwd) ?? cwd;
  }

  async refresh(): Promise<void> {
    const cwd = this.cwd;
    const { files, truncated } = await collectFiles(cwd);
    if (this.cwd !== cwd) return;
    this.files = files;
    this.listTruncated = truncated;
    this.lastRefresh = Date.now();
  }

  updateCwd(cwd: string): void {
    if (cwd !== this.cwd) {
      this.cwd = cwd;
      this.baseDir = findGitRoot(cwd) ?? cwd;
      this.lastRefresh = 0;
      this.refreshPromise = null;
    }
  }

  private needsRefresh(): boolean {
    return Date.now() - this.lastRefresh > REFRESH_TTL_MS;
  }

  private scheduleRefresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async ensureFresh(options: { waitForStale?: boolean } = {}): Promise<void> {
    if (!this.needsRefresh()) return;
    const refresh = this.scheduleRefresh();
    if (options.waitForStale || this.files.length === 0) await refresh;
  }

  async match(query: string, maxResults = 10): Promise<string[]> {
    await this.ensureFresh({ waitForStale: false });
    if (!query) return this.files.slice(0, maxResults);

    const scored: { path: string; score: number }[] = [];
    for (const f of this.files) {
      const s = scoreMatch(f, query);
      if (s >= 0) scored.push({ path: f, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map((s) => s.path);
  }

  /**
   * Token-aware match for prose queries. Splits both the query and each file
   * path into tokens and scores by bidirectional substring overlap (so
   * "authentication" matches `auth.ts`). Falls back to plain `match` when
   * tokenization yields nothing useful.
   */
  async matchTokens(query: string, maxResults = 10): Promise<string[]> {
    await this.ensureFresh({ waitForStale: false });
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return this.match(query, maxResults);

    const totals = new Map<string, number>();
    for (const f of this.files) {
      const pathTokens = tokenizePath(f);
      if (pathTokens.length === 0) continue;
      let total = 0;
      const matchedQueryTokens = new Set<string>();
      for (const qt of tokens) {
        for (const pt of pathTokens) {
          // Bidirectional substring: path-token contains query-token OR
          // query-token contains path-token (path-token must be >=3 chars to
          // avoid spurious hits on "ts", "js", etc.).
          if (pt.includes(qt) || (pt.length >= 3 && qt.includes(pt))) {
            // Exact path-token match is most informative, then prefix, then
            // generic substring.
            let s = 5;
            if (pt === qt) s = 40;
            else if (pt.startsWith(qt) || qt.startsWith(pt)) s = 20;
            // Prefer shorter (more specific) paths.
            s -= f.length * 0.05;
            total += s;
            matchedQueryTokens.add(qt);
            break; // count each query token at most once per path
          }
        }
      }
      if (matchedQueryTokens.size > 0) {
        // Reward paths that match multiple distinct query tokens.
        totals.set(f, total + matchedQueryTokens.size * 25);
      }
    }

    if (totals.size === 0) return this.match(query, maxResults);

    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults)
      .map(([path]) => path);
  }

  get size(): number {
    return this.files.length;
  }

  /** True when the workspace has more files than the index keeps: list() is not the full set. */
  get truncated(): boolean {
    return this.listTruncated;
  }

  async list(): Promise<string[]> {
    await this.ensureFresh({ waitForStale: true });
    return [...this.files];
  }

  resolvePath(filePath: string): string {
    return resolve(this.baseDir, filePath);
  }
}
