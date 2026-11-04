import type { Clock } from '../core/clock.js';
import type { AgentId } from '../core/types.js';
import type { DecisionLog } from '../observability/decision-log.js';
import type { Logger } from '../observability/logger.js';

/**
 * Scheduler.
 *
 * A plain interval runner with one property that matters more than anything
 * else it does: a job never overlaps itself. A five-minute scan that takes six
 * minutes must not have two copies competing over the same tokens, the same
 * rate limits and the same cash.
 *
 * Each job carries its own lock, so a slow agent delays only itself.
 */
export interface JobDefinition {
  name: string;
  /** Re-read every tick, so an interval change in config takes effect live. */
  intervalMs: () => number;
  enabled: () => boolean;
  run: () => Promise<void>;
  /** Run once at start rather than waiting out the first interval. */
  runOnStart?: boolean;
}

export interface JobStatus {
  name: string;
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  runCount: number;
  skippedCount: number;
}

interface JobState {
  definition: JobDefinition;
  running: boolean;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  nextRunAt: number;
  lastError: string | null;
  runCount: number;
  skippedCount: number;
}

export class Scheduler {
  private readonly jobs = new Map<string, JobState>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Resolves once every in-flight job has finished. Used by shutdown. */
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly log: DecisionLog,
    /** How often the scheduler wakes to see what is due. */
    private readonly tickMs = 1_000,
  ) {}

  register(definition: JobDefinition): void {
    this.jobs.set(definition.name, {
      definition,
      running: false,
      lastRunAt: null,
      lastDurationMs: null,
      nextRunAt: definition.runOnStart ? this.clock.now() : this.clock.now() + definition.intervalMs(),
      lastError: null,
      runCount: 0,
      skippedCount: 0,
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // Do not hold the process open just for the scheduler.
    this.timer.unref?.();
    this.log.record({ category: 'scheduler', message: `Scheduler started with ${this.jobs.size} jobs.` });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let anything mid-flight finish rather than tearing it down halfway
    // through a database transaction.
    await Promise.allSettled([...this.inFlight]);
    this.log.record({ category: 'scheduler', message: 'Scheduler stopped.' });
  }

  async tick(now = this.clock.now()): Promise<void> {
    if (this.stopped) return;
    for (const state of this.jobs.values()) {
      if (!state.definition.enabled()) continue;
      if (now < state.nextRunAt) continue;

      if (state.running) {
        // The overlap guard. The run is skipped, not queued: a queue of stale
        // scans is worse than missing one.
        state.skippedCount += 1;
        state.nextRunAt = now + state.definition.intervalMs();
        this.logger.warn(
          { job: state.definition.name, skipped: state.skippedCount },
          'previous run still in flight, skipping this interval',
        );
        continue;
      }

      const promise = this.runJob(state, now);
      this.inFlight.add(promise);
      void promise.finally(() => this.inFlight.delete(promise));
    }
  }

  private async runJob(state: JobState, now: number): Promise<void> {
    state.running = true;
    state.lastRunAt = now;
    const started = this.clock.now();
    try {
      await state.definition.run();
      state.lastError = null;
      state.runCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastError = message;
      this.log.record({
        level: 'error',
        category: 'scheduler',
        message: `Job ${state.definition.name} failed: ${message}`,
      });
    } finally {
      state.running = false;
      state.lastDurationMs = this.clock.now() - started;
      // Interval is measured from the end of a run, so a long run does not
      // immediately trigger the next one.
      state.nextRunAt = this.clock.now() + state.definition.intervalMs();
    }
  }

  /** Run one job now, outside its schedule. Still respects the lock. */
  async runNow(name: string): Promise<{ ok: boolean; message: string }> {
    const state = this.jobs.get(name);
    if (!state) return { ok: false, message: `No job named ${name}.` };
    if (state.running) return { ok: false, message: `${name} is already running.` };
    await this.runJob(state, this.clock.now());
    return { ok: true, message: state.lastError ? `${name} failed: ${state.lastError}` : `${name} finished.` };
  }

  status(): JobStatus[] {
    return [...this.jobs.values()].map((s) => ({
      name: s.definition.name,
      enabled: s.definition.enabled(),
      running: s.running,
      intervalMs: s.definition.intervalMs(),
      lastRunAt: s.lastRunAt,
      lastDurationMs: s.lastDurationMs,
      nextRunAt: s.definition.enabled() ? s.nextRunAt : null,
      lastError: s.lastError,
      runCount: s.runCount,
      skippedCount: s.skippedCount,
    }));
  }

  isRunning(name: AgentId | string): boolean {
    return this.jobs.get(name)?.running ?? false;
  }
}
