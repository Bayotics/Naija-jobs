/**
 * Inspection CLI: `pnpm inspect-jobs`
 *
 * Reports what discovery actually produced, so normalization quality can be
 * judged against real data rather than assumed.
 */
import { loadDotenv, loadEnv } from '@job-intel/config';
import { createDatabase, optionsFromEnv } from '@job-intel/db';
import { sql } from 'drizzle-orm';

async function main(): Promise<void> {
  loadDotenv();
  const handle = await createDatabase(optionsFromEnv(loadEnv()));
  const { db } = handle;

  try {
    const q = async (label: string, statement: ReturnType<typeof sql>) => {
      const result = await db.execute(statement);
      console.log(`\n── ${label} ──`);
      for (const row of result.rows) console.log('  ', JSON.stringify(row));
    };

    const totals = await db.execute(sql`
      SELECT count(*)::int AS jobs,
             count(DISTINCT source_id)::int AS sources,
             count(DISTINCT company_name_raw)::int AS companies
        FROM jobs
    `);
    console.log('\n=== TOTALS ===');
    console.log('  ', JSON.stringify(totals.rows[0]));

    const raw = await db.execute(sql`SELECT count(*)::int AS raw_postings FROM raw_postings`);
    console.log('  ', JSON.stringify(raw.rows[0]));

    await q(
      'jobs per source',
      sql`SELECT source_id, count(*)::int AS n FROM jobs GROUP BY source_id ORDER BY n DESC`,
    );
    await q(
      'remote type distribution',
      sql`SELECT remote_type, count(*)::int AS n FROM jobs GROUP BY remote_type ORDER BY n DESC`,
    );
    await q(
      'employment types resolved',
      sql`SELECT unnest(employment_types)::text AS t, count(*)::int AS n
            FROM jobs GROUP BY t ORDER BY n DESC LIMIT 8`,
    );
    await q(
      'countries resolved',
      sql`SELECT coalesce(country_code,'(none)') AS country, count(*)::int AS n
            FROM jobs GROUP BY country ORDER BY n DESC LIMIT 10`,
    );
    await q(
      'seniority inferred',
      sql`SELECT coalesce(seniority::text,'(none)') AS s, count(*)::int AS n
            FROM jobs GROUP BY s ORDER BY n DESC LIMIT 8`,
    );
    await q(
      'salary coverage',
      sql`SELECT count(*) FILTER (WHERE salary_normalized_annual_usd IS NOT NULL)::int AS with_salary,
                 count(*) FILTER (WHERE salary_normalized_annual_usd IS NULL)::int AS without_salary,
                 round(avg(salary_normalized_annual_usd))::int AS avg_usd
            FROM jobs`,
    );
    await q(
      'sample: structured salary (Jobicy)',
      sql`SELECT title, company_name_raw, salary_min, salary_max, salary_currency,
                 salary_period::text, salary_normalized_annual_usd
            FROM jobs WHERE salary_min IS NOT NULL ORDER BY random() LIMIT 3`,
    );
    await q(
      'sample: Nigerian postings',
      sql`SELECT title, company_name_raw, location_raw, country_code
            FROM jobs WHERE source_id='hotnigerianjobs' LIMIT 3`,
    );
    await q(
      'sample: URL normalization (tracking params stripped)',
      sql`SELECT source_url, canonical_url FROM jobs
           WHERE source_url <> canonical_url LIMIT 3`,
    );
    await q(
      'discovery events recorded',
      sql`SELECT name::text, count(*)::int AS n FROM system_events GROUP BY name ORDER BY n DESC LIMIT 8`,
    );
    await q(
      'source runs',
      sql`SELECT source_id, status::text, jobs_discovered, jobs_accepted, jobs_duplicated,
                 duration_ms, http_requests
            FROM job_source_runs ORDER BY started_at DESC LIMIT 8`,
    );

    // ── Enrichment ────────────────────────────────────────────────────────
    await q(
      'enrichment coverage',
      sql`SELECT count(*)::int AS enriched,
                 count(role_slug)::int AS with_role,
                 count(seniority)::int AS with_seniority,
                 count(min_years_experience)::int AS with_experience,
                 count(*) FILTER (WHERE salary_stated)::int AS with_salary,
                 count(*) FILTER (WHERE work_mode <> 'unknown')::int AS with_workmode,
                 count(country_code)::int AS with_country
            FROM job_enrichments`,
    );
    await q(
      'work mode',
      sql`SELECT work_mode, count(*)::int AS n FROM job_enrichments
           GROUP BY work_mode ORDER BY n DESC`,
    );
    await q(
      'visa sponsorship states',
      sql`SELECT visa_sponsorship, count(*)::int AS n FROM job_enrichments
           GROUP BY visa_sponsorship ORDER BY n DESC`,
    );
    await q(
      'seniority',
      sql`SELECT coalesce(seniority, '(none)') AS s, count(*)::int AS n
            FROM job_enrichments GROUP BY s ORDER BY n DESC LIMIT 8`,
    );
    await q(
      'job function',
      sql`SELECT job_function, count(*)::int AS n FROM job_enrichments
           GROUP BY job_function ORDER BY n DESC LIMIT 8`,
    );
    await q(
      'top skills by requirement strength',
      sql`SELECT display_name, count(*)::int AS total,
                 count(*) FILTER (WHERE requirement = 'required')::int AS req,
                 count(*) FILTER (WHERE requirement = 'optional')::int AS opt,
                 count(*) FILTER (WHERE requirement = 'inferred')::int AS inf
            FROM job_skill_extractions
           GROUP BY display_name ORDER BY total DESC LIMIT 10`,
    );
    await q(
      'quality, scam and performance',
      sql`SELECT round(avg(quality_score)::numeric, 3)::float8 AS avg_quality,
                 count(*) FILTER (WHERE scam_score > 0.5)::int AS suspicious,
                 count(*) FILTER (WHERE seniority_conflict IS NOT NULL)::int AS conflicts,
                 round(avg(total_duration_ms)::numeric, 1)::float8 AS avg_ms,
                 max(total_duration_ms)::int AS max_ms
            FROM job_enrichments`,
    );
    await q(
      'sample enriched jobs (still linked to source)',
      sql`SELECT e.normalized_title, e.role_slug, e.seniority, e.work_mode,
                 e.country_code, e.salary_annual_usd, j.title AS original_title, j.source_id
            FROM job_enrichments e JOIN jobs j ON j.id = e.job_id
           WHERE e.role_slug IS NOT NULL LIMIT 4`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[inspect] failed:', error);
  process.exit(1);
});
