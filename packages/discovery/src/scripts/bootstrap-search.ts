import { randomUUID } from 'node:crypto';
import { loadDotenv, loadEnv } from '@job-intel/config';
import { searchProfileSchema, type SearchProfile } from '@job-intel/contracts';
import {
  CandidateRepository,
  ProfileRepository,
  SearchConfigRepository,
  createDatabase,
  optionsFromEnv,
} from '@job-intel/db';

/**
 * Creates the first search profile: `pnpm bootstrap:search`
 *
 * A freshly seeded system has a *candidate* profile — who the user is — and no
 * *search* profile — what they are looking for. Those are deliberately separate
 * (Prompt 15 forbids merging candidate facts with search preferences), but the
 * consequence was a system with nothing to schedule, which ran indefinitely and
 * discovered nothing while reporting itself healthy.
 *
 * This derives an opening search strategy from the preferences the candidate
 * already stated, so the system has something to do on day one. It is a
 * starting point, not an inference engine: every field here comes from
 * something the user actually said, and anything they did not say is left at
 * its default rather than guessed. Editing it afterwards in the Control Center
 * is the expected next step.
 *
 * Idempotent — if a search profile already exists, it changes nothing.
 */

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const handle = await createDatabase(optionsFromEnv(env));

  try {
    const profiles = new ProfileRepository(handle.db);
    const searchConfig = new SearchConfigRepository(handle.db);

    const active = await profiles.getActiveProfile();

    if (!active) {
      console.error('No active candidate profile. Run `pnpm db:seed` first.');
      process.exitCode = 1;
      return;
    }

    const payload = active.payload as Record<string, unknown>;

    /*
     * Matching preferences come first, and are a third thing again.
     *
     * Three records describe the candidate and each has its own consumer: the
     * *candidate profile* holds facts, the *search profile* holds what to look
     * for, and *preferences* hold how to weigh a job once found — which is what
     * the matching engine reads. `initialisePreferences` documents itself as
     * used "on first run and by seeding", and nothing called it, so matching
     * failed with "No active preferences" against a fully seeded database.
     */
    await ensurePreferences(new CandidateRepository(handle.db), active.profileId, payload);

    const existing = await searchConfig.listProfiles(active.profileId);

    if (existing.length > 0) {
      console.log(
        `A search profile already exists (${existing.length}). Preferences checked; nothing else to do.`,
      );
      return;
    }

    const preferences = (payload['preferences'] ?? {}) as Record<string, unknown>;
    const professional = (payload['professional'] ?? {}) as Record<string, unknown>;
    const exclusions = (payload['exclusions'] ?? {}) as Record<string, unknown>;

    const location = (preferences['location'] ?? {}) as Record<string, unknown>;
    const salary = (preferences['salary'] ?? {}) as Record<string, unknown>;

    const titles = asStrings(preferences['desiredTitles']);
    const remoteTypes = new Set(asStrings(location['remoteTypes']));

    /*
     * Remote preference is read from the arrangements the candidate accepted,
     * not inferred from anything else. Where they accepted several, the
     * matching preference is the one that permits all of them — narrowing it
     * would silently discard opportunities they said they wanted.
     */
    const remote = remoteTypes.has('remote');
    const hybrid = remoteTypes.has('hybrid');
    const onsite = remoteTypes.has('onsite');

    /*
     * Every combination, not just the remote-flavoured ones.
     *
     * The version this replaced tested only remote and hybrid, so a candidate
     * who accepted all three arrangements was recorded as REMOTE_OR_HYBRID —
     * silently dropping on-site, which in a market where most roles are on-site
     * is most of the market. It read as a sensible default and was a
     * three-branch conditional that had simply never been given a third option.
     */
    const remotePreference =
      remote && hybrid && onsite
        ? 'ANY'
        : remote && hybrid
          ? 'REMOTE_OR_HYBRID'
          : remote && onsite
            ? 'REMOTE_OR_ONSITE'
            : hybrid && onsite
              ? 'HYBRID_OR_ONSITE'
              : remote
                ? 'REMOTE_ONLY'
                : hybrid
                  ? 'HYBRID_ONLY'
                  : onsite
                    ? 'ONSITE_ONLY'
                    : 'ANY';

    const draft: SearchProfile = searchProfileSchema.parse({
      id: randomUUID(),
      candidateId: active.profileId,
      profileName: 'Default Search',
      description: 'Created from your candidate preferences. Edit freely.',
      state: 'active',
      enabled: true,

      roles: titles.slice(0, 20).map((title, index) => ({
        title,
        priority: index === 0 ? 'primary' : 'secondary',
        rank: index,
      })),

      locations: [
        ...asStrings(location['countries']).map((value) => ({ kind: 'country', value })),
        ...asStrings(location['cities']).map((value) => ({ kind: 'city', value })),
      ],
      excludedLocations: [
        ...asStrings(exclusions['countries']).map((value) => ({ kind: 'country', value })),
        ...asStrings(exclusions['cities']).map((value) => ({ kind: 'city', value })),
      ],
      remotePreference,

      employmentTypes: asStrings(preferences['employmentTypes']),
      seniorityLevels: asStrings(preferences['seniorityLevels']),

      /*
       * Skills land as `preferred`, never `required`, whatever the candidate
       * marked as primary. A skill the user listed about *themselves* is not
       * the same statement as "reject any job that omits this" — reading it the
       * second way is exactly the over-filtering Prompt 18 rules out.
       */
      skills: asSkills(professional['skills']).slice(0, 40),
      excludedSkills: asStrings(exclusions['technologies']).slice(0, 40),

      salary: {
        minimum: typeof salary['minimum'] === 'number' ? salary['minimum'] : null,
        currency: typeof salary['currency'] === 'string' ? salary['currency'] : 'USD',
        /*
         * `preferred`, not `strict`, and unstated salaries accepted. Most
         * postings state no salary at all; a strict floor here would discard
         * the majority of the market to enforce a number nothing contradicted.
         */
        strictness: 'preferred',
        acceptUnstated: true,
      },

      /* Empty means every enabled source. Narrow it in the Control Center. */
      sources: [],
      searchFrequency: 'hourly',
    });

    const created = await searchConfig.createProfile(draft);

    console.log('Search profile created.\n');
    console.log(`  name            ${created.profileName}`);
    console.log(`  roles           ${created.roles.map((r) => r.title).join(', ') || '—'}`);
    console.log(`  remote          ${created.remotePreference}`);
    console.log(`  locations       ${created.locations.map((l) => l.value).join(', ') || 'anywhere'}`);
    console.log(`  skills          ${created.skills.length}`);
    console.log(`  frequency       ${created.searchFrequency}`);
    console.log(`  sources         all enabled`);
    console.log(
      '\nThe worker will reconcile this into schedules within a minute of its next tick.',
    );
  } finally {
    await handle.close();
  }
}

/**
 * Creates matching preferences when none exist.
 *
 * Derived from the same stated facts as the search profile, and deliberately
 * *not* shared with it: the search profile decides what gets fetched, these
 * decide how a fetched job scores. Keeping them separate is what lets someone
 * search broadly and still rank narrowly.
 */
async function ensurePreferences(
  candidates: CandidateRepository,
  profileId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const current = await candidates.getActivePreferences(profileId);

  if (current) {
    console.log(`Matching preferences already present (v${current.version}).`);
    return;
  }

  const preferences = (payload['preferences'] ?? {}) as Record<string, unknown>;
  const professional = (payload['professional'] ?? {}) as Record<string, unknown>;
  const exclusions = (payload['exclusions'] ?? {}) as Record<string, unknown>;
  const location = (preferences['location'] ?? {}) as Record<string, unknown>;
  const salary = (preferences['salary'] ?? {}) as Record<string, unknown>;

  const remoteTypes = new Set(asStrings(location['remoteTypes']));

  const weighted = (values: readonly string[], strength: string) =>
    values.map((value) => ({ value, strength, hard: false, note: null, source: 'explicit' }));

  const created = await candidates.initialisePreferences(profileId, {
    titles: weighted(asStrings(preferences['desiredTitles']), 'strongly_preferred'),
    countries: weighted(asStrings(location['countries']), 'preferred'),

    /*
     * Work authorisation, derived from the countries the candidate named.
     *
     * Nothing used to populate this, and the consequence was severe in the
     * system this was forked from: the on-site presence check refuses to judge
     * a posting when authorisation is unrecorded, so every on-site role
     * anywhere in the world came back UNKNOWN and sailed through. It took a
     * Munich job landing in a Lagos candidate's inbox to find it.
     *
     * Here it matters even more, because on-site is in scope rather than
     * excluded — without this, "on-site presence" is a permanent caveat on
     * every single match instead of a cleared check.
     *
     * This is a *statement the user made about where they want to work*, used
     * as where they can work. That is sound when the two coincide, and the
     * Control Centre is where it gets corrected when they do not. It is not
     * inferred from a name, a timezone, or the sources configured.
     */
    workAuthorization: {
      authorizedCountries: asStrings(location['countries']),
      willingToRelocate: location['willingToRelocate'] === true,
      relocationCountries: asStrings(location['relocationCountries']),
      sponsorshipRequirement:
        typeof preferences['visaSponsorship'] === 'string'
          ? preferences['visaSponsorship']
          : 'not_needed',
    },
    cities: weighted(asStrings(location['cities']), 'preferred'),

    /*
     * `REMOTE_PREFERRED` rather than `REMOTE_ONLY` when hybrid is also
     * acceptable. Reading "remote and hybrid" as remote-only would discard
     * every hybrid role the candidate explicitly said they would take.
     */
    workArrangement: remoteTypes.has('remote')
      ? remoteTypes.has('hybrid')
        ? 'REMOTE_PREFERRED'
        : 'REMOTE_ONLY'
      : remoteTypes.has('hybrid')
        ? 'HYBRID_ACCEPTED'
        : 'ANY',

    salary: {
      minimum: typeof salary['minimum'] === 'number' ? salary['minimum'] : null,
      currency: typeof salary['currency'] === 'string' ? salary['currency'] : 'USD',
    },

    employmentTypes: weighted(asStrings(preferences['employmentTypes']), 'preferred'),
    seniorityLevels: asStrings(preferences['seniorityLevels']),
    technologies: weighted(asSkills(professional['skills']).map((s) => s.value), 'preferred'),
    excludedKeywords: asStrings(exclusions['keywords']),
  });

  console.log(`Matching preferences created (v${created.version}).`);
}


function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function asSkills(value: unknown): Array<{ value: string; tier: 'preferred' }> {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        return (entry as { name: string }).name;
      }
      return null;
    })
    .filter((name): name is string => name !== null)
    .map((name) => ({ value: name, tier: 'preferred' as const }));
}

main().catch((error: unknown) => {
  console.error('[bootstrap:search] failed:', error);
  process.exit(1);
});
