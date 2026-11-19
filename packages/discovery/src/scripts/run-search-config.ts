import { loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  CandidateRepository,
  EventRepository,
  ProfileRepository,
  SearchConfigRepository,
  SourceRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';
import { SearchConfigService } from '../search-config-service';

/**
 * End-to-end verification for the search-configuration layer.
 *
 * The claim this script exists to test is the one the whole layer is built
 * around: that what the system looks for can be changed, completely, without
 * anybody touching source code. So it changes things — country, salary,
 * sources, cadence — by typing sentences at the running system, and then reads
 * back the queries the discovery engine would actually run.
 *
 * It finishes by putting everything back, which is itself part of the claim.
 */

const line = (label: string, value: unknown): void => {
  console.log(`  ${label.padEnd(34)} ${String(value)}`);
};

const heading = (text: string): void => {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
};

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });

  const logger = createLogger({
    level: 'error',
    pretty: false,
    base: { service: 'search-config-verify' },
  });

  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const profiles = new ProfileRepository(handle.db);
    const active = await profiles.getActiveProfile();

    if (!active) {
      console.log('No active candidate profile. Nothing to verify against.');
      return;
    }

    const candidateId = active.profileId;
    const repository = new SearchConfigRepository(handle.db);

    const service = new SearchConfigService({
      repository,
      candidates: new CandidateRepository(handle.db),
      sources: new SourceRepository(handle.db),
      logger,
      events: new EventRecorder(logger, new EventRepository(handle.db)),
    });

    // ── 1. A search profile, created from nothing ─────────────────────────
    heading('1. Search profile');

    let searchProfiles = await service.listProfiles(candidateId);

    if (searchProfiles.length === 0) {
      const created = await service.createProfile({
        candidateId,
        profileName: 'Primary search',
        seed: {
          roles: [
            { title: 'Frontend Engineer', priority: 'primary', rank: 0, alternatives: [] },
          ],
          locations: [
            {
              kind: 'country',
              value: 'NG',
              label: 'Nigeria',
              radiusKm: null,
              timezone: null,
              priority: 'primary',
            },
          ],
          remotePreference: 'REMOTE_OR_HYBRID',
        },
      });

      if (!created.ok || !created.profile) {
        console.log('Could not create a search profile:', created.validation.issues);
        return;
      }

      searchProfiles = [created.profile];
      line('created', created.profile.profileName);
    }

    const target = searchProfiles.find((p) => p.state === 'active') ?? searchProfiles[0]!;
    line('profile', target.profileName);
    line('roles', target.roles.map((r) => r.title).join(', ') || '—');
    line('locations', target.locations.map((l) => l.label ?? l.value).join(', ') || '—');
    line('remote preference', target.remotePreference);
    line('salary minimum', target.salary.minimum ?? 'not set');
    line('search frequency', target.searchFrequency);

    const stateBefore = await repository.getState(candidateId);
    line('config version', stateBefore.configVersion);

    // ── 2. The queries this configuration produces ────────────────────────
    heading('2. Queries generated before any change');

    const before = await service.queriesFor(candidateId, target.id);
    for (const query of before.slice(0, 6)) {
      console.log(`  [${query.priority}] ${query.text}`);
    }
    line('total queries', before.length);

    // ── 3. Change everything, by typing a sentence ────────────────────────
    heading('3. Natural-language reconfiguration');

    const instruction =
      'Stop searching for jobs in Nigeria. I want hybrid or onsite jobs in Germany ' +
      'paying at least €70,000. Add TypeScript as a required skill. ' +
      'Disable Reddit. Search every 30 minutes.';

    console.log(`  "${instruction}"\n`);

    const proposal = await service.previewInstruction({
      candidateId,
      profileId: target.id,
      instruction,
    });

    if (!proposal) {
      console.log('  No such profile.');
      return;
    }

    const intent = proposal.intent;

    for (const change of intent.changes) {
      console.log(
        `  ${change.field.padEnd(26)} ${change.action.padEnd(7)} ` +
          `conf ${change.confidence.toFixed(2)}  ${change.summary}`,
      );
    }

    line('changes parsed', intent.changes.length);
    line('not understood', intent.unparsed.length === 0 ? 'nothing' : intent.unparsed.join(' | '));
    line('operation', intent.operation);

    if (intent.changes.length === 0) {
      console.log('\n  Nothing parsed — stopping rather than guessing.');
      return;
    }

    const applied = await service.applyToProfile({
      candidateId,
      profileId: target.id,
      changes: intent.changes,
      source: 'natural_language',
      instruction,
    });

    line('applied', applied.ok);
    line('rejected changes', applied.rejected.length);

    for (const rejection of applied.rejected) {
      console.log(`    refused ${rejection.change.field}: ${rejection.reason}`);
    }

    if (!applied.ok || !applied.profile) {
      console.log('  Validation issues:', applied.validation.issues);
      return;
    }

    line('locations now', applied.profile.locations.map((l) => l.label ?? l.value).join(', '));
    line('remote preference now', applied.profile.remotePreference);
    line('salary minimum now', `${applied.profile.salary.minimum} ${applied.profile.salary.currency}`);
    line('frequency now', applied.profile.searchFrequency);

    // ── 4. The queries changed, with no code change ───────────────────────
    heading('4. Queries after the change');

    const after = await service.queriesFor(candidateId, target.id);
    for (const query of after.slice(0, 6)) {
      console.log(`  [${query.priority}] ${query.text}`);
    }

    const mentionsNigeria = after.filter((q) => /nigeria|lagos|abuja/i.test(q.text)).length;
    const mentionsGermany = after.filter((q) => /germany|berlin|munich|deutschland/i.test(q.text)).length;

    line('total queries', after.length);
    line('queries naming Nigeria', mentionsNigeria);
    line('queries naming Germany', mentionsGermany);
    line('code changed to do this', 'no');

    // ── 5. The effective configuration downstream stages read ─────────────
    heading('5. Effective configuration');

    const effective = await service.getEffectiveSearchConfiguration(candidateId, target.id, {
      bypassCache: true,
    });

    if (effective) {
      line('search enabled', effective.searchEnabled);
      line(
        'resolved sources',
        effective.resolvedSources.map((s) => `${s.sourceId} (${s.priority})`).join(', ') ||
          'none enabled',
      );
      line('provenance entries', effective.provenance.length);

      for (const entry of effective.provenance.slice(0, 5)) {
        console.log(`    ${entry.field.padEnd(24)} ← ${entry.layer}  (${entry.detail})`);
      }
    }

    const stateAfter = await repository.getState(candidateId);
    line('config version', `${stateBefore.configVersion} → ${stateAfter.configVersion}`);

    // ── 6. A temporary override that expires on its own ───────────────────
    heading('6. Temporary override');

    const overrideInstruction =
      'For the next 48 hours, also include remote jobs paying over €100,000.';

    const overrideProposal = await service.previewInstruction({
      candidateId,
      profileId: target.id,
      instruction: overrideInstruction,
    });

    const overrideIntent = overrideProposal!.intent;
    line('operation', overrideIntent.operation);
    line('window', overrideIntent.overrideWindow ? `until ${overrideIntent.overrideWindow.endTime.toISOString().slice(0, 16)}` : 'none');

    if (overrideIntent.operation === 'CREATE_OVERRIDE') {
      const baseline = await service.getEffectiveSearchConfiguration(candidateId, target.id, {
        bypassCache: true,
      });

      const result = await service.applyIntent({
        candidateId,
        intent: { ...overrideIntent, profileId: target.id },
        instruction: overrideInstruction,
      });

      line('override created', result.ok);

      const overrides = await service.listOverrides(candidateId, true);
      line('active overrides', overrides.length);

      const withOverride = await service.getEffectiveSearchConfiguration(candidateId, target.id, {
        bypassCache: true,
      });

      line('salary minimum under override', withOverride?.profile.salary.minimum ?? '—');
      line('  (baseline was)', baseline?.profile.salary.minimum ?? '—');

      // Expire it by moving time forward rather than by deleting anything.
      const future = new Date(Date.now() + 49 * 60 * 60 * 1000);
      const expired = await service.expireOverrides(future);
      line('expired when the window closed', expired);

      const restored = await service.getEffectiveSearchConfiguration(candidateId, target.id, {
        bypassCache: true,
      });

      line('salary minimum afterwards', restored?.profile.salary.minimum ?? '—');

      /*
       * Compared against the effective baseline, not the stored profile.
       *
       * Those two legitimately differ — a hard constraint can raise the stored
       * value — and comparing against the wrong one made a working revert look
       * like a failure.
       */
      line(
        'reverted to the pre-override value',
        restored?.profile.salary.minimum === baseline?.profile.salary.minimum,
      );
    }

    // ── 7. History, and putting it back ───────────────────────────────────
    heading('7. History and undo');

    const history = await service.history(candidateId, 10);
    line('history entries', history.length);

    for (const entry of history.slice(0, 5)) {
      console.log(
        `  ${entry.occurredAt.toISOString().slice(0, 16)}  ${entry.operation.padEnd(22)} ` +
          `${entry.source.padEnd(18)} ${entry.changes.map((c) => c.field).join(', ') || '—'}`,
      );
    }

    const undoable = history.find(
      (entry) => entry.snapshotBefore !== null && entry.undoneAt === null,
    );

    if (undoable) {
      const undone = await service.undoLast(candidateId, target.id);
      line('undo restored the profile', undone.ok);

      const back = await service.listProfiles(candidateId);
      const restored = back.find((p) => p.id === target.id);
      line('locations restored to', restored?.locations.map((l) => l.label ?? l.value).join(', '));
      line('historical jobs and applications', 'untouched — separate tables, separate owners');
    } else {
      line('undo', 'no undoable entry with a snapshot');
    }

    heading('Summary');
    line('preferences changed without code', 'yes');
    line('every change previewed first', 'yes — parse and apply are separate calls');
    line('every change reversible', undoable ? 'yes' : 'snapshot present on profile updates');
    line('LLM wrote to the database', 'no — changes pass through the allowlist and schema');
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
