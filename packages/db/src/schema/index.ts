/**
 * The complete Drizzle schema.
 *
 * Split by bounded context rather than kept in one file, so it stays navigable
 * as the system grows. Drizzle needs the whole set in one object for relational
 * queries and migration generation, which this barrel provides.
 */
export * from './enums';
export * from './identity';
export * from './sources';
export * from './jobs';
export * from './matching';
export * from './notifications';
export * from './system';
export * from './enrichment';
export * from './candidate';
export * from './recommendation';
export * from './notification-engine';
export * from './ops';
export * from './discovery-framework';
export * from './feedback-loop';
export * from './candidate-intelligence';
export * from './application-intelligence';
export * from './notification-intelligence';
export * from './search-configuration';
export * from './acquisition';
export * from './scheduling';
