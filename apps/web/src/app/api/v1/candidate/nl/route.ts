import { NextResponse } from 'next/server';
import { z } from 'zod';
import { preferenceProposalSchema } from '@job-intel/contracts';
import { requireProfile } from '@/lib/candidate';
import { handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Natural-language preference changes.
 *
 * Two deliberately separate operations:
 *
 *   POST  /nl            → propose (reads only, writes nothing)
 *   POST  /nl?apply=true → apply proposals the candidate confirmed
 *
 * Splitting them means the request that involves language interpretation and
 * the request that mutates the database are never the same request. A model can
 * suggest; only a confirmed proposal writes, and it does so through the same
 * validated mutation a UI edit would use.
 */
const proposeSchema = z.object({
  instruction: z.string().trim().min(3).max(2000),
});

const applySchema = z.object({
  /** Proposals the candidate accepted, re-validated here. */
  proposals: z.array(preferenceProposalSchema).min(1).max(20),
  confirmed: z.literal(true),
});

export function POST(request: Request) {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;

    const apply = new URL(request.url).searchParams.get('apply') === 'true';

    if (!apply) {
      const { instruction } = await parseBody(request, proposeSchema);
      const bundle = await guard.service.proposeFromInstruction(guard.profileId, instruction);

      return NextResponse.json({
        ...bundle,
        applied: false,
        note:
          'Nothing has been changed. Re-post to ?apply=true with the proposals you accept.',
      });
    }

    // `confirmed: true` is required in the body, not just the query string, so
    // an accidental replay of a propose request cannot mutate anything.
    const body = await parseBody(request, applySchema);
    const result = await guard.service.applyProposals(guard.profileId, body.proposals);

    return NextResponse.json({
      applied: true,
      version: result.version,
      changes: result.changes.map((c) => ({ path: c.path, summary: c.summary })),
      embeddingStale: result.embeddingStale,
      preferences: result.preferences,
    });
  });
}
