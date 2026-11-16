/**
 * @job-intel/discovery
 *
 * Orchestration: the per-posting pipeline, the source runner, and scheduling.
 *
 * This is the only package that depends on both `@job-intel/connectors` and
 * `@job-intel/db`. Keeping it separate is what lets `core` stay pure and lets
 * connectors stay ignorant of persistence.
 */
export * from './pipeline/discovery-pipeline';
export * from './source-runner';
export * from './scheduler';
export * from './source-health';
export * from './enrichment-runner';
export * from './candidate-intelligence-service';
export * from './matching-service';
export * from './matching-jobs';
export * from './recommendation-service';
export * from './recommendation-jobs';
export * from './notification-service';
export * from './ops-service';
export * from './strategy/query-planner';
export * from './framework/budget';
export * from './framework/adaptive-scheduler';
export * from './framework/coverage';
export * from './discovery-framework-service';
export * from './learning-service';
export * from './learning-jobs';
export * from './resume-service';
export * from './resume-jobs';
export * from './application-service';
export * from './application-jobs';
export * from './notification-intelligence-service';
export * from './notification-intelligence-jobs';
export * from './search-config-service';
export * from './search-config-jobs';
export * from './source-intelligence-service';
export * from './pipeline/relevance';
