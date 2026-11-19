import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_EVENTS } from '@job-intel/contracts';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '../testing';
import { EventRepository } from './system-repository';

/**
 * The TypeScript union and the Postgres enum must agree.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `SYSTEM_EVENTS` is the source of both: `pgEnum('system_event_name', ...)`
 * reads it, and so does every caller. But drizzle-kit generates no migration
 * when an enum's members change, so adding a name to the array updates the
 * types and leaves the deployed database rejecting it.
 *
 * The result is invisible by design. `EventRecorder` deliberately swallows
 * sink failures — observability must never take down the operation it
 * observes — so the insert fails, one line is logged, and the event is gone.
 * It has already happened twice: once to the search-configuration events, and
 * once to `SYSTEM_START_FAILED`, which is the event that reports a worker
 * crashing on startup. That one was swallowed by the very mechanism meant to
 * make a silent crash loud.
 *
 * Asserting every name round-trips turns the next drift into a failing test
 * instead of a deployment that quietly loses its audit trail.
 */
describe('system event enum', () => {
  let ctx: TestDatabase;

  beforeEach(async () => {
    ctx ??= await createTestDatabase();
    await resetTestDatabase(ctx.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('accepts every event name the code can emit', async () => {
    const repo = new EventRepository(ctx.db);

    // Each name inserted individually: a bulk insert would fail on the first
    // bad member and name only that one, when the useful report is all of them.
    const rejected: string[] = [];
    for (const name of SYSTEM_EVENTS) {
      try {
        await repo.record({
          name,
          severity: 'info',
          message: null,
          traceId: null,
          sourceId: null,
          jobId: null,
          runId: null,
          data: {},
        });
      } catch {
        rejected.push(name);
      }
    }

    expect(
      rejected,
      'These names exist in SYSTEM_EVENTS but not in the system_event_name enum. ' +
        'Add a migration: ALTER TYPE "public"."system_event_name" ADD VALUE IF NOT EXISTS ...',
    ).toEqual([]);
  });
});
