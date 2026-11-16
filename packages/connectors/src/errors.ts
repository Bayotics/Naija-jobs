/**
 * Failure classification.
 *
 * The single question the runner asks is "would running this again plausibly
 * succeed?". Getting it wrong is expensive in both directions: retrying a
 * malformed configuration twenty times wastes a run and hammers a source, while
 * not retrying a 503 loses a whole crawl to a momentary blip.
 */

export type FailureKind =
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'not_permitted'
  | 'configuration'
  | 'parse'
  | 'unknown';

export abstract class ConnectorError extends Error {
  abstract readonly kind: FailureKind;
  abstract readonly retryable: boolean;
  /** Seconds to wait before the next attempt, when the source told us. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** DNS failure, connection refused, socket reset. Always worth retrying. */
export class NetworkError extends ConnectorError {
  override readonly name = 'NetworkError';
  readonly kind = 'network' as const;
  readonly retryable = true;
}

export class TimeoutError extends ConnectorError {
  override readonly name = 'TimeoutError';
  readonly kind = 'timeout' as const;
  readonly retryable = true;
}

/** 429, or a source-specific quota signal. Honour `Retry-After` when present. */
export class RateLimitError extends ConnectorError {
  override readonly name = 'RateLimitError';
  readonly kind = 'rate_limited' as const;
  readonly retryable = true;

  constructor(
    message: string,
    override readonly retryAfterSeconds?: number,
    context: Record<string, unknown> = {},
  ) {
    super(message, context);
  }
}

/** 5xx. The source is broken, not us. */
export class ServerError extends ConnectorError {
  override readonly name = 'ServerError';
  readonly kind = 'server_error' as const;
  readonly retryable = true;

  constructor(
    readonly status: number,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message, context);
  }
}

/**
 * 4xx other than 429. Our request is wrong; repeating it unchanged cannot help
 * and only adds load to a source that already rejected us.
 */
export class ClientError extends ConnectorError {
  override readonly name = 'ClientError';
  readonly kind = 'client_error' as const;
  readonly retryable = false;

  constructor(
    readonly status: number,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message, context);
  }
}

/**
 * robots.txt disallows the path, or the source is registered as `restricted`.
 * Never retryable — retrying is precisely the wrong response to "you may not".
 */
export class NotPermittedError extends ConnectorError {
  override readonly name = 'NotPermittedError';
  readonly kind = 'not_permitted' as const;
  readonly retryable = false;
}

/** Bad source config. A deterministic failure that a retry cannot fix. */
export class ConfigurationError extends ConnectorError {
  override readonly name = 'ConnectorConfigurationError';
  readonly kind = 'configuration' as const;
  readonly retryable = false;
}

/** The response arrived but could not be understood. Usually a layout change. */
export class ParseError extends ConnectorError {
  override readonly name = 'ParseError';
  readonly kind = 'parse' as const;
  readonly retryable = false;
}

/**
 * Maps an arbitrary thrown value onto the taxonomy.
 * Unknown failures default to **non**-retryable: retrying something we do not
 * understand is how a bug becomes a denial-of-service against a source.
 */
export function classifyError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error.name === 'AbortError' || code === 'ABORT_ERR') {
      return new TimeoutError(`Request aborted: ${error.message}`);
    }
    if (
      code &&
      ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH'].includes(code)
    ) {
      return new NetworkError(`Network failure (${code}): ${error.message}`, { code });
    }
    // `fetch` wraps transport failures in a generic TypeError.
    if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) {
      const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
      return new NetworkError(`Fetch failed: ${cause?.code ?? error.message}`, {
        cause: cause?.code ?? null,
      });
    }
    return new UnknownError(error.message);
  }

  return new UnknownError(String(error));
}

export class UnknownError extends ConnectorError {
  override readonly name = 'UnknownConnectorError';
  readonly kind = 'unknown' as const;
  readonly retryable = false;
}

/** HTTP status → typed error, so status handling lives in exactly one place. */
export function errorFromStatus(
  status: number,
  url: string,
  retryAfterSeconds?: number,
): ConnectorError {
  if (status === 429) {
    return new RateLimitError(`Rate limited by ${url}`, retryAfterSeconds, { status, url });
  }
  if (status === 403 || status === 401) {
    return new NotPermittedError(
      `Access denied (${status}) for ${url}. The source requires authentication or forbids automated access.`,
      { status, url },
    );
  }
  if (status >= 500) {
    return new ServerError(status, `Source returned ${status} for ${url}`, { status, url });
  }
  return new ClientError(status, `Request rejected with ${status} for ${url}`, { status, url });
}
