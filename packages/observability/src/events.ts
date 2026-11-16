import {
  systemEventSchema,
  type SystemEventInput,
  type SystemEventName,
  type SystemEventSeverity,
} from '@job-intel/contracts';
import type { Logger, LogData } from './logger';

/**
 * Durable sink for system events. Implemented by `@job-intel/db` against the
 * `system_events` table; kept as a port so this package stays storage-free and
 * events still work (log-only) before a database exists.
 */
export interface EventSink {
  record(event: SystemEventInput): Promise<void>;
}

/**
 * Emits a typed system event to both the log stream and the durable sink.
 *
 * Two destinations on purpose: logs are for debugging a moment, the events
 * table is for answering "what happened to this job" weeks later, which is what
 * the observability requirements actually ask for.
 */
export class EventRecorder {
  constructor(
    private readonly logger: Logger,
    private readonly sink: EventSink | null = null,
  ) {}

  async emit(
    name: SystemEventName,
    options: {
      message?: string;
      severity?: SystemEventSeverity;
      traceId?: string;
      sourceId?: string;
      jobId?: string;
      runId?: string;
      data?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const event = systemEventSchema.parse({
      name,
      severity: options.severity ?? 'info',
      message: options.message ?? null,
      traceId: options.traceId ?? null,
      sourceId: options.sourceId ?? null,
      jobId: options.jobId ?? null,
      runId: options.runId ?? null,
      data: options.data ?? {},
    });

    const logData: LogData = {
      event: event.name,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.sourceId ? { sourceId: event.sourceId } : {}),
      ...(event.jobId ? { jobId: event.jobId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      ...event.data,
    };

    const line = event.message ?? event.name;
    if (event.severity === 'error') this.logger.error(line, logData);
    else if (event.severity === 'warn') this.logger.warn(line, logData);
    else this.logger.info(line, logData);

    if (!this.sink) return;
    try {
      await this.sink.record(event);
    } catch (err) {
      // An observability failure must never take down the operation it observes.
      this.logger.error('Failed to persist system event', { err, event: event.name });
    }
  }

  child(sink: EventSink): EventRecorder {
    return new EventRecorder(this.logger, sink);
  }
}

/** Collects events in memory for assertions. */
export class MemoryEventSink implements EventSink {
  readonly events: SystemEventInput[] = [];

  record(event: SystemEventInput): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  byName(name: SystemEventName): SystemEventInput[] {
    return this.events.filter((e) => e.name === name);
  }
}
