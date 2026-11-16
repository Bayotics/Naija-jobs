/**
 * @job-intel/enrichment
 *
 * Turns a discovered job into a structured, confidence-annotated record the
 * matching engine can reason about. Deterministic extraction runs on every job;
 * the LLM is consulted only where genuine ambiguity remains.
 */
export * from './taxonomy/skills';
export * from './cleaning/content-cleaner';
export * from './extractors/title';
export * from './extractors/experience';
export * from './extractors/seniority';
export * from './extractors/skills';
export * from './extractors/work-arrangement';
export * from './extractors/compensation';
export * from './extractors/work-authorization';
export * from './extractors/education-classification';
export * from './extractors/application-url';
export * from './quality/quality-analyzer';
export * from './ai/extraction-provider';
export * from './pipeline/enrichment-pipeline';
