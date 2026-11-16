import { NextResponse } from 'next/server';
import { z } from 'zod';
import { RECOMMENDATION_CATEGORIES } from '@job-intel/contracts';
import { requireMatchingProfile } from '@/lib/matching';
import { handler, parseQuery } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Every filter is an enum or a bounded number, never free text interpolated
 * into SQL. Filtering is expressive but the shape of the query is fixed by this
 * schema, so a caller cannot widen it into something the repository did not
 * intend to expose.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  minScore: z.coerce.number().min(0).max(100).optional(),
  eligibleOnly: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  recommendation: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(RECOMMENDATION_CATEGORIES)).optional()),
});

/**
 * The candidate's matches, best first.
 *
 * Returns a summary per match rather than the full trace: a list view needs the
 * score, the label and the headline reason, and shipping every component score
 * and evidence string for fifty jobs would be a payload nobody reads. The
 * detail endpoint has the rest.
 */
export function GET(request: Request) {
  return handler(async () => {
    const guard = await requireMatchingProfile();
    if (!guard.ok) return guard.response;

    const query = parseQuery(request, querySchema);
    const matches = await guard.matches.list({
      profileId: guard.profileId,
      limit: query.limit,
      offset: query.offset,
      eligibleOnly: query.eligibleOnly,
      ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
      ...(query.recommendation ? { recommendations: query.recommendation } : {}),
    });

    return NextResponse.json({
      items: matches.map((match) => ({
        jobId: match.jobId,
        score: match.overallScore,
        confidence: match.confidence,
        recommendation: match.recommendation,
        eligible: match.eligible,
        explanation: match.explanation,
        matchedRequirements: match.matchedRequirements.slice(0, 8),
        missingRequirements: match.missingRequirements.slice(0, 8),
        concerns: match.concerns.slice(0, 4),
        // Enough to render a breakdown bar without the full trace.
        topDimensions: match.componentScores
          .filter((c) => c.applicable)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((c) => ({ dimension: c.dimension, score: c.score })),
        computedAt: match.computedAt,
        matchingVersion: match.trace.matchingVersion,
      })),
      total: matches.length,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
