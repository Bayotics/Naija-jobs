/**
 * @job-intel/candidate
 *
 * The candidate intelligence layer: who the candidate is, what they want, what
 * is non-negotiable, and what their behaviour suggests — all as data.
 *
 * Nothing here contains a country, technology, salary figure or work
 * arrangement literal. Every comparison is against a value loaded from the
 * candidate's stored preferences, which is what makes a preference change a
 * database write rather than a code change.
 */
export * from './constraints/constraint-evaluator';
export * from './preferences/preference-service';
export * from './embedding/canonical-profile';
export * from './nl/preference-parser';
export * from './behavior/signal-aggregator';
export * from './skills/skill-graph';
export * from './learning/features';
export * from './learning/affinity';
export * from './learning/hierarchy';
export * from './learning/exploration';
export * from './learning/suggestions';
export * from './learning/performance';
export * from './intelligence/requirement-matrix';
export * from './intelligence/profile-builder';
export * from './intelligence/job-view';
export * from './intelligence/matching-bridge';
