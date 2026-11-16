import { NextResponse } from 'next/server';
import { z } from 'zod';
import { QUEUE_NAMES } from '@job-intel/queue';
import { getOpsContext } from '@/lib/ops';
import { getServerContext } from '@/lib/db';
import { getRecommendationContext } from '@/lib/recommendations';
import { getMatchingContext } from '@/lib/matching';
import { guardMutation } from '@/lib/auth';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Manual pipeline controls.
 *
 * One endpoint, a discriminated union of actions. Three properties hold for
 * every one of them:
 *
 *  - **Authorised**: `operator` for anything that runs work, `admin` for
 *    anything that changes a source's state.
 *  - **Audited**: before and after are recorded, so "who disabled LinkedIn" has
 *    an answer that includes what it was before.
 *  - **Confirmed**: destructive or outward-facing actions require an explicit
 *    `confirm: true`, which the UI supplies from a dialog rather than a click.
 */
const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('run_dry'),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal('run_discovery'),
    sourceIds: z.array(z.string().trim().max(120)).max(50).optional(),
    confirm: z.literal(true),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal('source_enable'),
    sourceId: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal('recalculate_matches'),
    confirm: z.literal(true),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal('recalculate_recommendations'),
    confirm: z.literal(true),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal('generate_digest'),
    confirm: z.literal(true),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal('rematch_job'),
    jobId: z.string().uuid(),
    reason: z.string().trim().max(200).optional(),
  }),
  z.object({
    action: z.literal('queue_job'),
    queue: z.enum(QUEUE_NAMES),
    jobId: z.string().trim().min(1).max(200),
    operation: z.enum(['retry', 'discard']),
    reason: z.string().trim().max(200).optional(),
  }),
]);

export function POST(request: Request) {
  return handler(async () => {
    const guard = await guardMutation('operator');
    if (!guard.ok) return guard.response;

    const body = await parseBody(request, actionSchema);
    const { service, repository } = await getOpsContext();
    const ctx = await getServerContext();
    const actor = guard.session.actor;

    switch (body.action) {
      // ── Dry run: inert by construction ──────────────────────────────────
      case 'run_dry': {
        const report = await service.dryRun({ triggeredBy: actor, reason: body.reason });
        await repository.recordAudit({
          action: 'pipeline.dry_run',
          actor,
          target: report.runId,
          after: { wouldNotify: report.wouldShortlist, wouldRecommend: report.wouldRecommend },
          reason: body.reason ?? null,
          requestId: guard.requestId,
        });
        return NextResponse.json({ ok: true, report });
      }

      // ── Discovery ────────────────────────────────────────────────────────
      case 'run_discovery': {
        const runId = await service.beginManualRun({
          triggeredBy: actor,
          note: body.reason ?? 'manual discovery',
        });
        await repository.recordAudit({
          action: 'pipeline.run_triggered',
          actor,
          target: runId,
          after: { sourceIds: body.sourceIds ?? 'all' },
          reason: body.reason ?? null,
          requestId: guard.requestId,
        });

        // The run record exists immediately so the dashboard shows it as
        // in-progress; the worker picks up the actual discovery work.
        return NextResponse.json({
          ok: true,
          runId,
          detail: 'Run recorded. Source execution is performed by the worker.',
        });
      }

      // ── Source state ─────────────────────────────────────────────────────
      case 'source_enable': {
        const admin = await guardMutation('admin');
        if (!admin.ok) return admin.response;

        const before = (await ctx.sources.list({ includeArchived: true })).find(
          (s) => s.id === body.sourceId,
        );
        if (!before) return apiError(404, 'NOT_FOUND', `Source not found: ${body.sourceId}`);

        await ctx.sources.update(body.sourceId, { enabled: body.enabled });
        await repository.recordAudit({
          action: body.enabled ? 'source.enabled' : 'source.disabled',
          actor,
          target: body.sourceId,
          before: { enabled: before.enabled },
          after: { enabled: body.enabled },
          reason: body.reason ?? null,
          requestId: guard.requestId,
        });

        return NextResponse.json({ ok: true, sourceId: body.sourceId, enabled: body.enabled });
      }

      // ── Recalculation ────────────────────────────────────────────────────
      case 'recalculate_matches': {
        const matching = await getMatchingContext();
        if (!matching.profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

        const result = await matching.service.matchAll(matching.profileId, {
          force: true,
          reason: body.reason ?? 'manual recalculation',
        });
        await repository.recordAudit({
          action: 'job.rematched',
          actor,
          target: matching.profileId,
          after: { matched: result.matched, failed: result.failed },
          reason: body.reason ?? null,
          requestId: guard.requestId,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'recalculate_recommendations': {
        const recommendation = await getRecommendationContext();
        if (!recommendation.profileId) {
          return apiError(409, 'NO_PROFILE', 'No active candidate profile');
        }

        await recommendation.service.refreshSignals({ limit: 1000, staleAfterHours: 0 });
        const result = await recommendation.service.rank(recommendation.profileId);
        await repository.recordAudit({
          action: 'job.reranked',
          actor,
          target: recommendation.profileId,
          after: { ranked: result.ranked, notifiable: result.notifiable },
          reason: body.reason ?? null,
          requestId: guard.requestId,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'rematch_job': {
        const matching = await getMatchingContext();
        if (!matching.profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

        const match = await matching.service.matchJob(
          matching.profileId,
          body.jobId,
          body.reason ?? 'manual rematch',
        );
        await repository.recordAudit({
          action: 'job.rematched',
          actor,
          target: body.jobId,
          after: { score: match.overallScore, recommendation: match.recommendation },
          reason: body.reason ?? null,
          requestId: guard.requestId,
        });
        return NextResponse.json({ ok: true, match });
      }

      // ── Dead-letter handling ─────────────────────────────────────────────
      case 'queue_job': {
        const applied = await service.actOnFailedJob(body.queue, body.jobId, body.operation);
        if (!applied) {
          return apiError(
            404,
            'NOT_FOUND',
            `No failed job ${body.jobId} on the ${body.queue} queue. It may have already been retried or aged out.`,
          );
        }

        await repository.recordAudit({
          action: body.operation === 'retry' ? 'queue.job_retried' : 'queue.job_discarded',
          actor,
          target: `${body.queue}:${body.jobId}`,
          after: { operation: body.operation },
          reason: body.reason ?? null,
          requestId: guard.requestId,
        });
        return NextResponse.json({ ok: true, queue: body.queue, jobId: body.jobId });
      }


      default:
        return apiError(400, 'UNKNOWN_ACTION', 'Unrecognised action');
    }
  });
}
