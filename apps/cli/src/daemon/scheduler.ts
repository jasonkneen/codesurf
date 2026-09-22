import {
  cronMatchesDate,
  getScheduleDaemonStatus,
  getScheduleRunLogPath,
  removeScheduleDaemonPid,
  type ScheduleDaemonStatus,
  ScheduleManager,
  type StoredSchedule,
  startDetachedHeadlessRun,
  writeScheduleDaemonPid,
} from "../tools/schedule";

export class SchedulerDaemon {
  private readonly schedules = new ScheduleManager();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  /** The in-flight tick, so stop() can join it instead of racing its awaits. */
  private activeTick: Promise<void> | null = null;
  private signalHandlersInstalled = false;

  async start(): Promise<void> {
    const status = await getScheduleDaemonStatus();
    if (status.running && status.pid !== process.pid) {
      throw new Error(`Schedule daemon is already running (pid ${status.pid}).`);
    }

    await writeScheduleDaemonPid(process.pid);
    this.installSignalHandlers();

    const allSchedules = await this.schedules.list();
    const recurringCount = allSchedules.filter((schedule) => schedule.enabled && schedule.cron).length;
    console.error(`Schedule daemon started (pid ${process.pid}). Watching ${recurringCount} recurring schedule(s).`);

    await this.runTick();
    // stop() may have completed while the initial tick was awaiting its
    // schedule listing. Installing the interval now would keep a "stopped"
    // daemon alive (and dispatching) after its PID record was removed.
    if (this.shuttingDown) return;
    this.tickTimer = setInterval(() => {
      void this.runTick();
    }, 60_000);
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    // Join the tick in flight so no dispatch is left racing past shutdown;
    // the tick itself re-checks `shuttingDown` after every await.
    if (this.activeTick) {
      await this.activeTick;
    }

    await removeScheduleDaemonPid();
  }

  async getStatus(): Promise<ScheduleDaemonStatus> {
    return getScheduleDaemonStatus();
  }

  private installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    const shutdown = (signal: NodeJS.Signals) => {
      console.error(`Schedule daemon stopping (${signal}).`);
      void this.stop().finally(() => {
        process.exit(0);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  private runTick(): Promise<void> {
    if (this.activeTick || this.shuttingDown) return this.activeTick ?? Promise.resolve();
    const tick = this.tick().finally(() => {
      if (this.activeTick === tick) this.activeTick = null;
    });
    this.activeTick = tick;
    return tick;
  }

  private async tick(): Promise<void> {
    try {
      const now = new Date();
      const schedules = await this.schedules.list();

      for (const schedule of schedules) {
        // Re-check ownership after every await and before dispatching: a
        // stop() that completed while the listing was pending must not be
        // followed by a detached launch.
        if (this.shuttingDown) return;
        if (!shouldRunScheduleNow(schedule, now)) {
          continue;
        }

        try {
          const pid = await startDetachedHeadlessRun({
            instruction: schedule.instruction,
            directory: schedule.directory,
            model: schedule.model,
            maxToolRounds: schedule.maxToolRounds,
            sandboxMode: schedule.sandboxMode,
            sandboxSettings: schedule.sandboxSettings,
            logPath: getScheduleRunLogPath(schedule.id),
          });

          await this.schedules.touchLastRunAt(schedule.id, now);
          const pidText = pid ? ` (pid ${pid})` : "";
          console.error(`Fired schedule ${schedule.id}${pidText}.`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Schedule ${schedule.id} failed: ${msg}`);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Schedule daemon tick failed: ${message}`);
    }
  }
}

function shouldRunScheduleNow(schedule: StoredSchedule, now: Date): boolean {
  if (!schedule.enabled || !schedule.cron) {
    return false;
  }
  if (!cronMatchesDate(schedule.cron, now)) {
    return false;
  }
  if (!schedule.lastRunAt) {
    return true;
  }

  const last = new Date(schedule.lastRunAt);
  if (Number.isNaN(last.getTime())) {
    return true;
  }

  return !isSameMinute(last, now);
}

function isSameMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}
