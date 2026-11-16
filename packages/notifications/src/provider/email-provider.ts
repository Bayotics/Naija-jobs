import type {
  DeliveryEvent,
  EmailSendResult,
  RenderedEmail,
} from '@job-intel/contracts';

/**
 * Email provider port.
 *
 * The notification system depends on this interface and never on a vendor SDK,
 * so switching from Resend to SES to SMTP is configuration plus one adapter.
 * Credentials come from the environment; nothing here reads or stores one.
 *
 * Two things every implementation must honour:
 *
 *  - **`idempotencyKey` is a promise, not a hint.** A retry after an ambiguous
 *    response must not produce a second email. Providers that support the
 *    header should pass it through; those that do not must dedupe locally.
 *  - **Failures are classified, not thrown.** `retryable` distinguishes a
 *    provider outage from a malformed recipient. Retrying the latter forever is
 *    how a queue fills with work that can never succeed.
 */

export interface EmailMessage {
  to: string;
  from: string;
  fromName: string;
  replyTo?: string;
  email: RenderedEmail;
  /** Correlates provider webhooks back to a delivery row. */
  tags?: Record<string, string>;
}

export interface EmailProvider {
  readonly id: string;
  /** False when unconfigured; the pipeline then records a decision, not a send. */
  isAvailable(): boolean;
  sendEmail(message: EmailMessage): Promise<EmailSendResult>;
  /** Default implementation sends serially; providers with a batch API override. */
  sendBatch(messages: readonly EmailMessage[]): Promise<EmailSendResult[]>;
  /** Optional: not every provider exposes delivery state. */
  getDeliveryStatus?(providerMessageId: string): Promise<DeliveryEvent | null>;
}

/**
 * Captures messages instead of sending them.
 *
 * The default in development and the whole of the test suite. Making the
 * non-sending path the *default* rather than a fallback means an unconfigured
 * deployment cannot accidentally email anyone, and it lets every test assert on
 * the real rendered payload rather than on a mock's call log.
 */
export class MemoryEmailProvider implements EmailProvider {
  readonly id = 'memory';
  readonly sent: EmailMessage[] = [];

  /** Set to fail the next N sends, for retry tests. */
  failNext = 0;
  failRetryable = true;

  isAvailable(): boolean {
    return true;
  }

  sendEmail(message: EmailMessage): Promise<EmailSendResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.resolve({
        accepted: false,
        providerMessageId: null,
        retryable: this.failRetryable,
        error: this.failRetryable ? 'simulated transient provider error' : 'invalid recipient',
      });
    }

    // Idempotency enforced here too: a provider that silently accepted the same
    // key twice would hide exactly the bug these tests exist to catch.
    const existing = this.sent.find(
      (m) => m.email.idempotencyKey === message.email.idempotencyKey,
    );
    if (existing) {
      return Promise.resolve({
        accepted: true,
        providerMessageId: `memory-${existing.email.idempotencyKey.slice(0, 12)}`,
        retryable: false,
        error: null,
      });
    }

    this.sent.push(message);
    return Promise.resolve({
      accepted: true,
      providerMessageId: `memory-${message.email.idempotencyKey.slice(0, 12)}`,
      retryable: false,
      error: null,
    });
  }

  async sendBatch(messages: readonly EmailMessage[]): Promise<EmailSendResult[]> {
    const results: EmailSendResult[] = [];
    for (const message of messages) results.push(await this.sendEmail(message));
    return results;
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = 0;
    this.failRetryable = true;
  }
}

/** No provider configured. Every send is refused, loudly and without throwing. */
export class NullEmailProvider implements EmailProvider {
  readonly id = 'null';
  isAvailable(): boolean {
    return false;
  }
  sendEmail(): Promise<EmailSendResult> {
    return Promise.resolve({
      accepted: false,
      providerMessageId: null,
      retryable: false,
      error: 'no email provider configured',
    });
  }
  sendBatch(messages: readonly EmailMessage[]): Promise<EmailSendResult[]> {
    return Promise.all(messages.map(() => this.sendEmail()));
  }
}

/**
 * Resend adapter.
 *
 * Chosen because it is the provider the environment schema already carries a
 * key for. It is one file behind the port — the rest of the system cannot tell
 * which provider is in use, which is the point.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly id = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isAvailable(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async sendEmail(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const response = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // The provider's own dedupe, on top of the ledger constraint.
          'Idempotency-Key': message.email.idempotencyKey,
        },
        body: JSON.stringify({
          from: `${message.fromName} <${message.from}>`,
          to: [message.to],
          subject: message.email.subject,
          html: message.email.html,
          text: message.email.text,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.tags
            ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }
            : {}),
        }),
      });

      if (response.ok) {
        const payload = (await response.json()) as { id?: string };
        return {
          accepted: true,
          providerMessageId: payload.id ?? null,
          retryable: false,
          error: null,
        };
      }

      const detail = await response.text();
      // 5xx and 429 are worth another attempt; a 4xx address error never will be.
      const retryable = response.status >= 500 || response.status === 429;
      return {
        accepted: false,
        providerMessageId: null,
        retryable,
        error: `${response.status}: ${detail.slice(0, 400)}`,
      };
    } catch (error) {
      // Network-level failure: unknown whether the message landed, so it is
      // retryable and the idempotency key is what makes that safe.
      return {
        accepted: false,
        providerMessageId: null,
        retryable: true,
        error: error instanceof Error ? error.message.slice(0, 400) : 'network error',
      };
    }
  }

  async sendBatch(messages: readonly EmailMessage[]): Promise<EmailSendResult[]> {
    const results: EmailSendResult[] = [];
    for (const message of messages) results.push(await this.sendEmail(message));
    return results;
  }
}

/**
 * Selects the provider for an environment.
 *
 * The dry-run path is the reason this exists rather than each caller deciding.
 * Testing a notification pipeline in production means running everything —
 * scoring, suppression, templating, link validation — and stopping at the last
 * step. Without one place that makes that choice, "did we actually send that?"
 * depends on which composition root the code went through, which is exactly the
 * question nobody wants to be unsure about.
 *
 * `MemoryEmailProvider` rather than `NullEmailProvider` for dry runs: null
 * reports failure, which would make the pipeline retry and eventually
 * dead-letter perfectly good notifications. Memory accepts and retains, so a
 * dry run exercises the success path and leaves the payload inspectable.
 */
export function createEmailProvider(config: {
  apiKey?: string | undefined;
  dryRun?: boolean | undefined;
}): EmailProvider {
  if (config.dryRun) return new MemoryEmailProvider();
  if (config.apiKey) return new ResendEmailProvider(config.apiKey);

  /*
   * No key and not explicitly dry-running. Null rather than memory, so the
   * absence is visible as a delivery failure on the dashboard instead of
   * silently succeeding into a buffer nobody reads.
   */
  return new NullEmailProvider();
}
