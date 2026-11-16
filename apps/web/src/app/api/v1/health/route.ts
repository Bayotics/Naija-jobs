import { NextResponse } from 'next/server';
import { checkDatabaseHealth } from '@job-intel/db';
import { getServerContext } from '@/lib/db';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * System health.
 *
 * Reports per-dependency status rather than a single boolean, so an operator
 * can tell "the database is slow" from "the database is gone". Returns 503 when
 * a critical dependency is down so a load balancer can act on it.
 */
export function GET() {
  return handler(async () => {
    const startedAt = Date.now();
    const ctx = await getServerContext();

    const database = await checkDatabaseHealth(ctx.handle.db);
    const [sources, profile] = await Promise.all([
      ctx.sources.list({ enabledOnly: true }).catch(() => []),
      ctx.profiles.getActiveProfile().catch(() => null),
    ]);

    const checks = {
      database: {
        ok: database.ok,
        driver: ctx.handle.driver,
        latencyMs: database.latencyMs,
        ...(database.error ? { error: database.error } : {}),
      },
      profile: {
        ok: profile !== null,
        ...(profile ? { version: profile.version } : { detail: 'no active candidate profile' }),
      },
      sources: { ok: true, enabled: sources.length },
    };

    const healthy = checks.database.ok;
    const body = {
      status: healthy ? ('ok' as const) : ('degraded' as const),
      environment: ctx.env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
      responseTimeMs: Date.now() - startedAt,
      checks,
    };

    if (!healthy) {
      return NextResponse.json(body, { status: 503 });
    }
    return NextResponse.json(body);
  }).catch(() => apiError(503, 'UNHEALTHY', 'Health check failed'));
}
