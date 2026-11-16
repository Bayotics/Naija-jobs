/**
 * @job-intel/search-config
 *
 * The dynamic search configuration layer: the machinery that lets someone
 * change what they are looking for without anyone touching the source code.
 *
 * Everything here is pure. No database, no clock beyond an injected `now`, no
 * network. The service layer binds it to persistence; keeping the resolver and
 * the intent parser as functions of their inputs is what makes precedence and
 * validation testable as arithmetic rather than as integration.
 */
export * from './resolve/effective-config';
export * from './resolve/apply-changes';
export * from './validate/validate-profile';
export * from './nl/intent-parser';
export * from './titles/title-synonyms';
export * from './query/query-builder';
