/**
 * Notification CLI: `pnpm notify [--digest] [--health] [--deliver] [--send]`
 *
 * Runs the real decision pass against the real corpus and prints what would be
 * sent, why, and what was held back. Sends nothing unless `--send` is given and
 * a provider is configured — the point is to *look at* the decisions before
 * trusting the system with someone's inbox.
 */
import { loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  CandidateRepository,
  EventRepository,
  NotificationRepository,
  ProfileRepository,
  RecommendationRepository,
  SourceRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { NOTIFICATION_ENGINE_VERSION } from '@job-intel/contracts';
import { MemoryEmailProvider, ResendEmailProvider } from '@job-intel/notifications';
import { NotificationService } from '../notification-service';

function parseArgs(argv: string[]) {
  return {
    digest: argv.includes('--digest'),
    health: argv.includes('--health'),
    deliver: argv.includes('--deliver'),
    send: argv.includes('--send'),
  };
}

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
    base: { service: 'notify-cli' },
  });

  const handle = await createDatabase(optionsFromEnv(env));
  const events = new EventRecorder(logger, new EventRepository(handle.db));

  const profiles = new ProfileRepository(handle.db);
  const profile = await profiles.getActiveProfile();
  if (!profile) {
    console.error('No active candidate profile.');
    await handle.close();
    process.exitCode = 1;
    return;
  }

  const notifications = new NotificationRepository(handle.db);

  // Captures instead of sending unless explicitly told otherwise, so running
  // this by accident cannot email anyone.
  const memory = new MemoryEmailProvider();
  const provider =
    args.send && env.RESEND_API_KEY ? new ResendEmailProvider(env.RESEND_API_KEY) : memory;

  const service = new NotificationService({
    notifications,
    recommendations: new RecommendationRepository(handle.db),
    candidates: new CandidateRepository(handle.db),
    profiles,
    sources: new SourceRepository(handle.db),
    logger,
    events,
    provider,
    config: { enabled: true, appUrl: env.APP_URL },
    preferenceSecret: env.FEEDBACK_TOKEN_SECRET ?? null,
    fromEmail: env.NOTIFICATION_FROM_EMAIL ?? 'notifications@localhost',
  });

  console.log(`\nNotification engine ${NOTIFICATION_ENGINE_VERSION}`);
  console.log(`Profile ${profile.profileId} (v${profile.version})`);
  console.log(`Provider ${provider.id}${args.send ? '' : ' (dry run — nothing will be sent)'}\n`);

  const { preferences, lastDigestAt } = await notifications.getPreferences(profile.profileId);
  console.log('── Preferences ────────────────────────────────────');
  console.log(`email            ${preferences.email ?? '(not set)'}`);
  console.log(`timezone         ${preferences.timezone}`);
  console.log(`digest           ${preferences.digestEnabled ? preferences.digestFrequency : 'disabled'} at ${preferences.digestTime}`);
  console.log(`immediate alerts ${preferences.immediateAlertsEnabled ? `max ${preferences.maxAlertsPerDay}/day` : 'disabled'}`);
  console.log(`thresholds       match ${preferences.minimumMatchScore} · rec ${preferences.minimumRecommendationScore} · conf ${preferences.minimumConfidence}`);
  console.log(`quiet hours      ${preferences.quietHours.enabled ? `${preferences.quietHours.start}–${preferences.quietHours.end}` : 'off'}`);
  console.log(`last digest      ${lastDigestAt ? lastDigestAt.toISOString() : 'never'}\n`);

  if (args.health) {
    const health = await service.processSourceHealth(profile.profileId);
    console.log('── Source health ──────────────────────────────────');
    console.log(`checked ${health.checked}, alerted ${health.alerted}\n`);
  }

  const run = await service.processCandidate(profile.profileId, {
    forceDigest: args.digest,
    reason: 'cli',
  });

  console.log('── Decision pass ──────────────────────────────────');
  console.log(`considered  ${run.considered}`);
  console.log(`alerts      ${run.immediateAlerts}`);
  console.log(`digest      ${run.digestSent ? `sent with ${run.digestJobs} job(s)` : 'not sent'}`);
  console.log(`suppressed  ${run.suppressed}`);
  console.log(`decisions   ${run.decisionsRecorded}`);
  console.log(`duration    ${run.durationMs} ms`);

  console.log('\n── Outcomes ───────────────────────────────────────');
  for (const [outcome, count] of Object.entries(run.byOutcome).sort((a, b) => b[1] - a[1])) {
    console.log(`${outcome.padEnd(34)} ${String(count).padStart(4)}`);
  }

  // The trace is the point: a system that stays quiet must say why.
  const recent = await notifications.recentDecisions(profile.profileId, 12);
  if (recent.length > 0) {
    console.log('\n── Why each job was or was not notified ───────────');
    for (const row of recent) {
      console.log(`\n  ${row.decision.outcome}`);
      console.log(`    ${row.job?.title ?? 'unknown'} — ${row.job?.companyNameRaw ?? 'unknown'}`);
      console.log(`    ${row.decision.reason}`);
    }
  }

  if (args.deliver) {
    const delivery = await service.processDeliveries();
    console.log('\n── Delivery ───────────────────────────────────────');
    console.log(`attempted ${delivery.attempted} · sent ${delivery.sent} · retrying ${delivery.retrying} · failed ${delivery.failed}`);

    for (const message of memory.sent) {
      console.log(`\n  → ${message.to}`);
      console.log(`    ${message.email.subject}`);
      console.log(`    html ${message.email.html.length} bytes · text ${message.email.text.length} bytes`);
      console.log(`    key ${message.email.idempotencyKey.slice(0, 16)}…`);
    }
  }

  const history = await notifications.history(profile.profileId, 10);
  console.log('\n── History ────────────────────────────────────────');
  if (history.length === 0) {
    console.log('nothing queued');
  } else {
    for (const row of history) {
      console.log(
        `  ${row.event.type.padEnd(16)} ${(row.delivery?.status ?? 'none').padEnd(10)} ` +
          `${row.event.jobIds.length} job(s)  ${row.event.subject.slice(0, 60)}`,
      );
    }
  }

  console.log('');
  await handle.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
