// Kernel-owned Schedule bridge tools.
//
// Phase 2 step 6 of the kernel-extensibility plan: takes the seven schedule
// tools (`schedule_create`, `schedule_list`, `schedule_remove`,
// `schedule_read_log`, `schedule_daemon_status`, `schedule_daemon_start`,
// `schedule_daemon_stop`) out of the `if (mode === "agent") { if
// (options.scheduleManager) {...} }` block in `createTools()` (in
// `src/grok/tools.ts`) and into a kernel extension that owns the full ai-sdk
// `tool({...})` defs. Replaces the metadata-only `scheduleToolsExtension`
// that previously lived in `./groups.ts` (now removed in this same step).
//
// Host coupling:
//
//   - `src/agent/agent.ts` binds the sink at Agent construction via
//     `setScheduleSink(this.schedules)` (the `ScheduleManager` instance
//     structurally satisfies `ScheduleSink`). When the sink is unbound (e.g.
//     headless boot before an Agent is constructed, or after
//     `shutdownPlugins()`) each `services.schedule.*` proxy throws
//     `"Schedule manager is not active. An Agent must be constructed and the
//     sink bound."` — the tool's existing try/catch wrapper turns the throw
//     into a standard `{ success: false, output: "Failed to <op>: ..." }`
//     ToolResult.
//
//   - All 7 tools were registered only in agent mode by `createTools()`
//     (gated by `if (mode === "agent")`). The kernel-owned versions use
//     `modes: ["agent"]` so the kernel mode filter (`setKernelMode`) drops
//     them at ToolSet build time in plan/ask. The formatter helpers
//     `formatScheduleList` and `formatDaemonReminder` (previously private to
//     `tools.ts`) moved into this file because they're only used by these
//     tools.
//
// Group: keeps the `"schedule"` group string the metadata-only extension
// used so user toggles via `services.tools.setEnabled(...)` and `/extensions`
// filters continue to work unchanged.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";
import type { ScheduleDaemonStatus, StoredSchedule } from "../../../tools/schedule";

const manifest: PluginManifest = {
  id: "builtin.tools.schedule",
  name: "Scheduled Tasks",
  version: "1.0.0",
  description: "Create and manage cron-style scheduled agent runs.",
  enabledByDefault: true,
  capabilities: ["tools"],
};

export const scheduleToolsPlugin: CodesurfPlugin = {
  name: "codesurf-schedule-tools",
  manifest,
  inject: ["contributions", "tools", "schedule"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "schedule_create",
        description: "Create a scheduled task.",
        group: "schedule",
        modes: ["agent"],
        tool: tool({
          description:
            "Create a recurring or one-time scheduled headless Grok run. Provide a name, the instruction to run, and a cron expression for recurring schedules. Omit cron for an immediate one-time run.",
          inputSchema: z.object({
            name: z.string().describe("Human-readable schedule name"),
            instruction: z.string().describe("The prompt/instruction Grok should run headlessly"),
            cron: z.string().optional().describe("Cron expression for recurring schedules, such as '0 9 * * 1-5'"),
            model: z.string().optional().describe("Optional model override; defaults to the current selected model"),
            directory: z.string().optional().describe("Optional working directory; defaults to the current directory"),
            max_tool_rounds: z.number().int().positive().optional().describe("Optional max tool rounds override"),
          }),
          // A schedule runs an unattended agent later (and on a cron, again and
          // again) with whatever instruction the model wrote, so a person
          // confirms it first.
          needsApproval: true,
          execute: ctx.tools.wrapExecute<{
            name: string;
            instruction: string;
            cron?: string;
            model?: string;
            directory?: string;
            max_tool_rounds?: number;
          }>("schedule_create", async ({ name, instruction, cron, model, directory, max_tool_rounds }) =>
            ctx.tools.safeExecute({
              label: "create schedule",
              fn: async () => {
                const result = await ctx.schedule.create({
                  name,
                  instruction,
                  cron,
                  model,
                  directory,
                  maxToolRounds: max_tool_rounds,
                });

                const lines = [
                  `Schedule created: ${result.schedule.name}`,
                  `ID: ${result.schedule.id}`,
                  `Type: ${result.schedule.cron ? "recurring" : "one-time"}`,
                  `Model: ${result.schedule.model}`,
                  `Directory: ${result.schedule.directory}`,
                ];
                if (result.schedule.cron) {
                  lines.push(`Cron: ${result.schedule.cron}`);
                  lines.push(formatDaemonReminder(result.daemonStatus));
                } else {
                  lines.push(`Run started in background${result.startedPid ? ` (pid ${result.startedPid})` : ""}.`);
                }

                return { success: true, output: lines.join("\n") };
              },
            }),
          ),
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "schedule_list",
        description: "List scheduled tasks.",
        group: "schedule",
        modes: ["agent"],
        tool: tool({
          description:
            "List all saved schedules, including one-time and recurring runs, along with daemon status and last run time.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              const [items, daemonStatus] = await Promise.all([ctx.schedule.list(), ctx.schedule.getDaemonStatus()]);
              if (items.length === 0) {
                return {
                  success: true,
                  output: `No schedules found.\n${formatDaemonReminder(daemonStatus)}`,
                };
              }

              return {
                success: true,
                output: formatScheduleList(items, daemonStatus),
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { success: false, output: `Failed to list schedules: ${msg}` };
            }
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "schedule_remove",
        description: "Remove a scheduled task.",
        group: "schedule",
        modes: ["agent"],
        tool: tool({
          description: "Remove a saved schedule and its run logs by schedule id.",
          inputSchema: z.object({
            id: z.string().describe("Schedule id, such as 'daily-security-scan'"),
          }),
          execute: async ({ id }) => {
            try {
              const removed = await ctx.schedule.remove(id);
              if (!removed) {
                return { success: false, output: `Schedule "${id}" not found.` };
              }
              return {
                success: true,
                output: `Removed schedule "${removed.name}" (${removed.id}).`,
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { success: false, output: `Failed to remove schedule: ${msg}` };
            }
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "schedule_read_log",
        description: "Read a scheduled task's log.",
        group: "schedule",
        modes: ["agent"],
        tool: tool({
          description: "Read recent log output from a saved schedule.",
          inputSchema: z.object({
            id: z.string().describe("Schedule id, such as 'daily-security-scan'"),
            tail: z.number().int().positive().optional().describe("Number of log lines to return from the end"),
          }),
          execute: async ({ id, tail }) => {
            try {
              return {
                success: true,
                output: await ctx.schedule.readLog(id, tail ?? 50),
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { success: false, output: `Failed to read schedule log: ${msg}` };
            }
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "schedule_daemon_status",
        description: "Check schedule daemon status.",
        group: "schedule",
        modes: ["agent"],
        tool: tool({
          description: "Check whether the schedule daemon is currently running.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              const status = await ctx.schedule.getDaemonStatus();
              return {
                success: true,
                output: formatDaemonReminder(status),
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { success: false, output: `Failed to get schedule daemon status: ${msg}` };
            }
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "schedule_daemon_start",
        description: "Start the schedule daemon.",
        group: "schedule",
        modes: ["agent"],
        tool: tool({
          description:
            "Start the schedule daemon in the background so recurring schedules can run even after the TUI closes.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              const result = await ctx.schedule.startDaemon();
              return {
                success: true,
                output: result.alreadyRunning
                  ? `Schedule daemon already running${result.status.pid ? ` (pid ${result.status.pid})` : ""}.`
                  : `Schedule daemon started${result.pid ? ` (pid ${result.pid})` : ""}.`,
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { success: false, output: `Failed to start schedule daemon: ${msg}` };
            }
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "schedule_daemon_stop",
        description: "Stop the schedule daemon.",
        group: "schedule",
        modes: ["agent"],
        tool: tool({
          description: "Stop the background schedule daemon.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              const result = await ctx.schedule.stopDaemon();
              return {
                success: true,
                output: result.wasRunning
                  ? `Schedule daemon stopped${result.pid ? ` (pid ${result.pid})` : ""}.`
                  : "Schedule daemon is not running.",
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { success: false, output: `Failed to stop schedule daemon: ${msg}` };
            }
          },
        }),
      }),
    );
  },
};

function formatScheduleList(schedules: StoredSchedule[], daemonStatus: ScheduleDaemonStatus): string {
  const lines = [
    `Daemon: ${daemonStatus.running ? `running${daemonStatus.pid ? ` (pid ${daemonStatus.pid})` : ""}` : "not running"}`,
  ];

  for (const schedule of schedules) {
    const scheduleType = schedule.cron ? "recurring" : "one-time";
    lines.push("");
    lines.push(`- ${schedule.name} (\`${schedule.id}\`)`);
    lines.push(`  type: ${scheduleType}`);
    if (schedule.cron) {
      lines.push(`  cron: ${schedule.cron}`);
      lines.push(`  enabled: ${schedule.enabled ? "yes" : "no"}`);
    }
    lines.push(`  model: ${schedule.model}`);
    lines.push(`  directory: ${schedule.directory}`);
    lines.push(`  last run: ${schedule.lastRunAt ?? "never"}`);
  }

  if (!daemonStatus.running) {
    lines.push("");
    lines.push("Start `grok daemon` to run recurring schedules.");
  }

  return lines.join("\n");
}

function formatDaemonReminder(status: ScheduleDaemonStatus): string {
  if (status.running) {
    return `Daemon status: running${status.pid ? ` (pid ${status.pid})` : ""}.`;
  }
  return "Daemon status: not running. Use `schedule_daemon_start` (or `grok daemon`) to run recurring schedules.";
}
