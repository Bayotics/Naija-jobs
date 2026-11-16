/**
 * @job-intel/recommendation
 *
 * The layer between matching and notification. Matching answers "how well does
 * this job fit?"; this answers "of everything available, what should the
 * candidate actually see, in what order, and why?".
 *
 * Deduplication, canonical jobs, source authority, freshness, staleness,
 * quality, scam detection, reposts, a transparent ranking formula, calibration,
 * diversification and notification eligibility — all deterministic, so ten
 * thousand jobs rank in one pass without a model call per job.
 */
export * from './dedup/signals';
export * from './dedup/duplicate-detector';
export * from './dedup/canonical-job';
export * from './authority/source-authority';
export * from './freshness/freshness';
export * from './freshness/staleness';
export * from './freshness/verification';
export * from './quality/job-quality';
export * from './quality/scam-detector';
export * from './quality/repost-detector';
export * from './ranking/recommendation-score';
export * from './ranking/calibration';
export * from './ranking/categories';
export * from './ranking/diversifier';
export * from './eligibility/exposure';
export * from './eligibility/material-change';
export * from './eligibility/notification-eligibility';
export * from './explanation/rank-explainer';
export * from './engine/recommendation-engine';
