import { describe, expect, it } from 'vitest';
import { sourcesNeedingFanOut } from './execution-engine';

/*
 * Every enabled source was being fetched twice an hour: once by its own
 * SOURCE_SCAN schedule and once by the profile-scan fan-out.
 *
 * Making the two agree on an idempotency key was not enough to collapse them.
 * `tasks_idempotency_live_unique` is a partial index over live statuses only —
 * deliberately, so that an hourly scan is not blocked forever by the first one
 * that succeeded — which means a scan that COMPLETES frees its key. The two
 * enqueues landed about five seconds apart, and the first scan finished inside
 * that gap often enough to let the duplicate through.
 *
 * So the rule is not "produce the duplicate and hope it collapses". It is
 * "do not produce it".
 */
describe('profile scan fan-out', () => {
  const sources = [{ id: 'jobberman-sales' }, { id: 'jooble-ng' }, { id: 'brand-new-board' }];

  it('skips the sources a schedule already covers', () => {
    const result = sourcesNeedingFanOut(sources, [
      { taskType: 'SOURCE_SCAN', sourceId: 'jobberman-sales' },
      { taskType: 'SOURCE_SCAN', sourceId: 'jooble-ng' },
    ]);

    expect(result.map((s) => s.id)).toEqual(['brand-new-board']);
  });

  it('covers a source that has no schedule yet', () => {
    // Reconciliation derives schedules on a timer, so a newly added source has
    // a window where nothing else will scan it. That is what this is for.
    expect(sourcesNeedingFanOut(sources, []).map((s) => s.id)).toEqual([
      'jobberman-sales',
      'jooble-ng',
      'brand-new-board',
    ]);
  });

  it('treats a disabled schedule as covered rather than as a gap', () => {
    // myjobmag is switched off on purpose. A fan-out that scanned it anyway
    // would quietly overrule that decision every hour.
    const result = sourcesNeedingFanOut([{ id: 'myjobmag' }], [
      { taskType: 'SOURCE_SCAN', sourceId: 'myjobmag' },
    ]);

    expect(result).toEqual([]);
  });

  it('ignores schedules that are not source scans', () => {
    const result = sourcesNeedingFanOut([{ id: 'jooble-ng' }], [
      { taskType: 'RANK_JOBS', sourceId: null },
      { taskType: 'ENRICH_JOB', sourceId: null },
      { taskType: 'MATCH_JOB', sourceId: null },
    ]);

    expect(result.map((s) => s.id)).toEqual(['jooble-ng']);
  });
});
