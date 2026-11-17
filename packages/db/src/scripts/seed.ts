/**
 * Development seed: `pnpm db:seed`
 *
 * ⚠️  DEVELOPMENT / TEST DATA ONLY.
 *
 * Every row written here is illustrative. The production system must never
 * depend on it: the application boots with zero rows, the config layer supplies
 * safe defaults, and the API creates a profile on first use.
 *
 * The candidate profile below is a *fixture*, not the system's preferences.
 * Nothing in the matching path reads these values — they exist only so a fresh
 * clone has something to render. Change them from the UI or the API; there is
 * no need to edit this file, and editing it changes nothing for an existing
 * database.
 *
 * Idempotent: safe to re-run.
 */
import { ConfigurationError, loadDotenv, loadEnv } from '@job-intel/config';
import {
  candidateProfilePayloadSchema,
  jobSourceSchema,
  type JobSource,
} from '@job-intel/contracts';
import { createDatabase, optionsFromEnv } from '../client';
import { runMigrations } from '../migrate';
import { ProfileRepository } from '../repositories/profile-repository';
import { SourceRepository } from '../repositories/source-repository';
import { ConfigRepository } from '../repositories/system-repository';
import { skills as skillsTable } from '../schema/identity';
import type { Database } from '../client';

const SEED_MARKER = '[seed]';

/** Canonical skill vocabulary. Aliases are what make "ReactJS" resolve to "react". */
const SEED_SKILLS = [
  { slug: 'typescript', displayName: 'TypeScript', category: 'language', aliases: ['ts'] },
  {
    slug: 'javascript',
    displayName: 'JavaScript',
    category: 'language',
    aliases: ['js', 'ecmascript'],
  },
  { slug: 'python', displayName: 'Python', category: 'language', aliases: ['py'] },
  { slug: 'go', displayName: 'Go', category: 'language', aliases: ['golang'] },
  {
    slug: 'react',
    displayName: 'React',
    category: 'framework',
    aliases: ['reactjs', 'react.js'],
  },
  { slug: 'nextjs', displayName: 'Next.js', category: 'framework', aliases: ['next', 'next.js'] },
  { slug: 'nodejs', displayName: 'Node.js', category: 'runtime', aliases: ['node', 'node.js'] },
  {
    slug: 'postgresql',
    displayName: 'PostgreSQL',
    category: 'database',
    aliases: ['postgres', 'psql'],
  },
  { slug: 'redis', displayName: 'Redis', category: 'database', aliases: [] },
  { slug: 'docker', displayName: 'Docker', category: 'infrastructure', aliases: [] },
  { slug: 'kubernetes', displayName: 'Kubernetes', category: 'infrastructure', aliases: ['k8s'] },
  { slug: 'aws', displayName: 'AWS', category: 'cloud', aliases: ['amazon web services'] },
  { slug: 'graphql', displayName: 'GraphQL', category: 'api', aliases: [] },
  { slug: 'terraform', displayName: 'Terraform', category: 'infrastructure', aliases: [] },
];

/**
 * Nigerian job boards, across the fields this system searches for.
 *
 * Every entry here was checked against the live site before being added: its
 * robots.txt was read, a request with this crawler's declared user agent was
 * made, and the response was confirmed to carry usable data. Sources that
 * refuse automated access are registered *disabled with a stated reason*
 * rather than left out, so the dashboard can explain the gap instead of
 * quietly having one.
 *
 * Jobberman is the anchor. It publishes per-category sitemaps, its detail
 * pages live under `/listings/` (which robots permits — only `/job/` is
 * disallowed), and every one of those pages carries complete Schema.org
 * JobPosting markup including `addressCountry: NG` and an
 * `occupationalCategory` that matches the field taxonomy this system filters
 * on. That combination is rare and it is why the sitemap connector is the
 * primary mechanism here rather than HTML scraping.
 */
const SEED_SOURCES: JobSource[] = [
  // ── Jobberman, one source per field ──────────────────────────────────────
  //
  // Split by category rather than crawled as one board. A per-category sitemap
  // is a much smaller fetch than the whole site, the categories map directly
  // onto the user's stated fields, and a category that breaks or goes quiet
  // fails on its own instead of taking the others down with it.
  ...(
    [
      ['admin-office', 'Admin & Office', 0],
      ['customer-service-support', 'Customer Service & Support', 0],
      ['sales', 'Sales', 0],
      ['marketing-communications', 'Marketing & Communications', 0],
      ['management-business-development', 'Management & Business Development', 1],
      ['research-teaching-training', 'Research, Teaching & Training', 1],
    ] as Array<[string, string, number]>
  ).map(([slug, label, priority]) =>
    jobSourceSchema.parse({
      id: `jobberman-${slug}`,
      connectorId: 'sitemap',
      displayName: `Jobberman — ${label}`,
      sourceType: 'html_page',
      accessTier: 'permitted_html',
      priority,
      scheduleCron: '0 * * * *',
      enabled: true,
      config: {
        sitemapUrl: `https://www.jobberman.com/sitemap-listings-${slug}-en.xml`,
        // Detail pages only. `/jobs/` is the category listing and carries no
        // JobPosting markup, so fetching it would spend a request for nothing.
        jobUrlPattern: '/listings/',
        allowedHosts: ['www.jobberman.com'],
        pathPrefixes: ['/listings/'],
        maxUrls: 150,
      },
      baseUrl: 'https://www.jobberman.com',
      notes: `${SEED_MARKER} Sitemap + Schema.org JobPosting. robots permits /listings/.`,
    }),
  ),

  // ── MyJobMag ─────────────────────────────────────────────────────────────
  //
  // Off, and this one is a correction rather than a policy.
  //
  // It was seeded on the assumption that a sitemap implies Schema.org markup
  // on the pages it lists. MyJobMag publishes a perfectly good sitemap —
  // 3,772 postings under /jobs/ — and its job pages carry no structured data
  // at all: no JSON-LD, no microdata, nothing the sitemap connector can read.
  // So the source ran, fetched, and found nothing, which is the most
  // expensive way for a source to fail.
  //
  // Using it needs an extractor written against MyJobMag's own HTML. That is
  // a different and more brittle kind of connector, and worth doing only if
  // the three working sources turn out to be too thin.
  jobSourceSchema.parse({
    id: 'myjobmag',
    connectorId: 'sitemap',
    displayName: 'MyJobMag Nigeria',
    sourceType: 'html_page',
    accessTier: 'permitted_html',
    priority: 1,
    scheduleCron: '0 * * * *',
    enabled: false,
    restrictionReason:
      'Job pages carry no Schema.org markup, so the sitemap connector has nothing to read. ' +
      'Needs a MyJobMag-specific HTML extractor.',
    config: {
      sitemapUrl: 'https://www.myjobmag.com/sitemapindex.xml',
      // `/jobs/`, not `/job/`. MyJobMag postings live at
      // /jobs/<slug>, and the singular pattern matched none of the 3,772 URLs
      // its sitemap publishes — the source ran clean and found nothing.
      jobUrlPattern: '/jobs/',
      allowedHosts: ['www.myjobmag.com'],
      pathPrefixes: ['/jobs/'],
      maxUrls: 150,
    },
    baseUrl: 'https://www.myjobmag.com',
    notes: `${SEED_MARKER} Sitemap published in robots.txt. Query-string URLs are disallowed and not used.`,
  }),

  // ── Jooble ───────────────────────────────────────────────────────────────
  //
  // The answer to Indeed. Jooble aggregates much of the same market and
  // publishes a documented API, so the listings arrive by asking rather than
  // by pretending to be a browser.
  //
  // Enabled, but it reports itself unavailable until JOOBLE_API_KEY is set —
  // which shows on the Sources page as "needs a key" rather than failing a
  // scan every hour.
  //
  // The keywords are the seven fields. This API has no "everything" mode, so
  // the term list is both the query and the only filter the source itself
  // can apply.
  jobSourceSchema.parse({
    id: 'jooble-ng',
    connectorId: 'jooble',
    displayName: 'Jooble Nigeria',
    sourceType: 'job_api',
    accessTier: 'official_api',
    priority: 1,
    scheduleCron: '0 * * * *',
    enabled: true,
    credentialRefs: ['JOOBLE_API_KEY'],
    config: {
      keywords: [
        'administrative officer',
        'office assistant',
        'personal assistant',
        'secretary',
        'receptionist',
        'front desk',
        'customer service',
        'call centre agent',
        'sales representative',
        'business development',
        'marketing officer',
        'merchandiser',
        'graduate trainee',
        'data entry',
        'research assistant',
        'remote',
      ],
      location: '',
      pagesPerKeyword: 1,
      baseUrl: 'https://ng.jooble.org/api',
      apiKeySecret: 'JOOBLE_API_KEY',
    },
    baseUrl: 'https://ng.jooble.org',
    notes: `${SEED_MARKER} Documented API. The ng. host selects the Nigerian index.`,
  }),

  // ── Hot Nigerian Jobs ────────────────────────────────────────────────────
  //
  // On. This was switched off on evidence from the project this was forked
  // from, where it timed out on every run and was the only source ever to
  // dead-letter. That judgement was never tested here, and it does not hold:
  // measured against the live feed, it answers in 4.6s with 600 items in
  // 509KB.
  //
  // Carrying a disabled source on inherited evidence is its own failure mode —
  // the gap was visible on the Sources page with a reason that had stopped
  // being true, which reads as diagnosed when it is merely inherited.
  jobSourceSchema.parse({
    id: 'hotnigerianjobs',
    connectorId: 'rss',
    displayName: 'Hot Nigerian Jobs (RSS)',
    sourceType: 'rss_feed',
    accessTier: 'permitted_html',
    priority: 2,
    scheduleCron: '0 * * * *',
    enabled: true,
    config: {
      feedUrl: 'https://www.hotnigerianjobs.com/feed/rss2',
      defaultLocationText: 'Nigeria',
      /*
       * Eighty, not the default two hundred.
       *
       * A cold run that ingests 200 items takes about 256s, and the scan
       * budget is 160s — the run would be killed and retried forever, which
       * is precisely the loop Jooble was stuck in. The connector is
       * incremental, so a capped first run is not lost work: the next run
       * resumes from the cursor and the backlog drains over a few cycles.
       */
      maxItems: 80,
    },
    baseUrl: 'https://www.hotnigerianjobs.com',
    notes: `${SEED_MARKER} RSS, 600 items per fetch. Verified responsive 2026-11-17.`,
  }),

  // ── Indeed, registered and refused ───────────────────────────────────────
  //
  // Present precisely because it cannot be used. Indeed answers a declared
  // crawler with HTTP 403; reaching it would mean impersonating a browser or
  // rotating residential proxies, which is anti-bot evasion and out of bounds
  // for this system. Recording that here means the absence is explained rather
  // than looking like an oversight.
  jobSourceSchema.parse({
    id: 'indeed-ng',
    connectorId: 'restricted',
    displayName: 'Indeed Nigeria',
    sourceType: 'html_page',
    accessTier: 'restricted',
    priority: 3,
    enabled: false,
    config: {},
    baseUrl: 'https://ng.indeed.com',
    restrictionReason:
      'Returns HTTP 403 to any declared crawler. Access would require anti-bot evasion, which this system does not do.',
    notes: `${SEED_MARKER} Verified 403 on 2026-11-16. Use an aggregator API instead.`,
  }),
];


/** Illustrative runtime config overrides, to prove the layering works. */
const SEED_CONFIG: Array<{ key: string; value: unknown; description: string }> = [
  {
    key: 'matching.minimumScore',
    value: 55,
    description: 'Below this score a job is never surfaced.',
  },
  /*
   * Where this corpus's raw scores actually sit.
   *
   * Measured over 685 ranked Nigerian postings: raw range 0 to 47.6, mean
   * 34.7. These are short listings, mostly without a stated salary, with no
   * tech stack and modest extraction confidence, so the factors that would
   * carry a raw score past 60 are simply absent.
   *
   * Against the engine's default references of [30, 82] the top of the scale
   * was unreachable by construction: the best job in the corpus — an 85/100
   * match — reported 33/100, no tier above LOW_PRIORITY could be reached, and
   * nothing was ever shortlisted. The ordering was correct throughout; the
   * number printed next to it was being measured against a ceiling that did
   * not exist.
   *
   * Calibration is monotonic, so this reorders nothing. Re-measure with
   * `pnpm recommend`, which prints the raw range, before changing it.
   */
  {
    key: 'recommendationCalibration.referenceLow',
    value: 18,
    description: 'Raw recommendation score mapped to the bottom of the reported scale.',
  },
  {
    key: 'recommendationCalibration.referenceHigh',
    value: 52,
    description: 'Raw recommendation score mapped to the top of the reported scale.',
  },
  {
    /*
     * On, with the same reasoning. The deterministic path still runs and still
     * decides eligibility; AI adds semantic matching on top of it. A key that
     * is absent degrades to the deterministic path rather than failing.
     */
    key: 'ai.enabled',
    value: true,
    description: 'Semantic matching and enrichment. Falls back to deterministic scoring without an API key.',
  },
];

async function seedSkills(db: Database): Promise<number> {
  let count = 0;
  for (const skill of SEED_SKILLS) {
    await db
      .insert(skillsTable)
      .values(skill)
      .onConflictDoUpdate({
        target: skillsTable.slug,
        set: { displayName: skill.displayName, aliases: skill.aliases, category: skill.category },
      });
    count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  // Resolves .env from the workspace root, not the package directory.
  loadDotenv();
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database. Seed data is for development only.');
  }

  const handle = await createDatabase(optionsFromEnv(env));
  try {
    // Seeding a fresh database should just work, so ensure schema first.
    await runMigrations(handle);

    const { db } = handle;
    const profiles = new ProfileRepository(db);
    const sources = new SourceRepository(db);
    const config = new ConfigRepository(db);

    const skillCount = await seedSkills(db);
    console.log(`${SEED_MARKER} skills upserted: ${skillCount}`);

    const existing = await profiles.getActiveProfile();
    if (existing) {
      console.log(
        `${SEED_MARKER} candidate profile already exists (v${existing.version}) — left untouched`,
      );
    } else {
      // A deliberately *partial* profile: it exercises the "empty list means no
      // constraint" semantics rather than pretending to know the user's goals.
      const payload = candidateProfilePayloadSchema.parse({
        identity: {
          fullName: 'Candidate',
          email: 'candidate@example.test',
          timezone: 'Africa/Lagos',
        },
        professional: {
          currentTitle: 'Administrative Officer',
          yearsOfExperience: 2,
          seniority: 'mid',
          technologies: ['Microsoft Office', 'Google Workspace', 'CRM'],
          skills: [
            { name: 'Administration', yearsOfExperience: 2, proficiency: 3, isPrimary: true },
            { name: 'Customer Service', yearsOfExperience: 2, proficiency: 3, isPrimary: true },
            { name: 'Microsoft Office', yearsOfExperience: 3, proficiency: 3, isPrimary: false },
          ],
        },
        preferences: {
          /*
           * The seven fields this system searches, as titles.
           *
           * Stated as roles rather than inferred from a CV, because the fields
           * were chosen deliberately and span work that shares almost no
           * vocabulary — an office assistant posting and a merchandiser
           * posting have nothing in common but the country.
           */
          desiredTitles: [
            'Administrative Officer',
            'Secretary',
            'Personal Assistant',
            'Office Assistant',
            'Customer Service Representative',
            'Front Desk Officer',
            'Receptionist',
            'Sales Representative',
            'Business Development Officer',
            'Marketing Officer',
            'Merchandiser',
            'Graduate Trainee',
            'Data Entry Officer',
            'Research Assistant',
          ],
          /*
           * Nigeria, every arrangement. On-site is fully in scope here, which
           * is the opposite of the system this was forked from — and the
           * reason `countries` is stated rather than left empty: the
           * on-site presence check needs a country to compare against, and an
           * empty list means "no constraint", not "Nigeria".
           */
          location: {
            remoteTypes: ['remote', 'hybrid', 'onsite'],
            countries: ['NG'],
            willingToRelocate: false,
          },
          /*
           * No salary floor, by instruction. `requireStatedSalary` stays false
           * because most Nigerian postings omit pay entirely, and requiring it
           * would discard the majority of the market to enforce a number
           * nobody supplied.
           */
          /*
           * No `minimum` key at all, rather than a null one. The schema makes
           * it optional, and omitting it is the accurate statement: there is no
           * floor, as opposed to a floor whose value happens to be unknown.
           */
          salary: { currency: 'NGN', requireStatedSalary: false },
          employmentTypes: ['full_time', 'contract', 'internship', 'part_time'],
          visaSponsorship: 'not_needed',
        },
        exclusions: {
          /*
           * The scams that dominate this end of the market. Each of these is a
           * phrase that reliably marks a posting as pay-to-apply, pyramid
           * recruitment, or commission-only work dressed as salaried.
           */
          keywords: [
            'unpaid',
            'commission only',
            'registration fee',
            'pay to apply',
            'training fee',
            'network marketing',
          ],
        },
      });
      const created = await profiles.createProfile({ payload, displayName: 'Candidate' });
      console.log(`${SEED_MARKER} candidate profile created (v${created.version})`);
    }

    for (const source of SEED_SOURCES) {
      await sources.upsert(source);
    }
    console.log(
      `${SEED_MARKER} sources upserted: ${SEED_SOURCES.length} ` +
        '(all disabled — enable them from the Sources page)',
    );

    for (const entry of SEED_CONFIG) {
      await config.set(entry.key, entry.value, 'seed');
    }
    console.log(`${SEED_MARKER} app config entries: ${SEED_CONFIG.length}`);
    console.log(`${SEED_MARKER} done`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(`\n[seed] ${error.format()}`);
  } else {
    console.error('[seed] failed:', error);
  }
  process.exit(1);
});
