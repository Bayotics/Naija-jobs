/**
 * Domain errors.
 *
 * Distinguishing these from unexpected exceptions is what lets the pipeline
 * decide whether to retry, dead-letter, or skip — see the retry matrix in the
 * architecture document.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;
  /** Whether re-running the identical operation could plausibly succeed. */
  abstract readonly retryable: boolean;
}

/** Input failed schema or business-rule validation. Never retryable. */
export class ValidationError extends DomainError {
  override readonly name = 'ValidationError';
  readonly code = 'VALIDATION_ERROR';
  readonly retryable = false;

  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

/** A requested entity does not exist. */
export class NotFoundError extends DomainError {
  override readonly name = 'NotFoundError';
  readonly code = 'NOT_FOUND';
  readonly retryable = false;

  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
  }
}

/** A source could not be reached or returned an error. Usually retryable. */
export class SourceUnavailableError extends DomainError {
  override readonly name = 'SourceUnavailableError';
  readonly code = 'SOURCE_UNAVAILABLE';

  constructor(
    readonly sourceId: string,
    message: string,
    readonly retryable = true,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Source ${sourceId} unavailable: ${message}`);
  }
}

/**
 * Access is prohibited by the source's terms or robots policy.
 * Never retryable — retrying is precisely the wrong response.
 */
export class AccessNotPermittedError extends DomainError {
  override readonly name = 'AccessNotPermittedError';
  readonly code = 'ACCESS_NOT_PERMITTED';
  readonly retryable = false;

  constructor(
    readonly sourceId: string,
    readonly reason: string,
  ) {
    super(`Access not permitted for ${sourceId}: ${reason}`);
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof DomainError ? error.retryable : false;
}
