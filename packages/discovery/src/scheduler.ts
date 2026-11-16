import parser from 'cron-parser';
import type { SourceRepository } from '@job-intel/db';
import type { Logger } from '@job-intel/observability';
import type { RunResult, SourceRunner } from './source-runner';

/**
 * Scheduling foundation.
 *
 * Schedules are **data**: each source carries its own cron expression, so
 * "every 15 minutes" for a cheap ATS feed and "daily" for an expensive one
 * coexist without a line of code. Nothing here assumes a global cadence.
 *
 * This is a tick-driven reconciler rather than a long-lived cron daemon: the
 * worker calls `tick()` on an interval, and the scheduler decides what is due.
 * That keeps it testable with a clock rather than with real time, and makes it
 * straightforward to hand over to BullMQ's repeatable jobs later without
 * changing how sources express their schedule.
 */

export interface ScheduleDecision {
  sourceId: string;
  dueAt: Date;
  reason: 'never_run' | 'due' | 'not_due' | 'disabled' | 'circuit_open' | 'invalid_cron';
  shouldRun: boolean;
  detail?: string;
}

export interface SchedulerOptions {
  /** Randomised offset so sources do not all fire on the hour together. */
  jitterSeconds?: number;
  /** Cap on sources started per tick, to bound load. */
  maxConcurrentSources?: number;
  now?: () => Date;
  random?: () => number;
}

/** Human-friendly presets. Any valid 5-field cron is accepted too. */
export const SCHEDULE_PRESETS: Readonly<Record<string, string>> = {
  every_15_minutes: '*/15 * * * *',
  every_30_minutes: '*/30 * * * *',
  hourly: '0 * * * *',
  every_6_hours: '0 */6 * * *',
  every_12_hours: '0 */12 * * *',
  daily: '0 6 * * *',
  weekly: '0 6 * * 1',
};

export function resolveSchedule(expression: string): string {
  return SCHEDULE_PRESETS[expression] ?? expression;
}

/** Validates a cron expression without throwing. */
export function isValidCron(expression: string): boolean {
  try {
    parser.parseExpression(resolveSchedule(expression));
    return true;
  } catch {
    return false;
  }
}

/** Next fire time strictly after `from`, or null when the expression is invalid. */
export function nextRunAt(expression: string, from: Date): Date | null {
  try {
    return parser.parseExpression(resolveSchedule(expression), { currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

export class SourceScheduler {
  private readonly jitterSeconds: number;
  private readonly maxConcurrentSources: number;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(
    private readonly deps: { sources: SourceRepository; runner: SourceRunner; logger: Logger },
    options: SchedulerOptions = {},
  ) {
    this.jitterSeconds = options.jitterSeconds ?? 60;
    this.maxConcurrentSources = options.maxConcurrentSources ?? 3;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  /**
   * Decides what is due, without running anything.
   * Exposed separately so the dashboard can show the schedule and so the
   * decision logic is testable against a fixed clock.
   */
  async plan(): Promise<ScheduleDecision[]> {
    const sources = await this.deps.sources.list({ includeArchived: false });
    const now = this.now();

    return sources.map((source): ScheduleDecision => {
      if (!source.enabled) {
        return { sourceId: source.id, dueAt: now, reason: 'disabled', shouldRun: false };
      }
      // An open circuit means the source is failing; scheduling must skip it
      // entirely rather than keep hammering a source that is already down.
      if (source.circuitState === 'open') {
        return {
          sourceId: source.id,
          dueAt: now,
          reason: 'circuit_open',
          shouldRun: false,
          detail: source.lastErrorMessage ?? 'circuit breaker is open',
        };
      }
      if (!isValidCron(source.scheduleCron)) {
        return {
          sourceId: source.id,
          dueAt: now,
          reason: 'invalid_cron',
          shouldRun: false,
          detail: `"${source.scheduleCron}" is not a valid cron expression`,
        };
      }

      const lastRun = source.lastAttemptedRunAt;
      if (!lastRun) {
        return { sourceId: source.id, dueAt: now, reason: 'never_run', shouldRun: true };
      }

      const due = nextRunAt(source.scheduleCron, lastRun);
      if (!due) {
        return { sourceId: source.id, dueAt: now, reason: 'invalid_cron', shouldRun: false };
      }

      // Jitter is applied to the *threshold*, not the stored schedule, so a
      // source's cadence stays predictable while start times spread out.
      const jitterMs = Math.floor(this.random() * this.jitterSeconds * 1_000);
      const shouldRun = now.getTime() >= due.getTime() + jitterMs;

      return {
        sourceId: source.id,
        dueAt: due,
        reason: shouldRun ? 'due' : 'not_due',
        shouldRun,
      };
    });
  }

  /**
   * Runs everything currently due, bounded by `maxConcurrentSources`.
   * Failures are already contained by the runner, so one bad source cannot
   * prevent the rest of the tick.
   */
  async tick(): Promise<{ planned: ScheduleDecision[]; results: RunResult[] }> {
    const planned = await this.plan();
    const due = planned.filter((d) => d.shouldRun).slice(0, this.maxConcurrentSources);

    if (due.length === 0) {
      this.deps.logger.debug('Scheduler tick: nothing due', { evaluated: planned.length });
      return { planned, results: [] };
    }

    this.deps.logger.info('Scheduler tick: running due sources', {
      due: due.map((d) => d.sourceId),
      evaluated: planned.length,
    });

    const results = await this.deps.runner.runMany(
      due.map((d) => d.sourceId),
      { trigger: 'schedule' },
    );
    return { planned, results };
  }
}
