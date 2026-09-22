import { describe, expect, it, vi } from "vitest";
import type { DelegationRun } from "../../types/index";
import {
  ACTIVE_DELEGATION_POLL_MS,
  buildRunningAgentRows,
  getDelegationPollInterval,
  IDLE_DELEGATION_POLL_MS,
  pollDelegationState,
} from "./use-running-agent-rows";

const runningDelegation: DelegationRun = {
  id: "calm-blue-fox-deadbeef",
  agent: "explore",
  description: "Inspect the renderer",
  summary: "Running in the background.",
  status: "running",
};

describe("delegation polling", () => {
  it("uses the fast cadence only while the turn, a delegation, or its detail view is active", () => {
    expect(
      getDelegationPollInterval({
        isProcessing: false,
        hasRunningDelegations: false,
        hasOpenDelegationModal: false,
      }),
    ).toBe(IDLE_DELEGATION_POLL_MS);
    expect(
      getDelegationPollInterval({
        isProcessing: true,
        hasRunningDelegations: false,
        hasOpenDelegationModal: false,
      }),
    ).toBe(ACTIVE_DELEGATION_POLL_MS);
  });

  it("merges run-state and completion reads without losing notifications when one read fails", async () => {
    const agent = {
      getDelegationRuns: vi.fn().mockResolvedValue([runningDelegation]),
      consumeBackgroundNotifications: vi.fn().mockResolvedValue(["Delegation complete"]),
    };

    await expect(pollDelegationState(agent)).resolves.toEqual({
      runningDelegations: [runningDelegation],
      notifications: ["Delegation complete"],
    });
    expect(agent.getDelegationRuns).toHaveBeenCalledTimes(1);
    expect(agent.consumeBackgroundNotifications).toHaveBeenCalledTimes(1);

    agent.getDelegationRuns.mockRejectedValueOnce(new Error("temporary filesystem error"));
    agent.consumeBackgroundNotifications.mockResolvedValueOnce(["Delegation failed"]);
    await expect(pollDelegationState(agent)).resolves.toEqual({
      runningDelegations: null,
      notifications: ["Delegation failed"],
    });
  });
});

describe("buildRunningAgentRows", () => {
  it("gives the inline sub-agent its start time so elapsed can render", () => {
    const rows = buildRunningAgentRows(
      { agent: "explore", description: "Inspect the renderer", detail: "grep", startedAt: "2026-09-17T09:00:00.000Z" },
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "inline",
      status: "running",
      startedAt: "2026-09-17T09:00:00.000Z",
    });
  });

  it("lists the inline sub-agent first, then every delegation", () => {
    const rows = buildRunningAgentRows({ agent: "a", description: "d", detail: "x" }, [runningDelegation]);
    expect(rows.map((r) => r.kind)).toEqual(["inline", "delegation"]);
    expect(rows[1]).toMatchObject({ id: runningDelegation.id, status: "running" });
  });

  it("is empty when nothing is running", () => {
    expect(buildRunningAgentRows(null, [])).toEqual([]);
  });
});
