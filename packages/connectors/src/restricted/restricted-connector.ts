import { z } from 'zod';
import type { SourceJobDraft } from '@job-intel/contracts';
import { NotPermittedError } from '../errors';
import {
  DEFAULT_CAPABILITIES,
  type Connector,
  type ConnectorAvailabilityContext,
  type ConnectorContext,
} from '../types';

/**
 * Placeholder for sources whose terms prohibit automated access.
 *
 * LinkedIn, Indeed and Wellfound all forbid automated collection of their
 * listings and defend it technically. Rather than omitting them — which would
 * leave an operator wondering why LinkedIn never appears — they are registered
 * with this connector, which:
 *
 *   - is permanently unavailable and never issues a request,
 *   - states *why* in a form the dashboard can display,
 *   - names the legitimate alternatives that do cover the same ground.
 *
 * The value of this system must not depend on violating access controls, so
 * this is the honest shape of that constraint rather than a stub waiting to be
 * filled in with a scraper.
 *
 * The real coverage path for these sources is `mailbox` ingestion: the operator
 * subscribes to the platform's own job-alert emails and the system reads their
 * own inbox. That is their data, delivered through a channel the platform built
 * for exactly this purpose.
 */
export const restrictedConfigSchema = z.object({
  /** Shown in the UI. Should name the specific term or mechanism. */
  restrictionReason: z.string().min(1),
  /** Concrete routes that *do* work for this source. */
  alternatives: z.array(z.string().min(1)).default([]),
  /** Documentation the operator can read. */
  referenceUrl: z.string().url().nullable().default(null),
});

export type RestrictedConfig = z.infer<typeof restrictedConfigSchema>;

export class RestrictedSourceConnector implements Connector<RestrictedConfig> {
  readonly id = 'restricted';
  readonly displayName = 'Restricted source (not fetched)';
  readonly sourceType = 'manual' as const;
  readonly accessTier = 'restricted' as const;
  readonly capabilities = DEFAULT_CAPABILITIES;
  readonly configSchema = restrictedConfigSchema;

  availability(ctx: ConnectorAvailabilityContext<RestrictedConfig>) {
    return {
      available: false,
      reason: ctx.config.restrictionReason,
      requires: ctx.config.alternatives,
    };
  }

  healthCheck(ctx: ConnectorContext<RestrictedConfig>) {
    // Intentionally makes no network request: "restricted" means we do not
    // probe the source at all, not that we probe it and expect failure.
    return Promise.resolve({
      healthy: false,
      message:
        `Not fetched by policy. ${ctx.config.restrictionReason}` +
        (ctx.config.alternatives.length > 0
          ? ` Alternatives: ${ctx.config.alternatives.join('; ')}`
          : ''),
      checkedAt: new Date(),
    });
  }

  // eslint-disable-next-line require-yield
  async *discover(ctx: ConnectorContext<RestrictedConfig>): AsyncGenerator<SourceJobDraft, void, void> {
    throw new NotPermittedError(
      `Source is registered as restricted and is never fetched. ${ctx.config.restrictionReason}`,
      { alternatives: ctx.config.alternatives, referenceUrl: ctx.config.referenceUrl },
    );
  }
}
