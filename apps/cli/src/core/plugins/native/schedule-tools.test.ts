// Smoke tests for the schedule-tools extension.
//
// Phase 2 step 6 of the kernel-extensibility plan. Verifies that the seven
// schedule tools (`schedule_create`, `schedule_list`, `schedule_remove`,
// `schedule_read_log`, `schedule_daemon_status`, `schedule_daemon_start`,
// `schedule_daemon_stop`) register correctly with the kernel, that they're
// mode-gated to agent mode only, that `services.schedule.*` throws (and the
// tool wraps the throw in a friendly failure ToolResult) when the bridge
// sink is unbound, and that when the Agent binds the sink via
// `setScheduleSink(...)` each tool forwards args to the matching
// ScheduleManager method at execute time.
//
// We don't exercise the real ScheduleManager — `setScheduleSink` accepts an
// arbitrary `ScheduleSink`, so we install spies that record calls and return
// canned structured data. The four daemon-formatter assertions migrated from
// `src/grok/tools.test.ts` (the `createScheduleToolSet` helper they used is
// gone now — those expectations moved into the per-method blocks below).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StoredSchedule } from "../../../tools/schedule";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  EXTENSIONS_V1_API_VERSION,
  getEnabledToolSet,
  getRegistrySnapshot,
  setKernelMode,
  setScheduleSink,
} from "../index";
import { createNativePluginModule } from "./host";
import { scheduleToolsPlugin } from "./schedule-tools";

let tempDir: string;
let originalConfigDir: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-schedule-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
  setScheduleSink(null);
  setKernelMode(null);
});

interface ToolResultLike {
  success: boolean;
  output?: string;
  error?: string;
}

interface ExecutableTool {
  execute: (args: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<ToolResultLike>;
}

const SCHEDULE_TOOLS = [
  "schedule_create",
  "schedule_list",
  "schedule_remove",
  "schedule_read_log",
  "schedule_daemon_status",
  "schedule_daemon_start",
  "schedule_daemon_stop",
] as const;

function getTool(name: (typeof SCHEDULE_TOOLS)[number]): ExecutableTool {
  return getRegistrySnapshot().tools.find((t) => t.name === name)!.tool as unknown as ExecutableTool;
}

function makeStoredSchedule(overrides: Partial<StoredSchedule> = {}): StoredSchedule {
  return {
    id: "daily-scan",
    name: "Daily security scan",
    instruction: "Run a security scan",
    cron: "0 9 * * *",
    model: "grok-4-1-fast-reasoning",
    directory: "/tmp/work",
    enabled: true,
    maxToolRounds: 400,
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("schedule-tools extension", () => {
  it("declares the expected manifest shape", () => {
    expect(scheduleToolsPlugin.manifest.id).toBe("builtin.tools.schedule");
    expect(createNativePluginModule(scheduleToolsPlugin).manifest.kind).toBe("builtin");
    expect(createNativePluginModule(scheduleToolsPlugin).manifest.hostApiVersion).toBe(EXTENSIONS_V1_API_VERSION);
    expect(scheduleToolsPlugin.manifest.capabilities).toContain("tools");
    expect(scheduleToolsPlugin.manifest.enabledByDefault).toBe(true);
  });

  it("registers all 7 schedule tools as kernel-owned with the 'schedule' group", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const names = snapshot.tools.map((t) => t.name).sort();
    expect(names).toEqual([...SCHEDULE_TOOLS].sort());
    for (const name of SCHEDULE_TOOLS) {
      const entry = snapshot.tools.find((t) => t.name === name)!;
      expect(entry.tool, `${name} should have a kernel-owned tool def`).toBeDefined();
      expect(entry.group).toBe("schedule");
    }
  });

  // Creating a schedule starts an unattended agent run with a model-written
  // instruction, so the model cannot do it without the user saying yes.
  it("requires approval for schedule_create", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);
    const create = getRegistrySnapshot().tools.find((t) => t.name === "schedule_create");
    expect((create?.tool as { needsApproval?: unknown }).needsApproval).toBe(true);
  });

  it("mode-gates all 7 schedule tools to agent mode only", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);
    const snapshot = getRegistrySnapshot();

    for (const name of SCHEDULE_TOOLS) {
      expect(snapshot.tools.find((t) => t.name === name)!.modes).toEqual(["agent"]);
    }

    // Agent mode → all seven available.
    setKernelMode("agent");
    expect(Object.keys(getEnabledToolSet()).sort()).toEqual([...SCHEDULE_TOOLS].sort());

    // Plan mode → none survive.
    setKernelMode("plan");
    expect(Object.keys(getEnabledToolSet())).toEqual([]);

    // Ask mode → none survive.
    setKernelMode("ask");
    expect(Object.keys(getEnabledToolSet())).toEqual([]);
  });

  it("returns friendly errors for all 7 tools when the bridge sink is unbound", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    // schedule_create
    const createResult = await getTool("schedule_create").execute({
      name: "x",
      instruction: "y",
    });
    expect(createResult.success).toBe(false);
    expect(createResult.output ?? "").toContain("Failed to create schedule");
    expect(createResult.output ?? "").toMatch(/schedule manager is not active/i);

    // schedule_list
    const listResult = await getTool("schedule_list").execute({});
    expect(listResult.success).toBe(false);
    expect(listResult.output ?? "").toContain("Failed to list schedules");
    expect(listResult.output ?? "").toMatch(/schedule manager is not active/i);

    // schedule_remove
    const removeResult = await getTool("schedule_remove").execute({ id: "daily-scan" });
    expect(removeResult.success).toBe(false);
    expect(removeResult.output ?? "").toContain("Failed to remove schedule");
    expect(removeResult.output ?? "").toMatch(/schedule manager is not active/i);

    // schedule_read_log
    const logResult = await getTool("schedule_read_log").execute({ id: "daily-scan" });
    expect(logResult.success).toBe(false);
    expect(logResult.output ?? "").toContain("Failed to read schedule log");
    expect(logResult.output ?? "").toMatch(/schedule manager is not active/i);

    // schedule_daemon_status
    const statusResult = await getTool("schedule_daemon_status").execute({});
    expect(statusResult.success).toBe(false);
    expect(statusResult.output ?? "").toContain("Failed to get schedule daemon status");
    expect(statusResult.output ?? "").toMatch(/schedule manager is not active/i);

    // schedule_daemon_start
    const startResult = await getTool("schedule_daemon_start").execute({});
    expect(startResult.success).toBe(false);
    expect(startResult.output ?? "").toContain("Failed to start schedule daemon");
    expect(startResult.output ?? "").toMatch(/schedule manager is not active/i);

    // schedule_daemon_stop
    const stopResult = await getTool("schedule_daemon_stop").execute({});
    expect(stopResult.success).toBe(false);
    expect(stopResult.output ?? "").toContain("Failed to stop schedule daemon");
    expect(stopResult.output ?? "").toMatch(/schedule manager is not active/i);
  });

  it("forwards args from schedule_create to the bound sink and renders a recurring summary", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    const calls: Array<{ method: string; payload: unknown }> = [];
    setScheduleSink({
      create: async (options) => {
        calls.push({ method: "create", payload: options });
        return {
          schedule: makeStoredSchedule({ name: options.name, instruction: options.instruction, cron: options.cron }),
          daemonStatus: { running: true, pid: 4242 },
          startedPid: null,
        };
      },
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_create").execute({
      name: "Daily security scan",
      instruction: "Run a security scan",
      cron: "0 9 * * *",
      max_tool_rounds: 200,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Schedule created: Daily security scan");
    expect(result.output).toContain("Type: recurring");
    expect(result.output).toContain("Cron: 0 9 * * *");
    expect(result.output).toContain("Daemon status: running (pid 4242).");

    expect(calls).toEqual([
      {
        method: "create",
        payload: {
          name: "Daily security scan",
          instruction: "Run a security scan",
          cron: "0 9 * * *",
          model: undefined,
          directory: undefined,
          maxToolRounds: 200,
        },
      },
    ]);
  });

  it("renders a one-time schedule_create summary with the started pid and no daemon reminder", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async (options) => ({
        schedule: makeStoredSchedule({ id: "one-shot", name: options.name, cron: undefined }),
        daemonStatus: { running: false, pid: null },
        startedPid: 9001,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_create").execute({
      name: "Right now",
      instruction: "Do the thing",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Type: one-time");
    expect(result.output).toContain("Run started in background (pid 9001).");
    expect(result.output).not.toContain("Daemon status:");
    expect(result.output).not.toContain("Cron:");
  });

  it("formats schedule_list output with daemon banner and per-schedule entries", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    const items: StoredSchedule[] = [
      makeStoredSchedule({
        id: "daily-scan",
        name: "Daily security scan",
        cron: "0 9 * * *",
        enabled: true,
        lastRunAt: "2026-04-29T09:00:00.000Z",
      }),
      makeStoredSchedule({
        id: "one-shot",
        name: "Right now",
        cron: undefined,
        lastRunAt: undefined,
      }),
    ];

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => items,
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: true, pid: 1234 }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_list").execute({});
    expect(result.success).toBe(true);
    expect(result.output).toContain("Daemon: running (pid 1234)");
    expect(result.output).toContain("- Daily security scan (`daily-scan`)");
    expect(result.output).toContain("type: recurring");
    expect(result.output).toContain("cron: 0 9 * * *");
    expect(result.output).toContain("enabled: yes");
    expect(result.output).toContain("- Right now (`one-shot`)");
    expect(result.output).toContain("type: one-time");
    expect(result.output).toContain("last run: 2026-04-29T09:00:00.000Z");
    expect(result.output).toContain("last run: never");
  });

  it("renders schedule_list empty-state with a daemon reminder", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_list").execute({});
    expect(result.success).toBe(true);
    expect(result.output).toContain("No schedules found.");
    expect(result.output).toContain("Daemon status: not running");
  });

  it("forwards id from schedule_remove and reports the removed name", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    const calls: Array<{ method: string; payload: unknown }> = [];
    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async (id) => {
        calls.push({ method: "remove", payload: id });
        return makeStoredSchedule({ id, name: `Removed ${id}` });
      },
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_remove").execute({ id: "daily-scan" });
    expect(result.success).toBe(true);
    expect(result.output).toBe('Removed schedule "Removed daily-scan" (daily-scan).');
    expect(calls).toEqual([{ method: "remove", payload: "daily-scan" }]);
  });

  it("returns a not-found message from schedule_remove when sink resolves null", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_remove").execute({ id: "missing" });
    expect(result.success).toBe(false);
    expect(result.output).toBe('Schedule "missing" not found.');
  });

  it("forwards id + tail to schedule_read_log and returns the body", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    const calls: Array<{ method: string; id: string; tail?: number }> = [];
    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async (id, tail) => {
        calls.push({ method: "readLog", id, tail });
        return `log for ${id} tail=${tail}`;
      },
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const explicit = await getTool("schedule_read_log").execute({ id: "daily-scan", tail: 25 });
    expect(explicit.success).toBe(true);
    expect(explicit.output).toBe("log for daily-scan tail=25");

    // No tail argument → tool defaults to 50.
    const defaulted = await getTool("schedule_read_log").execute({ id: "daily-scan" });
    expect(defaulted.success).toBe(true);
    expect(defaulted.output).toBe("log for daily-scan tail=50");

    expect(calls).toEqual([
      { method: "readLog", id: "daily-scan", tail: 25 },
      { method: "readLog", id: "daily-scan", tail: 50 },
    ]);
  });

  it("reports daemon status (migrated from tools.test.ts)", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: true, pid: 4321 }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_daemon_status").execute({});
    expect(result.success).toBe(true);
    expect(result.output).toContain("Daemon status: running");
    expect(result.output).toContain("4321");
  });

  it("formats daemon start output for a fresh start (migrated from tools.test.ts)", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 5555 }, pid: 5555, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_daemon_start").execute({});
    expect(result.success).toBe(true);
    expect(result.output).toBe("Schedule daemon started (pid 5555).");
  });

  it("formats daemon start output when already running (migrated from tools.test.ts)", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 7777 }, pid: 7777, alreadyRunning: true }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_daemon_start").execute({});
    expect(result.success).toBe(true);
    expect(result.output).toBe("Schedule daemon already running (pid 7777).");
  });

  it("formats daemon stop output (migrated from tools.test.ts)", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 8888, wasRunning: true }),
    });

    const result = await getTool("schedule_daemon_stop").execute({});
    expect(result.success).toBe(true);
    expect(result.output).toBe("Schedule daemon stopped (pid 8888).");
  });

  it("treats setScheduleSink(null) as 'unbound again' after a previous bind", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => [],
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: true, pid: 1 }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });
    setScheduleSink(null);

    const result = await getTool("schedule_daemon_status").execute({});
    expect(result.success).toBe(false);
    expect(result.output ?? "").toMatch(/schedule manager is not active/i);
  });

  it("surfaces sink rejections as the standard 'Failed to <op>' shape", async () => {
    await bootstrapPlugins([createNativePluginModule(scheduleToolsPlugin)]);

    setScheduleSink({
      create: async () => ({
        schedule: makeStoredSchedule(),
        daemonStatus: { running: false, pid: null },
        startedPid: null,
      }),
      list: async () => {
        throw new Error("disk on fire");
      },
      remove: async () => null,
      readLog: async () => "",
      getDaemonStatus: async () => ({ running: false, pid: null }),
      startDaemon: async () => ({ status: { running: true, pid: 1 }, pid: 1, alreadyRunning: false }),
      stopDaemon: async () => ({ status: { running: false, pid: null }, pid: 1, wasRunning: true }),
    });

    const result = await getTool("schedule_list").execute({});
    expect(result.success).toBe(false);
    expect(result.output).toBe("Failed to list schedules: disk on fire");
  });
});
