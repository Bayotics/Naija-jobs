import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  PREFERENCE_STRENGTHS,
  WORK_ARRANGEMENT_PREFERENCES,
  matchingWeightsSchema,
  salaryPreferenceSchema,
  weightedPreferenceSchema,
  workAuthorizationPreferenceSchema,
} from '@job-intel/contracts';
import { PREFERENCE_LIST_DIMENSIONS } from '@job-intel/candidate';
import { requireProfile } from '@/lib/candidate';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Candidate preferences.
 *
 * PATCH semantics throughout: each section is optional, and changing one never
 * overwrites another. That matters because the UI edits sections independently
 * and a whole-payload PUT would let a stale tab silently revert someone else's
 * change.
 */
const patchSchema = z
  .object({
    workArrangement: z.enum(WORK_ARRANGEMENT_PREFERENCES).optional(),
    maxOfficeDaysPerWeek: z.number().int().min(0).max(7).nullable().optional(),
    salary: salaryPreferenceSchema.partial().optional(),
    workAuthorization: workAuthorizationPreferenceSchema.partial().optional(),
    weights: matchingWeightsSchema.partial().optional(),
    excludedKeywords: z.array(z.string().trim().min(1).max(120)).optional(),
    seniorityLevels: z.array(z.string().max(40)).optional(),
    /** Whole-list replacement for any weighted dimension. */
    lists: z
      .record(z.enum(PREFERENCE_LIST_DIMENSIONS), z.array(weightedPreferenceSchema))
      .optional(),
    /** Single-entry upsert, so one tag edit does not resend the whole list. */
    upsert: z
      .object({
        dimension: z.enum(PREFERENCE_LIST_DIMENSIONS),
        entry: weightedPreferenceSchema,
      })
      .optional(),
    remove: z
      .object({
        dimension: z.enum(PREFERENCE_LIST_DIMENSIONS),
        value: z.string().min(1).max(200),
      })
      .optional(),
    updateStrength: z
      .object({
        dimension: z.enum(PREFERENCE_LIST_DIMENSIONS),
        value: z.string().min(1).max(200),
        strength: z.enum(PREFERENCE_STRENGTHS),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one section to change' });

export function GET() {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;

    const { version, versionId, preferences } = await guard.service.getPreferences(guard.profileId);

    // Surface which dimensions are currently acting as hard constraints, so the
    // UI can render that distinction without re-deriving the rules.
    const hardConstraints: string[] = [];
    if (preferences.workArrangement === 'REMOTE_ONLY') hardConstraints.push('workArrangement');
    if (preferences.maxOfficeDaysPerWeek !== null) hardConstraints.push('maxOfficeDaysPerWeek');
    if (preferences.salary.minimumIsHard && preferences.salary.minimum !== null) {
      hardConstraints.push('salary.minimum');
    }
    if (preferences.workAuthorization.sponsorshipRequirement === 'required') {
      hardConstraints.push('workAuthorization.sponsorship');
    }
    if (preferences.excludedKeywords.length > 0) hardConstraints.push('excludedKeywords');
    for (const dimension of PREFERENCE_LIST_DIMENSIONS) {
      const list = preferences[dimension];
      if (list.some((p) => p.strength === 'excluded' || p.strength === 'required' || p.hard)) {
        hardConstraints.push(dimension);
      }
    }

    return NextResponse.json({ version, versionId, preferences, hardConstraints });
  });
}

export function PATCH(request: Request) {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;

    const body = await parseBody(request, patchSchema);
    const { service, profileId } = guard;

    // Applied in sequence; each call is its own validated mutation, and each
    // records its own change-log rows.
    let result = await service.getPreferences(profileId).then((p) => ({
      version: p.version,
      versionId: p.versionId,
      preferences: p.preferences,
      changes: [] as Array<{ path: string; summary: string }>,
      embeddingStale: false,
    }));

    const apply = (r: Awaited<ReturnType<typeof service.updateSalary>>) => {
      result = {
        version: r.version,
        versionId: r.versionId,
        preferences: r.preferences,
        changes: [...result.changes, ...r.changes.map((c) => ({ path: c.path, summary: c.summary }))],
        embeddingStale: result.embeddingStale || r.embeddingStale,
      };
    };

    if (body.workArrangement !== undefined || body.maxOfficeDaysPerWeek !== undefined) {
      apply(
        await service.updateWorkArrangement(
          profileId,
          body.workArrangement ?? result.preferences.workArrangement,
          body.maxOfficeDaysPerWeek,
        ),
      );
    }
    if (body.salary) apply(await service.updateSalary(profileId, body.salary));
    if (body.workAuthorization) {
      apply(await service.updateWorkAuthorization(profileId, body.workAuthorization));
    }
    if (body.weights) apply(await service.updateWeights(profileId, body.weights));
    if (body.excludedKeywords) {
      apply(await service.updateExcludedKeywords(profileId, body.excludedKeywords));
    }
    if (body.lists) {
      for (const [dimension, values] of Object.entries(body.lists)) {
        apply(await service.updateList(profileId, dimension as never, values));
      }
    }
    if (body.upsert) {
      apply(await service.upsertListEntry(profileId, body.upsert.dimension, body.upsert.entry));
    }
    if (body.remove) {
      apply(await service.removeListEntry(profileId, body.remove.dimension, body.remove.value));
    }
    if (body.updateStrength) {
      const { dimension, value, strength } = body.updateStrength;
      const current = await service.getPreferences(profileId);
      const entry = current.preferences[dimension].find(
        (p) => p.value.toLowerCase() === value.toLowerCase(),
      );
      if (!entry) return apiError(404, 'NOT_FOUND', `"${value}" is not in ${dimension}`);
      apply(await service.upsertListEntry(profileId, dimension, { ...entry, strength }));
    }

    return NextResponse.json(result);
  });
}
