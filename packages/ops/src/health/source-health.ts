import {
  type ComponentStatus,
  type HealthComponent,
  type SourceHealthScore,
} from '@job-intel/contracts';

/**
 * Source health scoring.
 *
 * A transparent 0-100 built from six weighted components, each reporting its
 * own value and reason. The brief asks for the formula to be visible, and that
 * is not decoration: an opaque health number invites trust it has not earned,
 * and the first time it disagrees with reality nobody can tell whether the
 * source or the score is wrong.
 *
 * The subtle requirement is the zero-result rule. A source returning nothing on
 * one scan is *usually fine* — boards go quiet overnight, incremental cursors
 * legitimately return empty. It only means something against that source's own
 * history, so the anomaly compares to a baseline rather than to zero.
 */

export interface SourceHealthInput {
  sourceId: string;
  enabled: boolean;
  /** Recent runs, newest first. */
  runs: Array<{
    status: string;
    startedAt: Date;
    durationMs: number | null;
    jobsDiscovered: number;
    jobsAccepted: number;
    errorCount: number;
    httpRequests: number;
  }>;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  circuitState: string | null;
  rateLimitEvents: number;
  /** Median discovery volume over a longer window, for the anomaly check. */
  baselineDiscovered: number | null;
  now?: Date;
}

interface WeightedComponent extends HealthComponent {
  weight: number;
}

function component(
  name: string,
  score: number,
  weight: number,
  detail: string,
): WeightedComponent {
  return {
    component: name,
    score: Math.max(0, Math.min(100, score)),
    weight,
    applicable: true,
    detail,
  };
}

function notApplicable(name: string, weight: number, detail: string): WeightedComponent {
  return { component: name, score: 0, weight, applicable: false, detail };
}

export function scoreSourceHealth(input: SourceHealthInput): SourceHealthScore {
  const now = input.now ?? new Date();
  const runs = input.runs;
  const anomalies: string[] = [];

  if (!input.enabled) {
    return {
      sourceId: input.sourceId,
      score: 0,
      status: 'disabled',
      components: [],
      anomalies: [],
      explanation: 'Source is disabled; health is not scored',
    };
  }

  if (runs.length === 0) {
    return {
      sourceId: input.sourceId,
      score: 0,
      status: 'unknown',
      components: [],
      anomalies: [],
      explanation: 'No runs recorded yet',
    };
  }

  const components: WeightedComponent[] = [];

  // ── Success rate ────────────────────────────────────────────────────────
  const successes = runs.filter((r) => r.status === 'success' || r.status === 'partial').length;
  const successRate = successes / runs.length;
  components.push(
    component(
      'success_rate',
      successRate * 100,
      3,
      `${successes} of ${runs.length} recent runs succeeded`,
    ),
  );

  // ── Consecutive failures ────────────────────────────────────────────────
  // Weighted heavily and decaying fast: three failures in a row says far more
  // about a source's current state than a 90% success rate over a month.
  const streakScore = Math.max(0, 100 - input.consecutiveFailures * 25);
  components.push(
    component(
      'failure_streak',
      streakScore,
      input.consecutiveFailures > 0 ? 3 : 1,
      input.consecutiveFailures === 0
        ? 'No consecutive failures'
        : `${input.consecutiveFailures} consecutive failure(s)`,
    ),
  );

  // ── Latency ─────────────────────────────────────────────────────────────
  const timed = runs.filter((r) => r.durationMs !== null);
  if (timed.length > 0) {
    const mean = timed.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / timed.length;
    // 2s is excellent, 30s is poor. Linear between, clamped.
    const latencyScore = Math.max(0, Math.min(100, 100 - ((mean - 2000) / 28_000) * 100));
    components.push(
      component('latency', latencyScore, 1, `Average run ${Math.round(mean)} ms`),
    );
  } else {
    components.push(notApplicable('latency', 1, 'No timed runs'));
  }

  // ── Freshness ───────────────────────────────────────────────────────────
  if (input.lastSuccessAt) {
    const hours = (now.getTime() - input.lastSuccessAt.getTime()) / 3_600_000;
    const freshnessScore = Math.max(0, 100 - (hours / 48) * 100);
    components.push(
      component('freshness', freshnessScore, 2, `Last success ${Math.round(hours)}h ago`),
    );
  } else {
    components.push(component('freshness', 0, 2, 'Has never succeeded'));
  }

  // ── Result volume ───────────────────────────────────────────────────────
  const recentDiscovered = runs.slice(0, 5).reduce((sum, r) => sum + r.jobsDiscovered, 0);
  if (input.baselineDiscovered !== null && input.baselineDiscovered > 0) {
    const ratio = recentDiscovered / (input.baselineDiscovered * Math.min(5, runs.length));
    components.push(
      component(
        'volume',
        Math.min(100, ratio * 100),
        1.5,
        `${recentDiscovered} discovered recently against a baseline of ${input.baselineDiscovered}/run`,
      ),
    );

    // The zero-result rule: only an anomaly against this source's own history.
    if (recentDiscovered === 0 && input.baselineDiscovered >= 3) {
      anomalies.push(
        `Returned zero jobs across ${Math.min(5, runs.length)} runs, ` +
          `against a baseline of ${input.baselineDiscovered} per run`,
      );
    } else if (ratio < 0.25 && input.baselineDiscovered >= 5) {
      anomalies.push(
        `Volume is ${Math.round(ratio * 100)}% of this source's normal level`,
      );
    }
  } else {
    // No baseline yet: a quiet source is not evidence of anything.
    components.push(
      notApplicable('volume', 1.5, 'No baseline yet; volume is not scored'),
    );
  }

  // ── Errors and rate limits ──────────────────────────────────────────────
  const errorTotal = runs.reduce((sum, r) => sum + r.errorCount, 0);
  const requestTotal = runs.reduce((sum, r) => sum + r.httpRequests, 0);
  const errorRate = requestTotal === 0 ? 0 : errorTotal / requestTotal;
  components.push(
    component(
      'error_rate',
      Math.max(0, 100 - errorRate * 400),
      1.5,
      `${errorTotal} error(s) across ${requestTotal} request(s)`,
    ),
  );

  if (input.rateLimitEvents > 0) {
    components.push(
      component(
        'rate_limits',
        Math.max(0, 100 - input.rateLimitEvents * 20),
        1,
        `${input.rateLimitEvents} rate-limit response(s)`,
      ),
    );
    if (input.rateLimitEvents >= 3) {
      anomalies.push(`Rate limited ${input.rateLimitEvents} times — consider slowing this source`);
    }
  } else {
    components.push(component('rate_limits', 100, 0.5, 'No rate limiting observed'));
  }

  if (input.circuitState === 'open') {
    anomalies.push('Circuit breaker is open; the source is not being called');
  }

  // ── Aggregate ───────────────────────────────────────────────────────────
  const applicable = components.filter((c) => c.applicable);
  const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
  const score =
    totalWeight === 0
      ? 0
      : applicable.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;

  const status: ComponentStatus =
    input.circuitState === 'open' || score < 35
      ? 'down'
      : score < 70 || anomalies.length > 0
        ? 'degraded'
        : 'healthy';

  const weakest = applicable.slice().sort((a, b) => a.score - b.score)[0];

  return {
    sourceId: input.sourceId,
    score: Math.round(score * 10) / 10,
    status,
    components,
    anomalies,
    explanation:
      `${Math.round(score)}/100 from ${applicable.length} signals` +
      (weakest && weakest.score < 60 ? `; weakest is ${weakest.component} (${weakest.detail})` : ''),
  };
}

/**
 * Failure classification.
 *
 * The brief lists the categories that matter operationally, and they need
 * different responses: an auth failure needs a credential, a rate limit needs
 * patience, a format change needs a code fix. Lumping them into "failed" makes
 * every one of them the same ticket.
 */
export const FAILURE_KINDS = [
  'timeout',
  'authentication',
  'rate_limited',
  'unexpected_format',
  'network',
  'server_error',
  'unknown',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export function classifyFailure(message: string | null): FailureKind {
  if (!message) return 'unknown';
  const text = message.toLowerCase();

  if (/\btimed? ?out\b|etimedout|deadline/.test(text)) return 'timeout';
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid.{0,10}(key|token|credential)/.test(text)) {
    return 'authentication';
  }
  if (/\b429\b|rate.?limit|too many requests/.test(text)) return 'rate_limited';
  if (/parse|unexpected token|invalid json|schema|validation/.test(text)) return 'unexpected_format';
  if (/econnrefused|enotfound|econnreset|network|dns/.test(text)) return 'network';
  if (/\b5\d{2}\b|internal server error|bad gateway|unavailable/.test(text)) return 'server_error';
  return 'unknown';
}
