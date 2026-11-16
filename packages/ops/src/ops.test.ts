import { describe, expect, it } from 'vitest';
import { classifyFailure, scoreSourceHealth } from './health/source-health';
import { biggestDrop, buildFunnel } from './funnel/funnel';
import {
  DEFAULT_MODEL_PRICES,
  budgetStatus,
  computeCost,
  priceFor,
  summariseCost,
} from './cost/ai-cost';
import { buildDataQuality, concerningMetrics } from './quality/data-quality';
import { composeHealth, probe, redact, summariseLatency } from './metrics/percentiles';

/**
 * Operations tests.
 *
 * Two groups matter most: the *degradation* tests, which prove the dashboard
 * survives its dependencies failing, and the *no-fake-data* tests, which prove
 * an empty system reports empty rather than something that merely looks alive.
 */

const NOW = new Date('2026-08-19T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const run = (overrides: Partial<Parameters<typeof scoreSourceHealth>[0]['runs'][number]> = {}) => ({
  status: 'success',
  startedAt: ago(HOUR),
  durationMs: 1500,
  jobsDiscovered: 20,
  jobsAccepted: 18,
  errorCount: 0,
  httpRequests: 3,
  ...overrides,
});

describe('source health scoring', () => {
  const base = {
    sourceId: 'greenhouse',
    enabled: true,
    runs: [run(), run(), run(), run(), run()],
    consecutiveFailures: 0,
    lastSuccessAt: ago(HOUR),
    circuitState: 'closed',
    rateLimitEvents: 0,
    baselineDiscovered: 20,
    now: NOW,
  };

  it('scores a healthy source highly and shows every component', () => {
    const result = scoreSourceHealth(base);
    expect(result.score).toBeGreaterThan(85);
    expect(result.status).toBe('healthy');
    // The formula is visible: every component reports its own value and reason.
    expect(result.components.length).toBeGreaterThanOrEqual(5);
    for (const component of result.components) {
      expect(component.detail.length).toBeGreaterThan(3);
      expect(component.weight).toBeGreaterThan(0);
    }
  });

  it('collapses the score on a failure streak', () => {
    const failing = scoreSourceHealth({
      ...base,
      runs: [run({ status: 'failed', errorCount: 2 }), run({ status: 'failed', errorCount: 2 })],
      consecutiveFailures: 5,
      lastSuccessAt: ago(5 * DAY),
    });
    expect(failing.score).toBeLessThan(35);
    expect(failing.status).toBe('down');
  });

  it('does not treat one quiet scan as a broken source', () => {
    // The rule the brief calls out: zero results is only meaningful against
    // that source's own history.
    const noBaseline = scoreSourceHealth({
      ...base,
      runs: [run({ jobsDiscovered: 0 })],
      baselineDiscovered: null,
    });
    expect(noBaseline.anomalies).toHaveLength(0);
    expect(noBaseline.status).toBe('healthy');
  });

  it('flags zero results against a busy baseline', () => {
    const result = scoreSourceHealth({
      ...base,
      runs: Array.from({ length: 5 }, () => run({ jobsDiscovered: 0 })),
      baselineDiscovered: 40,
    });
    expect(result.anomalies.join(' ')).toMatch(/zero jobs/);
    expect(result.status).toBe('degraded');
  });

  it('reports a disabled source as disabled, not unhealthy', () => {
    const result = scoreSourceHealth({ ...base, enabled: false });
    expect(result.status).toBe('disabled');
    expect(result.explanation).toMatch(/disabled/);
  });

  it('reports a source with no history as unknown, not zero-health', () => {
    const result = scoreSourceHealth({ ...base, runs: [] });
    expect(result.status).toBe('unknown');
    expect(result.explanation).toMatch(/No runs/);
  });

  it('flags an open circuit and repeated throttling', () => {
    const result = scoreSourceHealth({ ...base, circuitState: 'open', rateLimitEvents: 4 });
    expect(result.anomalies.join(' ')).toMatch(/Circuit breaker is open/);
    expect(result.anomalies.join(' ')).toMatch(/Rate limited/);
    expect(result.status).toBe('down');
  });

  it('classifies failures into actionable kinds', () => {
    // Each needs a different response, so lumping them into "failed" makes them
    // all the same ticket.
    expect(classifyFailure('Request timed out after 30000ms')).toBe('timeout');
    expect(classifyFailure('HTTP 401 Unauthorized: invalid api key')).toBe('authentication');
    expect(classifyFailure('HTTP 429 rate limit exceeded')).toBe('rate_limited');
    expect(classifyFailure('Unexpected token < in JSON at position 0')).toBe('unexpected_format');
    expect(classifyFailure('connect ECONNREFUSED 127.0.0.1:443')).toBe('network');
    expect(classifyFailure('HTTP 503 Service Unavailable')).toBe('server_error');
    expect(classifyFailure(null)).toBe('unknown');
  });
});

describe('the funnel', () => {
  it('shows retention at every step', () => {
    const funnel = buildFunnel(
      {
        discovered: 10_000,
        unique: 6200,
        enriched: 5900,
        qualityPassed: 2100,
        eligible: 430,
        matched: 430,
        recommended: 87,
        notified: 14,
      },
      24,
      NOW,
    );

    expect(funnel.steps).toHaveLength(8);
    expect(funnel.steps[0]?.retention).toBeNull();
    expect(funnel.steps[1]?.retention).toBeCloseTo(0.62, 2);

    // Selection stages are excluded: notification removing 84% is the system
    // working, not a finding. The useful answer is the processing step.
    // Hard constraints removed 80% of quality-passing jobs — a larger drop
    // than quality analysis itself, and exactly the finding worth surfacing.
    expect(biggestDrop(funnel)?.step.key).toBe('eligible');
    expect(biggestDrop(funnel, { includeSelective: true })?.step.key).toBe('notified');
  });

  it('reports zeros for an empty system rather than inventing a shape', () => {
    const funnel = buildFunnel(
      {
        discovered: 0, unique: 0, enriched: 0, qualityPassed: 0,
        eligible: 0, matched: 0, recommended: 0, notified: 0,
      },
      24,
      NOW,
    );
    expect(funnel.steps.every((s) => s.count === 0)).toBe(true);
    expect(funnel.steps.every((s) => s.retention === null)).toBe(true);
    expect(biggestDrop(funnel)).toBeNull();
  });

  it('explains a step that exceeds the previous one instead of clamping it', () => {
    // Matching runs over the whole stored corpus, so a quiet discovery window
    // can legitimately produce more matches than it discovered.
    const funnel = buildFunnel(
      {
        discovered: 10, unique: 10, enriched: 10, qualityPassed: 10,
        eligible: 300, matched: 300, recommended: 20, notified: 2,
      },
      1,
      NOW,
    );
    const eligible = funnel.steps.find((s) => s.key === 'eligible');
    expect(eligible?.retention).toBeGreaterThan(1);
    expect(eligible?.detail).toMatch(/whole stored corpus/);
  });
});

describe('AI cost', () => {
  it('prices a call from the effective rate card', () => {
    const result = computeCost(
      { model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 200_000, at: NOW },
      DEFAULT_MODEL_PRICES,
    );
    expect(result.priced).toBe(true);
    expect(result.costUsd).toBeCloseTo(1 + 1, 4);
  });

  it('reports an unknown model as unpriced rather than free', () => {
    // A fabricated rate silently understates the bill; a visible gap prompts
    // someone to add the price.
    const result = computeCost(
      { model: 'some-new-model', inputTokens: 1_000_000, outputTokens: 0, at: NOW },
      DEFAULT_MODEL_PRICES,
    );
    expect(result.priced).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.detail).toMatch(/No price configured/);
  });

  it('uses the rate in force when the usage happened', () => {
    const prices = [
      { model: 'm', provider: 'p', inputPerMillion: 10, outputPerMillion: 0, effectiveFrom: new Date('2026-01-01'), note: null },
      { model: 'm', provider: 'p', inputPerMillion: 4, outputPerMillion: 0, effectiveFrom: new Date('2026-06-01'), note: null },
    ];
    // An old row keeps costing what it cost.
    expect(priceFor('m', new Date('2026-03-01'), prices)?.inputPerMillion).toBe(10);
    expect(priceFor('m', new Date('2026-08-01'), prices)?.inputPerMillion).toBe(4);
    expect(priceFor('m', new Date('2025-01-01'), prices)).toBeNull();
  });

  it('summarises by operation, model and day', () => {
    const summary = summariseCost({
      windowHours: 48,
      dailyBudgetUsd: 2,
      records: [
        {
          operation: 'enrichment_extraction', provider: 'anthropic', model: 'claude-haiku-4-5',
          inputTokens: 1000, outputTokens: 200, calls: 1, costUsd: 0.002, latencyMs: 400,
          succeeded: true, jobId: null, runId: null, sourceId: null,
          occurredAt: new Date('2026-08-18T10:00:00Z'),
        },
        {
          operation: 'match_reasoning', provider: 'anthropic', model: 'claude-opus-5',
          inputTokens: 5000, outputTokens: 900, calls: 2, costUsd: 0.14, latencyMs: 1200,
          succeeded: true, jobId: null, runId: null, sourceId: null,
          occurredAt: new Date('2026-08-19T09:00:00Z'),
        },
      ],
    });

    expect(summary.totalCalls).toBe(3);
    expect(summary.totalCostUsd).toBeCloseTo(0.142, 4);
    expect(summary.byOperation.match_reasoning).toBeCloseTo(0.14, 4);
    expect(summary.byDay).toHaveLength(2);
  });

  it('reports budget headroom without enforcing it', () => {
    expect(budgetStatus(0.1, 2).status).toBe('ok');
    expect(budgetStatus(1.7, 2).status).toBe('warning');
    expect(budgetStatus(2.4, 2).status).toBe('exceeded');
    expect(budgetStatus(99, null).status).toBe('ok');
  });

  it('reports an empty ledger as zero, not as unknown', () => {
    const summary = summariseCost({ records: [], windowHours: 24 });
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.byDay).toHaveLength(0);
  });
});

describe('data quality', () => {
  const counts = {
    total: 351,
    missingSalary: 300,
    missingLocation: 20,
    uncertainRemote: 90,
    uncertainVisa: 340,
    shortDescription: 12,
    failedEnrichment: 0,
    lowExtractionConfidence: 40,
    missingApplicationUrl: 30,
    noCompanyResolved: 351,
  };

  it('reports shares against the corpus', () => {
    const metrics = buildDataQuality(counts);
    const salary = metrics.find((m) => m.key === 'missingSalary');
    expect(salary?.share).toBeCloseTo(0.855, 2);
  });

  it('does not flag missing salary as a defect at ordinary levels', () => {
    // 85% is the world, not a broken extractor. Painting it red teaches the
    // reader to ignore red.
    const concerning = concerningMetrics(buildDataQuality(counts));
    expect(concerning.map((m) => m.key)).not.toContain('missingSalary');
    // An unresolved company for every job is a real gap.
    expect(concerning.map((m) => m.key)).toContain('noCompanyResolved');
  });

  it('flags any enrichment failure at all', () => {
    const concerning = concerningMetrics(buildDataQuality({ ...counts, failedEnrichment: 8 }));
    expect(concerning.map((m) => m.key)).toContain('failedEnrichment');
  });

  it('handles an empty corpus without dividing by zero', () => {
    const metrics = buildDataQuality({
      total: 0, missingSalary: 0, missingLocation: 0, uncertainRemote: 0,
      uncertainVisa: 0, shortDescription: 0, failedEnrichment: 0,
      lowExtractionConfidence: 0, missingApplicationUrl: 0, noCompanyResolved: 0,
    });
    expect(metrics.every((m) => m.share === 0)).toBe(true);
    expect(metrics.every((m) => m.detail === 'No jobs to assess yet')).toBe(true);
    expect(concerningMetrics(metrics)).toHaveLength(0);
  });
});

describe('metrics and percentiles', () => {
  it('computes percentiles rather than hiding the tail in an average', () => {
    const samples = [...Array.from({ length: 95 }, () => 40), ...Array.from({ length: 5 }, () => 9000)];
    const summary = summariseLatency('enrichment', samples);
    expect(summary.p50).toBe(40);
    expect(summary.p99).toBe(9000);
    // The mean would report ~488 and conceal the tail entirely.
    expect(summary.mean).toBeGreaterThan(400);
  });

  it('reports zeros for an operation with no samples', () => {
    const summary = summariseLatency('matching', []);
    expect(summary).toMatchObject({ count: 0, p50: 0, p95: 0, p99: 0 });
  });
});

describe('degradation', () => {
  const component = (
    name: string,
    status: 'healthy' | 'degraded' | 'down' | 'unknown' | 'disabled',
    detail = '',
  ) => ({ component: name, status, detail, latencyMs: null, checkedAt: NOW });

  it('takes the worst component and names it', () => {
    const health = composeHealth(
      [
        component('database', 'healthy'),
        component('queue', 'healthy'),
        component('email_provider', 'down', 'connection refused'),
      ],
      NOW,
    );
    // Averaging five green with one dead into "mostly healthy" is the dashboard
    // nobody looks at during an incident.
    expect(health.status).toBe('down');
    expect(health.summary).toMatch(/email_provider is down/);
  });

  it('does not let a deliberately disabled component degrade the system', () => {
    const health = composeHealth(
      [component('database', 'healthy'), component('ai_provider', 'disabled', 'AI switched off')],
      NOW,
    );
    expect(health.status).toBe('healthy');
  });

  it('reports nothing observed as unknown', () => {
    expect(composeHealth([], NOW).status).toBe('unknown');
  });

  it('turns a throwing probe into a down card instead of an exception', async () => {
    // The requirement in one test: the dashboard must survive its dependencies.
    const result = await probe('database', () => Promise.reject(new Error('ECONNREFUSED')));
    expect(result.status).toBe('down');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('times a hanging probe out rather than stalling the page', async () => {
    const result = await probe(
      'queue',
      () => new Promise(() => undefined),
      { timeoutMs: 30 },
    );
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/timed out/);
  });

  it('composes a page from a mix of working and broken components', async () => {
    const components = await Promise.all([
      probe('database', () => Promise.resolve({ status: 'healthy' as const, detail: 'ok' })),
      probe('queue', () => Promise.reject(new Error('redis unreachable'))),
      probe('ai_provider', () => Promise.resolve({ status: 'disabled' as const, detail: 'off' })),
    ]);
    const health = composeHealth(components, NOW);

    // One broken dependency degrades one card, not the page.
    expect(health.components).toHaveLength(3);
    expect(health.components.find((c) => c.component === 'database')?.status).toBe('healthy');
    expect(health.status).toBe('down');
  });
});

describe('secret redaction', () => {
  it('strips credentials from anything rendered to a browser', () => {
    // These reach the ops console verbatim as exception messages.
    expect(redact('failed: postgresql://user:hunter2@db.internal:5432/jobs')).not.toContain('hunter2');
    expect(redact('Authorization: Bearer sk-abcdef1234567890xyz')).toContain('[redacted]');
    expect(redact('provider said api_key="re_live_abcdef123456"')).not.toContain('re_live_abcdef123456');
    expect(redact('connect ECONNREFUSED 127.0.0.1:6379')).toBe('connect ECONNREFUSED 127.0.0.1:6379');
    expect(redact(null)).toBe('');
  });
});
