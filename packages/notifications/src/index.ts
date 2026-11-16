/**
 * @job-intel/notifications
 *
 * The layer between "these are the best jobs" and "an email exists".
 *
 * Two modes — a periodic digest and a rare, rule-gated immediate alert — with
 * every candidate's outcome recorded, including the suppressions. A system
 * whose main behaviour is staying quiet is only trustworthy if it can explain
 * each silence.
 *
 * The recommendation engine never reaches an email provider: this package owns
 * the decision, the template and the port, and nothing upstream holds a
 * reference to any of them.
 */
export * from './scheduling/schedule';
export * from './rules/alert-rules';
export * from './rules/source-health-alerts';
export * from './decision/notification-decider';
export * from './templates/components';
export * from './templates/job-card-builder';
export * from './templates/renderer';
export * from './provider/email-provider';
export * from './delivery/retry';
export * from './preferences/preference-link';

/*
 * The notification intelligence layer (prompt 14).
 *
 * Built on top of the decider above rather than beside it: this scores and
 * suppresses, and the existing decider still owns the immediate/digest split
 * and the schedule. Two competing notification systems would be worse than one
 * imperfect one.
 */
export * from './scoring/notification-score';
export * from './scoring/timing';
export * from './suppression/suppression-engine';
export * from './digest/digest-planner';
export * from './links/link-validator';
export * from './analytics/engagement';
export * from './templates/intelligence-templates';
