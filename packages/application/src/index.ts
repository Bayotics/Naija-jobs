/**
 * @job-intel/application
 *
 * The application intelligence layer: given a job and a candidate, decide
 * whether applying is worth an hour — and be able to show the reasoning.
 *
 * Everything here is pure. No database, no clock beyond the injected `now`, no
 * network. The service layer binds it to persistence; keeping the decision
 * itself a function of its inputs is what makes twenty synthetic jobs a
 * meaningful test of the policy.
 */
export * from './requirements/extract';
export * from './requirements/matcher';
export * from './dimensions/experience';
export * from './dimensions/preferences';
export * from './dimensions/compensation';
export * from './dimensions/eligibility-signals';
export * from './dimensions/friction';
export * from './dimensions/eligibility';
export * from './engine/resume-selection';
export * from './engine/application-engine';
export * from './analytics/funnel';

/*
 * Preparation (Prompt 19).
 *
 * Prompt 13 answered "should I apply". These answer "how" — what to select,
 * emphasise, write and prepare, with an integrity gate that makes an
 * unsupported claim unrepresentable rather than merely discouraged.
 */
export * from './integrity/fact-check';
export * from './preparation/customization';
export * from './preparation/answers';
export * from './preparation/package';
