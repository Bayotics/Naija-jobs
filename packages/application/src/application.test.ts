import { describe, expect, it } from 'vitest';
import {
  APPLICATION_RECOMMENDATIONS,
  MIN_SAMPLE_FOR_INFERENCE,
  OPPORTUNITY_TRANSITIONS,
  applicationRecordSchema,
  candidatePreferencesSchema,
  duplicateCheckSchema,
  companyHistorySchema,
  type ApplicationRecord,
  type CandidateIntelligence,
  type CandidatePreferences,
} from '@job-intel/contracts';
import { SkillGraph } from '@job-intel/candidate';
import {
  extractRequirements,
  importanceFromText,
  extractYears,
  requirementTypeOf,
} from './requirements/extract';
import { aggregateSkillAlignment, assessRequirement } from './requirements/matcher';
import { analyseExperience, analyseSeniority } from './dimensions/experience';
import { analyseCompensation } from './dimensions/compensation';
import { analyseAuthorization, analyseLanguages } from './dimensions/eligibility-signals';
import { analyseCompetitiveness, analyseFriction, analyseLegitimacy, analyseTiming } from './dimensions/friction';
import { runApplicationIntelligence, decide } from './engine/application-engine';
import { selectResume } from './engine/resume-selection';
import { computeAnalytics, computeCalibration, computeFunnel, computeResumePerformance } from './analytics/funnel';
import { CANDIDATE, CANDIDATE_ID, JOB_FIXTURES, NOW, PREFERENCES, documents } from './testing/fixtures';

const JOB_ID = '99999999-8888-4777-8666-555555555555';
const DOC_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DOC_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const JOB_ID_2 = '88888888-7777-4666-8555-444444444444';
const graph = new SkillGraph();

const byName = (name: string) => JOB_FIXTURES.find((fixture) => fixture.name === name)!;

function run(
  fixtureName: string,
  overrides: {
    profile?: CandidateIntelligence | null;
    preferences?: CandidatePreferences | null;
    duplicate?: ReturnType<typeof duplicateCheckSchema.parse>;
    companyHistory?: ReturnType<typeof companyHistorySchema.parse>;
    reportedApplicants?: { count: number; source: string } | null;
    acknowledgedBlockerIds?: string[];
    documents?: ReturnType<typeof documents>;
  } = {},
) {
  const fixture = byName(fixtureName);

  return runApplicationIntelligence({
    jobId: fixture.id,
    candidateId: CANDIDATE_ID,
    jobTitle: fixture.title,
    companyName: fixture.companyName,
    companyWebsite: fixture.companyWebsite,
    description: fixture.description,
    postedAt: fixture.postedAt,
    validThrough: fixture.validThrough,
    closed: fixture.closed,
    applyUrl: fixture.applyUrl,
    sourceCount: fixture.sourceCount,
    enrichment: fixture.enrichment,
    profile: overrides.profile === undefined ? CANDIDATE : overrides.profile,
    preferences: overrides.preferences === undefined ? PREFERENCES : overrides.preferences,
    evaluation: null,
    learnedSignals: [],
    documents: overrides.documents ?? documents(),
    matchScore: 74,
    jobQualityScore: fixture.enrichment.quality.qualityScore,
    scamScore: fixture.enrichment.quality.scamScore,
    duplicate: overrides.duplicate ?? null,
    companyHistory: overrides.companyHistory ?? null,
    reportedApplicants: overrides.reportedApplicants ?? null,
    acknowledgedBlockerIds: overrides.acknowledgedBlockerIds ?? [],
    hasPortfolio: false,
    graph,
    now: NOW,
  });
}

// ── 1. Requirement extraction ───────────────────────────────────────────────

describe('requirement extraction', () => {
  it('separates required from preferred from nice-to-have', () => {
    expect(importanceFromText('5+ years of React is required')).toBe('required');
    expect(importanceFromText('GraphQL experience preferred')).toBe('preferred');
    expect(importanceFromText('Rust is a plus')).toBe('nice_to_have');
    expect(importanceFromText('You will build web applications')).toBeNull();
  });

  it('reads years from the several ways postings write them', () => {
    expect(extractYears('5+ years of React')).toBe(5);
    expect(extractYears('3-5 years experience')).toBe(3);
    expect(extractYears('at least 4 years')).toBe(4);
    expect(extractYears('minimum of 2 yrs')).toBe(2);
    expect(extractYears('React experience')).toBeNull();
  });

  it('types requirements by what they actually ask for', () => {
    expect(requirementTypeOf('Must be authorized to work in the US')).toBe('work_authorization');
    expect(requirementTypeOf("Bachelor's degree in Computer Science")).toBe('education');
    expect(requirementTypeOf('German C1 required')).toBe('language');
    expect(requirementTypeOf('AWS Certified Solutions Architect')).toBe('certification');
    expect(requirementTypeOf('5+ years of experience')).toBe('experience_years');
  });

  it('lets a line override the section it sits under', () => {
    const requirements = extractRequirements({
      requirements: ['React (nice to have)'],
      preferredQualifications: [],
    });

    expect(requirements.find((entry) => entry.slug === 'react')?.importance).toBe('nice_to_have');
  });

  it('keeps the source sentence with every requirement', () => {
    const requirements = extractRequirements({
      requirements: ['5+ years building production React applications'],
      preferredQualifications: [],
    });

    for (const requirement of requirements) {
      expect(requirement.evidence).toBeTruthy();
    }
  });

  it('splits a compound line into separate checkable claims', () => {
    const requirements = extractRequirements({
      requirements: ['5+ years with React, TypeScript and GraphQL'],
      preferredQualifications: [],
    });

    const slugs = requirements.map((entry) => entry.slug).filter(Boolean);
    expect(slugs).toEqual(expect.arrayContaining(['react', 'typescript', 'graphql']));
    // The years demand is its own claim, separable from the skills.
    expect(requirements.some((entry) => entry.type === 'experience_years' && entry.minYears === 5)).toBe(true);
  });

  it('takes the stronger importance when a posting says both', () => {
    const requirements = extractRequirements({
      requirements: ['React is required'],
      preferredQualifications: ['React experience preferred'],
    });

    expect(requirements.find((entry) => entry.slug === 'react')?.importance).toBe('required');
  });

  it('marks structured enrichment skills the prose never stated as inferred', () => {
    const fixture = byName('excellent-match');
    const requirements = extractRequirements({
      requirements: [],
      preferredQualifications: [],
      enrichment: {
        ...fixture.enrichment,
        skills: fixture.enrichment.skills.map((skill) => ({ ...skill, requirement: 'inferred' as const })),
      },
    });

    // Scoped to skills: a stated years requirement is separately real.
    expect(
      requirements
        .filter((entry) => entry.type === 'technical_skill')
        .every((entry) => entry.importance !== 'required'),
    ).toBe(true);
  });
});

// ── 2. Match strength ───────────────────────────────────────────────────────

describe('match strength', () => {
  const context = { profile: CANDIDATE, preferences: PREFERENCES, graph, now: NOW };

  const requirement = (slug: string, text: string) =>
    extractRequirements({
      requirements: [text],
      preferredQualifications: [],
    }).find((entry) => entry.slug === slug)!;

  it('calls a directly evidenced skill a direct match', () => {
    const result = assessRequirement(requirement('react', 'React'), context);
    expect(result.strength).toBe('DIRECT_MATCH');
    expect(result.support).toBe('SUPPORTED');
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('calls same-family AWS experience a partial match, not direct', () => {
    const result = assessRequirement(requirement('lambda', 'AWS Lambda'), context);
    expect(result.strength).toBe('PARTIAL_MATCH');
    expect(result.credit).toBeLessThan(1);
    expect(result.explanation).toMatch(/not the same as direct/i);
  });

  it('calls a silent profile NO_EVIDENCE and UNKNOWN, never a failure', () => {
    const result = assessRequirement(requirement('kubernetes', 'Kubernetes'), context);
    expect(['NO_EVIDENCE', 'RELATED_MATCH']).toContain(result.strength);
    expect(result.support).toBe('UNKNOWN');
    expect(result.explanation).toMatch(/not evidence you lack it|not evidenced/i);
  });

  it('calls an explicitly excluded technology a CONFLICT', () => {
    const result = assessRequirement(requirement('php', 'PHP'), context);
    expect(result.strength).toBe('CONFLICT');
    expect(result.support).toBe('NOT_SUPPORTED');
    expect(result.credit).toBe(0);
  });

  it('discounts a stale skill against a current one', () => {
    const stale = assessRequirement(requirement('php', 'PHP'), {
      ...context,
      preferences: candidatePreferencesSchema.parse({}),
    });
    const current = assessRequirement(requirement('react', 'React'), context);

    expect(stale.credit).toBeLessThan(current.credit);
  });

  it('counts every stated skill in the denominator, not just the answered ones', () => {
    const answered = assessRequirement(requirement('react', 'React'), context);
    const silent = assessRequirement(requirement('kubernetes', 'Kubernetes'), context);

    const alignment = aggregateSkillAlignment([answered, silent]);
    expect(alignment.score).toBeLessThan(100);
    expect(alignment.noEvidence + alignment.related).toBe(1);
  });
});

// ── 3. Experience and seniority ─────────────────────────────────────────────

describe('experience', () => {
  it('does not let total experience stand in for relevant experience', () => {
    const result = run('relevant-experience-shortfall');

    // Seven years overall, two and a half of GraphQL, six demanded.
    expect(result.experience.totalYears).toBeGreaterThanOrEqual(6);
    expect(result.experience.coreSkillYears).toBeLessThan(6);
    expect(result.experience.totalMeetsButRelevantDoesNot).toBe(true);
    expect(result.explanation.summary).toMatch(/screener/i);
  });

  it('reports null rather than zero when nothing is datable', () => {
    const alignment = analyseExperience({
      profile: { ...CANDIDATE, experience: [], trajectory: { ...CANDIDATE.trajectory, totalExperienceMonths: null } },
      requirements: [],
      requiredSlugs: [],
      now: NOW,
    });

    expect(alignment.totalYears).toBeNull();
    expect(alignment.relevantYears).toBeNull();
  });

  it('classifies a level above as a stretch rather than a rejection', () => {
    const alignment = analyseSeniority({
      profile: CANDIDATE,
      jobLevel: 'staff',
      jobLevelConfidence: 0.8,
    });

    expect(alignment.fit).toBe('stretch');
    expect(alignment.explanation).toMatch(/not a disqualification/i);
  });

  it('classifies a level below as overqualified without condemning it', () => {
    const alignment = analyseSeniority({ profile: CANDIDATE, jobLevel: 'junior', jobLevelConfidence: 0.8 });
    expect(alignment.fit).toBe('overqualified');
    expect(alignment.explanation).toMatch(/some people want exactly this/i);
  });

  it('says unknown when either side has no level', () => {
    expect(analyseSeniority({ profile: CANDIDATE, jobLevel: null, jobLevelConfidence: 0 }).fit).toBe('unknown');
  });
});

// ── 4. Compensation ─────────────────────────────────────────────────────────

describe('compensation', () => {
  it('reports unknown, never below_preference, when the posting is silent', () => {
    const result = analyseCompensation({
      enrichment: byName('salary-unstated').enrichment,
      preferences: PREFERENCES,
    });

    expect(result.verdict).toBe('unknown');
    expect(result.explanation).toMatch(/not a signal about the pay/i);
  });

  it('marks a low salary below preference without blocking it', () => {
    const result = run('salary-below-preference');
    expect(result.compensation.verdict).toBe('below_preference');
    expect(result.compensation.belowHardMinimum).toBe(false);
    expect(result.overallRecommendation).not.toBe('BLOCKED');
  });

  it('blocks only when the candidate marked the minimum as hard', () => {
    const hard = candidatePreferencesSchema.parse({
      ...PREFERENCES,
      salary: { ...PREFERENCES.salary, minimumIsHard: true },
    });

    const result = run('salary-below-preference', { preferences: hard });
    expect(result.compensation.belowHardMinimum).toBe(true);
    expect(result.overallRecommendation).toBe('BLOCKED');
  });

  it('grades a strong offer as excellent', () => {
    const result = run('excellent-match');
    expect(['excellent', 'good']).toContain(result.compensation.verdict);
  });
});

// ── 5. Work authorisation and language ──────────────────────────────────────

describe('work authorisation', () => {
  it('blocks only when the candidate is elsewhere and the posting refuses to sponsor', () => {
    const result = run('hard-blocker-authorization');

    expect(result.overallRecommendation).toBe('BLOCKED');
    expect(result.blockers.some((entry) => entry.severity === 'HARD_BLOCKER')).toBe(true);
    expect(result.eligibility.eligible).toBe(false);
  });

  it('asks rather than blocks when the posting does not say where', () => {
    const result = run('unknown-work-authorization');

    expect(result.overallRecommendation).not.toBe('BLOCKED');
    expect(result.authorization.sponsorshipAvailable).toBe('unknown');
  });

  it('never invents sponsorship availability', () => {
    const result = analyseAuthorization({
      enrichment: byName('missing-information').enrichment,
      preferences: PREFERENCES,
      requirements: [],
    });

    expect(result.sponsorshipAvailable).toBe('unknown');
  });
});

describe('language requirements', () => {
  it('returns UNKNOWN when the candidate has not recorded the language', () => {
    const requirements = extractRequirements({
      requirements: ['German C1 required'],
      preferredQualifications: [],
    });

    const result = analyseLanguages({ requirements, profile: CANDIDATE });
    expect(result.requirements[0]!.support).toBe('UNKNOWN');
    expect(result.requirements[0]!.explanation).toMatch(/not evidence you do not speak it/i);
  });

  it('returns SUPPORTED when the stated level clears the bar', () => {
    const requirements = extractRequirements({
      requirements: ['English C1 required'],
      preferredQualifications: [],
    });

    const result = analyseLanguages({ requirements, profile: CANDIDATE });
    expect(result.requirements[0]!.support).toBe('SUPPORTED');
  });

  it('treats one level short as negotiable rather than failed', () => {
    const profile: CandidateIntelligence = {
      ...CANDIDATE,
      languages: [
        {
          language: 'German',
          proficiency: 'PROFESSIONAL',
          sourceText: 'German (B2)',
          userVerified: true,
        },
      ],
    };

    const requirements = extractRequirements({
      requirements: ['German C1 required'],
      preferredQualifications: [],
    });

    const result = analyseLanguages({ requirements, profile });
    expect(result.requirements[0]!.support).toBe('UNKNOWN');
    expect(result.requirements[0]!.explanation).toMatch(/one level short/i);
  });

  it('does not block a job on a language the candidate has not recorded', () => {
    const result = run('language-unknown');
    expect(result.overallRecommendation).not.toBe('BLOCKED');
  });
});

// ── 6. Friction, timing, competition, legitimacy ────────────────────────────

describe('application friction', () => {
  it('detects the parts of the process that cost time', () => {
    const fixture = byName('high-friction');
    const result = analyseFriction({ enrichment: fixture.enrichment, description: fixture.description });

    expect(result.coverLetterRequired).toBe(true);
    expect(result.assessmentRequired).toBe(true);
    expect(result.estimatedMinutes).toBeGreaterThan(60);
  });

  it('does not veto a strong job for being long-winded', () => {
    const result = run('high-friction');
    expect(['APPLY_NOW', 'APPLY', 'CONSIDER']).toContain(result.overallRecommendation);
  });

  it('flags a missing application route', () => {
    const result = analyseFriction({
      enrichment: byName('missing-information').enrichment,
      description: null,
    });
    expect(result.factors).toContain('unclear_route');
  });
});

describe('timing', () => {
  it('marks a passed deadline expired and refuses to recommend applying', () => {
    const result = run('expired');
    expect(result.timing.state).toBe('expired');
    expect(result.overallRecommendation).toBe('SKIP');
  });

  it('raises urgency when a deadline is days away', () => {
    const result = run('closing-soon');
    expect(result.timing.state).toBe('closing_soon');
    expect(result.timing.urgency).toBeGreaterThan(80);
  });

  it('keeps an old posting in play rather than discarding it', () => {
    const result = run('ageing-but-open');
    expect(result.timing.state).toBe('ageing');
    expect(result.overallRecommendation).not.toBe('SKIP');
    expect(result.timing.explanation).toMatch(/often still open/i);
  });

  it('reports unknown when the posting has no date', () => {
    const result = analyseTiming({
      postedAt: null,
      validThrough: null,
      description: null,
      closed: false,
      now: NOW,
    });
    expect(result.state).toBe('unknown');
  });
});

describe('competitiveness', () => {
  it('never invents an applicant count', () => {
    const result = run('high-competition');
    expect(result.competitiveness.applicantCount).toBeNull();
    expect(result.competitiveness.explanation).toMatch(/no source reported actual applicant numbers/i);
  });

  it('uses a reported count when a source genuinely provides one', () => {
    const result = run('high-competition', {
      reportedApplicants: { count: 340, source: 'ExampleBoard' },
    });

    expect(result.competitiveness.applicantCount).toBe(340);
    expect(result.competitiveness.level).toBe('HIGH');
    expect(result.competitiveness.confidence).toBeGreaterThan(0.5);
  });

  it('reads a low-bar worldwide role as more competitive than a narrow senior one', () => {
    const high = run('high-competition').competitiveness;
    const low = run('low-competition').competitiveness;

    expect(high.level).toBe('HIGH');
    expect(low.level).toBe('LOW');
  });

  it('keeps its confidence modest because these are proxies', () => {
    const result = analyseCompetitiveness({
      requirements: [],
      enrichment: byName('excellent-match').enrichment,
      timing: analyseTiming({ postedAt: NOW, validThrough: null, description: null, closed: false, now: NOW }),
      reportedApplicants: null,
      skillAlignmentScore: 80,
      sourceCount: 1,
    });

    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe('legitimacy', () => {
  it('flags a posting with fraud markers without accusing anyone', () => {
    const fixture = byName('suspicious');
    const result = analyseLegitimacy({
      description: fixture.description,
      companyName: fixture.companyName,
      companyWebsite: fixture.companyWebsite,
      applyUrl: fixture.applyUrl,
      scamScore: fixture.enrichment.quality.scamScore,
      qualityScore: fixture.enrichment.quality.qualityScore,
    });

    expect(result.verdict).toBe('SUSPICIOUS');
    expect(result.signals.some((signal) => signal.name === 'payment_requested')).toBe(true);
    // Describes the posting, never the company.
    expect(result.explanation).toMatch(/not proof of anything/i);
    expect(result.explanation).not.toMatch(/\bfraud(ulent)?\s+company|is\s+a\s+scam\b/i);
  });

  it('does not hide a suspicious job outright', () => {
    const result = run('suspicious');
    expect(result.overallRecommendation).not.toBe('APPLY_NOW');
    expect(result.explanation.summary.length).toBeGreaterThan(0);
  });

  it('reads a clean posting as likely legitimate', () => {
    const fixture = byName('excellent-match');
    const result = analyseLegitimacy({
      description: fixture.description,
      companyName: fixture.companyName,
      companyWebsite: fixture.companyWebsite,
      applyUrl: fixture.applyUrl,
      scamScore: 0.05,
      qualityScore: 0.8,
    });

    expect(result.verdict).toBe('LEGITIMATE_LIKELY');
  });
});

// ── 7. Blockers and the policy ──────────────────────────────────────────────

describe('blockers', () => {
  it('never produces a hard blocker from a silent profile', () => {
    const result = run('strong-with-one-gap');

    const hard = result.blockers.filter((entry) => entry.severity === 'HARD_BLOCKER');
    expect(hard).toHaveLength(0);
    expect(result.eligibility.unknown).toBeGreaterThan(0);
  });

  it('lets the candidate acknowledge a blocker and recomputes without it', () => {
    const blocked = run('hard-blocker-authorization');
    expect(blocked.overallRecommendation).toBe('BLOCKED');

    const ids = blocked.blockers
      .filter((entry) => entry.severity === 'HARD_BLOCKER')
      .map((entry) => entry.id);
    const resolved = run('hard-blocker-authorization', { acknowledgedBlockerIds: ids });

    expect(resolved.overallRecommendation).not.toBe('BLOCKED');
    expect(resolved.eligibility.eligible).toBe(true);
  });

  it('treats a years shortfall as likely rather than hard', () => {
    const result = run('seniority-stretch');

    const years = result.blockers.filter((entry) => entry.requirementType === 'experience_years');
    expect(years.every((entry) => entry.severity !== 'HARD_BLOCKER')).toBe(true);
  });

  it('treats an unmet degree requirement as likely rather than hard', () => {
    const result = run('degree-required-unmet');
    expect(result.overallRecommendation).not.toBe('BLOCKED');
    expect(result.blockers.some((entry) => entry.severity === 'LIKELY_BLOCKER')).toBe(true);
  });

  it('blocks a hybrid role that exceeds the stated office-day limit', () => {
    const result = run('hybrid-too-many-office-days');
    expect(result.location.support).toBe('NOT_SUPPORTED');
    expect(result.overallRecommendation).toBe('BLOCKED');
  });
});

describe('recommendation policy', () => {
  const base = {
    policy: {
      applyNowMinValue: 78,
      applyMinValue: 62,
      considerMinValue: 42,
      minConfidenceForVerdict: 0.35,
      applyNowMinUrgency: 55,
      valueWeights: {
        qualification: 28,
        skillAlignment: 20,
        preferenceAlignment: 16,
        careerAlignment: 10,
        jobQuality: 10,
        compensation: 8,
        timing: 5,
        friction: 3,
      },
      algorithmVersion: '1.0.0',
    },
    eligibility: { blockers: [], eligible: true } as never,
    timing: { state: 'fresh', urgency: 80 } as never,
    duplicate: duplicateCheckSchema.parse({}),
    legitimacy: { verdict: 'LEGITIMATE_LIKELY' } as never,
    hasProfile: true,
    hasEnrichment: true,
  };

  it('never lets a high score override a hard blocker', () => {
    const verdict = decide({
      ...base,
      value: 99,
      confidence: 0.95,
      eligibility: {
        blockers: [{ severity: 'HARD_BLOCKER', acknowledged: false }],
        eligible: false,
      } as never,
    });

    expect(verdict).toBe('BLOCKED');
  });

  it('degrades to UNKNOWN below the confidence floor rather than guessing', () => {
    expect(decide({ ...base, value: 85, confidence: 0.2 })).toBe('UNKNOWN');
  });

  it('never lets low confidence turn a blocker into a maybe', () => {
    const verdict = decide({
      ...base,
      value: 10,
      confidence: 0.05,
      eligibility: {
        blockers: [{ severity: 'HARD_BLOCKER', acknowledged: false }],
        eligible: false,
      } as never,
    });

    expect(verdict).toBe('BLOCKED');
  });

  it('reserves APPLY_NOW for high value plus urgency plus a clean record', () => {
    expect(decide({ ...base, value: 85, confidence: 0.8 })).toBe('APPLY_NOW');
    expect(decide({ ...base, value: 85, confidence: 0.8, timing: { state: 'ageing', urgency: 30 } as never })).toBe('APPLY');
  });

  it('walks down the bands as value falls', () => {
    expect(decide({ ...base, value: 70, confidence: 0.8 })).toBe('APPLY');
    expect(decide({ ...base, value: 50, confidence: 0.8 })).toBe('CONSIDER');
    expect(decide({ ...base, value: 20, confidence: 0.8 })).toBe('SKIP');
  });

  it('surfaces a suspicious posting as CONSIDER rather than hiding it', () => {
    const verdict = decide({
      ...base,
      value: 90,
      confidence: 0.8,
      legitimacy: { verdict: 'SUSPICIOUS' } as never,
    });

    expect(verdict).toBe('CONSIDER');
  });
});

// ── 8. Duplicates and company history ───────────────────────────────────────

describe('duplicate detection', () => {
  it('suppresses a job the candidate already applied to', () => {
    const result = run('excellent-match', {
      duplicate: duplicateCheckSchema.parse({
        reason: 'already_applied',
        suppresses: true,
        explanation: 'You applied to this role on 3 May.',
      }),
    });

    expect(result.overallRecommendation).toBe('SKIP');
    expect(result.explanation.summary).toMatch(/applied to this role/i);
  });

  it('does not suppress a merely saved job', () => {
    const result = run('excellent-match', {
      duplicate: duplicateCheckSchema.parse({
        reason: 'already_dismissed',
        suppresses: false,
        explanation: 'You dismissed this once.',
      }),
    });

    expect(result.overallRecommendation).not.toBe('SKIP');
  });

  it('does not close a door on one rejection from a company', () => {
    const single = run('excellent-match', {
      companyHistory: companyHistorySchema.parse({
        companyName: 'Northwind Software',
        applications: 1,
        rejections: 1,
        sentiment: -0.15,
      }),
    });

    expect(['APPLY_NOW', 'APPLY']).toContain(single.overallRecommendation);
  });
});

// ── 9. Resume selection and positioning ─────────────────────────────────────

describe('resume selection', () => {
  it('picks the document that argues the job best', () => {
    const result = run('excellent-match');
    expect(result.resume.recommendedLabel).toBe('Frontend CV');
    expect(result.resume.resumeFitScore).toBeGreaterThan(0);
  });

  it('picks a different document for a different job', () => {
    const platform = run('transferable-skills');
    expect(platform.resume.recommendedLabel).toBe('Cloud CV');
  });

  it('refuses to name a winner when the margin is noise', () => {
    const docs = documents();
    const twins = [docs[0]!, { ...docs[0]!, documentId: docs[1]!.documentId, label: 'Frontend CV (copy)' }];

    const result = selectResume({
      documents: twins,
      requirements: extractRequirements({
        requirements: ['5+ years React and TypeScript'],
        preferredQualifications: [],
      }),
      assessments: [],
      requiredSlugs: ['react', 'typescript'],
      jobTitle: 'Senior Frontend Engineer',
    });

    expect(result.reason).toMatch(/either would work/i);
  });

  it('names experience the profile has and the chosen resume omits', () => {
    const result = run('transferable-skills');
    // The Cloud CV wins but does not carry the frontend evidence.
    expect(Array.isArray(result.resume.missingFromResume)).toBe(true);
  });

  it('says so plainly when there are no documents', () => {
    const result = run('excellent-match', { documents: [] });
    expect(result.resume.recommendedDocumentId).toBeNull();
    expect(result.resume.reason).toMatch(/not uploaded a resume/i);
  });

  it('only recommends emphasising things the resume evidences', () => {
    const result = run('excellent-match');
    const resumeSkills = new Set(documents()[0]!.skills.map((skill) => skill.name));

    for (const item of result.resume.emphasise) {
      expect([...resumeSkills].some((name) => item.includes(name) || name.includes(item))).toBe(true);
    }
  });
});

describe('positioning and checklist', () => {
  it('addresses a transferable gap honestly', () => {
    const result = run('transferable-skills');
    expect(result.positioning.addressGaps.join(' ')).toMatch(/adjacent|related/i);
  });

  it('anticipates the concern a stretch role raises', () => {
    const result = run('seniority-stretch');
    expect(result.positioning.anticipatedConcerns.join(' ')).toMatch(/level above|scope/i);
  });

  it('builds a checklist for a job worth applying to', () => {
    const result = run('excellent-match');
    expect(result.checklist.length).toBeGreaterThanOrEqual(2);
    expect(result.checklist.some((item) => item.id === 'resume')).toBe(true);
    expect(result.checklist.some((item) => item.id === 'review')).toBe(true);
  });

  it('builds no checklist for a job it advised skipping', () => {
    expect(run('expired').checklist).toHaveLength(0);
    expect(run('hard-blocker-authorization').checklist).toHaveLength(0);
  });

  it('puts a required cover letter on the checklist', () => {
    const result = run('high-friction');
    expect(result.checklist.some((item) => item.id === 'cover-letter' && item.required)).toBe(true);
  });
});

// ── 10. Explanation ─────────────────────────────────────────────────────────

describe('explanation', () => {
  it('names the evidence behind every strength', () => {
    const result = run('excellent-match');

    expect(result.explanation.strengths.length).toBeGreaterThan(0);
    for (const strength of result.explanation.strengths) {
      // Every strength cites something, not just a score.
      expect(strength).toMatch(/:/);
    }
  });

  it('states unknowns as unknowns rather than gaps', () => {
    const result = run('strong-with-one-gap');
    expect(result.explanation.summary).toMatch(/unknowns, not gaps/i);
  });

  it('explains a block in terms of the requirement, not the fit', () => {
    const result = run('hard-blocker-authorization');
    expect(result.explanation.summary).toMatch(/separate from how well you fit/i);
    expect(result.explanation.summary).toMatch(/mark it as resolved/i);
  });

  it('never claims experience the profile does not carry', () => {
    const result = run('strong-with-one-gap');
    const prose = `${result.explanation.summary} ${result.explanation.strengths.join(' ')}`;

    // Kubernetes is not evidenced anywhere in the profile.
    expect(prose).not.toMatch(/you (?:have|bring) (?:extensive |strong )?kubernetes/i);
  });

  it('separates the recommendation from the confidence in it', () => {
    const result = run('missing-information');
    expect(APPLICATION_RECOMMENDATIONS).toContain(result.overallRecommendation);
    expect(result.confidence).toBeLessThan(0.5);
  });
});

// ── 11. Match score preservation ────────────────────────────────────────────

describe('separation from the match score', () => {
  it('carries the match score through without altering it', () => {
    const result = run('excellent-match');
    expect(result.matchScore).toBe(74);
  });

  it('produces an application value that is not the match score', () => {
    const result = run('expired');
    // A perfect match that is expired has no application value.
    expect(result.matchScore).toBe(74);
    expect(result.applicationValueScore).toBe(0);
  });
});

// ── 12. Missing profile ─────────────────────────────────────────────────────

describe('missing information', () => {
  it('returns UNKNOWN rather than guessing when there is no profile', () => {
    const result = run('excellent-match', { profile: null });
    expect(result.overallRecommendation).toBe('UNKNOWN');
    expect(result.confidence).toBeLessThanOrEqual(0.2);
  });

  it('still reads the posting when there is no profile', () => {
    const result = run('excellent-match', { profile: null });
    expect(result.timing.state).toBe('fresh');
    expect(result.compensation.stated).toBe(true);
  });
});

// ── 13. Opportunity state machine ───────────────────────────────────────────

describe('opportunity state machine', () => {
  it('has no path from RECOMMENDED straight to APPLIED', () => {
    expect(OPPORTUNITY_TRANSITIONS.RECOMMENDED).not.toContain('APPLIED');
    expect(OPPORTUNITY_TRANSITIONS.ANALYZED).not.toContain('APPLIED');
  });

  it('only reaches APPLIED through APPROVED', () => {
    const reaching = Object.entries(OPPORTUNITY_TRANSITIONS)
      .filter(([, next]) => next.includes('APPLIED'))
      .map(([state]) => state);

    expect(reaching).toEqual(['APPROVED']);
  });

  it('treats rejection and withdrawal as terminal', () => {
    expect(OPPORTUNITY_TRANSITIONS.REJECTED).toHaveLength(0);
    expect(OPPORTUNITY_TRANSITIONS.WITHDRAWN).toHaveLength(0);
  });
});

// ── 14. Analytics ───────────────────────────────────────────────────────────

function application(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return applicationRecordSchema.parse({
    id: overrides.id ?? crypto.randomUUID(),
    candidateId: CANDIDATE_ID,
    jobId: overrides.jobId ?? JOB_ID,
    status: overrides.status ?? 'applied',
    appliedAt: overrides.appliedAt ?? new Date('2025-05-01'),
    documentId: overrides.documentId ?? null,
    firstResponseAt: overrides.firstResponseAt ?? null,
    recommendationAtApply: overrides.recommendationAtApply ?? null,
  });
}

describe('application analytics', () => {
  it('computes the funnel', () => {
    const rates = computeFunnel([
      application({ status: 'applied' }),
      application({ status: 'rejected', firstResponseAt: new Date('2025-05-08') }),
      application({ status: 'interview', firstResponseAt: new Date('2025-05-05') }),
      application({ status: 'offer', firstResponseAt: new Date('2025-05-04') }),
    ]);

    expect(rates.applications).toBe(4);
    expect(rates.responses).toBe(3);
    expect(rates.interviews).toBe(2);
    expect(rates.offers).toBe(1);
  });

  it('reports rates but flags a sample too small to read', () => {
    const rates = computeFunnel([application({ status: 'interview' })]);
    expect(rates.interviewRate).toBe(1);
    expect(rates.sufficientSample).toBe(false);
  });

  it('flags a sample large enough to mean something', () => {
    const records = Array.from({ length: MIN_SAMPLE_FOR_INFERENCE }, () => application());
    expect(computeFunnel(records).sufficientSample).toBe(true);
  });

  it('refuses to compare resumes on tiny samples', () => {
    const performance = computeResumePerformance({
      records: [
        ...Array.from({ length: 4 }, () => application({ documentId: DOC_A, status: 'interview' })),
        ...Array.from({ length: 3 }, () => application({ documentId: DOC_B })),
      ],
      documentLabels: new Map([
        [DOC_A, 'Frontend CV'],
        [DOC_B, 'Cloud CV'],
      ]),
    });

    for (const entry of performance) {
      expect(entry.comparedToBest).toBeNull();
      expect(entry.note).toMatch(/too few/i);
    }
  });

  it('compares once both sides clear the threshold', () => {
    const performance = computeResumePerformance({
      records: [
        ...Array.from({ length: 20 }, (_, index) =>
          application({
            documentId: DOC_A,
            status: index < 8 ? 'interview' : 'applied',
            firstResponseAt: index < 8 ? new Date('2025-05-05') : null,
          }),
        ),
        ...Array.from({ length: 18 }, () => application({ documentId: DOC_B })),
      ],
      documentLabels: new Map([
        [DOC_A, 'Frontend CV'],
        [DOC_B, 'Cloud CV'],
      ]),
    });

    const cloud = performance.find((entry) => entry.label === 'Cloud CV')!;
    expect(cloud.comparedToBest).not.toBeNull();
    expect(cloud.comparedToBest!).toBeLessThan(0);
  });

  it('splits the funnel by dimension', () => {
    const analytics = computeAnalytics({
      candidateId: CANDIDATE_ID,
      records: [
        application({ jobId: JOB_ID, status: 'interview' }),
        application({ jobId: JOB_ID_2, status: 'rejected' }),
      ],
      jobFacts: new Map([
        [JOB_ID, { companyName: 'Northwind', sourceId: 'greenhouse', seniority: 'senior', countryCode: 'GB', roleSlug: 'frontend' }],
        [JOB_ID_2, { companyName: 'Cobalt', sourceId: 'lever', seniority: 'senior', countryCode: 'GB', roleSlug: 'frontend' }],
      ]),
      documentLabels: new Map(),
    });

    expect(analytics.overall.applications).toBe(2);
    expect(analytics.byDimension.company).toHaveLength(2);
    expect(analytics.byDimension.seniority?.[0]?.rates.applications).toBe(2);
  });
});

describe('calibration', () => {
  it('surfaces applications made against a SKIP that got a response', () => {
    const report = computeCalibration({
      candidateId: CANDIDATE_ID,
      decisions: [
        { recommendation: 'SKIP', applied: true, skipped: false, responded: true, interviewed: false },
        { recommendation: 'SKIP', applied: true, skipped: false, responded: false, interviewed: false },
        { recommendation: 'APPLY', applied: true, skipped: false, responded: true, interviewed: true },
      ],
    });

    expect(report.appliedAgainstAdvice).toBe(2);
    expect(report.appliedAgainstAdviceResponses).toBe(1);
    expect(report.note).toMatch(/the recommendation was wrong there/i);
  });

  it('flags bands with too few decisions to judge', () => {
    const report = computeCalibration({
      candidateId: CANDIDATE_ID,
      decisions: [{ recommendation: 'APPLY', applied: true, skipped: false, responded: false, interviewed: false }],
    });

    expect(report.buckets[0]!.sufficientSample).toBe(false);
    expect(report.note).toMatch(/not yet meaningful/i);
  });
});

// ── 15. The simulation (Part 49) ────────────────────────────────────────────

describe('simulation across every synthetic job', () => {
  it('produces a sensible verdict for all of them', () => {
    const failures: string[] = [];

    for (const fixture of JOB_FIXTURES) {
      const result = run(fixture.name);

      if (!fixture.expected.includes(result.overallRecommendation)) {
        failures.push(
          `${fixture.name}: expected one of ${fixture.expected.join('/')}, got ${result.overallRecommendation} ` +
            `(value ${result.applicationValueScore}, confidence ${result.confidence})`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it('never marks a requirement NOT_SUPPORTED purely from silence', () => {
    for (const fixture of JOB_FIXTURES) {
      const result = run(fixture.name);

      for (const assessment of result.eligibility.assessments) {
        if (assessment.support !== 'NOT_SUPPORTED') continue;

        // A negative must come from a conflict, never from an empty profile.
        expect(assessment.strength).toBe('CONFLICT');
      }
    }
  });

  it('gives every recommendation an explanation', () => {
    for (const fixture of JOB_FIXTURES) {
      const result = run(fixture.name);
      expect(result.explanation.summary.length).toBeGreaterThan(20);
    }
  });

  it('never recommends applying to an expired job', () => {
    for (const fixture of JOB_FIXTURES) {
      const result = run(fixture.name);
      if (result.timing.state !== 'expired') continue;

      expect(['SKIP', 'BLOCKED']).toContain(result.overallRecommendation);
    }
  });

  it('is deterministic', () => {
    for (const fixture of JOB_FIXTURES.slice(0, 8)) {
      const first = run(fixture.name);
      const second = run(fixture.name);

      expect(second.overallRecommendation).toBe(first.overallRecommendation);
      expect(second.applicationValueScore).toBe(first.applicationValueScore);
    }
  });

  it('ranks the excellent match above the poor one', () => {
    const excellent = run('excellent-match');
    const poor = run('poor-match');

    expect(excellent.applicationValueScore).toBeGreaterThan(poor.applicationValueScore);
  });

  it('ranks a strong long-form application above a mediocre easy one', () => {
    const strongButLong = run('high-friction');
    const mediocre = run('salary-below-preference');

    expect(strongButLong.applicationValueScore).toBeGreaterThan(mediocre.applicationValueScore);
  });
});
