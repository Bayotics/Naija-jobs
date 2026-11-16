import { createHash } from 'node:crypto';
import type {
  DiscoveryItemResult,
  SourceJobDraft,
} from '@job-intel/contracts';
import { type JobIdentityService, normalizeJobDraft, type NormalizationOptions } from '@job-intel/core';
import type { DiscoveryRepository } from '@job-intel/db';

/**
 * The per-posting pipeline:
 *
 *   RAW → NORMALIZE → VALIDATE → IDENTITY → UPSERT → VERSION → EVENT
 *
 * Each stage is a separate, independently testable function, and the whole
 * chain is wrapped so that **one bad posting can never abort a source run**.
 * That property is the entire point: a single source returning one malformed
 * record out of two hundred must cost one record, not the run.
 */

export interface ValidationRule {
  name: string;
  /** Returns null when the job passes, or a human-readable reason when not. */
  check(input: { draft: SourceJobDraft; job: ReturnType<typeof normalizeJobDraft> }): string | null;
}

export interface PipelineOptions {
  normalization?: NormalizationOptions;
  /** Postings older than this are dropped at validation. 0 disables the check. */
  maxAgeDays?: number;
  minDescriptionLength?: number;
  extraRules?: ValidationRule[];
}

export interface PipelineDependencies {
  repository: DiscoveryRepository;
  identity: JobIdentityService;
  sourceId: string;
  sourceRunId: string | null;
  traceId: string;
  /**
   * The query that produced this posting, when one did.
   *
   * Carried through so query learning can later ask which searches surfaced
   * jobs the candidate engaged with. Null for feeds and ATS listings, where the
   * concept does not apply.
   */
  discoveryQueryId?: string | null;
  onEvent?: (event: PipelineEvent) => void;
}

export type PipelineEvent =
  | { type: 'JOB_DISCOVERED'; jobId: string; title: string; url: string }
  | { type: 'JOB_UPDATED'; jobId: string; changedFields: string[] }
  | { type: 'JOB_DUPLICATE'; jobId: string }
  | { type: 'JOB_REJECTED'; reason: string; url: string }
  | { type: 'JOB_FAILED'; reason: string; url: string | null };

/**
 * Baseline validation.
 *
 * Deliberately minimal and *structural*: this stage answers "is this a usable
 * job record", never "does this suit the candidate". Preference filtering is a
 * separate concern that runs against a profile, not against a source.
 */
export function defaultValidationRules(options: PipelineOptions): ValidationRule[] {
  const maxAgeDays = options.maxAgeDays ?? 90;
  const minDescriptionLength = options.minDescriptionLength ?? 0;

  const rules: ValidationRule[] = [
    {
      name: 'title_present',
      check: ({ job }) =>
        job.ok && job.job.title.trim().length >= 2 ? null : 'title is missing or too short',
    },
    {
      name: 'company_present',
      check: ({ job }) =>
        job.ok && job.job.company.name.trim().length >= 2 ? null : 'company name is missing',
    },
    {
      name: 'url_present',
      check: ({ job }) => (job.ok && job.job.sourceUrl ? null : 'source URL is missing'),
    },
  ];

  if (minDescriptionLength > 0) {
    rules.push({
      name: 'description_length',
      check: ({ job }) => {
        if (!job.ok) return null;
        const length = job.job.description?.length ?? 0;
        return length >= minDescriptionLength
          ? null
          : `description is ${length} chars, below the ${minDescriptionLength} minimum`;
      },
    });
  }

  if (maxAgeDays > 0) {
    rules.push({
      name: 'not_stale',
      check: ({ job }) => {
        if (!job.ok || !job.job.postedAt) return null; // unknown age is not a failure
        const ageDays = (Date.now() - job.job.postedAt.getTime()) / 86_400_000;
        return ageDays <= maxAgeDays ? null : `posting is ${Math.round(ageDays)} days old`;
      },
    });
  }

  return [...rules, ...(options.extraRules ?? [])];
}

/**
 * Runs one draft through the full chain.
 *
 * Never throws. Every failure mode — normalization, validation, persistence —
 * becomes a typed result the runner can count.
 */
export async function processDraft(
  draft: SourceJobDraft,
  deps: PipelineDependencies,
  options: PipelineOptions = {},
  rules: ValidationRule[] = defaultValidationRules(options),
): Promise<DiscoveryItemResult> {
  try {
    // ── NORMALIZE ─────────────────────────────────────────────────────────
    const normalized = normalizeJobDraft(draft, options.normalization);
    if (!normalized.ok) {
      deps.onEvent?.({ type: 'JOB_REJECTED', reason: normalized.reason, url: draft.url });
      return { outcome: 'rejected', jobId: null, reason: normalized.reason, changedFields: [] };
    }

    // ── VALIDATE ──────────────────────────────────────────────────────────
    for (const rule of rules) {
      const failure = rule.check({ draft, job: normalized });
      if (failure) {
        const reason = `${rule.name}: ${failure}`;
        deps.onEvent?.({ type: 'JOB_REJECTED', reason, url: draft.url });
        return { outcome: 'rejected', jobId: null, reason, changedFields: [] };
      }
    }

    const job = normalized.job;

    // ── IDENTITY ──────────────────────────────────────────────────────────
    // Two distinct hashes, deliberately:
    //
    //   `identity.contentHash` covers the *normalized* job, and drives job
    //   change detection. Deriving it from the raw payload instead would mean
    //   an improved normalizer replaying old data is skipped as "unchanged".
    //
    //   `rawContentHash` covers the *raw payload*, and is the exact-dedup guard
    //   on `raw_postings` that makes re-crawling free.
    const identity = deps.identity.compute(job);
    const rawContentHash = deps.identity.contentHash(draft.raw ?? null);
    const sourceIdentity = resolveSourceIdentity(draft, identity.urlHash, identity.contentHash);

    // ── RAW CAPTURE ───────────────────────────────────────────────────────
    // Stored before the job so a normalization change can be replayed against
    // exactly what the source sent, even for records that later fail.
    const raw = await deps.repository.saveRawPosting({
      sourceId: deps.sourceId,
      sourceRunId: deps.sourceRunId,
      externalId: draft.externalId,
      sourceUrl: draft.url,
      payload: draft.raw ?? null,
      payloadFormat: draft.descriptionFormat === 'html' ? 'html' : 'json',
      contentHash: rawContentHash,
      traceId: deps.traceId,
    });

    // ── UPSERT (+ VERSION) ────────────────────────────────────────────────
    const persisted = await deps.repository.upsertJob({
      job,
      sourceId: deps.sourceId,
      rawPostingId: raw.id,
      identity: { ...identity, sourceIdentity },
      traceId: deps.traceId,
      discoveryQueryId: deps.discoveryQueryId ?? null,
    });

    // ── EVENT ─────────────────────────────────────────────────────────────
    if (persisted.outcome === 'created') {
      deps.onEvent?.({
        type: 'JOB_DISCOVERED',
        jobId: persisted.jobId,
        title: job.title,
        url: job.canonicalUrl ?? job.sourceUrl,
      });
    } else if (persisted.outcome === 'updated') {
      deps.onEvent?.({
        type: 'JOB_UPDATED',
        jobId: persisted.jobId,
        changedFields: persisted.changedFields,
      });
    } else {
      deps.onEvent?.({ type: 'JOB_DUPLICATE', jobId: persisted.jobId });
    }

    return {
      outcome: persisted.outcome,
      jobId: persisted.jobId,
      reason: null,
      changedFields: persisted.changedFields,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.onEvent?.({ type: 'JOB_FAILED', reason, url: draft.url ?? null });
    return { outcome: 'failed', jobId: null, reason, changedFields: [] };
  }
}

/**
 * The stable per-source key.
 *
 * Preference order matters. A source's own id is best because it survives URL
 * changes; a normalized URL hash is the next best; the content hash is a last
 * resort and means an edit will look like a new posting for that source.
 */
export function resolveSourceIdentity(
  draft: SourceJobDraft,
  urlHash: string | null,
  contentHash: string,
): string {
  if (draft.externalId && draft.externalId.trim().length > 0) {
    return `ext:${createHash('sha256').update(draft.externalId.trim()).digest('hex').slice(0, 32)}`;
  }
  if (urlHash) return `url:${urlHash.slice(0, 32)}`;
  return `content:${contentHash.slice(0, 32)}`;
}
