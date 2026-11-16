import { describe, expect, it } from 'vitest';
import {
  supportedClaimSchema,
  type ApplicationRisk,
  type EvidenceRef,
  type SupportedClaim,
} from '@job-intel/contracts';
import { factCheck, isPackagePresentable, type FactCheckContext } from './integrity/fact-check';
import { analyseKeywords, buildCustomizationPlan } from './preparation/customization';
import {
  decideCoverLetter,
  extractQuestions,
  prepareAnswer,
  prepareAuthorizationGuidance,
  prepareSalaryGuidance,
} from './preparation/answers';
import {
  applicationPriority,
  assemblePackage,
  buildPreparationChecklist,
  checkApplicationUrl,
  decideApplication,
  estimateEffort,
  scorePackage,
} from './preparation/package';

/**
 * Application preparation, and the attempts to make it lie.
 *
 * The second half of this file is the more important one. Every generated
 * artefact in this layer is a chance to invent something, so the tests do not
 * merely check that honest input produces honest output — they feed the system
 * the exact inputs that would produce a fabrication and assert that it refuses.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const ref = (overrides: Partial<EvidenceRef> = {}): EvidenceRef => ({
  kind: 'employment',
  sourceId: 'emp-1',
  quote: 'Built and maintained the customer dashboard in React and TypeScript over three years.',
  locator: 'CINNSOL',
  confidence: 0.9,
  ...overrides,
});

const claim = (text: string, refs: EvidenceRef[] = [ref()]): SupportedClaim =>
  supportedClaimSchema.parse({ claim: text, evidence: refs });

const CONTEXT: FactCheckContext = {
  jobId: '11111111-1111-4111-8111-111111111111',
  companyName: 'Northwind GmbH',
  jobTitle: 'Frontend Engineer',
  knownEmployers: ['CINNSOL', 'Eko Club'],
  knownCertifications: [],
  knownMetrics: [],
  knownSkills: ['react', 'typescript', 'nextjs'],
  otherCompanies: ['Contoso Ltd', 'Acme Corp'],
  otherJobTitles: ['Backend Engineer'],
};

// ── Decision and priority (Parts 1–3) ───────────────────────────────────────

describe('application decision', () => {
  const base = {
    jobId: '11111111-1111-4111-8111-111111111111',
    candidateId: '22222222-2222-4222-8222-222222222222',
    eligible: true,
    blockers: [],
    priority: 92,
    confidence: 0.8,
    strengths: [claim('4 years of production React')],
    risks: [] as ApplicationRisk[],
    gaps: [],
  };

  it('does not simply mirror the match score', () => {
    /*
     * Same priority, different friction. A sixty-minute application is still
     * worth doing — it is just not the thing to do in the next ten minutes.
     */
    const quick = decideApplication({ ...base, effortMinutes: 8 });
    const slow = decideApplication({ ...base, effortMinutes: 75 });

    expect(quick.decision).toBe('APPLY_NOW');
    expect(slow.decision).toBe('APPLY');
  });

  it('softens a confident-looking decision built on thin evidence', () => {
    const thin = decideApplication({ ...base, confidence: 0.2 });
    expect(thin.decision).not.toBe('APPLY_NOW');
  });

  it('returns INELIGIBLE rather than a low score', () => {
    const blocked = decideApplication({
      ...base,
      eligible: false,
      blockers: ['The employer states they do not sponsor visas.'],
    });

    expect(blocked.decision).toBe('INELIGIBLE');
    expect(blocked.whyApply).toHaveLength(0);
    expect(blocked.whyNot[0]).toContain('sponsor');
  });

  it('refuses to recommend a job the candidate already applied to', () => {
    const duplicate = decideApplication({ ...base, existingStatus: 'APPLIED' });

    expect(duplicate.decision).toBe('SKIP');
    expect(duplicate.recommendedAction).toContain('existing');
  });

  it('never invents a weakness', () => {
    const clean = decideApplication(base);
    expect(clean.whyNot).toHaveLength(0);
  });
});

describe('application priority', () => {
  const base = {
    matchScore: 80,
    confidence: 0.8,
    jobQuality: 80,
    careerValue: 80,
    compensationFit: 80,
    ageDays: 2,
    daysToDeadline: null,
    effortMinutes: 10,
  };

  it('promotes the cheaper of two equal applications', () => {
    const cheap = applicationPriority(base);
    const expensive = applicationPriority({ ...base, effortMinutes: 90 });

    expect(cheap.score).toBeGreaterThan(expensive.score);
  });

  it('lets a closing deadline promote a slightly weaker job', () => {
    const urgent = applicationPriority({ ...base, matchScore: 74, daysToDeadline: 1 });
    const relaxed = applicationPriority({ ...base, matchScore: 78, daysToDeadline: 40 });

    expect(urgent.score).toBeGreaterThan(relaxed.score);
  });

  it('drops unknown dimensions rather than scoring them zero', () => {
    /*
     * Scoring an unstated salary as zero would systematically demote every
     * posting that simply omits one — which is most of them.
     */
    const withSalary = applicationPriority(base);
    const without = applicationPriority({ ...base, compensationFit: null });

    expect(Math.abs(withSalary.score - without.score)).toBeLessThan(5);
  });
});

// ── Resume gaps (Parts 12–15) ───────────────────────────────────────────────

describe('resume customization', () => {
  const input = {
    documentId: 'doc-1',
    jobId: '11111111-1111-4111-8111-111111111111',
    requirements: [
      { text: 'React', slug: 'react', importance: 'required' as const, confidence: 0.9 },
      { text: 'Frontend architecture', slug: null, importance: 'required' as const, confidence: 0.9 },
      { text: 'Kubernetes', slug: 'kubernetes', importance: 'required' as const, confidence: 0.9 },
      { text: 'CI/CD', slug: null, importance: 'preferred' as const, confidence: 0.8 },
    ],
    candidateEvidence: [
      { slug: 'react', label: 'React', refs: [ref()], strength: 'professional' as const },
      {
        slug: 'design-system',
        label: 'Design system work',
        refs: [ref({ sourceId: 'emp-2', quote: 'Owned the shared component library.' })],
        strength: 'professional' as const,
      },
    ],
    resumeSections: [
      {
        heading: 'Experience',
        bullets: [
          'Built web applications using React and TypeScript.',
          'Owned the shared component library.',
          'Set up automated deployment pipelines.',
          'Maintained internal documentation.',
        ],
      },
    ],
    resumeSkills: ['react', 'typescript', 'php'],
  };

  it('separates "you have it and the resume is silent" from "you do not have it"', () => {
    const plan = buildCustomizationPlan(input);

    const kubernetes = plan.gaps.find((gap) => gap.requirement === 'Kubernetes')!;
    expect(kubernetes.kind).toBe('NOT_EVIDENCED');
    expect(kubernetes.actionable).toBe(false);
    /* Nothing here may suggest wording that implies the experience. */
    expect(kubernetes.recommendation).toMatch(/leave it out|cannot defend/i);
  });

  it('recognises the same claim in different words', () => {
    const plan = buildCustomizationPlan(input);
    const cicd = plan.gaps.find((gap) => gap.requirement === 'CI/CD')!;

    /*
     * The resume says "automated deployment pipelines", which is the better
     * phrase. Reporting it missing would push the candidate toward jargon.
     */
    expect(cicd.kind).toBe('TERMINOLOGY_MISMATCH');
    expect(cicd.resumeSays).toMatch(/automated deployment/i);
  });

  it('emphasises only what the job asks for and the candidate can evidence', () => {
    const plan = buildCustomizationPlan(input);

    expect(plan.emphasise.length).toBeGreaterThan(0);
    for (const item of plan.emphasise) {
      expect(item.evidence.length).toBeGreaterThan(0);
    }
    expect(plan.emphasise.some((item) => /kubernetes/i.test(item.claim))).toBe(false);
  });

  it('never proposes new text without evidence behind it', () => {
    const plan = buildCustomizationPlan(input);

    for (const bullet of plan.bullets) {
      if (bullet.proposed !== null) {
        expect(bullet.evidence.length).toBeGreaterThan(0);
      }
    }
  });

  it('leaves every recommendation pending until a person decides', () => {
    const plan = buildCustomizationPlan(input);

    expect(plan.requiresReview).toBe(true);
    for (const bullet of plan.bullets) {
      expect(bullet.userDecision).toBe('pending');
    }
  });

  it('does not report an equivalent phrasing as missing', () => {
    const keywords = analyseKeywords(
      input.requirements,
      input.resumeSections[0]!.bullets.join('\n'),
    );

    const cicd = keywords.find((entry) => entry.term === 'CI/CD')!;
    expect(cicd.state).toBe('equivalent');
  });
});

// ── Cover letter (Parts 23, 24) ─────────────────────────────────────────────

describe('cover letter strategy', () => {
  const strengths = [claim('4 years of production React')];

  it('says not to bother when the posting says optional and the fit is strong', () => {
    const strategy = decideCoverLetter({
      descriptionText: 'A cover letter is optional.',
      matchScore: 88,
      strengths,
      companyFacts: [],
    });

    expect(strategy.verdict).toBe('UNNECESSARY');
    expect(strategy.brief).toBeNull();
  });

  it('writes a brief when the posting requires one', () => {
    const strategy = decideCoverLetter({
      descriptionText: 'A cover letter is required for this position.',
      matchScore: 80,
      strengths,
      companyFacts: [],
    });

    expect(strategy.verdict).toBe('REQUIRED');
    expect(strategy.brief?.topEvidence.length).toBeGreaterThan(0);
  });

  it('omits the company angle when nothing about the company is verified', () => {
    const strategy = decideCoverLetter({
      descriptionText: 'Cover letter required.',
      matchScore: 80,
      strengths,
      companyFacts: [],
    });

    /*
     * A letter praising a company for something it does not do is worse than
     * one that says nothing about the company.
     */
    expect(strategy.brief?.companyPoint).toBeNull();
  });

  it('refuses to draft anything when there is no evidence to draw on', () => {
    const strategy = decideCoverLetter({
      descriptionText: null,
      matchScore: 60,
      strengths: [],
      companyFacts: [],
    });

    expect(strategy.verdict).toBe('UNKNOWN');
    expect(strategy.brief).toBeNull();
  });

  it('leaves motivation to the candidate', () => {
    const strategy = decideCoverLetter({
      descriptionText: 'Cover letter required.',
      matchScore: 80,
      strengths,
      companyFacts: [],
    });

    expect(strategy.brief?.motivation).toMatch(/your own words|leave this blank/i);
  });
});

// ── Questions, salary, authorisation (Parts 27–33) ──────────────────────────

describe('question preparation', () => {
  const blank = {
    strengths: [] as SupportedClaim[],
    yearsOfExperience: null,
    noticePeriod: null,
    availableFrom: null,
    salary: null,
    authorization: null,
  };

  it('extracts questions from a posting', () => {
    const questions = extractQuestions(
      'Why do you want to work here?\nWhat are your salary expectations?\nWe build software.',
    );

    expect(questions).toHaveLength(2);
    expect(questions.map((q) => q.kind)).toContain('salary');
  });

  it('refuses to invent a behavioural story', () => {
    const answer = prepareAnswer({
      ...blank,
      question: 'Tell me about a time you handled conflict.',
      kind: 'behavioral',
    });

    expect(answer.recommendedAnswer).toBeNull();
    expect(answer.missingInformation.length).toBeGreaterThan(0);
  });

  it('leaves the STAR result to the candidate even when it has a story', () => {
    const answer = prepareAnswer({
      ...blank,
      question: 'Tell me about a time you shipped something difficult.',
      kind: 'behavioral',
      strengths: [claim('Owned the customer dashboard')],
    });

    /*
     * The outline comes from the record; the outcome does not. Putting a number
     * here would be the single most damaging fabrication in the file.
     */
    expect(answer.star?.result).toMatch(/will not put a number|your own words/i);
    expect(answer.missingInformation).toContain('The result. Only you know how it turned out.');
  });

  it('does not answer "why do you want to work here" for the candidate', () => {
    const answer = prepareAnswer({ ...blank, question: 'Why here?', kind: 'motivation' });
    expect(answer.recommendedAnswer).toBeNull();
  });

  it('says what is missing rather than guessing a notice period', () => {
    const answer = prepareAnswer({ ...blank, question: 'Notice period?', kind: 'notice_period' });

    expect(answer.recommendedAnswer).toBeNull();
    expect(answer.missingInformation[0]).toMatch(/not recorded/i);
  });
});

describe('salary guidance', () => {
  it('anchors on a posted range when there is one', () => {
    const guidance = prepareSalaryGuidance({
      postedMin: 70_000,
      postedMax: 90_000,
      postedCurrency: 'EUR',
      targetMin: 75_000,
      targetCurrency: 'EUR',
    });

    expect(guidance.strategy).toBe('range');
    expect(guidance.postedRange).toContain('70,000');
    expect(guidance.containsEstimates).toBe(false);
  });

  it('defers rather than inventing a number', () => {
    const guidance = prepareSalaryGuidance({
      postedMin: null,
      postedMax: null,
      postedCurrency: null,
      targetMin: null,
      targetCurrency: null,
    });

    expect(guidance.strategy).toBe('defer');
    expect(guidance.recommendedResponse).toMatch(/no basis|invented/i);
    /* No figure appears anywhere in the response. */
    expect(guidance.recommendedResponse).not.toMatch(/\d{4,}/);
  });

  it('labels market data as an estimate', () => {
    const guidance = prepareSalaryGuidance({
      postedMin: null,
      postedMax: null,
      postedCurrency: null,
      targetMin: null,
      targetCurrency: null,
      marketMedian: 80_000,
      marketSource: 'Levels.fyi 2026',
    });

    expect(guidance.containsEstimates).toBe(true);
    expect(guidance.marketContext).toMatch(/estimated/i);
  });
});

describe('authorization guidance', () => {
  it('never infers authorisation', () => {
    const guidance = prepareAuthorizationGuidance({
      authorizedCountries: [],
      requiresSponsorship: null,
      employerSponsorship: 'not_mentioned',
      jobCountry: 'DE',
    });

    expect(guidance.needsCandidateInput).toBe(true);
    expect(guidance.requiresSponsorship).toBeNull();
    expect(guidance.recommendedResponse).toMatch(/cannot be guessed/i);
  });

  it('uses what the candidate configured', () => {
    const guidance = prepareAuthorizationGuidance({
      authorizedCountries: ['DE'],
      requiresSponsorship: false,
      employerSponsorship: 'not_mentioned',
      jobCountry: 'DE',
    });

    expect(guidance.requiresSponsorship).toBe(false);
    expect(guidance.recommendedResponse).toMatch(/^Yes/);
  });
});

// ── URL, effort, checklist (Parts 37, 38, 47) ───────────────────────────────

describe('application url', () => {
  it('trusts an ATS destination', () => {
    const check = checkApplicationUrl('https://boards.greenhouse.io/northwind/jobs/4001')!;

    expect(check.verdict).toBe('ATS_DIRECT');
    expect(check.safeToPresent).toBe(true);
  });

  it('does not vouch for an unknown domain', () => {
    const check = checkApplicationUrl('https://jobs-r-us.example.test/apply/123')!;

    expect(check.verdict).toBe('UNVERIFIED');
    expect(check.safeToPresent).toBe(false);
  });

  it('rejects a non-http scheme', () => {
    const check = checkApplicationUrl('file:///etc/passwd')!;
    expect(check.safeToPresent).toBe(false);
  });

  it('does not claim reachability it did not test', () => {
    const check = checkApplicationUrl('https://boards.greenhouse.io/x/jobs/1')!;
    expect(check.reachable).toBeNull();
  });
});

describe('effort estimate', () => {
  it('adds up the things a posting asks for', () => {
    const easy = estimateEffort('Upload your resume and apply.');
    const hard = estimateEffort(
      'Create an account, upload your resume, write a cover letter and complete a take-home assessment.',
    );

    expect(hard.minutes).toBeGreaterThan(easy.minutes);
    expect(hard.complexity).toBe('high');
    expect(hard.isEstimate).toBe(true);
  });
});

describe('checklist', () => {
  it('blocks on a question only the candidate can answer', () => {
    const checks = buildPreparationChecklist({
      resumeSelected: true,
      customizationReviewed: true,
      coverLetterVerdict: 'UNNECESSARY',
      answers: [
        prepareAnswer({
          question: 'Salary?',
          kind: 'salary',
          strengths: [],
          yearsOfExperience: null,
          noticePeriod: null,
          availableFrom: null,
          salary: null,
          authorization: null,
        }),
      ],
      portfolioRequired: false,
      portfolioSelected: 0,
      urlCheck: null,
      unresolvedGaps: [],
    });

    const questions = checks.find((check) => check.id === 'questions')!;
    expect(questions.state).toBe('blocked');
    expect(questions.blocking).toBe(true);
  });

  it('warns about a gap without suggesting it can be papered over', () => {
    const checks = buildPreparationChecklist({
      resumeSelected: true,
      customizationReviewed: true,
      coverLetterVerdict: 'OPTIONAL',
      answers: [],
      portfolioRequired: false,
      portfolioSelected: 0,
      urlCheck: null,
      unresolvedGaps: ['Kubernetes'],
    });

    const gap = checks.find((check) => check.label.includes('Kubernetes'))!;
    expect(gap.detail).toMatch(/do not imply otherwise/i);
  });
});

// ── The adversarial half ────────────────────────────────────────────────────

describe('attempts to make the system fabricate', () => {
  it('rejects a claim with no evidence at the schema boundary', () => {
    /*
     * `evidence` has a minimum length of one, so an unsupported claim is
     * unrepresentable rather than merely discouraged.
     */
    expect(() => supportedClaimSchema.parse({ claim: 'Led a team of 12', evidence: [] })).toThrow();
  });

  it('catches a metric that appears nowhere in the evidence', () => {
    const report = factCheck(
      [],
      [claim('Improved page load time by 60%')],
      CONTEXT,
    );

    expect(report.passed).toBe(false);
    expect(report.findings[0]!.violation).toBe('FABRICATED_METRIC');
  });

  it('allows a metric the evidence actually contains', () => {
    const report = factCheck(
      [],
      [
        claim('Reduced load time by 60%', [
          ref({ quote: 'Reduced first contentful paint by 60% across the dashboard.' }),
        ]),
      ],
      CONTEXT,
    );

    expect(report.passed).toBe(true);
  });

  it('catches an invented metric in generated resume text', () => {
    const report = factCheck(
      [{ location: 'Experience#0', text: 'Scaled the platform to 2 million users.' }],
      [],
      CONTEXT,
    );

    expect(report.findings.some((f) => f.violation === 'FABRICATED_METRIC')).toBe(true);
  });

  it('catches an invented certification', () => {
    const report = factCheck(
      [{ location: 'Summary', text: 'AWS Certified Solutions Architect with 5 years of cloud work.' }],
      [],
      CONTEXT,
    );

    expect(report.findings.some((f) => f.violation === 'FABRICATED_CREDENTIAL')).toBe(true);
  });

  it('catches another company leaking into this cover letter', () => {
    const report = factCheck(
      [
        {
          location: 'CoverLetter',
          text: 'I have long admired Contoso Ltd and would love to join the team.',
        },
      ],
      [],
      CONTEXT,
    );

    const contamination = report.findings.find((f) => f.violation === 'CROSS_JOB_CONTAMINATION')!;

    expect(contamination).toBeDefined();
    expect(contamination.severity).toBe('CRITICAL');
    expect(report.passed).toBe(false);
  });

  it('does not fire on a substring that merely contains a company name', () => {
    const report = factCheck(
      [{ location: 'Summary', text: 'Worked extensively with metadata pipelines.' }],
      [],
      { ...CONTEXT, otherCompanies: ['Meta'] },
    );

    /* A substring check would fire on "metadata" and train people to ignore it. */
    expect(report.findings.some((f) => f.violation === 'CROSS_JOB_CONTAMINATION')).toBe(false);
  });

  it('catches an employer the candidate never worked for', () => {
    const report = factCheck(
      [{ location: 'Experience', text: 'Worked at Globex Industries as a senior engineer.' }],
      [],
      CONTEXT,
    );

    expect(report.findings.some((f) => f.violation === 'FABRICATED_EMPLOYER')).toBe(true);
  });

  it('rejects a claim about the candidate backed only by the job posting', () => {
    const report = factCheck(
      [],
      [
        claim('Four years of Kubernetes experience', [
          ref({ kind: 'job_posting', sourceId: 'job-1', quote: 'We require 4 years of Kubernetes.' }),
        ]),
      ],
      CONTEXT,
    );

    /*
     * Circular: the posting says the *job* wants it, not that the candidate has
     * it. A generator makes this mistake readily because both texts mention it.
     */
    expect(report.findings.some((f) => f.violation === 'UNSUPPORTED_CLAIM')).toBe(true);
  });

  it('strips a fabricated claim from the package rather than flagging it', () => {
    const assembled = assemblePackage({
      jobId: CONTEXT.jobId,
      candidateId: '22222222-2222-4222-8222-222222222222',
      jobSnapshot: { title: 'Frontend Engineer' },
      decision: decideApplication({
        jobId: CONTEXT.jobId,
        candidateId: '22222222-2222-4222-8222-222222222222',
        eligible: true,
        blockers: [],
        priority: 85,
        confidence: 0.8,
        strengths: [claim('Improved conversion by 45%'), claim('Built the dashboard in React')],
        risks: [],
        gaps: [],
      }),
      resume: { action: 'reuse', selected: null, alternatives: [], reason: 'Test.' },
      generatedTexts: [],
      factContext: CONTEXT,
      requirementsCovered: 3,
      requirementsTotal: 4,
    });

    expect(assembled.integrity.passed).toBe(false);
    expect(assembled.presentable.presentable).toBe(false);

    /* The unsupported claim never reaches the candidate. */
    const claims = assembled.package.decision.strengths.map((entry) => entry.claim);
    expect(claims.some((text) => text.includes('45%'))).toBe(false);
  });

  it('zeroes the quality score when integrity fails', () => {
    const quality = scorePackage({
      hasResume: true,
      hasCustomization: true,
      hasCoverLetterDecision: true,
      answeredQuestions: 3,
      totalQuestions: 3,
      claims: [claim('React')],
      requirementsCovered: 4,
      requirementsTotal: 4,
      integrityPassed: false,
      integrityFindings: 1,
    });

    /*
     * A package with a fabricated claim is not 70% good. Averaging that away
     * would let it through.
     */
    expect(quality.overall).toBe(0);
    expect(quality.consistency).toBe(0);
  });

  it('never presents a score as a probability of being hired', () => {
    const quality = scorePackage({
      hasResume: true,
      hasCustomization: true,
      hasCoverLetterDecision: true,
      answeredQuestions: 1,
      totalQuestions: 1,
      claims: [claim('React')],
      requirementsCovered: 4,
      requirementsTotal: 4,
      integrityPassed: true,
      integrityFindings: 0,
    });

    expect(quality.disclaimer).toMatch(/not a probability/i);
  });

  it('never marks a package as submitted', () => {
    const assembled = assemblePackage({
      jobId: CONTEXT.jobId,
      candidateId: '22222222-2222-4222-8222-222222222222',
      jobSnapshot: { title: 'Frontend Engineer' },
      decision: decideApplication({
        jobId: CONTEXT.jobId,
        candidateId: '22222222-2222-4222-8222-222222222222',
        eligible: true,
        blockers: [],
        priority: 95,
        confidence: 0.9,
        strengths: [claim('Built the dashboard in React')],
        risks: [],
        gaps: [],
      }),
      resume: { action: 'reuse', selected: null, alternatives: [], reason: 'Test.' },
      generatedTexts: [],
      factContext: CONTEXT,
      requirementsCovered: 4,
      requirementsTotal: 4,
    });

    /*
     * There is no submit path anywhere in this package — not disabled, absent.
     * Only the interface, acting for a person, writes these.
     */
    expect(assembled.package.submittedByUserAt).toBeNull();
    expect(assembled.package.reviewedByUserAt).toBeNull();
  });

  it('freezes the job snapshot against later mutation', () => {
    const snapshot: Record<string, unknown> = { title: 'Frontend Engineer', salary: '70k' };

    const assembled = assemblePackage({
      jobId: CONTEXT.jobId,
      candidateId: '22222222-2222-4222-8222-222222222222',
      jobSnapshot: snapshot,
      decision: decideApplication({
        jobId: CONTEXT.jobId,
        candidateId: '22222222-2222-4222-8222-222222222222',
        eligible: true,
        blockers: [],
        priority: 80,
        confidence: 0.8,
        strengths: [],
        risks: [],
        gaps: [],
      }),
      resume: { action: 'reuse', selected: null, alternatives: [], reason: 'Test.' },
      generatedTexts: [],
      factContext: CONTEXT,
      requirementsCovered: 1,
      requirementsTotal: 1,
    });

    /* The employer edits the posting after the candidate prepared. */
    snapshot['salary'] = 'withdrawn';

    expect(assembled.package.jobSnapshot['salary']).toBe('70k');
  });

  it('reports honestly when everything checks out', () => {
    const report = factCheck(
      [{ location: 'Summary', text: 'Frontend engineer with React and TypeScript experience.' }],
      [claim('Built the customer dashboard in React')],
      CONTEXT,
    );

    expect(report.passed).toBe(true);
    expect(isPackagePresentable(report).reason).toMatch(/backed by your own records/i);
  });
});
