import {
  verificationConfigSchema,
  type VerificationConfig,
  type VerificationResult,
} from '@job-intel/contracts';

/**
 * Application-URL re-verification.
 *
 * Checking every posting before every digest would be both slow and rude to the
 * hosts involved, so verification is *targeted*: a 95-match about to be emailed
 * is worth one HEAD request; a low-scoring three-week-old posting is not.
 *
 * The policy is configuration, and the checker is a port — nothing here knows
 * about HTTP. That keeps the ranking engine testable without a network and lets
 * the deployment supply a client that already honours robots.txt and the
 * per-domain rate limits the discovery layer established.
 */

export interface UrlVerifier {
  readonly id: string;
  /** Never throws: a failed check resolves to `error`, which is not closure. */
  verify(url: string, timeoutMs: number): Promise<VerificationResult>;
}

/**
 * The default: no verification.
 *
 * Ranking must be fully functional without network access, so the no-op is the
 * tested default path rather than an untested fallback.
 */
export class NullUrlVerifier implements UrlVerifier {
  readonly id = 'null';
  verify(url: string): Promise<VerificationResult> {
    return Promise.resolve({
      outcome: 'skipped',
      url,
      httpStatus: null,
      checkedAt: new Date(),
      durationMs: 0,
      detail: 'no verifier configured',
    });
  }
}

export interface VerificationCandidate {
  jobId: string;
  url: string | null;
  recommendationScore: number;
  lastVerifiedAt: Date | null;
}

export interface VerificationDecision {
  verify: boolean;
  reason: string;
}

/**
 * Whether a job is worth a check right now.
 *
 * Two thresholds rather than one: value decides *whether* it matters, and the
 * recency of the last check decides *whether it is already answered*. A job
 * verified an hour ago does not need verifying again however valuable it is.
 */
export function shouldVerify(
  candidate: VerificationCandidate,
  config: VerificationConfig,
  now = new Date(),
): VerificationDecision {
  if (!config.enabled) return { verify: false, reason: 'verification disabled' };
  if (!candidate.url) return { verify: false, reason: 'no application url to check' };

  const highValue = candidate.recommendationScore >= config.highValueScore;
  const maxAgeHours = highValue ? config.maxAgeHoursHighValue : config.maxAgeHoursNormal;

  if (candidate.lastVerifiedAt) {
    const ageHours = (now.getTime() - candidate.lastVerifiedAt.getTime()) / 3_600_000;
    if (ageHours < maxAgeHours) {
      return {
        verify: false,
        reason: `verified ${Math.round(ageHours)}h ago, inside the ${maxAgeHours}h window`,
      };
    }
  }

  return {
    verify: true,
    reason: highValue
      ? `high-value (${Math.round(candidate.recommendationScore)}) and not verified recently`
      : 'not verified recently',
  };
}

export interface VerificationRunResult {
  checked: number;
  skipped: number;
  results: Array<{ jobId: string; result: VerificationResult }>;
}

/**
 * Verifies the most valuable candidates, up to the configured budget.
 *
 * Sorted by score before the cap is applied, so a truncated run checks the jobs
 * that matter rather than whichever happened to be first.
 */
export async function verifyBatch(
  candidates: readonly VerificationCandidate[],
  verifier: UrlVerifier,
  config: Partial<VerificationConfig> = {},
  now = new Date(),
): Promise<VerificationRunResult> {
  const cfg = verificationConfigSchema.parse(config);
  const results: VerificationRunResult['results'] = [];
  let skipped = 0;

  const queue = [...candidates].sort((a, b) => b.recommendationScore - a.recommendationScore);

  for (const candidate of queue) {
    if (results.length >= cfg.maxChecksPerRun) {
      skipped += 1;
      continue;
    }
    const decision = shouldVerify(candidate, cfg, now);
    if (!decision.verify) {
      skipped += 1;
      continue;
    }
    // `verify` is contracted never to throw, but a third-party implementation
    // is a replaceable component and one bad checker must not end the run.
    try {
      const result = await verifier.verify(candidate.url as string, cfg.timeoutMs);
      results.push({ jobId: candidate.jobId, result });
    } catch (error) {
      results.push({
        jobId: candidate.jobId,
        result: {
          outcome: 'error',
          url: candidate.url as string,
          httpStatus: null,
          checkedAt: now,
          durationMs: 0,
          detail: error instanceof Error ? error.message.slice(0, 300) : 'verification threw',
        },
      });
    }
  }

  return { checked: results.length, skipped, results };
}
