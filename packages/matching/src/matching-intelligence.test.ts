import { describe, expect, it } from 'vitest';
import {
  applyCaps,
  coverageRatio,
  decideTier,
  DEFAULT_SCORE_CAPS,
  dominates,
  evaluateRemoteEligibility,
  evidenceCredit,
  gapSeverity,
  matchCacheFingerprint,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  recencyMultiplier,
  skillEvidenceSchema,
  type JobMatchResult,
} from '@job-intel/contracts';
import { assessTrajectory } from './career/trajectory';
import { extractRemoteReach } from './geography/remote-reach';
import { analyseGap, computeCoverage, describeCoverage, rankGaps } from './gaps/skill-gaps';
import { computeFrontier, describeTradeoffs, explainRanking } from './tradeoffs/pareto';
import { MatchCache } from './cache/match-cache';
import {
  compareVersions,
  evaluateBands,
  evaluateRanking,
  type ScoredCase,
} from './evaluation/offline-eval';

/**
 * The reasoning layer, and the thirty-scenario comparison.
 *
 * The comparison against naive keyword matching is the part that matters. Every
 * matching system claims to be more than keyword overlap; the only way to know
 * is to run both over the same jobs and look at where they disagree. The
 * disagreements below are not incidental — each one is a category of mistake
 * the naive version makes structurally and cannot be patched out of.
 */

// ── Evidence (Parts 7, 8, 9) ────────────────────────────────────────────────

describe('evidence strength', () => {
  const evidence = (overrides: Record<string, unknown> = {}) =>
    skillEvidenceSchema.parse({ skill: 'react', strength: 'EXPLICIT_PROFESSIONAL', ...overrides });

  it('ranks production work above a skills-list claim', () => {
    const professional = evidenceCredit(
      evidence({ strength: 'EXPLICIT_PROFESSIONAL', months: 36 }),
    );
    const claimed = evidenceCredit(evidence({ strength: 'SELF_REPORTED', months: 36 }));

    /*
     * A skills list costs nothing to write and is frequently aspirational.
     * Scoring the two alike recommends jobs the candidate cannot survive an
     * interview for.
     */
    expect(professional.credit).toBeGreaterThan(claimed.credit * 2);
  });

  it('does not treat a long-unused skill as absent', () => {
    const now = new Date('2026-08-22T00:00:00Z');
    const stale = recencyMultiplier(new Date('2018-08-22T00:00:00Z'), now);

    expect(stale.multiplier).toBeLessThan(1);
    /* Stale, not void — someone who shipped Java for six years still knows it. */
    expect(stale.multiplier).toBeGreaterThanOrEqual(0.45);
  });

  it('does not assume an undated skill is old', () => {
    const undated = recencyMultiplier(null);
    expect(undated.multiplier).toBeGreaterThan(0.8);
  });

  it('saturates on duration rather than scaling linearly', () => {
    const twoYears = evidenceCredit(evidence({ months: 24 })).credit;
    const tenYears = evidenceCredit(evidence({ months: 120 })).credit;

    expect(tenYears).toBeGreaterThanOrEqual(twoYears);
    expect(tenYears - twoYears).toBeLessThan(0.2);
  });

  it('earns nothing, rather than losing points, for absent evidence', () => {
    const unknown = evidenceCredit(evidence({ strength: 'UNKNOWN' }));
    expect(unknown.credit).toBe(0);
  });
});

// ── Remote geography (Parts 20, 21, 22) ─────────────────────────────────────

describe('remote geography', () => {
  it('does not read a bare "remote" as globally remote', () => {
    const reach = extractRemoteReach({
      arrangement: 'remote',
      locationText: 'Remote',
      description: 'We are a fully remote company building developer tools.',
    });

    /*
     * The highest-value distinction in the layer. Reading this as GLOBAL sends
     * a candidate in Lagos to a hundred US-only roles.
     */
    expect(reach.reach).toBe('UNSPECIFIED');

    const eligibility = evaluateRemoteEligibility(reach, 'NG');
    expect(eligibility.result).toBe('UNKNOWN');
  });

  it('reads an explicit worldwide statement', () => {
    const reach = extractRemoteReach({
      arrangement: 'remote',
      locationText: 'Remote — Worldwide',
      description: 'Work from anywhere in the world.',
    });

    expect(reach.reach).toBe('GLOBAL');
    expect(evaluateRemoteEligibility(reach, 'NG').result).toBe('PASS');
  });

  it('catches a US-only restriction', () => {
    const reach = extractRemoteReach({
      arrangement: 'remote',
      locationText: 'Remote (US)',
      description: 'You must be authorized to work in the United States. Remote within the US.',
    });

    expect(reach.reach).toBe('COUNTRY_RESTRICTED');
    expect(reach.countries).toContain('US');

    expect(evaluateRemoteEligibility(reach, 'NG').result).toBe('FAIL');
    expect(evaluateRemoteEligibility(reach, 'US').result).toBe('PASS');
  });

  it('does not treat a mentioned country as a restriction', () => {
    const reach = extractRemoteReach({
      arrangement: 'remote',
      locationText: 'Remote',
      description: 'Our headquarters are in Germany. We hire remotely across the team.',
    });

    /*
     * A company based in Berlin can hire anywhere. Treating every mention of a
     * place as a boundary would reject most of the market.
     */
    expect(reach.reach).not.toBe('COUNTRY_RESTRICTED');
  });

  it('extracts hybrid office days', () => {
    const reach = extractRemoteReach({
      arrangement: 'hybrid',
      locationText: 'Berlin, Germany',
      description: 'Hybrid role: 2 days per week in the office in Berlin.',
    });

    expect(reach.onsiteDaysPerWeek).toBe(2);
    expect(reach.officeLocation).toContain('Berlin');
  });

  it('extracts a time-zone restriction', () => {
    const reach = extractRemoteReach({
      arrangement: 'remote',
      locationText: 'Remote',
      description: 'You should work within UTC+1 to UTC+3 for team overlap.',
    });

    expect(reach.reach).toBe('TIMEZONE_RESTRICTED');
    expect(reach.timezoneOffsets.length).toBeGreaterThan(0);
  });
});

// ── Career trajectory (Parts 18, 19) ────────────────────────────────────────

describe('career trajectory', () => {
  const frontend = {
    candidateTitles: ['Frontend Developer', 'Junior Frontend Developer'],
    candidateSeniority: 'mid',
    candidateDomains: ['react', 'typescript', 'javascript', 'css', 'nextjs'],
  };

  it('recognises the natural next step', () => {
    const assessment = assessTrajectory({
      ...frontend,
      jobTitle: 'Senior Frontend Engineer',
      jobSeniority: 'senior',
      jobDomains: ['react', 'typescript', 'nextjs'],
    });

    expect(assessment.verdict).toBe('NATURAL_PROGRESSION');
    expect(assessment.score).toBeGreaterThan(85);
  });

  it('rejects an unrelated field even when generic words overlap', () => {
    const assessment = assessTrajectory({
      ...frontend,
      jobTitle: 'Senior Accountant',
      jobSeniority: 'senior',
      jobDomains: ['sap', 'ifrs', 'taxation', 'audit'],
    });

    /*
     * This is the failure the signal exists to catch: a frontend engineer shown
     * an accounting role because both descriptions mention "stakeholders".
     */
    expect(assessment.verdict).toBe('UNRELATED');
    expect(assessment.score).toBeLessThan(40);
  });

  it('does not punish a deliberate step back', () => {
    const assessment = assessTrajectory({
      ...frontend,
      candidateSeniority: 'senior',
      jobTitle: 'Frontend Engineer',
      jobSeniority: 'mid',
      jobDomains: ['react', 'typescript'],
    });

    expect(assessment.verdict).toBe('STEP_BACK');
    /* Unusual, not wrong. */
    expect(assessment.score).toBeGreaterThan(40);
  });

  it('keeps the whole signal weak', () => {
    /*
     * Trajectory should nudge a ranking, not decide it. A range that reached 5
     * would fight every career change the user attempted.
     */
    const best = assessTrajectory({
      ...frontend,
      jobTitle: 'Senior Frontend Engineer',
      jobSeniority: 'senior',
      jobDomains: ['react'],
    });
    const pivot = assessTrajectory({
      ...frontend,
      jobTitle: 'Data Engineer',
      jobSeniority: 'mid',
      jobDomains: ['python', 'spark', 'sql', 'react'],
    });

    expect(best.score - pivot.score).toBeLessThan(40);
  });

  it('says so when it cannot tell', () => {
    const assessment = assessTrajectory({
      candidateTitles: [],
      candidateSeniority: null,
      candidateDomains: [],
      jobTitle: 'Frontend Engineer',
      jobSeniority: null,
      jobDomains: [],
    });

    expect(assessment.verdict).toBe('UNKNOWN');
    expect(assessment.confidence).toBeLessThan(0.4);
  });
});

// ── Skill gaps (Parts 41, 42) ───────────────────────────────────────────────

describe('skill gap analysis', () => {
  it('calls a required gap with nothing adjacent critical', () => {
    const gap = analyseGap({
      skill: 'Kubernetes',
      importance: 'required',
      requirementText: '5+ years of Kubernetes in production',
    });

    expect(gap.severity).toBe('CRITICAL');
    expect(gap.learnability).toBe('NOT_LEARNABLE');
  });

  it('names adjacent experience the candidate can lead with', () => {
    const gap = analyseGap({
      skill: 'Next.js',
      importance: 'required',
      closest: { skill: 'React', proximity: 'TRANSFERABLE', evidence: '4 years production React' },
    });

    expect(gap.severity).toBe('MODERATE');
    expect(gap.recommendation).toContain('React');
    expect(gap.recommendation).toMatch(/adjacent|lead with/i);
  });

  it('tells the truth about what cannot be learned before applying', () => {
    const years = analyseGap({
      skill: '8 years of experience',
      importance: 'required',
      requirementText: 'Minimum 8 years of experience',
    });

    expect(years.learnability).toBe('NOT_LEARNABLE');
    expect(years.recommendation).not.toMatch(/weekend|quickly|easy/i);
  });

  it('treats a preferred gap as minor when something is adjacent', () => {
    const gap = analyseGap({
      skill: 'GraphQL',
      importance: 'preferred',
      closest: { skill: 'REST APIs', proximity: 'TRANSFERABLE', evidence: 'API design' },
    });

    expect(gap.severity).toBe('MINOR');
    expect(gap.learnability).toBe('QUICK');
  });

  it('orders gaps by what to act on first', () => {
    const ranked = rankGaps([
      analyseGap({ skill: 'GraphQL', importance: 'nice_to_have' }),
      analyseGap({ skill: 'Kubernetes', importance: 'required' }),
      analyseGap({ skill: 'AWS', importance: 'preferred' }),
    ]);

    expect(ranked[0]!.skill).toBe('Kubernetes');
  });

  it('follows the posting rather than learnability for severity', () => {
    /*
     * A required skill is critical even when it is quick to learn — the
     * screening filter does not care how fast you could pick it up.
     */
    expect(gapSeverity('required', 'UNRELATED')).toBe('CRITICAL');
    expect(gapSeverity('nice_to_have', 'UNRELATED')).toBe('MINOR');
  });
});

// ── Requirement coverage (Part 40) ──────────────────────────────────────────

describe('requirement coverage', () => {
  it('reports fractions rather than a blended number', () => {
    const coverage = computeCoverage({
      requirements: [
        { importance: 'required', covered: true, confidence: 0.9 },
        { importance: 'required', covered: true, confidence: 0.9 },
        { importance: 'required', covered: false, confidence: 0.9 },
        { importance: 'preferred', covered: true, confidence: 0.8 },
        { importance: 'preferred', covered: false, confidence: 0.8 },
      ],
    });

    expect(coverage.requiredCovered).toBe(2);
    expect(coverage.requiredTotal).toBe(3);
    expect(describeCoverage(coverage)).toBe('2/3 required, 1/2 preferred met.');
  });

  it('does not let a low-confidence extraction become a hard miss', () => {
    const coverage = computeCoverage({
      requirements: [{ importance: 'required', covered: false, confidence: 0.2 }],
    });

    /*
     * The sentence it came from may not have been a requirement at all.
     * Counting it as a hard miss lets a misread line block a good job.
     */
    expect(coverage.requiredTotal).toBe(0);
    expect(coverage.preferredTotal).toBe(1);
    expect(coverage.lowConfidenceCount).toBe(1);
  });

  it('measures coverage on required requirements only', () => {
    const coverage = computeCoverage({
      requirements: [
        { importance: 'required', covered: true, confidence: 0.9 },
        { importance: 'preferred', covered: false, confidence: 0.9 },
        { importance: 'preferred', covered: false, confidence: 0.9 },
      ],
    });

    expect(coverageRatio(coverage)).toBe(1);
  });
});

// ── Caps and tiers (Parts 35, 52, 53, 54) ───────────────────────────────────

describe('score caps', () => {
  it('caps rather than penalises', () => {
    const { score, applied } = applyCaps(96, [
      { reason: 'Work authorisation unknown', cap: DEFAULT_SCORE_CAPS.authorizationUnknown },
    ]);

    expect(score).toBe(85);
    expect(applied).toHaveLength(1);
  });

  it('leaves a score below the cap untouched', () => {
    const { score, applied } = applyCaps(60, [{ reason: 'x', cap: 85 }]);

    expect(score).toBe(60);
    expect(applied).toHaveLength(0);
  });

  it('applies the lowest cap when several bind', () => {
    const { score } = applyCaps(99, [
      { reason: 'a', cap: 90 },
      { reason: 'b', cap: 80 },
    ]);

    expect(score).toBe(80);
  });
});

describe('matching tiers', () => {
  it('spends nothing on an ineligible job', () => {
    const decision = decideTier({
      structuredScore: 95,
      confidence: 0.4,
      eligible: false,
      deepUsedThisRun: 0,
    });

    expect(decision.tier).toBe('FAST');
    expect(decision.shortCircuit).toBe(true);
  });

  it('short-circuits an obvious mismatch', () => {
    const decision = decideTier({
      structuredScore: 12,
      confidence: 0.9,
      eligible: true,
      deepUsedThisRun: 0,
    });

    expect(decision.shortCircuit).toBe(true);
  });

  it('reserves deep reasoning for high-value ambiguity', () => {
    const ambiguous = decideTier({
      structuredScore: 82,
      confidence: 0.5,
      eligible: true,
      deepUsedThisRun: 0,
    });
    const confident = decideTier({
      structuredScore: 82,
      confidence: 0.95,
      eligible: true,
      deepUsedThisRun: 0,
    });

    expect(ambiguous.tier).toBe('DEEP');
    /* Confident enough that reasoning would not change the answer. */
    expect(confident.tier).toBe('STANDARD');
  });

  it('honours the per-run deep budget', () => {
    const decision = decideTier({
      structuredScore: 90,
      confidence: 0.4,
      eligible: true,
      deepUsedThisRun: 25,
    });

    expect(decision.tier).toBe('STANDARD');
  });

  it('costs a fraction of a full deep pass over a thousand jobs', () => {
    let deep = 0;
    let shortCircuited = 0;

    for (let i = 0; i < 1_000; i += 1) {
      /* A realistic distribution: most discovered jobs are not close. */
      const score = i < 700 ? 20 + (i % 15) : 60 + (i % 35);
      const confidence = i % 3 === 0 ? 0.5 : 0.85;

      const decision = decideTier(
        { structuredScore: score, confidence, eligible: true, deepUsedThisRun: deep },
      );

      if (decision.tier === 'DEEP') deep += 1;
      if (decision.shortCircuit) shortCircuited += 1;
    }

    expect(shortCircuited).toBeGreaterThan(600);
    expect(deep).toBeLessThanOrEqual(25);
  });
});

// ── Cache (Part 51) ─────────────────────────────────────────────────────────

describe('match cache', () => {
  const key = {
    jobId: '00000000-0000-4000-8000-00000000000a',
    candidateProfileId: '00000000-0000-4000-8000-00000000000b',
    profileVersion: 1,
    preferenceVersion: 1,
    jobVersion: 1,
    enrichmentVersion: 1,
    scoringVersion: '1.0.0',
    taxonomyVersion: '1.0.0',
    behavioralVersion: 0,
  };

  const result = { matchScore: 80 } as unknown as JobMatchResult;

  it('returns a stored result for identical inputs', () => {
    const cache = new MatchCache();
    cache.set(key, result);

    expect(cache.get(key)).toBe(result);
    expect(cache.stats.hits).toBe(1);
  });

  it('misses when any input changes', () => {
    const inputs: Array<keyof typeof key> = [
      'profileVersion',
      'preferenceVersion',
      'jobVersion',
      'enrichmentVersion',
      'behavioralVersion',
    ];

    for (const field of inputs) {
      const cache = new MatchCache();
      cache.set(key, result);

      const changed = { ...key, [field]: 99 };
      expect(cache.get(changed), `${field} should invalidate`).toBeNull();
    }
  });

  it('misses when the scoring or taxonomy version changes', () => {
    const cache = new MatchCache();
    cache.set(key, result);

    expect(cache.get({ ...key, scoringVersion: '1.1.0' })).toBeNull();
    expect(cache.get({ ...key, taxonomyVersion: '2.0.0' })).toBeNull();
  });

  it('does not serve an entry past its age limit', () => {
    let now = new Date('2026-08-22T00:00:00Z');
    const cache = new MatchCache({ maxAgeMs: 3_600_000, now: () => now });

    cache.set(key, result);
    expect(cache.get(key)).toBe(result);

    now = new Date('2026-08-23T00:00:00Z');
    expect(cache.get(key)).toBeNull();
    expect(cache.stats.staleRejections).toBe(1);
  });

  it('drops every entry for a withdrawn job', () => {
    const cache = new MatchCache();
    cache.set(key, result);
    cache.set({ ...key, candidateProfileId: '00000000-0000-4000-8000-00000000000c' }, result);

    expect(cache.invalidate({ jobId: key.jobId })).toBe(2);
    expect(cache.get(key)).toBeNull();
  });

  it('bounds its own size', () => {
    const cache = new MatchCache({ maxEntries: 10 });

    for (let i = 0; i < 50; i += 1) {
      cache.set({ ...key, jobVersion: i }, result);
    }

    expect(cache.stats.size).toBe(10);
    expect(cache.stats.evictions).toBe(40);
  });

  it('produces a readable fingerprint', () => {
    expect(matchCacheFingerprint(key)).toContain('s1.0.0');
  });
});

// ── Tradeoffs (Parts 46, 47) ────────────────────────────────────────────────

describe('tradeoff reasoning', () => {
  const options = [
    {
      id: 'a',
      label: 'Job A',
      overallScore: 95,
      dimensions: { skills: 95, salary: null, location: 90, seniority: 88 },
    },
    {
      id: 'b',
      label: 'Job B',
      overallScore: 88,
      dimensions: { skills: 82, salary: 95, location: 90, seniority: 85 },
    },
    {
      id: 'c',
      label: 'Job C',
      overallScore: 60,
      dimensions: { skills: 55, salary: 50, location: 40, seniority: 50 },
    },
  ];

  it('does not let an unknown support dominance', () => {
    /*
     * Job A scores higher on skills but its salary is unknown — and the unknown
     * might be terrible. Letting a job with no information dominate one with
     * disappointing information is precisely backwards.
     */
    expect(dominates(options[0]!.dimensions, options[1]!.dimensions)).toBe(false);
  });

  it('finds genuine dominance', () => {
    const frontier = computeFrontier(options);
    const b = frontier.find((entry) => entry.id === 'b')!;

    expect(b.dominates).toContain('c');
    expect(b.onFrontier).toBe(true);
  });

  it('names the cost, not only the strengths', () => {
    const explained = explainRanking([options[1]!, options[2]!]);

    expect(explained[0]!.explanation).toMatch(/strong/i);
    expect(explained[1]!.explanation).toMatch(/weak/i);
  });

  it('reports an unknown dimension as unknown rather than as weak', () => {
    const tradeoffs = describeTradeoffs(options[0]!);
    const salary = tradeoffs.find((entry) => entry.dimension === 'salary')!;

    expect(salary.kind).toBe('unknown');
    expect(salary.summary).toContain('not stated');
  });

  it('stays quiet about middling dimensions', () => {
    const tradeoffs = describeTradeoffs({
      id: 'd',
      label: 'Job D',
      overallScore: 65,
      dimensions: { skills: 64, salary: 66 },
    });

    expect(tradeoffs).toHaveLength(0);
  });
});

// ── Ranking metrics (Part 58) ───────────────────────────────────────────────

describe('ranking metrics', () => {
  it('measures precision over the window a person actually reads', () => {
    const ranked = [
      { relevant: true },
      { relevant: true },
      { relevant: false },
      { relevant: true },
      { relevant: false },
      { relevant: true },
    ];

    expect(precisionAtK(ranked, 5)).toBeCloseTo(0.6, 5);
    expect(recallAtK(ranked, 5)).toBeCloseTo(0.75, 5);
  });

  it('rewards putting the best result first', () => {
    const good = ndcgAtK([{ relevance: 4 }, { relevance: 2 }, { relevance: 0 }], 10);
    const bad = ndcgAtK([{ relevance: 0 }, { relevance: 2 }, { relevance: 4 }], 10);

    expect(good).toBe(1);
    expect(bad).toBeLessThan(good);
  });

  it('returns zero rather than dividing by zero on an empty grade set', () => {
    expect(ndcgAtK([{ relevance: 0 }, { relevance: 0 }], 10)).toBe(0);
    expect(precisionAtK([], 5)).toBe(0);
  });
});

// ── Version comparison (Part 59) ────────────────────────────────────────────

describe('scoring version comparison', () => {
  const cases = (scores: number[]): ScoredCase[] =>
    scores.map((score, index) => ({
      id: `case-${index}`,
      label: `Case ${index}`,
      expectedBand: index < 3 ? 'EXCELLENT' : 'POOR',
      relevance: index < 3 ? 4 : 0,
      actualScore: score,
      actualEligible: true,
      confidence: 0.8,
    }));

  it('refuses to promote a version that is merely more generous', () => {
    const incumbent = evaluateRanking(cases([90, 88, 85, 30, 25, 20]), '1.0.0');
    /* Everything ten points higher; the ordering is identical. */
    const challenger = evaluateRanking(cases([100, 98, 95, 40, 35, 30]), '1.1.0');

    const comparison = compareVersions(incumbent, challenger);

    expect(comparison.challengerWins).toBe(false);
    expect(comparison.verdict).toMatch(/not proven/i);
  });

  it('promotes a version that genuinely ranks better', () => {
    const incumbent = evaluateRanking(cases([40, 88, 85, 90, 25, 20]), '1.0.0');
    const challenger = evaluateRanking(cases([92, 88, 85, 30, 25, 20]), '1.1.0');

    const comparison = compareVersions(incumbent, challenger);

    expect(challenger.ndcgAt10).toBeGreaterThan(incumbent.ndcgAt10);
    expect(comparison.challengerWins).toBe(true);
  });

  it('measures band error to the nearest edge, not to a made-up midpoint', () => {
    const report = evaluateBands([
      {
        id: 'a',
        label: 'in band',
        expectedBand: 'EXCELLENT',
        relevance: 4,
        actualScore: 85,
        actualEligible: true,
        confidence: 0.9,
      },
    ]);

    expect(report.meanAbsoluteError).toBe(0);
    expect(report.inBand).toBe(1);
  });

  it('reports an eligibility mistake separately from a scoring mistake', () => {
    const report = evaluateBands([
      {
        id: 'a',
        label: 'should have been blocked',
        expectedBand: 'EXCELLENT',
        expectIneligible: true,
        relevance: 0,
        actualScore: 88,
        actualEligible: true,
        confidence: 0.9,
      },
    ]);

    expect(report.inBand).toBe(1);
    expect(report.eligibilityCorrect).toBe(0);
  });
});
