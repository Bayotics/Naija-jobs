import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigProvider, loadEnv } from '@job-intel/config';
import { EventRecorder, MemoryLogger } from '@job-intel/observability';
import {
  ConfigRepository,
  EngagementRepository,
  EventRepository,
  JobRepository,
  ProfileRepository,
  SourceRepository,
} from '@job-intel/db';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from '@job-intel/db/testing';
import { makeCandidateProfile } from '@job-intel/contracts/factories';
import type { ServerContext } from '@/lib/db';

/**
 * API route tests.
 *
 * These call the real route handlers against a real Postgres engine, with only
 * the composition root substituted. So validation, error translation, status
 * codes and repository behaviour are all genuinely exercised — the layer these
 * tests cover is the one where a wrong status code or a leaked internal message
 * would otherwise reach a client unnoticed.
 */
const hoisted = vi.hoisted(() => ({
  ctx: undefined as unknown as ServerContext,
  /** Request-scoped state the ops routes read through `next/headers`. */
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));

vi.mock('@/lib/db', () => ({
  getServerContext: () => Promise.resolve(hoisted.ctx),
}));

/*
 * Next's request-scoped helpers are unavailable outside a request. Stubbing
 * them is what lets the authentication and CSRF guards be exercised as real
 * code paths rather than asserted about in prose.
 */
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = hoisted.cookies.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string) => hoisted.cookies.set(name, value),
      delete: (name: string) => hoisted.cookies.delete(name),
    }),
  headers: () => Promise.resolve({ get: (name: string) => hoisted.headers.get(name) ?? null }),
}));

// Imported after the mock is registered (vitest hoists `vi.mock` above these).
const health = await import('../app/api/v1/health/route');
const profile = await import('../app/api/v1/profile/route');
const preferences = await import('../app/api/v1/preferences/route');
const jobs = await import('../app/api/v1/jobs/route');
const jobById = await import('../app/api/v1/jobs/[id]/route');
const feedback = await import('../app/api/v1/jobs/[id]/feedback/route');
const sources = await import('../app/api/v1/sources/route');
const sourceById = await import('../app/api/v1/sources/[id]/route');
const sourceRuns = await import('../app/api/v1/source-runs/route');
const applications = await import('../app/api/v1/applications/route');
const matches = await import('../app/api/v1/matches/route');
const opsOverview = await import('../app/api/v1/ops/overview/route');
const opsJobs = await import('../app/api/v1/ops/jobs/route');
const opsActions = await import('../app/api/v1/ops/actions/route');
const opsAudit = await import('../app/api/v1/ops/audit/route');
const opsSession = await import('../app/api/v1/ops/session/route');
const { createSession } = await import('@/lib/auth');

const UNKNOWN_UUID = '11111111-1111-1111-1111-111111111111';

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

function jsonReq(url: string, method: string, body: unknown): Request {
  return req(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function buildContext(ctx: TestDatabase): ServerContext {
  const logger = new MemoryLogger();
  const appConfig = new ConfigRepository(ctx.db);
  return {
    env: loadEnv({ DATABASE_DRIVER: 'pglite' }),
    handle: ctx.handle,
    logger,
    events: new EventRecorder(logger, new EventRepository(ctx.db)),
    config: new AppConfigProvider(appConfig),
    profiles: new ProfileRepository(ctx.db),
    sources: new SourceRepository(ctx.db),
    jobs: new JobRepository(ctx.db),
    engagement: new EngagementRepository(ctx.db),
    appConfig,
  };
}

const validSource = {
  id: 'test:api',
  connectorId: 'greenhouse',
  displayName: 'API Test Source',
  sourceType: 'ats',
  accessTier: 'official_api',
};

describe('API routes', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await resetTestDatabase(db.db);
    hoisted.ctx = buildContext(db);
    hoisted.cookies.clear();
    hoisted.headers.clear();
  });

  const seedProfile = () =>
    hoisted.ctx.profiles.createProfile({ payload: makeCandidateProfile() });

  describe('GET /health', () => {
    it('reports per-dependency status rather than a single boolean', async () => {
      const res = await health.GET();
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.checks.database.ok).toBe(true);
      // A missing profile is reported, not treated as a failure.
      expect(body.checks.profile.ok).toBe(false);
      expect(typeof body.uptimeSeconds).toBe('number');
    });
  });

  describe('/profile', () => {
    it('404s before a profile exists, then creates and reads it', async () => {
      expect((await profile.GET()).status).toBe(404);

      const created = await profile.POST(
        jsonReq('/api/v1/profile', 'POST', {
          identity: { fullName: 'API Test', email: 'api@example.com' },
        }),
      );
      expect(created.status).toBe(201);

      const res = await profile.GET();
      expect(res.status).toBe(200);
      expect((await res.json()).payload.identity.email).toBe('api@example.com');
    });

    it('refuses a second profile with 409', async () => {
      await seedProfile();
      const res = await profile.POST(
        jsonReq('/api/v1/profile', 'POST', {
          identity: { fullName: 'Other', email: 'other@example.com' },
        }),
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('ALREADY_EXISTS');
    });

    it('rejects an invalid payload with field-level issues', async () => {
      const res = await profile.POST(
        jsonReq('/api/v1/profile', 'POST', { identity: { fullName: 'X', email: 'nope' } }),
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.issues.some((i: { path: string }) => i.path.includes('email'))).toBe(true);
    });

    it('rejects malformed JSON', async () => {
      const res = await profile.PATCH(
        req('/api/v1/profile', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: 'not json',
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /preferences', () => {
    it('applies a change as a new profile version', async () => {
      await seedProfile();

      const res = await preferences.PATCH(
        jsonReq('/api/v1/preferences', 'PATCH', {
          preferences: {
            salary: { minimum: 90_000 },
            location: { remoteTypes: ['onsite'], countries: ['DE', 'NL'] },
            visaSponsorship: 'required',
          },
        }),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.version).toBe(2);
      expect(body.preferences.salary.minimum).toBe(90_000);
      expect(body.preferences.location.countries).toEqual(['DE', 'NL']);
      expect(body.preferences.visaSponsorship).toBe('required');
    });

    it('persists the change for the next reader', async () => {
      await seedProfile();
      await preferences.PATCH(
        jsonReq('/api/v1/preferences', 'PATCH', { preferences: { salary: { minimum: 12_345 } } }),
      );

      const body = await (await preferences.GET()).json();
      expect(body.version).toBe(2);
      expect(body.preferences.salary.minimum).toBe(12_345);
    });

    it('records a durable system event for the activation', async () => {
      await seedProfile();
      await preferences.PATCH(
        jsonReq('/api/v1/preferences', 'PATCH', {
          preferences: { desiredTitles: ['Platform Engineer'] },
          changeSummary: 'test change',
        }),
      );

      const events = await new EventRepository(db.db).list({
        name: 'PROFILE_VERSION_ACTIVATED',
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.message).toBe('test change');
    });

    it('rejects an invalid country code without mutating the profile', async () => {
      await seedProfile();
      const res = await preferences.PATCH(
        jsonReq('/api/v1/preferences', 'PATCH', {
          preferences: { location: { countries: ['GERMANY'] } },
        }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.issues.length).toBeGreaterThan(0);

      expect((await hoisted.ctx.profiles.getActiveProfile())?.version).toBe(1);
    });

    it('rejects an empty patch', async () => {
      await seedProfile();
      const res = await preferences.PATCH(jsonReq('/api/v1/preferences', 'PATCH', {}));
      expect(res.status).toBe(400);
    });

    it('404s when no profile exists', async () => {
      expect((await preferences.GET()).status).toBe(404);
    });
  });

  describe('/jobs', () => {
    it('returns an empty, well-formed page', async () => {
      const res = await jobs.GET(req('/api/v1/jobs'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toMatchObject({ items: [], total: 0, hasMore: false });
    });

    it('validates query parameters', async () => {
      // limit is capped; 9999 must be rejected rather than silently clamped.
      expect((await jobs.GET(req('/api/v1/jobs?limit=9999'))).status).toBe(400);
      expect((await jobs.GET(req('/api/v1/jobs?status=nonsense'))).status).toBe(400);
      expect((await jobs.GET(req('/api/v1/jobs?limit=10&offset=5'))).status).toBe(200);
    });

    it('400s on a non-UUID id and 404s on an unknown one', async () => {
      expect((await jobById.GET(req('/x'), params('abc'))).status).toBe(400);
      expect((await jobById.GET(req('/x'), params(UNKNOWN_UUID))).status).toBe(404);
    });
  });

  describe('POST /jobs/:id/feedback', () => {
    it('409s when no candidate profile exists', async () => {
      const res = await feedback.POST(
        jsonReq('/x', 'POST', { action: 'saved' }),
        params(UNKNOWN_UUID),
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('NO_PROFILE');
    });

    it('404s for an unknown job', async () => {
      await seedProfile();
      const res = await feedback.POST(
        jsonReq('/x', 'POST', { action: 'saved' }),
        params(UNKNOWN_UUID),
      );
      expect(res.status).toBe(404);
    });

    it('rejects an action outside the allowed set', async () => {
      await seedProfile();
      const res = await feedback.POST(
        jsonReq('/x', 'POST', { action: 'maybe_later' }),
        params(UNKNOWN_UUID),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('/sources', () => {
    it('registers a source and reports missing credentials by name only', async () => {
      const created = await sources.POST(
        jsonReq('/api/v1/sources', 'POST', {
          ...validSource,
          credentialRefs: ['DEFINITELY_NOT_SET_TEST_KEY'],
        }),
      );
      expect(created.status).toBe(201);

      const body = await (await sources.GET()).json();
      expect(body.total).toBe(1);
      expect(body.items[0].missingCredentials).toEqual(['DEFINITELY_NOT_SET_TEST_KEY']);
      // The value must never appear anywhere in the response.
      expect(JSON.stringify(body)).not.toContain('secret');
    });

    it('rejects an unknown access tier', async () => {
      const res = await sources.POST(
        jsonReq('/api/v1/sources', 'POST', { ...validSource, accessTier: 'scrape_everything' }),
      );
      expect(res.status).toBe(400);
    });

    it('rejects a malformed cron expression', async () => {
      const res = await sources.POST(
        jsonReq('/api/v1/sources', 'POST', { ...validSource, scheduleCron: '* * *' }),
      );
      expect(res.status).toBe(400);
    });

    it('updates schedule and enablement without a redeploy', async () => {
      await sources.POST(jsonReq('/api/v1/sources', 'POST', validSource));

      const res = await sourceById.PATCH(
        jsonReq('/x', 'PATCH', { enabled: false, scheduleCron: '*/30 * * * *' }),
        params(validSource.id),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.source.enabled).toBe(false);
      expect(body.source.scheduleCron).toBe('*/30 * * * *');
    });

    it('404s for an unknown source on GET, PATCH and DELETE', async () => {
      expect((await sourceById.GET(req('/x'), params('nope'))).status).toBe(404);
      expect(
        (await sourceById.PATCH(jsonReq('/x', 'PATCH', { enabled: false }), params('nope'))).status,
      ).toBe(404);
      expect((await sourceById.DELETE(req('/x'), params('nope'))).status).toBe(404);
    });

    it('archives rather than deletes, so history survives', async () => {
      await sources.POST(jsonReq('/api/v1/sources', 'POST', validSource));
      expect((await sourceById.DELETE(req('/x'), params(validSource.id))).status).toBe(200);

      // Gone from the default listing…
      expect((await (await sources.GET()).json()).total).toBe(0);
      // …but the row is still there.
      const all = await hoisted.ctx.sources.list({ includeArchived: true });
      expect(all).toHaveLength(1);
      expect(all[0]?.archivedAt).not.toBeNull();
    });

    it('lists runs for a source', async () => {
      await sources.POST(jsonReq('/api/v1/sources', 'POST', validSource));
      const run = await hoisted.ctx.sources.startRun(validSource.id, 'manual', 'trace-1');
      await hoisted.ctx.sources.completeRun(run.id, {
        status: 'success',
        stats: { jobsDiscovered: 7, jobsAccepted: 2 },
      });

      const body = await (await sourceRuns.GET(req('/api/v1/source-runs'))).json();
      expect(body.total).toBe(1);
      expect(body.items[0].jobsDiscovered).toBe(7);
      expect(body.items[0].status).toBe('success');
    });
  });

  describe('/applications', () => {
    it('409s without a profile', async () => {
      expect((await applications.GET(req('/api/v1/applications'))).status).toBe(409);
    });

    it('returns an empty board once a profile exists', async () => {
      await seedProfile();
      const res = await applications.GET(req('/api/v1/applications'));
      expect(res.status).toBe(200);
      expect((await res.json()).total).toBe(0);
    });

    it('404s when upserting against an unknown job', async () => {
      await seedProfile();
      const res = await applications.PUT(
        jsonReq('/api/v1/applications', 'PUT', { jobId: UNKNOWN_UUID, state: 'applied' }),
      );
      expect(res.status).toBe(404);
    });

    it('rejects an unknown application state', async () => {
      await seedProfile();
      const res = await applications.PUT(
        jsonReq('/api/v1/applications', 'PUT', { jobId: UNKNOWN_UUID, state: 'ghosted' }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('stage endpoints', () => {
    it('/matches returns an empty list before anything has been scored', async () => {
      await seedProfile();
      const res = await matches.GET(new Request('http://localhost/api/v1/matches'));
      expect(res.status).toBe(200);

      const body = await res.json();
      // Empty because nothing has been matched yet — not because the endpoint
      // is a placeholder. The shape is the real one.
      expect(body).toMatchObject({ items: [], total: 0, limit: 50, offset: 0 });
    });

  });

  /*
   * Operations console.
   *
   * The authorisation tests here matter more than anything else in this file:
   * this console can disable connectors, trigger runs and read every job in the
   * system, so a gap here is a different order of problem from a wrong status
   * code on a read endpoint.
   */
  describe('operations console', () => {
    const SECRET = 'test-auth-secret-value-32-chars-min';
    const PASSWORD = 'correct horse battery staple';

    /** Re-loads the environment with the console protected. */
    const protect = () => {
      hoisted.ctx = {
        ...hoisted.ctx,
        env: loadEnv({
          DATABASE_DRIVER: 'pglite',
          AUTH_SECRET: SECRET,
          OPS_PASSWORD: PASSWORD,
          APP_URL: 'http://localhost:3000',
        }),
      };
    };

    const signIn = (role: 'viewer' | 'operator' | 'admin') => {
      hoisted.cookies.set(
        'jobintel_ops',
        createSession({ actor: 'tester', role, expiresAt: Date.now() + 3_600_000 }, SECRET),
      );
    };

    it('reports zeros for an empty system rather than inventing numbers', async () => {
      await seedProfile();
      const res = await opsOverview.GET(req('/api/v1/ops/overview'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.overview.pipeline).toMatchObject({
        discoveredToday: 0,
        enriched: 0,
        matched: 0,
        recommended: 0,
      });
      // The funnel exists and is all zeros: an empty shape, not a missing one.
      expect(body.funnel.steps.every((step: { count: number }) => step.count === 0)).toBe(true);
    });

    it('paginates the job explorer instead of returning the corpus', async () => {
      const res = await opsJobs.GET(req('/api/v1/ops/jobs?limit=10&offset=0'));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toMatchObject({ total: 0, limit: 10, offset: 0 });
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('rejects an out-of-range page size rather than honouring it', async () => {
      expect((await opsJobs.GET(req('/api/v1/ops/jobs?limit=100000'))).status).toBe(400);
    });

    it('runs open when no AUTH_SECRET is configured', async () => {
      // A deliberate single-user local mode: warned about in the UI, and still
      // audited, with every action attributed to `local`.
      expect((await opsOverview.GET(req('/api/v1/ops/overview'))).status).toBe(200);
    });

    it('refuses an unauthenticated request once the console is protected', async () => {
      protect();
      const res = await opsOverview.GET(req('/api/v1/ops/overview'));

      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
    });

    it('refuses a session whose signature does not verify', async () => {
      protect();
      hoisted.cookies.set('jobintel_ops', 'eyJhY3RvciI6ImV2aWwifQ.not-a-real-signature');

      expect((await opsOverview.GET(req('/api/v1/ops/overview'))).status).toBe(401);
    });

    it('refuses an expired session', async () => {
      protect();
      hoisted.cookies.set(
        'jobintel_ops',
        createSession({ actor: 'tester', role: 'admin', expiresAt: Date.now() - 1_000 }, SECRET),
      );

      expect((await opsOverview.GET(req('/api/v1/ops/overview'))).status).toBe(401);
    });

    it('enforces role, not merely authentication', async () => {
      protect();
      signIn('viewer');

      // A viewer may read the dashboard.
      expect((await opsOverview.GET(req('/api/v1/ops/overview'))).status).toBe(200);

      // The audit log is admin-only: it records who did what.
      const audit = await opsAudit.GET(req('/api/v1/ops/audit'));
      expect(audit.status).toBe(403);
      expect((await audit.json()).error.code).toBe('FORBIDDEN');

      // And a viewer may not trigger work.
      const action = await opsActions.POST(
        jsonReq('/api/v1/ops/actions', 'POST', { action: 'run_dry' }),
      );
      expect(action.status).toBe(403);
    });

    it('rejects a cross-origin mutation even with a valid session', async () => {
      protect();
      signIn('admin');
      hoisted.headers.set('origin', 'https://attacker.example');

      const res = await opsActions.POST(
        jsonReq('/api/v1/ops/actions', 'POST', { action: 'run_dry' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('CROSS_ORIGIN');
    });

    it('accepts a same-origin mutation and records it in the audit log', async () => {
      protect();
      signIn('admin');
      hoisted.headers.set('origin', 'http://localhost:3000');
      await seedProfile();

      const res = await opsActions.POST(
        jsonReq('/api/v1/ops/actions', 'POST', { action: 'run_dry', reason: 'api test' }),
      );
      expect(res.status).toBe(200);

      const audit = await opsAudit.GET(req('/api/v1/ops/audit'));
      const body = await audit.json();
      expect(body.items[0]).toMatchObject({ action: 'pipeline.dry_run', actor: 'tester' });
    });

    it('requires explicit confirmation for an action that can send email', async () => {
      protect();
      signIn('admin');
      hoisted.headers.set('origin', 'http://localhost:3000');

      // No `confirm: true` in the body.
      const res = await opsActions.POST(
        jsonReq('/api/v1/ops/actions', 'POST', { action: 'generate_digest' }),
      );
      expect(res.status).toBe(400);
    });

    it('refuses sign-in with the wrong password and never echoes any secret', async () => {
      protect();
      hoisted.headers.set('origin', 'http://localhost:3000');

      const res = await opsSession.POST(
        jsonReq('/api/v1/ops/session', 'POST', { password: 'not it' }),
      );
      expect(res.status).toBe(401);

      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(SECRET);
    });

    it('issues a session for the correct password', async () => {
      protect();
      hoisted.headers.set('origin', 'http://localhost:3000');

      const res = await opsSession.POST(
        jsonReq('/api/v1/ops/session', 'POST', { password: PASSWORD }),
      );
      expect(res.status).toBe(200);
      expect(hoisted.cookies.get('jobintel_ops')).toBeTruthy();

      // That cookie is now good enough to read the dashboard.
      expect((await opsOverview.GET(req('/api/v1/ops/overview'))).status).toBe(200);
    });

    it('rate-limits repeated sign-in attempts', async () => {
      protect();
      hoisted.headers.set('origin', 'http://localhost:3000');
      hoisted.headers.set('x-real-ip', `brute-${Date.now()}`);

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const res = await opsSession.POST(
          jsonReq('/api/v1/ops/session', 'POST', { password: 'guess' }),
        );
        statuses.push(res.status);
      }

      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    });

    it('reports sign-in as unavailable rather than open when no credential is set', async () => {
      hoisted.ctx = {
        ...hoisted.ctx,
        env: loadEnv({
          DATABASE_DRIVER: 'pglite',
          AUTH_SECRET: SECRET,
          APP_URL: 'http://localhost:3000',
        }),
      };
      hoisted.headers.set('origin', 'http://localhost:3000');

      const res = await opsSession.POST(
        jsonReq('/api/v1/ops/session', 'POST', { password: 'anything' }),
      );
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe('AUTH_NOT_CONFIGURED');
    });
  });
});
