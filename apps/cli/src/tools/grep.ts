import { type ChildProcessByStdio, type SpawnOptions, spawn } from "child_process";
import { stat } from "fs/promises";
import path from "path";
import type { Readable } from "stream";
import type { ToolResult } from "../types/index";

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 2000;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;

interface GrepParams {
  pattern: string;
  path?: string;
  include?: string;
}

/** Spawn seam so tests can drive ripgrep's stdout/stderr/exit deterministically. */
export type GrepSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessByStdio<null, Readable, Readable>;

export interface GrepOptions {
  spawn?: GrepSpawn;
}

const defaultSpawn: GrepSpawn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });

interface RipgrepMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    absolute_offset: number;
    submatches: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

function buildArgs(params: GrepParams): string[] {
  // No `--no-messages`: ripgrep exits 2 for unreadable files/paths and the
  // stderr text is the only evidence of what went wrong, so keep it.
  const args = ["--no-config", "--json", "--hidden", "--glob=!.git/*"];

  if (params.include) {
    args.push(`--glob=${params.include}`);
  }

  args.push("--", params.pattern, params.path ?? ".");
  return args;
}

function cleanPath(file: string): string {
  return path.normalize(file.replace(/^\.[\\/]/, ""));
}

interface ParsedMatch {
  file: string;
  line: number;
  text: string;
}

interface RipgrepCollection {
  matches: ParsedMatch[];
  /** Collection stopped at the match limit; the true total is unknown. */
  capped: boolean;
  /** JSON records discarded because they exceeded MAX_RECORD_BYTES. */
  skippedRecords: number;
  exitCode: number | null;
  stderr: string;
}

function parseLine(line: string): ParsedMatch | undefined {
  if (line.length === 0) return;
  try {
    const parsed = JSON.parse(line) as RipgrepMatch;
    if (parsed.type !== "match") return;
    return {
      file: cleanPath(parsed.data.path.text),
      line: parsed.data.line_number,
      text: parsed.data.lines.text.replace(/\n$/, ""),
    };
  } catch {
    // skip malformed lines
  }
}

async function getFileMtimes(files: string[], cwd: string): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  await Promise.all(
    files.map(async (file) => {
      const fullPath = path.isAbsolute(file) ? file : path.join(cwd, file);
      try {
        const info = await stat(fullPath);
        times.set(file, info.mtimeMs);
      } catch {
        // skip inaccessible files
      }
    }),
  );
  return times;
}

export async function executeGrep(
  params: GrepParams,
  cwd: string,
  abortSignal?: AbortSignal,
  options: GrepOptions = {},
): Promise<ToolResult> {
  if (!params.pattern) {
    return { success: false, error: "pattern is required" };
  }

  if (abortSignal?.aborted) {
    return { success: false, error: "Grep aborted." };
  }

  const searchPath = params.path ? (path.isAbsolute(params.path) ? params.path : path.join(cwd, params.path)) : cwd;

  let searchCwd: string;
  let searchTarget: string | undefined;
  try {
    const info = await stat(searchPath);
    if (info.isDirectory()) {
      searchCwd = searchPath;
    } else {
      searchCwd = path.dirname(searchPath);
      searchTarget = path.relative(searchCwd, searchPath);
    }
  } catch {
    searchCwd = cwd;
    searchTarget = params.path;
  }

  const args = buildArgs({ ...params, path: searchTarget });

  try {
    const collected = await streamRipgrep(args, searchCwd, abortSignal, options.spawn ?? defaultSpawn);
    const stderr = collected.stderr.trim();
    const errored = collected.exitCode === 2;
    const notices: string[] = [];

    if (collected.skippedRecords > 0) {
      notices.push(
        `(Skipped ${collected.skippedRecords} oversized result record${collected.skippedRecords === 1 ? "" : "s"} larger than ${MAX_RECORD_BYTES} bytes.)`,
      );
    }

    if (collected.matches.length === 0) {
      if (errored) {
        return { success: false, error: `Grep failed: ${stderr || "ripgrep exited with code 2"}` };
      }
      return { success: true, output: ["No matches found.", ...notices].join("\n") };
    }

    if (errored) {
      notices.push(
        `(Search incomplete: ripgrep exited with code 2, so some files or paths were not searched.${stderr ? `\n${stderr}` : ""})`,
      );
    }

    const rebase = (file: string) => path.relative(cwd, path.resolve(searchCwd, file));

    const capped = collected.capped;
    const matches = capped ? collected.matches.slice(0, MAX_MATCHES) : collected.matches;
    const uniqueFiles = [...new Set(matches.map((m) => rebase(m.file)))];
    const mtimes = await getFileMtimes(uniqueFiles, cwd);

    const rows = matches
      .map((m) => ({
        file: rebase(m.file),
        line: m.line,
        text: m.text,
        mtime: mtimes.get(rebase(m.file)) ?? 0,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    const output: string[] = [
      capped
        ? `Found ${MAX_MATCHES} matches (limit reached; more exist, total not counted)`
        : `Found ${rows.length} matches`,
    ];

    let currentFile = "";
    for (const row of rows) {
      if (currentFile !== row.file) {
        if (currentFile !== "") output.push("");
        currentFile = row.file;
        output.push(`${row.file}:`);
      }
      const text = row.text.length > MAX_LINE_LENGTH ? `${row.text.substring(0, MAX_LINE_LENGTH)}...` : row.text;
      output.push(`  Line ${row.line}: ${text}`);
    }

    if (capped) {
      notices.push(
        `(Results truncated: the search stopped after ${MAX_MATCHES} matches, so the total is unknown. Consider using a more specific path or pattern.)`,
      );
    }

    if (notices.length > 0) {
      output.push("");
      output.push(...notices);
    }

    return { success: true, output: output.join("\n") };
  } catch (err: unknown) {
    if (abortSignal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Grep failed: ${msg}` };
  }
}

function streamRipgrep(
  args: string[],
  cwd: string,
  abortSignal: AbortSignal | undefined,
  spawnProcess: GrepSpawn,
): Promise<RipgrepCollection> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("rg", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
    });

    const matches: ParsedMatch[] = [];
    let stderrBuffer = "";
    let stopped = false;
    let aborted = false;
    let skippedRecords = 0;

    const stopChild = () => {
      if (stopped) return;
      stopped = true;
      if (!child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    };

    const onAbort = () => {
      aborted = true;
      stopChild();
      reject(new Error("Grep aborted."));
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // Records are split on raw newline bytes (0x0A never occurs inside a
    // multi-byte UTF-8 sequence), so a record is only decoded once it is
    // complete and chunk boundaries can never split a character.
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let discarding = false;

    const handleRecord = (record: Buffer): boolean => {
      const match = parseLine(record.toString("utf8"));
      if (!match) return false;
      matches.push(match);
      // One lookahead: collecting MAX_MATCHES + 1 proves more exist without
      // pretending to know the total.
      if (matches.length > MAX_MATCHES) {
        stopChild();
        return true;
      }
      return false;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        if (newline === -1) {
          if (!discarding) {
            const rest = chunk.subarray(start);
            if (pendingBytes + rest.length > MAX_RECORD_BYTES) {
              discarding = true;
              skippedRecords++;
              pendingChunks = [];
              pendingBytes = 0;
            } else {
              pendingChunks.push(Buffer.from(rest));
              pendingBytes += rest.length;
            }
          }
          break;
        }

        if (discarding) {
          discarding = false;
          start = newline + 1;
          continue;
        }

        const part = chunk.subarray(start, newline);
        start = newline + 1;
        if (pendingBytes + part.length > MAX_RECORD_BYTES) {
          skippedRecords++;
          pendingChunks = [];
          pendingBytes = 0;
          continue;
        }

        const record = pendingChunks.length > 0 ? Buffer.concat([...pendingChunks, part]) : part;
        pendingChunks = [];
        pendingBytes = 0;
        if (handleRecord(record)) break;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuffer.length < MAX_STDERR_CHARS) {
        stderrBuffer += chunk.toString("utf8");
      }
    });

    child.on("error", (err) => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      if (aborted) return;

      if (!stopped && pendingChunks.length > 0) {
        handleRecord(Buffer.concat(pendingChunks));
        pendingChunks = [];
        pendingBytes = 0;
      }

      const capped = matches.length > MAX_MATCHES;
      if (!capped && code !== 0 && code !== 1 && code !== 2) {
        return reject(new Error(stderrBuffer.trim() || `ripgrep failed with code ${code}`));
      }

      resolve({ matches, capped, skippedRecords, exitCode: code, stderr: stderrBuffer });
    });
  });
}
