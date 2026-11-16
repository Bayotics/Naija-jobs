import { NextResponse } from 'next/server';
import { getResumeContext } from '@/lib/resume';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * One document: its extraction detail, or its deletion.
 *
 * The GET returns section text, which is the one place in the API where
 * document content is exposed at all. It is here because the extraction
 * debugger cannot show why a role was parsed the way it was without it, and it
 * is guarded the same way as everything else: the document must belong to the
 * active profile, and the response is never cached.
 */

interface Params {
  params: Promise<{ id: string }>;
}

export function GET(_request: Request, { params }: Params) {
  return handler(async () => {
    const { id } = await params;
    const { repository, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const document = await repository.getDocument(id);

    // The same response for "not yours" and "not found": distinguishing them
    // turns the endpoint into a way to test whether a document id exists.
    if (!document || document.candidateId !== profileId || document.deletedAt) {
      return apiError(404, 'NOT_FOUND', 'No such document');
    }

    const sections = await repository.getSections(id);

    return NextResponse.json({
      document,
      sections: sections.map((section) => ({
        kind: section.kind,
        heading: section.heading,
        confidence: section.confidence,
        aiClassified: section.aiClassified,
        startOffset: section.startOffset,
        endOffset: section.endOffset,
        text: section.text,
      })),
    });
  });
}

export function DELETE(_request: Request, { params }: Params) {
  return handler(async () => {
    const { id } = await params;
    const { service, repository, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const document = await repository.getDocument(id);
    if (!document || document.candidateId !== profileId) {
      return apiError(404, 'NOT_FOUND', 'No such document');
    }

    await service.deleteDocument(profileId, id);
    return NextResponse.json({ deleted: true, id });
  });
}
