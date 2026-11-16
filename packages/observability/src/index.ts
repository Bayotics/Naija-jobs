/**
 * @job-intel/observability
 *
 * Structured logging and the typed system-event stream. Application code
 * depends on the `Logger` / `EventSink` ports, never on a concrete transport,
 * so production observability tooling is a swap rather than a refactor.
 */
export * from './logger';
export * from './events';
