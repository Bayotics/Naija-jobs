/**
 * @job-intel/matching
 *
 * Hybrid job matching: deterministic constraints, structured feature scoring,
 * semantic similarity, configurable weights, bounded LLM refinement, and an
 * explanation for every number.
 *
 * The engine never asks a model "is this a good match?". It computes an
 * explainable structural verdict first and lets a model refine it within a
 * configured range — and never lets any of that overturn an eligibility rule
 * the candidate set.
 */
export * from './types';
export * from './constraints/hard-constraints';
export * from './scoring/util';
export * from './scoring/skills';
export * from './scoring/experience';
export * from './scoring/role';
export * from './scoring/place';
export * from './scoring/compensation';
export * from './scoring/quality';
export * from './semantic/embedding-provider';
export * from './semantic/similarity';
export * from './behavioral/behavioral-adjustment';
export * from './weights/weight-normalizer';
export * from './confidence/confidence';
export * from './explanation/explainer';
export * from './llm/match-reasoning-provider';
export * from './engine/recommendation';
export * from './engine/matching-engine';

/*
 * The reasoning layer (Prompt 18).
 *
 * Everything above answers "how well do these line up". These answer the
 * harder questions: what can the candidate actually demonstrate, where will
 * this remote role really hire from, which gaps are closeable, what did this
 * ranking give up, and is the engine measurably better than keyword overlap.
 */
export * from './career/trajectory';
export * from './geography/remote-reach';
export * from './gaps/skill-gaps';
export * from './tradeoffs/pareto';
export * from './cache/match-cache';
export * from './evaluation/offline-eval';
