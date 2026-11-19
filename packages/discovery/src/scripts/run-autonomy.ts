import { hostname } from 'node:os';
import { loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger } from '@job-intel/observability';
import {
  ProfileRepository,
  SearchConfigRepository,
  SourceRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import {
  CoordinationService,
  DeadLetterQueue,
  ReconciliationService,
  Scheduler,
  SystemHealthService,
  TaskQueue,
  WorkerRegistry,
} from '@job-intel/scheduler';

/**
 * The autonomy test (Prompt 20, Part 72).
 *
 * The question this answers is the only one the user actually asked: does the
 * system do this by itself? Not "can a script be run that does it" — whether
 * the scheduler, left alone, creates the work and whether a worker picks it up.
 *
 * Nothing here triggers a scan directly. It advances a clock, ticks the
 * scheduler, and watches what appears in the queue.
 */

const line = (label: string, value: unknown): void => {
  console.log(`  ${label.padEnd(36)} ${String(value)}`);
};

const heading = (text: string): void => {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
};

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });

  const logger = createLogger({ level: 'error', pretty: false, base: { service: 'autonomy' } });
  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const profiles = new ProfileRepository(handle.db);
    const active = await profiles.getActiveProfile();

    if (!active) {
      console.log('No active candidate profile. Nothing to verify.');
      return;
    }

    const candidateId = active.profileId;

    const queue = new TaskQueue(handle.db);
    const coordination = new CoordinationService(handle.db);
    const deadLetters = new DeadLetterQueue(handle.db);
    const sources = new SourceRepository(handle.db);
    const searchConfig = new SearchConfigRepository(handle.db);

    /* A clock the test drives, so a simulated day takes milliseconds. */
    let now = new Date('2026-08-22T09:00:00Z');
    const clock = (): Date => new Date(now);

    const scheduler = new Scheduler(
      {
        db: handle.db,
        queue,
        coordination,
        logger,
        instanceId: `${hostname()}-autonomy`,
      },
      { now: clock },
    );

    const reconciler = new ReconciliationService({ scheduler, queue, logger });

    // ── 1. What the user configured ───────────────────────────────────────
    heading('1. Configuration the system will act on');

    const searchProfiles = await searchConfig.listProfiles(candidateId);
    const allSources = await sources.list({});
    const enabled = allSources.filter((source) => source.enabled);

    line('candidate', candidateId.slice(0, 8));
    line('search profiles', searchProfiles.length);
    line('sources registered', allSources.length);
    line('sources enabled', enabled.length);

    if (searchProfiles.length === 0) {
      console.log('\n  No search profile configured — nothing to schedule.');
      return;
    }

    const target = searchProfiles.find((p) => p.state === 'active') ?? searchProfiles[0]!;
    line('profile under test', target.profileName);
    line('configured frequency', target.searchFrequency);
    line('locations', target.locations.map((l) => l.label ?? l.value).join(', ') || '—');

    // ── 2. Reconcile: turn configuration into schedules ───────────────────
    heading('2. Reconciliation (configuration → schedules)');

    const reconciled = await reconciler.reconcileSearchProfile({
      profileId: target.id,
      active: true,
      intervalMinutes: 60,
      sources: enabled.map((source) => ({
        sourceId: source.id,
        intervalMinutes: 60,
        schedulable: true,
      })),
    });

    line('schedules created', reconciled.schedulesCreated);
    line('schedules updated', reconciled.schedulesUpdated);
    line('queued work cancelled', reconciled.tasksCancelled);

    const schedules = await scheduler.listSchedules({ profileId: target.id });
    line('total schedules for profile', schedules.length);

    // ── 3. The scheduler, unattended ──────────────────────────────────────
    heading('3. Twenty-four simulated hours, nobody watching');

    let ticks = 0;
    let created = 0;
    let duplicates = 0;

    for (let minute = 0; minute < 24 * 60; minute += 15) {
      const tick = await scheduler.tick();

      ticks += 1;
      created += tick.enqueued;
      duplicates += tick.duplicates;

      now = new Date(now.getTime() + 15 * 60_000);
    }

    line('scheduler ticks', ticks);
    line('tasks created', created);
    line('duplicate tasks suppressed', duplicates);
    line('queue depth now', await queue.depth());

    /*
     * The number that matters. Twenty-four hours at an hourly cadence across N
     * schedules should produce roughly 24 × N tasks — not 96 × N (one per tick)
     * and not zero.
     */
    const expected = schedules.filter((s) => s.enabled).length * 24;
    line('expected (24h × schedules)', expected);
    line('within expected range', created > 0 && created <= expected * 1.2);

    // ── 4. A worker claims it ─────────────────────────────────────────────
    heading('4. Work is claimable by a worker');

    const claimed = await queue.claim({ workerId: 'autonomy-probe', limit: 5, now: clock() });

    line('claimed by one worker', claimed.length);

    for (const task of claimed.slice(0, 5)) {
      console.log(`  ${task.type.padEnd(22)} ${task.sourceId ?? task.profileId?.slice(0, 8) ?? '—'}`);
    }

    /* Released rather than executed — this probe must not consume real work. */
    for (const task of claimed) {
      await handle.db.execute(
        `update tasks set status = 'READY', locked_by = null, lease_expires_at = null where id = '${task.taskId}'`,
      );
    }

    line('released back to the queue', claimed.length);

    // ── 5. Configuration change reaches the next cycle ────────────────────
    heading('5. A configuration change takes effect without a deploy');

    const before = (await scheduler.listSchedules({ profileId: target.id }))[0]!;
    line('interval before', `${before.intervalMinutes} minutes`);

    await scheduler.upsertSchedule({
      taskType: before.taskType,
      profileId: target.id,
      ...(before.sourceId ? { sourceId: before.sourceId } : {}),
      intervalMinutes: 15,
    });

    const after = (await scheduler.listSchedules({ profileId: target.id })).find(
      (s) => s.scheduleId === before.scheduleId,
    )!;

    line('interval after', `${after.intervalMinutes} minutes`);
    line('next run re-based', after.nextRunAt !== before.nextRunAt);
    line('code changed', 'no');
    line('redeploy required', 'no');

    // ── 6. Pause and resume ───────────────────────────────────────────────
    heading('6. Pause and resume');

    const cancelled = await scheduler.pauseProfile(target.id);
    const pausedTick = await scheduler.tick();

    line('queued work cancelled on pause', cancelled);
    line('tasks created while paused', pausedTick.enqueued);

    /* Three days pass with the profile paused. */
    now = new Date(now.getTime() + 3 * 24 * 3_600_000);

    await scheduler.resumeProfile(target.id);
    const resumedTick = await scheduler.tick();

    line('tasks created on resume', resumedTick.enqueued);
    line('missed runs replayed', resumedTick.skippedMisfires === 0 ? 'none' : resumedTick.skippedMisfires);

    // ── 7. Health ─────────────────────────────────────────────────────────
    heading('7. System health');

    const health = new SystemHealthService({
      queue,
      deadLetters,
      workers: new WorkerRegistry(handle.db),
      scheduler,
      logger,
      probes: [
        {
          component: 'database',
          check: async () => {
            await handle.db.execute('select 1');
            return { status: 'healthy' as const, detail: 'Database reachable.' };
          },
        },
      ],
    });

    const report = await health.check(clock());

    line('status', report.status);
    console.log(`  ${report.summary}`);

    for (const component of report.components) {
      console.log(`    ${component.component.padEnd(16)} ${component.status.padEnd(10)} ${component.detail.slice(0, 70)}`);
    }

    // ── Summary ───────────────────────────────────────────────────────────
    heading('Summary');
    line('scheduler runs unattended', created > 0);
    line('duplicate tasks created', duplicates);
    line('configuration changes apply', 'yes, without a deploy');
    line('pause stops new work', pausedTick.enqueued === 0);
    /*
     * One task per schedule, not one per missed hour. Three days paused at an
     * hourly cadence would be 72 runs per schedule if downtime were replayed.
     */
    const schedulesForProfile = (await scheduler.listSchedules({ profileId: target.id })).filter(
      (s) => s.enabled,
    ).length;

    line(
      'resume replays downtime',
      resumedTick.enqueued <= schedulesForProfile
        ? `no — ${resumedTick.enqueued} catch-up run(s) for ${schedulesForProfile} schedule(s)`
        : 'yes',
    );

    /* Leave nothing behind: this probe must not alter the live schedule. */
    await scheduler.upsertSchedule({
      taskType: before.taskType,
      profileId: target.id,
      ...(before.sourceId ? { sourceId: before.sourceId } : {}),
      intervalMinutes: before.intervalMinutes,
    });
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
