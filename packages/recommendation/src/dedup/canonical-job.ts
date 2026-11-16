import {
  AUTHORITY_WEIGHTS,
  type CanonicalJob,
  type CanonicalMember,
  type FieldProvenance,
  type MergeConflict,
  type SourceAuthorityLevel,
} from '@job-intel/contracts';
import type { SourceAuthorityResolver } from '../authority/source-authority';
import type { DedupCandidate } from './signals';

/**
 * Canonical job assembly.
 *
 * When several records describe one opening, one of them represents the group
 * and the rest stay attached to it. That structure — rather than deleting the
 * losers — is what lets the system answer "where was this found?", "which
 * source is freshest?" and "which application URL should I actually use?".
 *
 * Merging is **not** "take the winner's row". Sources carry different subsets
 * of the truth: LinkedIn often omits the salary the careers page states, and
 * the careers page often omits the structured location the aggregator parsed.
 * Each field is resolved independently, on authority first and recency second,
 * and any genuine disagreement is *recorded* rather than quietly resolved —
 * "LinkedIn says hybrid, the employer says remote" is something the candidate
 * needs to know before they spend an evening on the application.
 */

export interface CanonicalMemberInput {
  candidate: DedupCandidate;
  sourceType: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  duplicateConfidence: number;
  duplicateReason: string;
}

/** The merged field values, alongside where each came from. */
export interface MergedFields {
  applyUrl: string | null;
  canonicalUrl: string | null;
  salaryAnnualUsd: number | null;
  remoteType: string | null;
  city: string | null;
  countryCode: string | null;
  postedAt: Date | null;
  description: string | null;
}

export interface CanonicalAssembly {
  canonical: CanonicalJob;
  merged: MergedFields;
}

interface Claim<T> {
  value: T;
  sourceId: string;
  authority: SourceAuthorityLevel;
  observedAt: Date;
  jobId: string;
}

/**
 * Picks a field value across members.
 *
 * Authority first, recency as the tie-break — but with one deliberate
 * exception: a *present* value from a lower-authority source beats a *missing*
 * value from a higher one. Preferring an authoritative silence over a
 * lower-ranked fact would throw away exactly the information merging exists to
 * recover.
 */
function resolve<T>(
  claims: ReadonlyArray<Claim<T | null>>,
  field: string,
  format: (value: T) => string,
  equal: (a: T, b: T) => boolean = (a, b) => a === b,
): { value: T | null; provenance: FieldProvenance | null; conflict: MergeConflict | null } {
  const present = claims.filter((c): c is Claim<T> => c.value !== null && c.value !== undefined);
  if (present.length === 0) return { value: null, provenance: null, conflict: null };

  const ranked = [...present].sort((a, b) => {
    const byAuthority = AUTHORITY_WEIGHTS[b.authority] - AUTHORITY_WEIGHTS[a.authority];
    if (byAuthority !== 0) return byAuthority;
    return b.observedAt.getTime() - a.observedAt.getTime();
  });

  const winner = ranked[0] as Claim<T>;
  const dissenting = ranked.slice(1).filter((c) => !equal(c.value, winner.value));

  const provenance: FieldProvenance = {
    field,
    sourceId: winner.sourceId,
    authority: winner.authority,
    confidence: AUTHORITY_WEIGHTS[winner.authority],
    observedAt: winner.observedAt,
    reason:
      dissenting.length === 0
        ? `only ${winner.sourceId} stated it`
        : `${winner.sourceId} is the most authoritative of ${ranked.length} sources stating it`,
  };

  const conflict: MergeConflict | null =
    dissenting.length === 0
      ? null
      : {
          field,
          chosen: format(winner.value),
          chosenSourceId: winner.sourceId,
          alternatives: dissenting.map((c) => ({
            value: format(c.value),
            sourceId: c.sourceId,
            authority: c.authority,
            observedAt: c.observedAt,
          })),
          reason:
            `${winner.sourceId} (${winner.authority}) disagrees with ` +
            `${dissenting.map((c) => `${c.sourceId} (${c.authority})`).join(', ')}`,
        };

  return { value: winner.value, provenance, conflict };
}

export class CanonicalJobBuilder {
  constructor(private readonly authority: SourceAuthorityResolver) {}

  build(groupId: string, members: readonly CanonicalMemberInput[]): CanonicalAssembly {
    if (members.length === 0) throw new Error('a canonical job needs at least one member');

    const claims = members.map((member) => ({
      member,
      authority: this.authority.level({
        id: member.candidate.sourceId,
        sourceType: member.sourceType,
      }),
    }));

    const claim = <T>(pick: (m: CanonicalMemberInput) => T | null): Array<Claim<T | null>> =>
      claims.map(({ member, authority }) => ({
        value: pick(member),
        sourceId: member.candidate.sourceId,
        authority,
        observedAt: member.lastSeenAt,
        jobId: member.candidate.jobId,
      }));

    const asString = (v: unknown) => String(v);

    const applyUrl = resolve(claim((m) => m.candidate.applyUrl), 'applyUrl', asString);
    const canonicalUrl = resolve(claim((m) => m.candidate.canonicalUrl), 'canonicalUrl', asString);
    const salary = resolve(
      claim((m) => m.candidate.salaryAnnualUsd),
      'salaryAnnualUsd',
      (v) => `$${v.toLocaleString()}/yr`,
      // Bands within 10% are the same claim expressed differently, not a
      // disagreement worth showing the candidate.
      (a, b) => Math.abs(a - b) / Math.max(a, b, 1) < 0.1,
    );
    const remoteType = resolve(
      claim((m) => (m.candidate.remoteType === 'unknown' ? null : m.candidate.remoteType)),
      'remoteType',
      asString,
    );
    const city = resolve(claim((m) => m.candidate.city), 'city', asString);
    const countryCode = resolve(claim((m) => m.candidate.countryCode), 'countryCode', asString);
    const description = resolve(
      // Longest description wins the *claim*; authority then arbitrates. A
      // truncated aggregator copy is worse than the employer's full text even
      // when the aggregator is fresher.
      claim((m) => m.candidate.description),
      'description',
      (v) => `${v.slice(0, 60)}…`,
      (a, b) => a.length === b.length,
    );

    // Posted date takes the *earliest* known value rather than the most
    // authoritative: the first appearance is when the job actually opened, and
    // aggregators routinely restamp it on every crawl.
    const postedClaims = claim((m) => m.candidate.postedAt).filter(
      (c): c is Claim<Date> => c.value instanceof Date,
    );
    const earliestPosted =
      postedClaims.length === 0
        ? null
        : postedClaims.reduce((a, b) => (a.value.getTime() <= b.value.getTime() ? a : b));

    const provenance = [
      applyUrl.provenance,
      canonicalUrl.provenance,
      salary.provenance,
      remoteType.provenance,
      city.provenance,
      countryCode.provenance,
      description.provenance,
      earliestPosted
        ? {
            field: 'postedAt',
            sourceId: earliestPosted.sourceId,
            authority: earliestPosted.authority,
            confidence: AUTHORITY_WEIGHTS[earliestPosted.authority],
            observedAt: earliestPosted.observedAt,
            reason: 'earliest known posting date across all sources',
          }
        : null,
    ].filter((p): p is FieldProvenance => p !== null);

    const conflicts = [
      applyUrl.conflict,
      salary.conflict,
      remoteType.conflict,
      city.conflict,
      countryCode.conflict,
    ].filter((c): c is MergeConflict => c !== null);

    // The canonical record is the most authoritative member, freshest first on
    // a tie — the one whose row a reader should treat as "the" job.
    const canonicalMember = [...claims].sort((a, b) => {
      const byAuthority = AUTHORITY_WEIGHTS[b.authority] - AUTHORITY_WEIGHTS[a.authority];
      if (byAuthority !== 0) return byAuthority;
      return b.member.lastSeenAt.getTime() - a.member.lastSeenAt.getTime();
    })[0]!;

    // The best application path is chosen across *all* members, independently
    // of which record is canonical: the authoritative source often links back
    // to a board while a lower-ranked member holds the direct ATS link.
    const bestApply = claims
      .filter(({ member }) => member.candidate.applyUrl !== null)
      .sort((a, b) => AUTHORITY_WEIGHTS[b.authority] - AUTHORITY_WEIGHTS[a.authority])[0];

    const canonicalMembers: CanonicalMember[] = claims.map(({ member, authority }) => ({
      jobId: member.candidate.jobId,
      sourceId: member.candidate.sourceId,
      authority,
      sourceUrl: member.candidate.sourceUrl,
      applyUrl: member.candidate.applyUrl,
      postedAt: member.candidate.postedAt,
      lastSeenAt: member.lastSeenAt,
      duplicateConfidence: member.duplicateConfidence,
      duplicateReason: member.duplicateReason,
    }));

    return {
      canonical: {
        groupId,
        canonicalJobId: canonicalMember.member.candidate.jobId,
        bestApplyUrl: bestApply?.member.candidate.applyUrl ?? null,
        bestApplyUrlSourceId: bestApply?.member.candidate.sourceId ?? null,
        members: canonicalMembers,
        provenance,
        conflicts,
        firstSeenAt: new Date(Math.min(...members.map((m) => m.firstSeenAt.getTime()))),
        lastSeenAt: new Date(Math.max(...members.map((m) => m.lastSeenAt.getTime()))),
      },
      merged: {
        applyUrl: applyUrl.value,
        canonicalUrl: canonicalUrl.value,
        salaryAnnualUsd: salary.value,
        remoteType: remoteType.value,
        city: city.value,
        countryCode: countryCode.value,
        postedAt: earliestPosted?.value ?? null,
        description: description.value,
      },
    };
  }
}
