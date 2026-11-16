/**
 * @job-intel/scheduler
 *
 * The durable execution engine: a Postgres-backed task queue, a leader-elected
 * scheduler, and a worker runtime. Together they are what lets the system run
 * unattended — deciding what is due, distributing it across however many
 * workers exist, and surviving the crashes, rate limits and restarts that
 * happen in between.
 *
 * The BullMQ port in `@job-intel/queue` is untouched and still moves work
 * between pipeline stages. This package answers a different question: not "what
 * happens next to this job" but "what should the system be doing right now".
 */
export * from './task-queue';
export * from './dead-letters';
export * from './coordination';
export * from './scheduler';
export * from './worker-runtime';
export * from './reconciliation';
