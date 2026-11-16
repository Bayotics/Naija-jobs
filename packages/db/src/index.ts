/**
 * @job-intel/db
 *
 * Schema, migrations and repositories.
 *
 * Repositories are the only sanctioned way for application code to touch the
 * database: they own the SQL, enforce the idempotency guarantees, and keep
 * Drizzle types from leaking into API and UI layers.
 */
export * as schema from './schema/index';
export * from './client';
export * from './migrate';

export * from './repositories/profile-repository';
export * from './repositories/source-repository';
export * from './repositories/job-repository';
export * from './repositories/discovery-repository';
export * from './repositories/enrichment-repository';
export * from './repositories/candidate-repository';
export * from './repositories/system-repository';
export * from './repositories/engagement-repository';
export * from './repositories/match-repository';
export * from './repositories/embedding-repository';
export * from './repositories/recommendation-repository';
export * from './repositories/ops-repository';
export * from './repositories/discovery-framework-repository';
export * from './repositories/learning-repository';
export * from './repositories/intelligence-repository';
export * from './repositories/application-repository';
export * from './repositories/search-config-repository';
export * from './repositories/acquisition-repository';
