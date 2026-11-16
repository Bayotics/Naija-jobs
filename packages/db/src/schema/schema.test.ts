import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testing';
import * as schema from './index';

/**
 * Schema integration tests.
 *
 * These run against a real Postgres engine (PGlite), so they verify the things
 * that only a real database can tell you: that the migration applies, that
 * constraints actually fire, and that enum values match the contract tuples.
 */
describe('database schema', () => {
  let ctx: TestDatabase;

  beforeAll(async () => {
    ctx = await createTestDatabase();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('applies all migrations and creates the expected tables', async () => {
    const result = await ctx.db.execute<{ tablename: string }>(sql`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
       ORDER BY tablename
    `);
    const tables = result.rows.map((r) => r.tablename);

    expect(tables).toEqual(
      expect.arrayContaining([
        'ai_usage',
        'app_config',
        'audit_log',
        'applications',
        'candidate_profiles',
        'candidate_skills',
        'companies',
        'job_embeddings',
        'job_feedback',
        'job_groups',
        'candidate_job_exposure',
        'job_duplicates',
        'job_group_merges',
        'job_match_history',
        'job_matches',
        'job_recommendations',
        'job_signals',
        'job_verifications',
        'job_skills',
        'job_source_runs',
        'job_sources',
        'job_urls',
        'job_versions',
        'jobs',
        'notification_channel_deliveries',
        'notification_decisions',
        'notification_deliveries',
        'notification_delivery_events',
        'notification_events',
        'notification_preferences',
        'notification_ledger',
        'notifications',
        'notified_jobs',
        'profile_versions',
        'metric_samples',
        'pipeline_runs',
        'rate_limit_events',
        'raw_postings',
        'source_alert_state',
        'skills',
        'system_events',
        'users',
      ]),
    );
  });

  it('installs the pgvector extension and accepts a vector column', async () => {
    const ext = await ctx.db.execute<{ extname: string }>(
      sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(ext.rows).toHaveLength(1);

    const col = await ctx.db.execute<{ udt_name: string }>(sql`
      SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'job_embeddings' AND column_name = 'embedding'
    `);
    expect(col.rows[0]?.udt_name).toBe('vector');
  });

  it('enforces the unique constraint that makes re-crawling idempotent', async () => {
    await ctx.db.insert(schema.jobSources).values({
      id: 'unique-test',
      connectorId: 'test',
      displayName: 'Unique Test',
      sourceType: 'job_api',
      accessTier: 'official_api',
    });

    const row = {
      sourceId: 'unique-test',
      payload: { a: 1 },
      payloadFormat: 'json',
      contentHash: 'a'.repeat(64),
    };

    await ctx.db.insert(schema.rawPostings).values(row);
    // Same source + same content hash must be rejected by the database itself,
    // not merely avoided by application logic.
    await expect(ctx.db.insert(schema.rawPostings).values(row)).rejects.toThrow();
  });

  it('rejects an enum value outside the contract tuple', async () => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO job_sources (id, connector_id, display_name, source_type, access_tier)
        VALUES ('bad-enum', 'test', 'Bad', 'not_a_real_source_type', 'official_api')
      `),
    ).rejects.toThrow();
  });
});
