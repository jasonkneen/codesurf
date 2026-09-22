// In-memory gateway session registry (Phase 1 W2). Ephemeral by design: the
// gateway host owns agent persistence; the registry owns live routing only.

import { randomUUID } from "node:crypto";
import type { GatewayPresentation, GatewaySessionInput, GatewaySessionRecord } from "./types";

export class GatewaySessionRegistry {
  private readonly sessions = new Map<string, GatewaySessionRecord>();

  /** `defaultPresentation` applies when a create request names none (`serve --presentation`). */
  constructor(private readonly defaultPresentation: GatewayPresentation = "native") {}

  create(input: GatewaySessionInput = {}): GatewaySessionRecord {
    const record: GatewaySessionRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      cwd: input.cwd,
      model: input.model,
      presentation: input.presentation ?? this.defaultPresentation,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  get(id: string): GatewaySessionRecord | undefined {
    return this.sessions.get(id);
  }

  list(): GatewaySessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  remove(id: string): boolean {
    return this.sessions.delete(id);
  }
}
