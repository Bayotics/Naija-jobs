import { NextResponse } from 'next/server';
import { redact } from '@job-intel/ops';
import { getOpsContext } from '@/lib/ops';
import { getServerContext } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Source status, health score and rate-limit state.
 *
 * Credentials are never included: the response carries the *names* of required
 * secrets and whether each is present, which is what an operator needs to
 * diagnose a misconfiguration without the secret leaving the server.
 */
export function GET() {
  return handler(async () => {
    const auth = await requireRole('viewer');
    if (!auth.ok) return auth.response;

    const ctx = await getServerContext();
    const { service, repository } = await getOpsContext();

    const [sources, scores, rateLimits] = await Promise.all([
      ctx.sources.list({ includeArchived: false }),
      service.sourceHealthScores().catch(() => []),
      repository.rateLimitSummaries(24).catch(() => []),
    ]);

    const scoreById = new Map(scores.map((s) => [s.sourceId, s]));
    const limitsById = new Map(rateLimits.map((r) => [r.sourceId, r]));

    return NextResponse.json({
      items: sources.map((source) => {
        const score = scoreById.get(source.id);
        const limits = limitsById.get(source.id);

        return {
          id: source.id,
          displayName: source.displayName,
          sourceType: source.sourceType,
          accessTier: source.accessTier,
          enabled: source.enabled,
          healthStatus: source.healthStatus,
          circuitState: source.circuitState,
          consecutiveFailures: source.consecutiveFailures,
          lastSuccessAt: source.lastSuccessfulRunAt,
          lastAttemptAt: source.lastAttemptedRunAt,
          lastError: redact(source.lastErrorMessage),
          scheduleCron: source.scheduleCron,
          limits: source.limits,
          // Names only. Never values.
          credentialRefs: source.credentialRefs,
          health: score
            ? {
                score: score.score,
                status: score.status,
                components: score.components,
                anomalies: score.anomalies,
                explanation: score.explanation,
              }
            : null,
          rateLimits: limits
            ? {
                requests: limits.requests,
                succeeded: limits.succeeded,
                failed: limits.failed,
                rateLimited: limits.rateLimited,
                backoffUntil: limits.backoffUntil,
                remainingQuota: limits.remainingQuota,
              }
            : null,
        };
      }),
    });
  });
}
