// Steward tier gate (Phase 2 W2). The always-on dispatch gate: authz + scope +
// audit for delegated tool calls (v0 §7 tier 2). The gate decides, it does not
// reason — Q (the broker agent) is out of scope for slice 1. Every gated call
// records an audit entry.

export interface AuditEntry {
  auditId: string;
  at: string; // ISO timestamp
  principal: string;
  tool: string; // steward-scoped tool name
  scope: string;
  allowed: boolean;
  reason?: string;
}

export interface StewardPolicy {
  /** tool name -> principals allowed to call it. */
  allow: Record<string, string[]>;
}

let auditSeq = 0;
function nextAuditId(): string {
  auditSeq = (auditSeq + 1) % 100000;
  return "aud-" + Date.now().toString(36) + "-" + auditSeq;
}

export class Steward {
  private readonly audits: AuditEntry[] = [];
  private readonly maxAudits: number;

  constructor(
    private readonly policy: StewardPolicy,
    maxAudits = 1000,
  ) {
    this.maxAudits = maxAudits;
  }

  /**
   * Authorize a principal's call to a steward-scoped tool within a scope.
   * Always records an audit entry (the audit trail satisfies v0 §7 tier-2).
   */
  authorize(principal: string, tool: string, scope: string): { allowed: boolean; auditId: string; reason?: string } {
    const allowedPrincipals = this.policy.allow[tool] ?? [];
    const allowed = allowedPrincipals.includes("*") || allowedPrincipals.includes(principal);
    const entry: AuditEntry = {
      auditId: nextAuditId(),
      at: new Date().toISOString(),
      principal,
      tool,
      scope,
      allowed,
      reason: allowed ? undefined : `principal ${principal} not allowed to call ${tool}`,
    };
    this.audits.push(entry);
    if (this.audits.length > this.maxAudits) this.audits.splice(0, this.audits.length - this.maxAudits);
    return { allowed, auditId: entry.auditId, reason: entry.reason };
  }

  /** Snapshot of the audit log (newest last). */
  auditLog(): readonly AuditEntry[] {
    return this.audits.slice();
  }
}
