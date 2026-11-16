import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MAX_FILE_BYTES } from '@job-intel/resume';
import { getResumeContext } from '@/lib/resume';
import { apiError, handler } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Document upload and listing.
 *
 * Three deliberate properties:
 *
 *  - **The candidate comes from the session, never the request.** A
 *    client-supplied candidate id on an upload endpoint would let anyone write
 *    a resume into someone else's profile.
 *
 *  - **The response never echoes document text.** It carries counts, section
 *    kinds and stage results. Returning the extracted text would put it into
 *    browser caches, proxy logs and error reporters, all of which are places
 *    the brief says a resume must not be.
 *
 *  - **A rejection is a 200 with a reason, not a 500.** "Your PDF is a scan" is
 *    a normal outcome the candidate needs to read, not a server error.
 */

const metadataSchema = z.object({
  label: z.string().trim().max(120).optional(),
  targetRole: z.string().trim().max(120).nullable().optional(),
  kind: z.enum(['resume', 'cover_letter', 'portfolio_export', 'other']).optional(),
});

export function GET() {
  return handler(async () => {
    const { service, repository, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const [documents, comparison] = await Promise.all([
      repository.listDocuments(profileId),
      service.compareDocuments(profileId),
    ]);

    return NextResponse.json({
      documents: documents.map((document) => ({
        id: document.id,
        label: document.label,
        filename: document.filename,
        kind: document.kind,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        status: document.status,
        rejectionReason: document.rejectionReason,
        targetRole: document.targetRole,
        uploadedAt: document.uploadedAt,
        extractedAt: document.extractedAt,
      })),
      comparison,
    });
  });
}

export function POST(request: Request) {
  return handler(async () => {
    const { service, profileId } = await getResumeContext();
    if (!profileId) return apiError(409, 'NO_PROFILE', 'No active candidate profile');

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return apiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload the document as multipart/form-data.');
    }

    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return apiError(400, 'MISSING_FILE', 'No file was included in the upload.');
    }

    /*
     * Size is checked before the bytes are read into memory. The validator
     * checks it again — it must, since it can be called from anywhere — but
     * refusing here means a 200MB upload never becomes a 200MB buffer.
     */
    if (file.size > MAX_FILE_BYTES) {
      return apiError(
        413,
        'FILE_TOO_LARGE',
        `The file is ${(file.size / 1024 / 1024).toFixed(1)}MB, above the ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB limit.`,
      );
    }

    const metadata = metadataSchema.parse({
      label: form.get('label')?.toString() || undefined,
      targetRole: form.get('targetRole')?.toString() || undefined,
      kind: form.get('kind')?.toString() || undefined,
    });

    const result = await service.upload({
      candidateId: profileId,
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      declaredMimeType: file.type || null,
      ...(metadata.label !== undefined ? { label: metadata.label } : {}),
      ...(metadata.targetRole !== undefined ? { targetRole: metadata.targetRole } : {}),
      ...(metadata.kind !== undefined ? { kind: metadata.kind } : {}),
    });

    return NextResponse.json(
      {
        document: {
          id: result.document.id,
          label: result.document.label,
          filename: result.document.filename,
          status: result.document.status,
          rejectionReason: result.document.rejectionReason,
        },
        duplicate: result.duplicate,
        accepted: result.accepted,
        validation: {
          accepted: result.validation.accepted,
          detectedMimeType: result.validation.detectedMimeType,
          declaredMimeType: result.validation.declaredMimeType,
          sizeBytes: result.validation.sizeBytes,
          checks: result.validation.checks,
          rejectionReason: result.validation.rejectionReason,
        },
        // Counts and stage names only. Never the text.
        extraction: result.pipeline
          ? {
              stages: result.pipeline.stages,
              sections: result.pipeline.sections.map((section) => ({
                kind: section.kind,
                heading: section.heading,
                confidence: section.confidence,
                aiClassified: section.aiClassified,
                characters: section.text.length,
              })),
              roles: result.pipeline.experience.length,
              skills: result.pipeline.skills.length,
              education: result.pipeline.education.length,
              certifications: result.pipeline.certifications.length,
              projects: result.pipeline.projects.length,
              textLength: result.pipeline.textLength,
            }
          : null,
        profile: result.profile
          ? {
              profileVersion: result.profile.profileVersion,
              skills: result.profile.skills.length,
              experience: result.profile.experience.length,
              quality: result.profile.quality,
            }
          : null,
        conflictsDetected: result.conflictsDetected,
      },
      // A rejected document is a recorded, meaningful outcome — 201 for the
      // record that was created, with `accepted: false` carrying the verdict.
      { status: result.duplicate ? 200 : 201 },
    );
  });
}
