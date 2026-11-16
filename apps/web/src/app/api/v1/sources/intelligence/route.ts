import { NextResponse } from 'next/server';
import { getAcquisitionContext } from '@/lib/acquisition';
import { handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Source intelligence.
 *
 * Everything the dashboard renders, as data. What is *not* here is as
 * deliberate as what is: `auth.credentialRefs` carries environment variable
 * names, and no field in the response can hold a credential value, because the
 * service that assembles it never receives one — it only ever asks whether a
 * name resolves.
 *
 * `config` is echoed back because connector configuration is genuinely useful
 * for debugging a source, and it is safe for the same structural reason:
 * secrets are referenced by name from the environment and were never written
 * into these rows.
 */
export function GET(request: Request) {
  return handler(async () => {
    const { service } = await getAcquisitionContext();

    const url = new URL(request.url);
    const hours = Math.min(720, Math.max(1, Number(url.searchParams.get('hours') ?? 24) || 24));

    const [sources, summary] = await Promise.all([
      service.describeAll(hours),
      service.summary(),
    ]);

    return NextResponse.json({
      windowHours: hours,
      summary: {
        total: summary.total,
        schedulable: summary.schedulable,
        byState: summary.byState,
        needingAttention: summary.needingAttention.map((entry) => ({
          sourceId: entry.entry.sourceId,
          sourceName: entry.entry.sourceName,
          state: entry.entry.state,
          reason: entry.blockedReason,
          requires: entry.entry.auth.credentialRefs,
        })),
      },
      sources: sources.map((entry) => ({
        sourceId: entry.entry.sourceId,
        sourceName: entry.entry.sourceName,
        sourceType: entry.entry.sourceType,
        connectorId: entry.entry.connectorId,
        state: entry.entry.state,
        healthScore: entry.entry.healthScore,
        method: entry.method,
        blockedReason: entry.blockedReason,
        alternatives: entry.alternatives,
        capabilities: entry.entry.capabilities,
        accessPolicy: entry.entry.accessPolicy,
        auth: {
          strategy: entry.entry.auth.strategy,
          /* Names only. There is nowhere in this shape for a value. */
          credentialRefs: entry.entry.auth.credentialRefs,
          setupUrl: entry.entry.auth.setupUrl,
        },
        rateLimit: entry.entry.rateLimit,
        metrics: entry.metrics,
        watermark: {
          lastSuccessfulScanAt: entry.watermark.lastSuccessfulScanAt,
          lastSeenPublishedAt: entry.watermark.lastSeenPublishedAt,
          hasCursor: entry.watermark.lastCursor !== null,
          emptyScans: entry.watermark.emptyScans,
        },
        health: entry.health.factors,
      })),
    });
  });
}
