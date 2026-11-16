import pino, { type Logger as PinoLogger } from 'pino';
import type { LogLevel } from '@job-intel/contracts';

/**
 * The logging port.
 *
 * Application code depends on this interface, never on pino directly, so the
 * transport can be swapped (Axiom, Better Stack, OTel) without touching call
 * sites — and tests can assert on what was logged.
 */
export interface Logger {
  trace(message: string, data?: LogData): void;
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, data?: LogData): void;
  fatal(message: string, data?: LogData): void;
  /** Returns a logger with permanently bound context (traceId, sourceId, …). */
  child(bindings: LogData): Logger;
}

export type LogData = Record<string, unknown> & {
  err?: unknown;
  traceId?: string;
  sourceId?: string;
  jobId?: string;
  runId?: string;
};

/**
 * Keys whose values are never written to logs, at any level.
 * Redaction is enforced here rather than left to discipline at call sites.
 */
const REDACTED_KEYS = [
  'password',
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  'connectionString',
  'DATABASE_URL',
  'REDIS_URL',
];

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  base?: LogData;
}

class PinoLoggerAdapter implements Logger {
  constructor(private readonly logger: PinoLogger) {}

  trace(message: string, data?: LogData): void {
    this.logger.trace(data ?? {}, message);
  }
  debug(message: string, data?: LogData): void {
    this.logger.debug(data ?? {}, message);
  }
  info(message: string, data?: LogData): void {
    this.logger.info(data ?? {}, message);
  }
  warn(message: string, data?: LogData): void {
    this.logger.warn(data ?? {}, message);
  }
  error(message: string, data?: LogData): void {
    this.logger.error(normalizeError(data), message);
  }
  fatal(message: string, data?: LogData): void {
    this.logger.fatal(normalizeError(data), message);
  }
  child(bindings: LogData): Logger {
    return new PinoLoggerAdapter(this.logger.child(bindings));
  }
}

/** Errors do not JSON-serialize usefully; unwrap them before they reach the transport. */
function normalizeError(data?: LogData): Record<string, unknown> {
  if (!data?.err) return data ?? {};
  const { err, ...rest } = data;
  if (err instanceof Error) {
    return {
      ...rest,
      err: { name: err.name, message: err.message, stack: err.stack },
    };
  }
  return { ...rest, err: String(err) };
}

/**
 * Whether a worker-thread log transport can survive here.
 *
 * `pino-pretty` is loaded as a *transport*, which means thread-stream spawns a
 * worker thread and resolves the module by path at run time. A bundler defeats
 * that: Next rewrites the module into `.next/server/vendor-chunks/…`, the
 * worker cannot resolve its own entry point, and the failure surfaces as
 * `Cannot find module …/lib/worker.js` followed by `the worker thread exited` —
 * repeatedly, on every render, with nothing in the message connecting it to
 * logging.
 *
 * The worker process is unbundled and unaffected, so pretty logs stay where
 * they are actually read. Inside Next the same output goes to the dev console
 * as JSON, which is the correct trade for a category of error that is nearly
 * undiagnosable from its symptoms.
 */
function supportsWorkerTransport(): boolean {
  return process.env['NEXT_RUNTIME'] === undefined;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { level = 'info', pretty = false, base = {} } = options;

  const usePretty = pretty && supportsWorkerTransport();

  const logger = pino({
    level,
    base,
    redact: { paths: REDACTED_KEYS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    ...(usePretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  });

  return new PinoLoggerAdapter(logger);
}

export interface CapturedLog {
  level: LogLevel;
  message: string;
  data: LogData;
}

/** In-memory logger for tests. Captures instead of writing. */
export class MemoryLogger implements Logger {
  readonly records: CapturedLog[] = [];

  constructor(private readonly bindings: LogData = {}) {}

  private push(level: LogLevel, message: string, data?: LogData): void {
    this.records.push({ level, message, data: { ...this.bindings, ...data } });
  }

  trace(m: string, d?: LogData): void {
    this.push('trace', m, d);
  }
  debug(m: string, d?: LogData): void {
    this.push('debug', m, d);
  }
  info(m: string, d?: LogData): void {
    this.push('info', m, d);
  }
  warn(m: string, d?: LogData): void {
    this.push('warn', m, d);
  }
  error(m: string, d?: LogData): void {
    this.push('error', m, d);
  }
  fatal(m: string, d?: LogData): void {
    this.push('fatal', m, d);
  }

  child(bindings: LogData): Logger {
    const child = new MemoryLogger({ ...this.bindings, ...bindings });
    // Share the buffer so assertions can inspect the whole tree from the root.
    Object.defineProperty(child, 'records', { value: this.records });
    return child;
  }
}
