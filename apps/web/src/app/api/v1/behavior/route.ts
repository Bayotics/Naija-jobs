import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  BEHAVIOR_EVENT_TYPES,
  CANDIDATE_REJECTION_REASONS,
  EVENT_CONTEXTS,
} from '@job-intel/contracts';
import { getLearningContext } from '@/lib/learning';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Behaviour ingestion.
 *
 * Deliberately the cheapest endpoint in the system: it validates, writes one
 * row, and returns. No aggregation, no model call, no recomputation. Clicking a
 * job must not cost anything the user can feel, and the aggregation that makes
 * the click useful happens on a debounced background pass.
 *
 * The candidate is taken from the active profile rather than from the request
 * body. A client-supplied candidate id on an ingestion endpoint is an invitation
 * to write events into someone else's history.
 */
const eventSchema = z.object({
  jobId: z.string().uuid().nullable().default(null),
  eventType: z.enum(BEHAVIOR_EVENT_TYPES),
  context: z.enum(EVENT_CONTEXTS).default('DASHBOARD'),
  sessionId: z.string().max(80).nullable().default(null),
  notificationId: z.string().uuid().nullable().default(null),
  recommendationId: z.string().max(120).nullable().default(null),
  shownAtRank: z.number().int().min(1).max(10_000).nullable().default(null),
  rejectionReason: z.enum(CANDIDATE_REJECTION_REASONS).nullable().default(null),
  reasonText: z.string().trim().max(500).nullable().default(null),
  /**
   * Bounded and non-identifying.
   *
   * Constrained to scalars rather than accepting an arbitrary object: a
   * general-purpose metadata bag on an ingestion endpoint is how personal data
   * ends up in a behavioural store nobody meant to put it in.
   */
  metadata: z
    .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
    .default({}),
});

const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(50) });

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getLearningContext();
    if (!profileId) {
      return apiError(409, 'NO_PROFILE', 'No active candidate profile');
    }

    const body = await parseBody(request, z.union([eventSchema, batchSchema]));
    const events = 'events' in body ? body.events : [body];

    const results = [];
    for (const event of events) {
      results.push(
        await service.recordEvent({
          ...event,
          candidateId: profileId,
          occurredAt: new Date(),
        }),
      );
    }

    return NextResponse.json({
      recorded: results.filter((result) => !result.duplicate).length,
      duplicates: results.filter((result) => result.duplicate).length,
    });
  });
}

/** The candidate's own learning state. */
export function GET() {
  return handler(async () => {
    const { service, profileId } = await getLearningContext();
    if (!profileId) {
      return apiError(409, 'NO_PROFILE', 'No active candidate profile');
    }

    const state = await service.getLearningState(profileId);

    return NextResponse.json({
      config: state.config,
      profile: state.profile,
      // Capped: the full affinity table is not a useful API response.
      affinities: state.affinities.slice(0, 100),
      suggestions: state.suggestions,
      timeline: state.timeline.slice(0, 40),
    });
  });
}

/**
 * Deletes behavioural history.
 *
 * Separate from the reset controls because it is categorically different: reset
 * clears what was *inferred*, this clears what was *recorded*.
 */
export function DELETE() {
  return handler(async () => {
    const { service, profileId } = await getLearningContext();
    if (!profileId) {
      return apiError(409, 'NO_PROFILE', 'No active candidate profile');
    }

    const removed = await service.deleteHistory(profileId);
    return NextResponse.json({ ...removed, explicitPreferencesUnchanged: true });
  });
}
