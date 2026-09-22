import * as fs from "node:fs";
import * as path from "node:path";

export interface DaemonJobRecord {
  id: string;
  taskLabel: string | null;
  provider: string | null;
  model: string | null;
  cardId: string | null;
  workspaceDir: string | null;
  status: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
  sessionId: string | null;
}

export interface SplitSessionRepairGroup {
  key: string;
  cardId: string;
  taskLabel: string;
  workspaceDir: string | null;
  provider: string | null;
  model: string | null;
  canonicalSessionId: string;
  sessionIds: string[];
  jobIds: string[];
}

export interface SplitSessionRepairResult {
  groups: SplitSessionRepairGroup[];
  jobsPatched: number;
  timelinesPatched: number;
  failures: Array<{ jobId: string; kind: "job" | "timeline"; message: string }>;
  dryRun: boolean;
}

interface RepairOptions {
  homeDir: string;
  dryRun?: boolean;
  workspaceDir?: string | null;
  cardId?: string | null;
}

function jobsDir(homeDir: string): string {
  return path.join(homeDir, "jobs");
}

function timelinePath(homeDir: string, jobId: string): string {
  return path.join(homeDir, "timelines", `${jobId}.jsonl`);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestampOf(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newerFirst(a: DaemonJobRecord, b: DaemonJobRecord): number {
  return timestampOf(b.updatedAt ?? b.requestedAt) - timestampOf(a.updatedAt ?? a.requestedAt);
}

function readJobRecord(filePath: string): DaemonJobRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const id = asString(parsed.id) ?? path.basename(filePath, ".json");
    return {
      id,
      taskLabel: asString(parsed.taskLabel) ?? asString(parsed.initialPrompt),
      provider: asString(parsed.provider),
      model: asString(parsed.model),
      cardId: asString(parsed.cardId),
      workspaceDir: asString(parsed.workspaceDir),
      status: asString(parsed.status),
      requestedAt: asString(parsed.requestedAt),
      updatedAt: asString(parsed.updatedAt),
      sessionId: asString(parsed.sessionId),
    };
  } catch {
    return null;
  }
}

export function readDaemonJobRecords(homeDir: string): DaemonJobRecord[] {
  const dir = jobsDir(homeDir);
  if (!fs.existsSync(dir)) return [];
  const records: DaemonJobRecord[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const record = readJobRecord(path.join(dir, entry));
    if (record) records.push(record);
  }
  return records.sort(newerFirst);
}

export function findLatestDaemonSessionIdForCard(
  homeDir: string,
  cardId: string,
  workspaceDir?: string | null,
): string | null {
  const normalizedCardId = cardId.trim();
  if (!normalizedCardId) return null;
  const normalizedWorkspace = workspaceDir?.trim() || null;
  const match = readDaemonJobRecords(homeDir).find(
    (job) =>
      job.cardId === normalizedCardId &&
      !!job.sessionId &&
      (!normalizedWorkspace || !job.workspaceDir || job.workspaceDir === normalizedWorkspace),
  );
  return match?.sessionId ?? null;
}

function splitGroupKey(job: DaemonJobRecord): string | null {
  if (!job.cardId || !job.taskLabel || !job.sessionId) return null;
  return [job.cardId, job.workspaceDir ?? "", job.provider ?? "", job.model ?? "", job.taskLabel].join("\0");
}

function buildSplitGroups(records: DaemonJobRecord[], options: RepairOptions): SplitSessionRepairGroup[] {
  const normalizedWorkspace = options.workspaceDir?.trim() || null;
  const normalizedCardId = options.cardId?.trim() || null;
  const byKey = new Map<string, DaemonJobRecord[]>();

  for (const job of records) {
    if (job.status === "running") continue;
    if (normalizedWorkspace && job.workspaceDir !== normalizedWorkspace) continue;
    if (normalizedCardId && job.cardId !== normalizedCardId) continue;
    const key = splitGroupKey(job);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), job]);
  }

  const groups: SplitSessionRepairGroup[] = [];
  for (const [key, jobs] of byKey) {
    const sorted = [...jobs].sort(newerFirst);
    const sessionIds = [...new Set(sorted.map((job) => job.sessionId).filter((id): id is string => !!id))];
    if (sessionIds.length <= 1) continue;
    const canonicalSessionId = sorted[0]?.sessionId;
    const first = sorted[0];
    if (!canonicalSessionId || !first?.cardId || !first.taskLabel) continue;
    groups.push({
      key,
      cardId: first.cardId,
      taskLabel: first.taskLabel,
      workspaceDir: first.workspaceDir,
      provider: first.provider,
      model: first.model,
      canonicalSessionId,
      sessionIds,
      jobIds: sorted.map((job) => job.id),
    });
  }

  return groups.sort((a, b) => b.jobIds.length - a.jobIds.length || a.cardId.localeCompare(b.cardId));
}

export function patchDaemonJobSession(homeDir: string, jobId: string, sessionId: string, dryRun = false): boolean {
  const trimmed = sessionId.trim();
  if (!trimmed) return false;
  const filePath = path.join(jobsDir(homeDir), `${jobId}.json`);
  if (!fs.existsSync(filePath)) return false;

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (parsed.sessionId === trimmed) return false;
  if (!dryRun) {
    parsed.sessionId = trimmed;
    fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  return true;
}

export function patchDaemonTimelineSession(homeDir: string, jobId: string, sessionId: string, dryRun = false): boolean {
  const trimmed = sessionId.trim();
  if (!trimmed) return false;
  const filePath = timelinePath(homeDir, jobId);
  if (!fs.existsSync(filePath)) return false;

  const raw = fs.readFileSync(filePath, "utf8");
  const hadTrailingNewline = raw.endsWith("\n");
  let changed = false;
  const lines = raw.split(/\n/);
  const rewritten = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.sessionId === "string" && parsed.sessionId !== trimmed) {
        parsed.sessionId = trimmed;
        changed = true;
        return JSON.stringify(parsed);
      }
      return line;
    } catch {
      return line;
    }
  });

  if (changed && !dryRun) {
    fs.writeFileSync(filePath, `${rewritten.join("\n").replace(/\n+$/, "")}${hadTrailingNewline ? "\n" : ""}`, "utf8");
  }
  return changed;
}

export function repairSplitDaemonSessions(options: RepairOptions): SplitSessionRepairResult {
  const groups = buildSplitGroups(readDaemonJobRecords(options.homeDir), options);
  let jobsPatched = 0;
  let timelinesPatched = 0;
  const failures: SplitSessionRepairResult["failures"] = [];

  for (const group of groups) {
    for (const jobId of group.jobIds) {
      try {
        if (patchDaemonJobSession(options.homeDir, jobId, group.canonicalSessionId, options.dryRun)) jobsPatched += 1;
      } catch (err) {
        failures.push({ jobId, kind: "job", message: err instanceof Error ? err.message : String(err) });
      }
      try {
        if (patchDaemonTimelineSession(options.homeDir, jobId, group.canonicalSessionId, options.dryRun)) {
          timelinesPatched += 1;
        }
      } catch (err) {
        failures.push({ jobId, kind: "timeline", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    groups,
    jobsPatched,
    timelinesPatched,
    failures,
    dryRun: options.dryRun === true,
  };
}
