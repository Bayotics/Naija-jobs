import type { ComponentHealth, ComponentStatus, LatencySummary, SystemHealth } from '@job-intel/contracts';
import { STATUS_RANK } from '@job-intel/contracts';

/**
 * Latency summaries and system-health composition.
 *
 * Percentiles rather than averages, because a mean hides the tail that actually
 * hurts: a p50 of 40 ms and a p99 of 9 s is a very different system from one
 * where both are 300 ms, and the average is the same story in both.
 */

export function summariseLatency(operation: string, samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { operation, count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank: with few samples this reports a value that was actually
  // observed rather than an interpolation between two that were not.
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const round = (value: number) => Math.round(value * 100) / 100;

  return {
    operation,
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
  };
}

/**
 * Composes overall health from its parts.
 *
 * The worst component wins, and the summary names it. A dashboard that averages
 * five green components with one dead one into "mostly healthy" is precisely
 * the dashboard nobody looks at during an incident.
 *
 * `disabled` never degrades the whole: a deliberately switched-off email
 * provider is a configuration choice, not a fault.
 */
export function composeHealth(components: readonly ComponentHealth[], now = new Date()): SystemHealth {
  if (components.length === 0) {
    return {
      status: 'unknown',
      components: [],
      summary: 'No components reported',
      checkedAt: now,
    };
  }

  const significant = components.filter((c) => c.status !== 'disabled');
  const worst = significant.reduce<ComponentStatus>(
    (acc, c) => (STATUS_RANK[c.status] > STATUS_RANK[acc] ? c.status : acc),
    'healthy',
  );

  const failing = significant
    .filter((c) => c.status === 'down' || c.status === 'degraded')
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);

  const summary =
    failing.length === 0
      ? significant.length === 0
        ? 'Every component is disabled'
        : 'All components healthy'
      : failing
          .slice(0, 3)
          .map((c) => `${c.component} is ${c.status} (${c.detail})`)
          .join('; ');

  return {
    status: significant.length === 0 ? 'disabled' : worst,
    components: [...components],
    summary: summary.slice(0, 400),
    checkedAt: now,
  };
}

/**
 * Wraps a probe so a failing component reports `down` instead of throwing.
 *
 * The brief's requirement in one function: the dashboard must stay usable when
 * a component fails. A probe that throws takes the whole page with it, which is
 * exactly the moment the page is needed.
 */
export async function probe(
  component: string,
  check: () => Promise<{ status: ComponentStatus; detail: string }>,
  options: { timeoutMs?: number; now?: () => Date } = {},
): Promise<ComponentHealth> {
  const now = options.now ?? (() => new Date());
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;

  try {
    const result = await Promise.race([
      check(),
      new Promise<{ status: ComponentStatus; detail: string }>((_, reject) =>
        setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    return {
      component,
      status: result.status,
      detail: result.detail.slice(0, 400),
      latencyMs: Date.now() - startedAt,
      checkedAt: now(),
    };
  } catch (error) {
    return {
      component,
      status: 'down',
      // The message is truncated and never includes a stack: probe errors can
      // carry connection strings, and this reaches a browser.
      detail: (error instanceof Error ? error.message : 'probe failed').slice(0, 400),
      latencyMs: Date.now() - startedAt,
      checkedAt: now(),
    };
  }
}

/**
 * Redacts anything that looks like a credential.
 *
 * Applied to every error string the ops console renders. Connection strings,
 * bearer tokens and API keys end up in exception messages constantly, and this
 * dashboard displays exception messages.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\/[^\s"']+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\b(?:re|sk|pk|rk)_[A-Za-z0-9]{12,}/g,
  /\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|password|token)[A-Za-z0-9_-]*["'\s:=]+[^\s"',}]{8,}/gi,
];

export function redact(value: string | null | undefined): string {
  if (!value) return '';
  let output = value;
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted]');
  return output;
}
