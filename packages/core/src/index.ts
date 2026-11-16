/**
 * @job-intel/core
 *
 * Pure domain logic: normalization, job identity, preference evaluation.
 *
 * This package must never import from `@job-intel/connectors`. That constraint
 * is what makes "add a new source without touching the matching engine" true by
 * construction rather than by good intentions.
 */
export * from './errors';
export * from './normalize/text';
export * from './normalize/vocabulary';
export * from './normalize/fields';
export * from './normalize/html';
export * from './normalize/job-normalizer';
export * from './jobs/job-identity';
export * from './preferences/preference-engine';
export * from './money/fx';
export * from './sources/circuit-breaker';
