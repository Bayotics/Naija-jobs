/**
 * @job-intel/ops
 *
 * Pure computation for the operations control centre: source health scoring,
 * the discovery-to-notification funnel, AI cost accounting, data-quality
 * reporting, latency percentiles and health composition.
 *
 * No database, no clock beyond what callers pass, no fabricated numbers. An
 * empty system produces zeros and empty states — a dashboard that looks alive
 * when nothing is running is trusted right up until it matters.
 */
export * from './health/source-health';
export * from './funnel/funnel';
export * from './cost/ai-cost';
export * from './quality/data-quality';
export * from './metrics/percentiles';
