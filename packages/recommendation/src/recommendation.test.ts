import { describe, expect, it } from 'vitest';
import { qualityAssessmentSchema, jobRecommendationSchema } from '@job-intel/contracts';
import { DuplicateDetector } from './dedup/duplicate-detector';
import { CanonicalJobBuilder } from './dedup/canonical-job';
import { SourceAuthorityResolver } from './authority/source-authority';
import { scoreFreshness, withinFreshnessWindow } from './freshness/freshness';
import { detectStaleness } from './freshness/staleness';
import { shouldVerify, verifyBatch, NullUrlVerifier } from './freshness/verification';
import { scoreJobQuality } from './quality/job-quality';
import {
  combineWithReasoning,
  detectScamDeterministic,
  shouldConsultModel,
} from './quality/scam-detector';
import { detectRepost } from './quality/repost-detector';
import { calibrate, describeDistribution } from './ranking/calibration';
import { classifyTier } from './ranking/categories';
import { diversify } from './ranking/diversifier';
import { detectMaterialChanges } from './eligibility/material-change';
import {
  applyDigestCaps,
  evaluateNotificationEligibility,
} from './eligibility/notification-eligibility';
import { advanceExposure, emptyExposure, behavioralAffinity } from './eligibility/exposure';
import { RecommendationEngine } from './engine/recommendation-engine';
import {
  FIXTURE_NOW,
  ago,
  buildFixtureCorpus,
  makeDedupCandidate,
  makeRecommendationInput,
} from './testing/fixtures';

/**
 * Recommendation layer tests.
 *
 * Organised around the twenty-one scenarios the brief names, then the realistic
 * fifty-job ranking. The last group is the important one: anything can be made
 * to pass on hand-picked fixtures, and the question that matters is whether the
 * *ordering* over a mostly-mediocre corpus is one a person would agree with.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const PROFILE = '00000000-0000-4000-8000-0000000000c0';

const detector = new DuplicateDetector();
const authority = new SourceAuthorityResolver();

function quality(overrides = {}) {
  return qualityAssessmentSchema.parse({
    qualityScore: 0.7, scamScore: 0.02, qualityConfidence: 0.8, ...overrides,
  });
}

describe('deduplication', () => {
  // 1
  it('recognises an exact duplicate via a shared application URL', () => {
    const verdict = detector.compare(
      makeDedupCandidate({ jobId: 'a', sourceId: 'linkedin', applyUrl: 'https://boards.greenhouse.io/acme/jobs/9?utm_source=li' }),
      makeDedupCandidate({ jobId: 'b', sourceId: 'careers', applyUrl: 'https://boards.greenhouse.io/acme/jobs/9' }),
    );
    expect(verdict.isDuplicate).toBe(true);
    expect(verdict.tier).toBe('exact');
    expect(verdict.duplicateReason).toMatch(/same normalized url/);
  });

  // 2
  it('recognises a near duplicate from company, title, location and text', () => {
    const verdict = detector.compare(
      makeDedupCandidate({ jobId: 'a', sourceId: 'linkedin' }),
      makeDedupCandidate({ jobId: 'b', sourceId: 'indeed' }),
    );
    expect(verdict.duplicateConfidence).toBeGreaterThan(0.7);
    expect(verdict.tier === 'strong' || verdict.tier === 'exact').toBe(true);
  });

  // 3
  it('never merges the same title at a different company', () => {
    const verdict = detector.compare(
      makeDedupCandidate({ jobId: 'a', companyName: 'Acme Corp' }),
      makeDedupCandidate({ jobId: 'b', companyName: 'Globex Industries' }),
    );
    // Descriptions are copied between employers constantly. Without this veto a
    // similarity-only system merges half a job board into one record.
    expect(verdict.isDuplicate).toBe(false);
    expect(verdict.tier).toBe('distinct');
    expect(verdict.duplicateReason).toMatch(/different companies/);
  });

  // 4
  it('keeps two different jobs at the same company apart', () => {
    const verdict = detector.compare(
      makeDedupCandidate({ jobId: 'a', title: 'Senior Frontend Engineer', city: 'Berlin' }),
      makeDedupCandidate({
        jobId: 'b',
        title: 'Staff Data Engineer',
        city: 'Munich',
        description: 'We need a data engineer to build our Spark and Airflow pipelines at scale for analytics workloads across the business.',
        requirements: ['Spark', 'Airflow', 'Python'],
      }),
    );
    expect(verdict.isDuplicate).toBe(false);
  });

  // 5
  it('merges the same job seen through different sources', () => {
    const verdict = detector.compare(
      makeDedupCandidate({ jobId: 'a', sourceId: 'reddit-dev-jobs', applyUrl: null }),
      makeDedupCandidate({ jobId: 'b', sourceId: 'company-careers', applyUrl: null }),
    );
    expect(verdict.duplicateConfidence).toBeGreaterThan(detector.config.reviewThreshold);
  });

  // 6
  it('treats two missing salaries as unknown, not as agreement', () => {
    const verdict = detector.compare(
      makeDedupCandidate({ jobId: 'a', salaryAnnualUsd: null }),
      makeDedupCandidate({ jobId: 'b', salaryAnnualUsd: null }),
    );
    const salary = verdict.signals.find((s) => s.signal === 'salary');
    // Shared silence manufacturing confidence is the classic dedup bug.
    expect(salary?.agreement).toBe('unknown');
  });

  // 7
  it('records a salary conflict without vetoing the merge', () => {
    const verdict = detector.compare(
      makeDedupCandidate({ jobId: 'a', salaryAnnualUsd: 120_000, applyUrl: 'https://x.test/1' }),
      makeDedupCandidate({ jobId: 'b', salaryAnnualUsd: 60_000, applyUrl: 'https://x.test/1' }),
    );
    expect(verdict.conflicts.some((c) => c.signal === 'salary')).toBe(true);
    // An aggregator's estimate beside an employer's exact figure is normal.
    expect(verdict.isDuplicate).toBe(true);
  });

  // 8 — canonical assembly and conflicting remote status
  it('merges fields on authority and records the conflict', () => {
    const builder = new CanonicalJobBuilder(authority);
    const assembly = builder.build('group-1', [
      {
        candidate: makeDedupCandidate({
          jobId: 'a', sourceId: 'linkedin', remoteType: 'hybrid', salaryAnnualUsd: null,
          applyUrl: 'https://linkedin.test/apply/1',
        }),
        sourceType: 'job_api',
        firstSeenAt: ago(3 * DAY),
        lastSeenAt: ago(HOUR),
        duplicateConfidence: 0.9,
        duplicateReason: 'same job',
      },
      {
        candidate: makeDedupCandidate({
          jobId: 'b', sourceId: 'greenhouse', remoteType: 'remote', salaryAnnualUsd: 90_000,
          applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        }),
        sourceType: 'ats',
        firstSeenAt: ago(2 * DAY),
        lastSeenAt: ago(2 * HOUR),
        duplicateConfidence: 1,
        duplicateReason: 'canonical member',
      },
    ]);

    // The ATS wins the canonical slot and its remote claim, but the
    // disagreement survives so the candidate can see it.
    expect(assembly.canonical.canonicalJobId).toBe('b');
    expect(assembly.merged.remoteType).toBe('remote');
    expect(assembly.canonical.conflicts.some((c) => c.field === 'remoteType')).toBe(true);
    // A present value from anywhere beats an absent one from the authority.
    expect(assembly.merged.salaryAnnualUsd).toBe(90_000);
    expect(assembly.canonical.bestApplyUrl).toContain('greenhouse');
  });

  it('takes the earliest posting date, not the most authoritative', () => {
    const builder = new CanonicalJobBuilder(authority);
    const assembly = builder.build('group-2', [
      {
        candidate: makeDedupCandidate({ jobId: 'a', sourceId: 'aggregator', postedAt: ago(1 * DAY) }),
        sourceType: 'job_api',
        firstSeenAt: ago(1 * DAY), lastSeenAt: ago(HOUR),
        duplicateConfidence: 1, duplicateReason: 'x',
      },
      {
        candidate: makeDedupCandidate({ jobId: 'b', sourceId: 'greenhouse', postedAt: ago(9 * DAY) }),
        sourceType: 'ats',
        firstSeenAt: ago(9 * DAY), lastSeenAt: ago(HOUR),
        duplicateConfidence: 1, duplicateReason: 'y',
      },
    ]);
    // Aggregators restamp dates on every crawl; the first appearance is when
    // the job actually opened.
    expect(assembly.merged.postedAt?.getTime()).toBe(ago(9 * DAY).getTime());
  });
});

describe('source authority', () => {
  it('resolves per-source, then per-type, then default', () => {
    const resolver = new SourceAuthorityResolver({
      bySourceId: { 'noisy-aggregator': 'unverified' },
    });
    expect(resolver.level({ id: 'noisy-aggregator', sourceType: 'job_api' })).toBe('unverified');
    expect(resolver.level({ id: 'greenhouse', sourceType: 'ats' })).toBe('authoritative');
    expect(resolver.level({ id: 'unknown', sourceType: 'nonexistent' })).toBe('medium');
  });

  it('is configuration, not a hardcoded hierarchy', () => {
    const inverted = new SourceAuthorityResolver({
      bySourceType: { ats: 'low', social: 'authoritative' },
    });
    expect(inverted.weight({ id: 'x', sourceType: 'social' })).toBeGreaterThan(
      inverted.weight({ id: 'y', sourceType: 'ats' }),
    );
  });
});

describe('freshness and lifecycle', () => {
  it('scores a minutes-old posting at the top and decays with age', () => {
    const fresh = scoreFreshness({
      postedAt: ago(20 * 60_000), updatedAt: null, lastVerifiedAt: null,
      firstSeenAt: ago(20 * 60_000), now: FIXTURE_NOW,
    });
    const old = scoreFreshness({
      postedAt: ago(25 * DAY), updatedAt: null, lastVerifiedAt: null,
      firstSeenAt: ago(25 * DAY), now: FIXTURE_NOW,
    });
    expect(fresh.score).toBe(100);
    expect(old.score).toBeLessThan(15);
    expect(fresh.basis).toBe('posted');
  });

  it('reports lower confidence when the age is inferred from first sight', () => {
    const inferred = scoreFreshness({
      postedAt: null, updatedAt: null, lastVerifiedAt: null,
      firstSeenAt: ago(2 * DAY), now: FIXTURE_NOW,
    });
    expect(inferred.basis).toBe('first_seen');
    expect(inferred.confidence).toBeLessThan(0.6);
    expect(inferred.explanation).toMatch(/lower bound/);
  });

  // 9
  it('marks an old, long-absent posting stale without closing it', () => {
    const verdict = detectStaleness({
      postedAt: ago(70 * DAY), validThrough: null, lastSeenAt: ago(20 * DAY),
      lastVerifiedAt: null, absenceRuns: 4, verification: null,
      description: 'We are hiring an engineer.', removedFromSource: false, now: FIXTURE_NOW,
    });
    expect(verdict.status).toBe('STALE');
  });

  // 10
  it('marks a posting past its stated deadline as expired', () => {
    const verdict = detectStaleness({
      postedAt: ago(40 * DAY), validThrough: ago(5 * DAY), lastSeenAt: ago(DAY),
      lastVerifiedAt: null, absenceRuns: 0, verification: null,
      description: null, removedFromSource: false, now: FIXTURE_NOW,
    });
    expect(verdict.status).toBe('EXPIRED');
  });

  // 11
  it('closes a job whose application URL 404s', () => {
    const verdict = detectStaleness({
      postedAt: ago(6 * DAY), validThrough: null, lastSeenAt: ago(DAY),
      lastVerifiedAt: null, absenceRuns: 0,
      verification: { outcome: 'not_found', httpStatus: 404 },
      description: null, removedFromSource: false, now: FIXTURE_NOW,
    });
    expect(verdict.status).toBe('CLOSED');
  });

  it('closes a job whose text says the position is filled', () => {
    const verdict = detectStaleness({
      postedAt: ago(10 * DAY), validThrough: null, lastSeenAt: ago(DAY),
      lastVerifiedAt: null, absenceRuns: 0, verification: null,
      description: 'This position has been filled. Thank you for your interest.',
      removedFromSource: false, now: FIXTURE_NOW,
    });
    expect(verdict.status).toBe('CLOSED');
  });

  it('does not treat a transient HTTP error as closure', () => {
    const verdict = detectStaleness({
      postedAt: ago(2 * DAY), validThrough: null, lastSeenAt: ago(HOUR),
      lastVerifiedAt: null, absenceRuns: 0,
      verification: { outcome: 'error', httpStatus: 503 },
      description: null, removedFromSource: false, now: FIXTURE_NOW,
    });
    expect(verdict.status).toBe('ACTIVE');
  });

  it('verifies high-value jobs first and honours the budget', async () => {
    const checked: string[] = [];
    const verifier = {
      id: 'stub',
      verify: (url: string) => {
        checked.push(url);
        return Promise.resolve({
          outcome: 'reachable' as const, url, httpStatus: 200,
          checkedAt: FIXTURE_NOW, durationMs: 5, detail: '',
        });
      },
    };

    const run = await verifyBatch(
      [
        { jobId: 'low', url: 'https://x/low', recommendationScore: 40, lastVerifiedAt: null },
        { jobId: 'high', url: 'https://x/high', recommendationScore: 95, lastVerifiedAt: null },
      ],
      verifier,
      { maxChecksPerRun: 1 },
      FIXTURE_NOW,
    );

    expect(run.checked).toBe(1);
    expect(checked[0]).toContain('high');
  });

  it('skips a job verified inside its window', () => {
    const decision = shouldVerify(
      { jobId: 'x', url: 'https://x', recommendationScore: 95, lastVerifiedAt: ago(HOUR) },
      { enabled: true, highValueScore: 80, maxAgeHoursHighValue: 6, maxAgeHoursNormal: 168, maxChecksPerRun: 10, timeoutMs: 1000 },
      FIXTURE_NOW,
    );
    expect(decision.verify).toBe(false);
  });

  it('degrades to skipped with no verifier configured', async () => {
    const result = await new NullUrlVerifier().verify('https://x');
    expect(result.outcome).toBe('skipped');
  });
});

describe('job quality', () => {
  const base = {
    enrichmentQuality: quality(),
    companyIdentified: true,
    companyDomainKnown: true,
    descriptionLength: 2600,
    requirementsCount: 5,
    responsibilitiesCount: 4,
    salaryStated: true,
    applicationUrlPresent: true,
    applicationUrlReachable: true as boolean | null,
    sourceAuthority: 'authoritative' as const,
    sourceCount: 2,
    isRepost: false,
  };

  // 12
  it('scores a complete, verified, authoritative posting highly', () => {
    const result = scoreJobQuality(base);
    expect(result.score).toBeGreaterThan(90);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('does not punish a missing salary — it lowers confidence instead', () => {
    const withSalary = scoreJobQuality(base);
    const without = scoreJobQuality({ ...base, salaryStated: false });

    // The rule the whole quality model rests on. Three quarters of real
    // postings omit salary; demoting them would promote aggregator spam.
    expect(without.score).toBeGreaterThanOrEqual(withSalary.score - 1);
    expect(without.confidence).toBeLessThan(withSalary.confidence);
    expect(without.flags).toContain('salary not stated');
  });

  it('penalises a broken application URL heavily', () => {
    const broken = scoreJobQuality({ ...base, applicationUrlReachable: false });
    expect(broken.score).toBeLessThan(scoreJobQuality(base).score - 10);
    expect(broken.flags).toContain('application url broken');
  });

  it('penalises an unidentifiable employer', () => {
    const anon = scoreJobQuality({ ...base, companyIdentified: false, companyDomainKnown: false });
    expect(anon.flags).toContain('company unidentified');
    expect(anon.score).toBeLessThan(scoreJobQuality(base).score);
  });
});

describe('scam detection', () => {
  const clean = {
    title: 'Senior Frontend Engineer',
    companyName: 'Northwind',
    description: 'We are hiring a senior frontend engineer to own our design system.',
    applyUrl: 'https://boards.greenhouse.io/northwind/jobs/1',
    contactEmails: [],
    salaryAnnualUsd: 150_000,
    minYearsExperience: 5,
    copiedDescriptionCount: 0,
  };

  // 13
  it('flags an advance-fee posting as likely scam', () => {
    const result = detectScamDeterministic({
      ...clean,
      companyName: 'Confidential',
      description:
        'URGENT HIRING! A registration fee of $150 is required. Send payment via Bitcoin. ' +
        'Provide your bank account details to hr2026@gmail.com.',
      contactEmails: ['hr2026@gmail.com'],
      minYearsExperience: 0,
      salaryAnnualUsd: 200_000,
    });
    expect(result.verdict).toBe('likely_scam');
    expect(result.risk).toBeGreaterThan(0.9);
    expect(result.signals.some((s) => s.signal === 'requests_payment')).toBe(true);
  });

  it('leaves an ordinary posting clear', () => {
    expect(detectScamDeterministic(clean).verdict).toBe('clear');
  });

  it('only consults a model in the ambiguous middle', () => {
    const suspicious = detectScamDeterministic({
      ...clean,
      companyName: 'Our Client',
      description: 'Urgent hiring, immediate start.',
    });
    expect(shouldConsultModel(detectScamDeterministic(clean))).toBe(false);
    expect(shouldConsultModel(suspicious)).toBe(true);
  });

  it('never lets a model condemn a posting on its own', () => {
    const deterministic = detectScamDeterministic(clean);
    const combined = combineWithReasoning(
      deterministic,
      { risk: 1, concerns: ['feels wrong'], reasoning: 'suspicious tone' },
      'test-model',
    );
    // The model may raise risk within its bound, but `likely_scam` still
    // requires a rule — otherwise a hallucination quarantines an employer.
    expect(combined.verdict).not.toBe('likely_scam');
    expect(combined.risk).toBeLessThanOrEqual(0.25);
    expect(combined.aiRisk).toBe(1);
    expect(combined.deterministicRisk).toBe(0);
  });
});

describe('reposts', () => {
  // 14
  it('distinguishes a refresh from a repost from a reopening', () => {
    const refresh = detectRepost({
      firstSeenAt: ago(10 * DAY), lastSeenAt: ago(HOUR),
      sightings: [ago(10 * DAY), ago(3 * DAY), ago(HOUR)],
      contentHashes: ['h', 'h', 'h'],
      claimedPostingDates: [ago(10 * DAY), ago(5 * DAY), ago(HOUR)],
    });
    const repost = detectRepost({
      firstSeenAt: ago(40 * DAY), lastSeenAt: ago(HOUR),
      sightings: [ago(40 * DAY), ago(HOUR)],
      contentHashes: ['h', 'h'],
      claimedPostingDates: [ago(40 * DAY)],
    });
    const reopened = detectRepost({
      firstSeenAt: ago(60 * DAY), lastSeenAt: ago(HOUR),
      sightings: [ago(60 * DAY), ago(HOUR)],
      contentHashes: ['h1', 'h2'],
      claimedPostingDates: [ago(60 * DAY), ago(HOUR)],
    });

    expect(refresh.kind).toBe('refresh');
    expect(repost.kind).toBe('repost');
    expect(reopened.kind).toBe('reopened');
    // A restamped listing must not keep winning freshness it did not earn.
    expect(refresh.noveltyFactor).toBeLessThan(reopened.noveltyFactor);
  });
});

describe('scoring, calibration and tiers', () => {
  it('stretches a clustered raw range onto a usable scale', () => {
    const config = { enabled: true, referenceHigh: 82, referenceLow: 30, ceiling: 98 };
    expect(calibrate(82, config).calibrated).toBeCloseTo(98, 0);
    expect(calibrate(56, config).calibrated).toBeCloseTo(49, 0);
    // Monotonic: calibration respaces, it never reorders.
    expect(calibrate(70, config).calibrated).toBeGreaterThan(calibrate(60, config).calibrated);
  });

  // 15
  it('reports a degenerate distribution rather than hiding it', () => {
    const clustered = describeDistribution(
      Array.from({ length: 10 }, () => ({ score: 95, tier: 'EXCEPTIONAL' as const })),
    );
    expect(clustered.clustered).toBe(true);
    expect(clustered.note).toMatch(/raise calibration/);
  });

  it('never labels an ineligible or closed job as recommended', () => {
    const thresholds = {
      exceptional: 88, highlyRecommended: 76, strong: 64, worthConsidering: 48, minimumConfidence: 0.3,
    };
    expect(classifyTier({ score: 99, confidence: 1, eligible: false, lifecycle: 'ACTIVE' }, thresholds)).toBe('EXCLUDED');
    expect(classifyTier({ score: 99, confidence: 1, eligible: true, lifecycle: 'CLOSED' }, thresholds)).toBe('STALE');
    expect(classifyTier({ score: 99, confidence: 0.1, eligible: true, lifecycle: 'ACTIVE' }, thresholds)).toBe('LOW_PRIORITY');
  });
});

describe('diversification', () => {
  const items = (company: string, count: number, startScore: number) =>
    Array.from({ length: count }, (_, i) => ({
      jobId: `${company}-${i}`,
      score: startScore - i,
      companyKey: company,
      sourceId: 'src',
      roleKey: 'frontend',
      technologies: ['react'],
    }));

  // 16
  it('interleaves companies instead of listing one company first', () => {
    const result = diversify(
      [...items('mega', 6, 90), ...items('other', 3, 85)],
      { maxPerCompany: 10 },
    );
    // The property that matters is interleaving, not a quota: with only three
    // lower-scoring 'other' jobs, demanding two of the top five would be
    // demanding that diversification outrank a real score gap.
    const top3 = result.slice(0, 3).map((r) => r.item.companyKey);
    expect(top3).toContain('other');
    expect(new Set(result.slice(0, 5).map((r) => r.item.companyKey)).size).toBeGreaterThan(1);
  });

  // 17
  it('caps a company without deleting its remaining jobs', () => {
    const result = diversify(items('mega', 10, 90), { maxPerCompany: 3 });
    expect(result).toHaveLength(10);
    expect(result.filter((r) => r.cappedBy === null)).toHaveLength(3);
    // Demoted, not hidden — the candidate asked for a ranking.
    expect(result.slice(3).every((r) => r.cappedBy !== null)).toBe(true);
  });

  // 18
  it('stops one noisy source crowding out better ones', () => {
    const noisy = Array.from({ length: 12 }, (_, i) => ({
      jobId: `noisy-${i}`, score: 80 - i * 0.1, companyKey: `agency-${i}`,
      sourceId: 'aggregator', roleKey: 'web', technologies: [],
    }));
    const good = Array.from({ length: 3 }, (_, i) => ({
      jobId: `good-${i}`, score: 78, companyKey: `real-${i}`,
      sourceId: 'careers', roleKey: 'frontend', technologies: [],
    }));

    const result = diversify([...noisy, ...good], { sourcePenalty: 6, maxPerSource: 20 });
    const topSix = result.slice(0, 6).map((r) => r.item.sourceId);
    expect(topSix.filter((s) => s === 'careers').length).toBeGreaterThanOrEqual(2);
  });

  it('honours the penalty ceiling, and doubles it only for a hard cap', () => {
    const uncapped = diversify(items('mega', 12, 95), { maxPerCompany: 50, maxPenalty: 15 });
    expect(Math.max(...uncapped.map((r) => r.penalty))).toBeLessThanOrEqual(15);

    // A hard cap is expressed as a heavy additional penalty rather than an
    // exclusion, so its ceiling is twice the ordinary one — and still bounded.
    const capped = diversify(items('mega', 12, 95), { maxPerCompany: 3, maxPenalty: 15 });
    expect(Math.max(...capped.map((r) => r.penalty))).toBeLessThanOrEqual(30);
    expect(capped.some((r) => r.cappedBy === 'company')).toBe(true);
  });

  it('applies a freshness window filter unchanged', () => {
    const fresh = scoreFreshness({
      postedAt: ago(2 * HOUR), updatedAt: null, lastVerifiedAt: null,
      firstSeenAt: ago(2 * HOUR), now: FIXTURE_NOW,
    });
    expect(withinFreshnessWindow(fresh, 24)).toBe(true);
    expect(withinFreshnessWindow(fresh, 1)).toBe(false);
    expect(withinFreshnessWindow(fresh, null)).toBe(true);
  });
});

describe('exposure and material change', () => {
  it('keeps the strongest state a candidate has expressed', () => {
    let exposure = emptyExposure();
    exposure = advanceExposure(exposure, 'applied', FIXTURE_NOW);
    exposure = advanceExposure(exposure, 'shown', FIXTURE_NOW);
    // A later view must not erase the fact that they applied.
    expect(exposure.state).toBe('applied');
  });

  // 19
  it('does not re-notify when only formatting moved', () => {
    const snapshot = {
      salaryAnnualUsd: 120_000, city: 'Berlin', countryCode: 'DE', remoteType: 'hybrid',
      visaSponsorship: 'not_mentioned', seniority: 'senior', employmentTypes: ['full_time'],
      requirements: ['React', 'TypeScript'], applyUrl: 'https://x/1',
    };
    const result = detectMaterialChanges(snapshot, { ...snapshot, salaryAnnualUsd: 121_000 });
    // 0.8% is FX drift, not news.
    expect(result.changed).toBe(false);
  });

  // 20
  it('detects a salary rise and a newly-offered visa as material', () => {
    const before = {
      salaryAnnualUsd: 120_000, city: 'Berlin', countryCode: 'DE', remoteType: 'hybrid',
      visaSponsorship: 'not_mentioned', seniority: 'senior', employmentTypes: ['full_time'],
      requirements: ['React'], applyUrl: 'https://x/1',
    };
    const result = detectMaterialChanges(before, {
      ...before, salaryAnnualUsd: 160_000, visaSponsorship: 'offered', remoteType: 'remote',
    });

    expect(result.changed).toBe(true);
    expect(result.maxSignificance).toBeGreaterThan(0.7);
    expect(result.changes.map((c) => c.field)).toEqual(
      expect.arrayContaining(['salary', 'visa_sponsorship', 'work_arrangement']),
    );
  });
});

describe('notification eligibility', () => {
  const policy = {
    minimumScore: 64, minimumConfidence: 0.4, maxPerDigest: 10,
    maxPerCompanyPerDigest: 2, maxPerSourcePerDigest: 6, freshnessWindowHours: null,
    requireApplicationPath: true, maxScamRisk: 0.4, renotifyMinSignificance: 0.5,
    renotifyCooldownHours: 72, allowedLifecycleStatuses: ['ACTIVE', 'UNKNOWN'] as const,
  };

  const base = {
    tier: 'STRONG' as const,
    score: 80,
    confidence: 0.7,
    matchEligible: true,
    lifecycle: 'ACTIVE' as const,
    freshness: scoreFreshness({ postedAt: ago(HOUR), updatedAt: null, lastVerifiedAt: null, firstSeenAt: ago(HOUR), now: FIXTURE_NOW }),
    scam: detectScamDeterministic({
      title: 'x', companyName: 'Northwind', description: 'A normal posting.',
      applyUrl: 'https://x/1', contactEmails: [], salaryAnnualUsd: 120_000,
      minYearsExperience: 5, copiedDescriptionCount: 0,
    }),
    exposure: emptyExposure(),
    duplicateOf: null,
    applicationUrlPresent: true,
    applicationUrlReachable: null,
    materialChange: null,
    now: FIXTURE_NOW,
  };

  it('passes a fresh, eligible, well-scored job', () => {
    expect(evaluateNotificationEligibility(base, policy as never).eligible).toBe(true);
  });

  it('collects every blocker rather than stopping at the first', () => {
    const result = evaluateNotificationEligibility(
      { ...base, matchEligible: false, score: 10, applicationUrlPresent: false, duplicateOf: 'other' },
      policy as never,
    );
    // "Why wasn't I told?" needs the complete answer.
    expect(result.blockers.length).toBeGreaterThanOrEqual(4);
    expect(result.blockers).toEqual(
      expect.arrayContaining(['ineligible_match', 'below_score_threshold', 'no_application_path', 'duplicate']),
    );
  });

  // 21
  it('blocks a job the candidate rejected however well it scores', () => {
    const result = evaluateNotificationEligibility(
      { ...base, score: 99, exposure: { ...emptyExposure(), state: 'rejected' } },
      policy as never,
    );
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('previously_rejected');
  });

  it('re-notifies only for a material change past the cooldown', () => {
    const notified = {
      ...base,
      exposure: { ...emptyExposure(), state: 'notified' as const, notifiedAt: ago(8 * DAY) },
    };

    const unchanged = evaluateNotificationEligibility(
      { ...notified, materialChange: { changed: false, changes: [], maxSignificance: 0, explanation: 'no change' } },
      policy as never,
    );
    const improved = evaluateNotificationEligibility(
      {
        ...notified,
        materialChange: {
          changed: true, maxSignificance: 0.9, explanation: 'Salary rose by 17%',
          changes: [{ field: 'salary', before: '$150,000', after: '$175,000', significance: 0.9, direction: 'improved', summary: 'Salary rose by 17%' }],
        },
      },
      policy as never,
    );
    const tooSoon = evaluateNotificationEligibility(
      {
        ...notified,
        exposure: { ...emptyExposure(), state: 'notified', notifiedAt: ago(HOUR) },
        materialChange: {
          changed: true, maxSignificance: 0.9, explanation: 'Salary rose',
          changes: [{ field: 'salary', before: null, after: null, significance: 0.9, direction: 'improved', summary: 'Salary rose' }],
        },
      },
      policy as never,
    );

    expect(unchanged.eligible).toBe(false);
    expect(improved.eligible).toBe(true);
    expect(improved.renotifyReason).toMatch(/Salary rose/);
    expect(tooSoon.eligible).toBe(false);
  });

  it('caps a digest by total, company and source', () => {
    const ranked = Array.from({ length: 20 }, (_, i) => ({
      jobId: `j${i}`,
      companyKey: i < 6 ? 'mega' : `co-${i}`,
      sourceId: i < 12 ? 'aggregator' : 'careers',
      score: 90 - i,
    }));

    const { selected, held } = applyDigestCaps(ranked, {
      ...policy, maxPerDigest: 8, maxPerCompanyPerDigest: 2, maxPerSourcePerDigest: 4,
    } as never);

    expect(selected).toHaveLength(8);
    expect(selected.filter((s) => s.companyKey === 'mega')).toHaveLength(2);
    expect(selected.filter((s) => s.sourceId === 'aggregator')).toHaveLength(4);
    expect(held.some((h) => h.blocker === 'company_cap_reached')).toBe(true);
  });
});

describe('behavioural signals', () => {
  it('weights recent events more heavily and stays bounded', () => {
    const positive = behavioralAffinity(
      [{ event: 'job_applied', occurredAt: ago(DAY) }],
      { now: FIXTURE_NOW },
    );
    const negative = behavioralAffinity(
      [{ event: 'job_marked_irrelevant', occurredAt: ago(DAY) }],
      { now: FIXTURE_NOW },
    );
    expect(positive).toBeGreaterThan(0);
    expect(negative).toBeLessThan(0);
    expect(Math.abs(positive)).toBeLessThanOrEqual(1);
  });
});

// ── The realistic ranking ───────────────────────────────────────────────────

describe('the realistic 50-job ranking', () => {
  const engine = new RecommendationEngine();
  const corpus = buildFixtureCorpus();
  const result = engine.rank(PROFILE, corpus);
  const byId = new Map(corpus.map((j) => [j.jobId, j]));
  const named = (rec: { jobId: string }) => {
    const job = byId.get(rec.jobId);
    return `${job?.title} @ ${job?.companyName}`;
  };

  it('has a corpus of at least 50 jobs with the intended mix', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(50);
    expect(corpus.filter((j) => j.duplicateOf !== null)).toHaveLength(4);
    expect(corpus.filter((j) => j.companyName === 'Megacorp')).toHaveLength(8);
  });

  it('suppresses merged duplicates and closed jobs before ranking', () => {
    const suppressedIds = new Set(result.suppressed.map((s) => s.jobId));
    for (const dup of corpus.filter((j) => j.duplicateOf !== null)) {
      expect(suppressedIds.has(dup.jobId)).toBe(true);
    }
    // "This position has been filled" — closed, so never ranked.
    const filled = corpus.find((j) => j.companyName === 'Tessera');
    expect(suppressedIds.has(filled!.jobId)).toBe(true);
  });

  it('puts genuinely excellent, fresh, authoritative jobs at the top', () => {
    const topFive = result.recommendations.slice(0, 5).map(named);
    // Northwind: 94 match, 40 minutes old, ATS, verified, $185k.
    expect(topFive[0]).toContain('Northwind');
    expect(topFive.join(' | ')).toMatch(/Helios|Cobalt|Lumen/);
  });

  it('keeps scams and dead links out of the top ten', () => {
    const topTen = result.recommendations.slice(0, 10).map(named).join(' | ');
    expect(topTen).not.toMatch(/Confidential|Our Client/);
    // Solstice matches at 90 but its application URL 404s.
    expect(topTen).not.toMatch(/Solstice/);
  });

  it('ranks a fresher, slightly lower match above a stale higher one', () => {
    const rank = (company: string) =>
      result.recommendations.findIndex((r) => named(r).includes(company));
    // Vega matches at 96 but is 22 days old; Lumen matches at 88 and is
    // 22 minutes old on the company's own careers page.
    expect(rank('Lumen')).toBeLessThan(rank('Vega'));
    // …and the underlying match scores are untouched by that reordering.
    const vega = result.recommendations.find((r) => named(r).includes('Vega'));
    const lumen = result.recommendations.find((r) => named(r).includes('Lumen'));
    expect(vega!.matchScore).toBe(96);
    expect(lumen!.matchScore).toBe(88);
  });

  it('does not let Megacorp own the top of the list', () => {
    const topTen = result.recommendations.slice(0, 10).map(named);
    expect(topTen.filter((t) => t.includes('Megacorp')).length).toBeLessThanOrEqual(3);
  });

  it('does not let the noisy aggregator own the list either', () => {
    const topFifteen = result.recommendations.slice(0, 15).map((r) => byId.get(r.jobId)!.sourceId);
    expect(topFifteen.filter((s) => s === 'noisy-aggregator').length).toBeLessThanOrEqual(3);
  });

  it('produces a discriminating score distribution', () => {
    // The failure this guards against: everything clustered in 90-99, where the
    // number has stopped carrying information.
    expect(result.distribution.clustered).toBe(false);
    expect(result.distribution.share90Plus).toBeLessThan(0.15);
    expect(result.distribution.max).toBeGreaterThan(70);
    expect(result.distribution.median).toBeLessThan(60);
  });

  it('marks only a small, high-quality subset notifiable', () => {
    const notifiable = result.recommendations.filter((r) => r.notificationEligible);
    expect(notifiable.length).toBeGreaterThan(0);
    expect(notifiable.every((r) => r.score.finalScore >= 64)).toBe(true);

    // Per-job eligibility is the first gate; the digest caps are the second,
    // and they are what actually delivers "not hundreds of emails".
    const digest = engine.selectForDigest(
      result.recommendations,
      (jobId) => byId.get(jobId)!.companyName,
    );
    expect(digest.selected.length).toBeLessThanOrEqual(10);
    expect(digest.selected.length).toBeGreaterThan(0);
  });

  it('blocks the rejected job and the unchanged previously-notified one', () => {
    const basalt = result.recommendations.find((r) => named(r).includes('Basalt'));
    const onyx = result.recommendations.find((r) => named(r).includes('Onyx'));
    const ferrous = result.recommendations.find((r) => named(r).includes('Ferrous'));

    expect(basalt!.notificationEligible).toBe(false);
    expect(onyx!.notificationEligible).toBe(false);
    // Ferrous was notified eight days ago but its salary rose 17%.
    expect(ferrous!.notificationEligible).toBe(true);
  });

  it('explains every ranking from structured data', () => {
    for (const rec of result.recommendations.slice(0, 10)) {
      expect(rec.rankExplanation).toMatch(/Ranked #\d+/);
      expect(rec.rankReasons.length).toBeGreaterThan(2);
      expect(rec.rankReasons.some((r) => /% candidate match/.test(r))).toBe(true);
      expect(rec.score.factors.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('validates every recommendation against the contract', () => {
    for (const rec of result.recommendations) {
      expect(jobRecommendationSchema.safeParse(rec).success).toBe(true);
    }
  });

  it('answers top-N queries without re-ranking', () => {
    const top3 = engine.selectTop(result.recommendations, { limit: 3 });
    expect(top3).toHaveLength(3);
    expect(top3.map((r) => r.rank)).toEqual([1, 2, 3]);

    const notifiable = engine.selectTop(result.recommendations, {
      limit: 50, notificationEligibleOnly: true,
    });
    expect(notifiable.every((r) => r.notificationEligible)).toBe(true);
  });
});

describe('performance', () => {
  it('ranks 10,000 jobs in one pass with no model call', () => {
    const engine = new RecommendationEngine();
    const pool = Array.from({ length: 10_000 }, (_, i) =>
      makeRecommendationInput({
        jobId: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`,
        title: `Engineer ${i % 40}`,
        companyName: `Company ${i % 500}`,
        sourceId: `source-${i % 8}`,
        sourceType: i % 3 === 0 ? 'ats' : 'job_api',
        matchScore: 40 + (i % 55),
        ageMs: (i % 30) * DAY,
      }),
    );

    const started = Date.now();
    const result = engine.rank(PROFILE, pool);
    const elapsed = Date.now() - started;

    expect(result.recommendations).toHaveLength(10_000);
    // Deterministic arithmetic throughout; an LLM per job would be ~3 hours.
    expect(elapsed).toBeLessThan(20_000);
  });
});
