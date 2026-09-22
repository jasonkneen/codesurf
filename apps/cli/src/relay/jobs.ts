// Distributed-compute jobs (Phase 3 -> the "distributed compute" requirement).
// A JobHost is a node-side bounded job queue: it runs jobs through a runner seam
// in the background (clients may disconnect; the node keeps working), adapt.
// tracks per-node load for placement, and reports bounded status. Jobs ride the
// same relay delegate path: registerJobTools() exposes them as steward-scoped
// tools so a client delegates job_submit/job_status/job_cancel via a hub.

import type { BoundedPayload } from "./envelope";
import type { RelayNode } from "./node";

export type JobStatusKind = "queued" | "running" | "done" | "failed";

export interface JobSpec {
  type: string;
  tool: string;
  args: unknown;
  repo?: string;
  principal: string;
  scope: string;
  budgetBytes?: number;
}

export interface JobStatus {
  id: string;
  type: string;
  status: JobStatusKind;
  result?: BoundedPayload;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type JobRunner = (spec: JobSpec) => Promise<BoundedPayload>;

export interface JobHostOptions {
  maxConcurrent?: number;
}

interface JobRecord {
  id: string;
  spec: JobSpec;
  status: JobStatusKind;
  result?: BoundedPayload;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export class JobHost {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly pending: JobRecord[] = [];
  private active = 0;
  private seq = 0;

  constructor(
    private readonly runner: JobRunner,
    private readonly opts: JobHostOptions = {},
  ) {}

  submit(spec: JobSpec): JobStatus {
    const id = "job-" + ++this.seq;
    const record: JobRecord = { id, spec, status: "queued", queuedAt: new Date().toISOString() };
    this.jobs.set(id, record);
    this.pending.push(record);
    void this.pump();
    return this.status(id)!;
  }

  status(id: string): JobStatus | null {
    const record = this.jobs.get(id);
    if (!record) return null;
    return {
      id: record.id,
      type: record.spec.type,
      status: record.status,
      result: record.result,
      error: record.error,
      queuedAt: record.queuedAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }

  cancel(id: string): boolean {
    const record = this.jobs.get(id);
    if (!record || record.status === "done" || record.status === "failed") return false;
    if (record.status === "queued") {
      this.pending.splice(this.pending.indexOf(record), 1);
      record.status = "failed";
      record.error = "cancelled";
      record.finishedAt = new Date().toISOString();
      return true;
    }
    return false; // running jobs are not preempted in slice 1
  }

  /** Total queued + running jobs (the node's reported load). */
  load(): number {
    return this.active + this.pending.length;
  }

  /** Drop finished/failed jobs older than ttlMs so a busy node does not leak. */
  reapFinished(ttlMs = 30 * 60_000): number {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const [id, record] of [...this.jobs]) {
      if (
        (record.status === "done" || record.status === "failed") &&
        record.finishedAt &&
        Date.parse(record.finishedAt) < cutoff
      ) {
        this.jobs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  private async pump(): Promise<void> {
    const max = this.opts.maxConcurrent ?? 4;
    while (this.active < max && this.pending.length > 0) {
      const record = this.pending.shift()!;
      this.active++;
      record.status = "running";
      record.startedAt = new Date().toISOString();
      void this.runOne(record).finally(() => {
        this.active--;
        void this.pump();
      });
    }
  }

  private async runOne(record: JobRecord): Promise<void> {
    try {
      record.result = await this.runner(record.spec);
      record.status = "done";
    } catch (error) {
      record.error = String(error);
      record.status = "failed";
    } finally {
      record.finishedAt = new Date().toISOString();
    }
  }
}

// Expose a JobHost as steward-scoped relay tools (distributed compute over the
// delegate path). Tool names: job_submit, job_status, job_cancel.
export function registerJobTools(node: RelayNode, host: JobHost, onChange?: () => void): void {
  node.registerTool({
    name: "job_submit",
    description: "Submit a bounded compute job to this node",
    run: (args) => {
      const partial = args as Partial<JobSpec>;
      const status = host.submit({
        type: String(partial.type ?? "job"),
        tool: String(partial.tool ?? ""),
        args: partial.args,
        repo: partial.repo,
        principal: String(partial.principal ?? ""),
        scope: String(partial.scope ?? ""),
      });
      onChange?.();
      return { statement: JSON.stringify({ id: status.id, status: status.status }), anchors: [], handle: status.id };
    },
  });
  node.registerTool({
    name: "job_status",
    description: "Read a bounded status for a job",
    run: (args) => {
      const id = String((args as { id?: string }).id ?? "");
      const status = host.status(id);
      onChange?.();
      if (!status) return { statement: "unknown:" + id, anchors: [] };
      return { statement: JSON.stringify(status), anchors: [], handle: id };
    },
  });
  node.registerTool({
    name: "job_cancel",
    description: "Cancel a queued job",
    run: (args) => {
      const id = String((args as { id?: string }).id ?? "");
      const removed = host.cancel(id);
      return { statement: removed ? "cancelled:" + id : "not:" + id, anchors: [] };
    },
  });
}
