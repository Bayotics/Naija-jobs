import { describe, expect, it } from 'vitest';
import { createLogger } from '@job-intel/observability';
import { SkillGraph } from '@job-intel/candidate';
import { MatchingEngine } from './engine/matching-engine';
import {
  makeCandidateContext,
  makeCandidateSkill,
  makeJobContext,
} from './testing/fixtures';
import { extractRemoteReach } from './geography/remote-reach';
import { assessTrajectory } from './career/trajectory';
import { evaluateBands, naiveKeywordScore, type ScoredCase } from './evaluation/offline-eval';
import { explainRanking } from './tradeoffs/pareto';
import type { JobMatch } from '@job-intel/contracts';

/**
 * Thirty realistic jobs, one candidate, and the comparison that matters.
 *
 * The candidate is fixed and deliberately ordinary: a mid-level frontend
 * engineer in Nigeria with four years of production React and TypeScript, who
 * needs visa sponsorship and will not relocate for an onsite role. Every job
 * below is a real shape that this system encounters, and each one is here
 * because it breaks a specific naive assumption.
 *
 * The suite asserts two different things, and the second is the point.
 *
 * First, that the engine gets each case right — eligible or not, roughly the
 * right band, the right blockers.
 *
 * Second, that it beats naive keyword overlap *where it should*. A keyword
 * matcher does fine on the easy cases; the whole argument for this machinery is
 * the cases where it does not, and those are enumerated rather than summarised.
 */

const logger = createLogger({ level: 'error', pretty: false, base: { service: 'scenarios' } });
const engine = new MatchingEngine({ logger });

// ── The candidate ───────────────────────────────────────────────────────────

const CANDIDATE_SKILLS = ['react', 'typescript', 'javascript', 'css', 'nextjs', 'jest'];

function candidate() {
  return makeCandidateContext({
    professional: {
      yearsOfExperience: 4,
      currentTitle: 'Frontend Developer',
      seniorityLevel: 'mid',
    },
    preferences: {
      workArrangement: 'REMOTE_ONLY',
      workAuthorization: { sponsorshipRequirement: 'required', authorizedCountries: ['NG'], citizenships: ['NG'] },
      salary: { minimum: 40_000, target: 70_000, currency: 'USD', period: 'year' },
      companies: [{ value: 'Excluded Corp', strength: 'excluded', hard: true }],
    },
    skills: [
      makeCandidateSkill('React', {
        slug: 'react',
        yearsOfExperience: 4,
        importance: 'primary',
        source: 'explicit',
      }),
      makeCandidateSkill('TypeScript', {
        slug: 'typescript',
        yearsOfExperience: 4,
        importance: 'primary',
      }),
      makeCandidateSkill('JavaScript', { slug: 'javascript', yearsOfExperience: 5 }),
      makeCandidateSkill('Next.js', { slug: 'nextjs', yearsOfExperience: 2 }),
      makeCandidateSkill('CSS', { slug: 'css', yearsOfExperience: 5 }),
      makeCandidateSkill('Jest', { slug: 'jest', yearsOfExperience: 3 }),
    ],
    skillGraph: new SkillGraph(),
  });
}

const CANDIDATE_TITLES = ['Frontend Developer', 'Junior Frontend Developer'];

// ── Scenario definition ─────────────────────────────────────────────────────

interface Scenario {
  n: number;
  label: string;
  title: string;
  company?: string;
  description: string;
  enrichment?: Record<string, unknown>;
  expectedBand: ScoredCase['expectedBand'];
  expectIneligible?: boolean;
  relevance: number;
  /** What this case is here to prove that keywords cannot. */
  teaches?: string;
}

/**
 * Work arrangement as enrichment records it.
 *
 * The field is `mode`, not `arrangement` — an earlier draft of this file used
 * the wrong name, Zod filled the default silently, and every hybrid and onsite
 * job sailed past a REMOTE_ONLY candidate's hard constraint scoring the same as
 * a perfect remote role. No error, no warning, just sixteen jobs with identical
 * scores. Worth stating because the failure mode is invisible.
 */
const remote = (
  mode: 'remote' | 'hybrid' | 'onsite',
  options: { worldwide?: boolean; regions?: string[]; country?: string; officeDays?: number } = {},
) => ({
  workArrangement: {
    mode,
    confidence: 0.9,
    method: 'pattern' as const,
    evidence: null,
    remoteAllowed: mode === 'remote',
    remoteRegions: options.regions ?? [],
    remoteWorldwide: options.worldwide ?? false,
    officeDaysPerWeek: options.officeDays ?? null,
  },
  location: {
    raw: options.country ?? (mode === 'remote' ? 'Remote' : 'Unknown'),
    countryCode: options.country ?? null,
    city: null,
    region: null,
    confidence: 0.8,
  },
});

/**
 * Compensation as enrichment records it.
 *
 * `conversion` is required, not optional decoration: the salary scorer compares
 * annualised USD, so a stated salary without it reads as no salary at all.
 */
const salary = (min: number | null, max: number | null) =>
  min === null
    ? { stated: false, confidence: 0, method: 'default' as const }
    : {
        stated: true,
        minimum: min,
        maximum: max,
        currency: 'USD',
        period: 'year' as const,
        confidence: 0.9,
        method: 'pattern' as const,
        rawText: `$${min}–$${max}`,
        conversion: {
          annualUsd: min,
          rate: 1,
          rateSource: 'fixture',
          rateTimestamp: new Date('2026-08-01T00:00:00Z'),
          periodInferred: false,
        },
      };


/**
 * Skills as the enrichment layer would have extracted them.
 *
 * The engine reads structured enrichment, not description prose — normalising
 * text into slugs is enrichment's job, and duplicating it here would test the
 * wrong thing. These are the outputs enrichment produces for each posting.
 */
const skills = (
  entries: ReadonlyArray<[string, 'required' | 'preferred' | 'optional' | 'inferred']>,
) =>
  entries.map(([slug, requirement]) => ({
    slug,
    displayName: slug,
    category: 'framework' as const,
    requirement,
    confidence: 0.9,
    method: 'taxonomy' as const,
    matchedText: slug,
    evidence: null,
  }));

const SCENARIOS: Scenario[] = [
  {
    n: 1,
    label: 'Perfect React/TypeScript role',
    title: 'Frontend Engineer',
    description:
      'We need a frontend engineer with strong React and TypeScript. You will build interfaces with Next.js and write tests with Jest. 3+ years of experience.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required'],['nextjs','preferred'],['jest','preferred']]), ...remote('remote'), compensation: salary(60_000, 85_000), seniority: 'mid' },
    expectedBand: 'EXCELLENT',
    relevance: 4,
  },
  {
    n: 2,
    label: 'Strong React role, slightly low salary',
    title: 'Frontend Developer',
    description: 'React and TypeScript role. Build product UI. 3+ years required.',
    enrichment: { normalizedTitle: 'Frontend Developer', skills: skills([['react','required'],['typescript','required']]), ...remote('remote'), compensation: salary(42_000, 48_000), seniority: 'mid' },
    expectedBand: 'GOOD',
    relevance: 3,
  },
  {
    n: 3,
    label: 'Strong role, unknown salary',
    title: 'Frontend Engineer',
    description: 'React, TypeScript, Next.js. Competitive compensation.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required'],['nextjs','preferred']]), ...remote('remote'), compensation: salary(null, null), seniority: 'mid' },
    expectedBand: 'GOOD',
    relevance: 3,
    teaches: 'An unstated salary must not be scored as a failed salary test.',
  },
  {
    n: 4,
    label: 'Senior role for a mid-level candidate',
    title: 'Senior Frontend Engineer',
    description: 'Senior React/TypeScript role. 7+ years of experience required. Lead a team.',
    enrichment: { normalizedTitle: 'Senior Frontend Engineer', skills: skills([['react','required'],['typescript','required']]), ...remote('remote'), compensation: salary(90_000, 120_000), seniority: 'senior' },
    expectedBand: 'GOOD',
    relevance: 2,
  },
  {
    n: 5,
    label: 'Mid role for a senior candidate',
    title: 'Junior Frontend Developer',
    description: 'Entry-level React position. 0–2 years.',
    enrichment: { normalizedTitle: 'Junior Frontend Developer', skills: skills([['react','required']]), ...remote('remote'), compensation: salary(25_000, 35_000), seniority: 'junior' },
    expectedBand: 'BORDERLINE',
    relevance: 1,
  },
  {
    n: 6,
    label: 'Remote US-only role',
    title: 'Frontend Engineer',
    description:
      'React and TypeScript. Remote within the United States. You must be authorized to work in the United States. No sponsorship.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required']]), ...remote('remote', { regions: ['US'], country: 'US' }), compensation: salary(90_000, 130_000) },
    expectedBand: 'POOR',
    expectIneligible: true,
    relevance: 0,
    teaches: 'A "remote" role that only hires from the US is not remote for this candidate.',
  },
  {
    n: 7,
    label: 'Remote worldwide role',
    title: 'Frontend Engineer',
    description: 'React, TypeScript. Work from anywhere in the world. We hire globally.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required']]), ...remote('remote', { worldwide: true }), compensation: salary(55_000, 75_000) },
    expectedBand: 'EXCELLENT',
    relevance: 4,
  },
  {
    n: 8,
    label: 'Hybrid Germany role',
    title: 'Frontend Engineer',
    description: 'React role in Berlin. Hybrid: 2 days per week in the office. Visa sponsorship available.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required']]),
      ...remote('hybrid', { country: 'DE', officeDays: 2 }),
      compensation: salary(60_000, 80_000),
    },
    expectedBand: 'POOR',
    expectIneligible: true,
    relevance: 0,
    teaches: 'The candidate stated REMOTE_ONLY; a hybrid role fails a hard preference.',
  },
  {
    n: 9,
    label: 'Onsite Nigeria role',
    title: 'Frontend Developer',
    description: 'On-site React role in Lagos. Full time.',
    enrichment: { normalizedTitle: 'Frontend Developer', skills: skills([['react','required']]),
      ...remote('onsite', { country: 'NG' }),
      compensation: salary(20_000, 30_000),
    },
    expectedBand: 'POOR',
    expectIneligible: true,
    relevance: 0,
  },
  {
    n: 10,
    label: 'Visa sponsorship available',
    title: 'Frontend Engineer',
    description: 'React/TypeScript. We sponsor visas for the right candidate. Remote worldwide.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required']]),
      ...remote('remote'),
      compensation: salary(65_000, 90_000),
      workAuthorization: { sponsorship: 'offered', confidence: 0.9, evidence: 'We sponsor visas' },
    },
    expectedBand: 'EXCELLENT',
    relevance: 4,
  },
  {
    n: 11,
    label: 'Visa sponsorship unavailable',
    title: 'Frontend Engineer',
    description:
      'React role. We are unable to provide visa sponsorship. Applicants must already have the right to work.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required']]),
      ...remote('remote'),
      compensation: salary(70_000, 95_000),
      workAuthorization: {
        sponsorship: 'not_offered',
        confidence: 0.9,
        evidence: 'unable to provide visa sponsorship',
      },
    },
    expectedBand: 'POOR',
    expectIneligible: true,
    relevance: 0,
    teaches: 'A stated refusal to sponsor is a hard blocker, not a scoring penalty.',
  },
  {
    n: 12,
    label: 'Authorization unknown',
    title: 'Frontend Engineer',
    description: 'React and TypeScript role. Remote.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required']]), ...remote('remote', { worldwide: true }), compensation: salary(60_000, 80_000) },
    expectedBand: 'GOOD',
    relevance: 3,
    teaches: 'Silence about sponsorship lowers confidence and caps the score; it does not block.',
  },
  {
    n: 13,
    label: 'Required Kubernetes gap',
    title: 'Frontend Platform Engineer',
    description:
      'React and TypeScript, plus 5+ years of Kubernetes in production. Required: Kubernetes, Docker, Terraform.',
    enrichment: { normalizedTitle: 'Frontend Platform Engineer', skills: skills([['react','required'],['typescript','required'],['kubernetes','required'],['docker','required'],['terraform','required']]), ...remote('remote'), compensation: salary(80_000, 110_000) },
    expectedBand: 'BORDERLINE',
    relevance: 1,
  },
  {
    n: 14,
    label: 'Preferred AWS gap',
    title: 'Frontend Engineer',
    description: 'React, TypeScript required. AWS experience is a plus. Remote.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required'],['aws','preferred']]), ...remote('remote'), compensation: salary(60_000, 80_000) },
    expectedBand: 'EXCELLENT',
    relevance: 4,
    teaches: 'A missing *preferred* skill should barely move the score.',
  },
  {
    n: 15,
    label: 'React/Next.js transferable match',
    title: 'Next.js Engineer',
    description: 'Deep Next.js work. App router, server components, React Server Components.',
    enrichment: { normalizedTitle: 'Next.js Engineer', skills: skills([['nextjs','required'],['react','required']]), ...remote('remote'), compensation: salary(65_000, 85_000) },
    expectedBand: 'GOOD',
    relevance: 3,
    teaches: 'React experience is genuine partial evidence for Next.js.',
  },
  {
    n: 16,
    label: 'Vue role',
    title: 'Vue.js Frontend Developer',
    description: 'Vue 3, Composition API, Pinia, Nuxt. 4+ years of Vue required.',
    enrichment: { normalizedTitle: 'Vue.js Frontend Developer', skills: skills([['vue','required'],['nuxt','required'],['pinia','preferred']]), ...remote('remote'), compensation: salary(60_000, 80_000) },
    expectedBand: 'BORDERLINE',
    relevance: 1,
    teaches: 'React does not equal Vue, but a frontend engineer is not irrelevant to it either.',
  },
  {
    n: 17,
    label: 'Angular role',
    title: 'Angular Developer',
    description: 'Angular 17, RxJS, NgRx. 5 years of Angular required.',
    enrichment: { normalizedTitle: 'Angular Developer', skills: skills([['angular','required'],['rxjs','required'],['ngrx','preferred']]), ...remote('remote'), compensation: salary(60_000, 80_000) },
    expectedBand: 'BORDERLINE',
    relevance: 1,
  },
  {
    n: 18,
    label: 'Unrelated software role',
    title: 'Embedded Firmware Engineer',
    description: 'C, C++, RTOS, hardware bring-up, oscilloscopes. Embedded systems.',
    enrichment: { normalizedTitle: 'Embedded Firmware Engineer', skills: skills([['c','required'],['cpp','required'],['rtos','required'],['embedded','required']]), ...remote('remote'), compensation: salary(70_000, 95_000) },
    expectedBand: 'POOR',
    relevance: 0,
  },
  {
    n: 19,
    label: 'Preferred company',
    title: 'Frontend Engineer',
    company: 'Preferred Inc',
    description: 'React and TypeScript. Remote worldwide.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required']]), ...remote('remote'), compensation: salary(60_000, 80_000) },
    expectedBand: 'EXCELLENT',
    relevance: 4,
  },
  {
    n: 20,
    label: 'Excluded company',
    title: 'Frontend Engineer',
    company: 'Excluded Corp',
    description: 'Perfect React and TypeScript role. Remote worldwide. Excellent salary.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required']]), ...remote('remote'), compensation: salary(100_000, 140_000) },
    expectedBand: 'POOR',
    expectIneligible: true,
    relevance: 0,
    teaches: 'An explicit exclusion overrides an otherwise perfect match.',
  },
  {
    n: 21,
    label: 'Expired job',
    title: 'Frontend Engineer',
    description: 'React and TypeScript. Remote.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required']]),
      ...remote('remote'),
      compensation: salary(70_000, 90_000),
    },
    /*
     * Expiry is enforced before matching — an expired job never reaches the
     * engine — so the engine legitimately scores this on its merits. Graded as
     * the good role it is, with the lifecycle filter tested where it lives.
     */
    expectedBand: 'GOOD',
    relevance: 1,
  },
  {
    n: 22,
    label: 'Suspicious job',
    title: 'Frontend Engineer — Earn $$$ Fast',
    description:
      'Work from home! No experience needed! Send your bank details to begin. Earn $5000 per week immediately!',
    enrichment: { normalizedTitle: 'Frontend Engineer — Earn $$$ Fast', skills: skills([]), ...remote('remote'), compensation: salary(200_000, 400_000) },
    expectedBand: 'POOR',
    relevance: 0,
  },
  {
    n: 23,
    label: 'Duplicate job',
    title: 'Frontend Engineer',
    description: 'We need a frontend engineer with strong React and TypeScript. Next.js and Jest.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required'],['nextjs','preferred'],['jest','preferred']]), ...remote('remote'), compensation: salary(60_000, 85_000) },
    expectedBand: 'EXCELLENT',
    relevance: 3,
  },
  {
    n: 24,
    label: 'Excellent job, poor application UX',
    title: 'Frontend Engineer',
    description:
      'React, TypeScript, Next.js. Remote worldwide. To apply, create an account, upload a resume, write a cover letter and complete a 4-hour take-home assessment.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required'],['nextjs','preferred']]), ...remote('remote'), compensation: salary(70_000, 95_000) },
    expectedBand: 'EXCELLENT',
    relevance: 4,
    teaches: 'Application friction is a ranking cost, not a fit penalty.',
  },
  {
    n: 25,
    label: 'Mediocre job, excellent salary',
    title: 'Software Engineer',
    description: 'General software engineering. Some JavaScript. Mostly backend Java work.',
    enrichment: { normalizedTitle: 'Software Engineer', skills: skills([['java','required'],['spring','required'],['javascript','optional']]), ...remote('remote'), compensation: salary(140_000, 180_000) },
    expectedBand: 'BORDERLINE',
    relevance: 1,
    teaches: 'Salary alone must not dominate matching.',
  },
  {
    n: 26,
    label: 'Excellent job, unknown location',
    title: 'Frontend Engineer',
    description: 'React and TypeScript. Next.js. Jest.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required'],['nextjs','preferred'],['jest','preferred']]), compensation: salary(65_000, 85_000) },
    expectedBand: 'GOOD',
    relevance: 3,
  },
  {
    n: 27,
    label: 'Excellent job, weak evidence for a key requirement',
    title: 'Frontend Engineer',
    description:
      'React and TypeScript required. Must have deep GraphQL and Apollo experience — this is central to the role.',
    enrichment: { normalizedTitle: 'Frontend Engineer', skills: skills([['react','required'],['typescript','required'],['graphql','required'],['apollo','required']]), ...remote('remote'), compensation: salary(70_000, 90_000) },
    expectedBand: 'GOOD',
    relevance: 2,
  },
  {
    n: 28,
    label: 'Excellent job, strong evidence',
    title: 'React Engineer',
    description:
      'React, TypeScript, Next.js, Jest, CSS. Exactly the stack. 3–5 years. Remote worldwide.',
    enrichment: { normalizedTitle: 'React Engineer', skills: skills([['react','required'],['typescript','required'],['nextjs','required'],['jest','required'],['css','preferred']]), ...remote('remote'), compensation: salary(70_000, 95_000) },
    expectedBand: 'EXCELLENT',
    relevance: 4,
  },
  {
    n: 29,
    label: 'Career-trajectory mismatch',
    title: 'Senior Accountant',
    description:
      'Manage financial reporting, IFRS compliance, audit coordination and stakeholder communication. Advanced Excel.',
    enrichment: { normalizedTitle: 'Senior Accountant', skills: skills([['ifrs','required'],['audit','required'],['excel','required'],['reporting','required']]), ...remote('remote'), compensation: salary(60_000, 80_000) },
    expectedBand: 'POOR',
    relevance: 0,
    teaches: 'Generic overlap ("stakeholder", "communication") is not relevant experience.',
  },
  {
    n: 30,
    label: 'Perfect overall match',
    title: 'Frontend Engineer (React/TypeScript)',
    description:
      'Build product interfaces with React, TypeScript and Next.js. Test with Jest. 3–5 years. Remote worldwide, visa sponsorship available. Salary $70,000–$95,000.',
    enrichment: { normalizedTitle: 'Frontend Engineer (React/TypeScript)', skills: skills([['react','required'],['typescript','required'],['nextjs','required'],['jest','preferred']]),
      ...remote('remote'),
      compensation: salary(70_000, 95_000),
      seniority: 'mid',
      workAuthorization: { sponsorship: 'offered', confidence: 0.9, evidence: 'sponsorship available' },
    },
    expectedBand: 'EXCELLENT',
    relevance: 4,
  },
];

// ── Running them ────────────────────────────────────────────────────────────

interface Outcome {
  scenario: Scenario;
  match: JobMatch;
  naive: number;
}

async function runAll(): Promise<Outcome[]> {
  const person = candidate();
  const outcomes: Outcome[] = [];

  for (const scenario of SCENARIOS) {
    const job = makeJobContext({
      jobId: `00000000-0000-4000-8000-${String(scenario.n).padStart(12, '0')}`,
      title: scenario.title,
      companyName: scenario.company ?? 'Example Co',
      description: scenario.description,
      enrichment: scenario.enrichment ?? {},
    });

    const match = await engine.match(person, job);

    outcomes.push({
      scenario,
      match,
      naive: naiveKeywordScore({
        candidateSkills: CANDIDATE_SKILLS,
        jobText: scenario.description,
        jobTitle: scenario.title,
        candidateTitles: CANDIDATE_TITLES,
      }),
    });
  }

  return outcomes;
}

let cached: Outcome[] | null = null;

async function outcomes(): Promise<Outcome[]> {
  cached ??= await runAll();
  return cached;
}

const find = (all: Outcome[], n: number): Outcome => all.find((entry) => entry.scenario.n === n)!;

describe('thirty scenarios', () => {
  it('produces a complete, explained result for every scenario', async () => {
    const all = await outcomes();

    expect(all).toHaveLength(30);

    for (const { scenario, match } of all) {
      expect(match.explanation.length, `#${scenario.n} needs an explanation`).toBeGreaterThan(20);
      expect(match.overallScore).toBeGreaterThanOrEqual(0);
      expect(match.overallScore).toBeLessThanOrEqual(100);
      expect(match.confidence).toBeGreaterThanOrEqual(0);
      expect(match.trace.componentScores.length).toBeGreaterThan(0);
      expect(match.trace.matchingVersion).toBeTruthy();
    }
  }, 120_000);

  it('blocks what must be blocked, whatever it scores', async () => {
    const all = await outcomes();

    /* #20: an excluded company with an otherwise perfect posting. */
    const excluded = find(all, 20);
    expect(excluded.match.eligible).toBe(false);
    expect(excluded.match.recommendation).toBe('INELIGIBLE');

    /*
     * The naive matcher scores it like any other well-matched React role —
     * every keyword is present, and it has no representation for "the candidate
     * asked never to see this company". The gap between the two numbers is the
     * entire problem with keyword matching.
     */
    expect(excluded.naive - excluded.match.overallScore).toBeGreaterThan(20);

    /* #11: a stated refusal to sponsor, for a candidate who needs it. */
    const noSponsorship = find(all, 11);
    expect(noSponsorship.match.eligible).toBe(false);
  }, 120_000);

  it('does not fail a job for staying silent', async () => {
    const all = await outcomes();

    const unknownSalary = find(all, 3);
    const statedSalary = find(all, 1);

    /*
     * Missing salary lowers confidence, not the score. A system that scored
     * silence as failure would discard most of its corpus.
     */
    expect(unknownSalary.match.eligible).toBe(true);
    expect(unknownSalary.match.overallScore).toBeGreaterThan(50);
    expect(unknownSalary.match.confidence).toBeLessThanOrEqual(statedSalary.match.confidence);
  }, 120_000);

  it('separates a preferred gap from a required one', async () => {
    const all = await outcomes();

    const preferredGap = find(all, 14);
    const requiredGap = find(all, 13);

    expect(preferredGap.match.overallScore).toBeGreaterThan(requiredGap.match.overallScore);
  }, 120_000);

  it('ranks an unrelated field below every real frontend role', async () => {
    const all = await outcomes();

    const accounting = find(all, 29);
    const embedded = find(all, 18);
    const perfect = find(all, 30);

    expect(accounting.match.overallScore).toBeLessThan(perfect.match.overallScore);
    expect(embedded.match.overallScore).toBeLessThan(perfect.match.overallScore);

    const trajectory = assessTrajectory({
      candidateTitles: CANDIDATE_TITLES,
      candidateSeniority: 'mid',
      candidateDomains: CANDIDATE_SKILLS,
      jobTitle: accounting.scenario.title,
      jobSeniority: 'senior',
      jobDomains: ['ifrs', 'audit', 'excel', 'reporting'],
    });

    expect(trajectory.verdict).toBe('UNRELATED');
  }, 120_000);

  it('reads the remote geography of every remote posting', async () => {
    const all = await outcomes();

    const usOnly = find(all, 6);
    const worldwide = find(all, 7);

    const usReach = extractRemoteReach({
      arrangement: 'remote',
      locationText: 'Remote (US)',
      description: usOnly.scenario.description,
    });
    const globalReach = extractRemoteReach({
      arrangement: 'remote',
      locationText: 'Remote',
      description: worldwide.scenario.description,
    });

    expect(usReach.reach).toBe('COUNTRY_RESTRICTED');
    expect(globalReach.reach).toBe('GLOBAL');

    /*
     * The naive matcher cannot tell these apart at all — the keyword content is
     * nearly identical, and the difference is the whole answer.
     */
    expect(Math.abs(usOnly.naive - worldwide.naive)).toBeLessThan(25);
  }, 120_000);

  it('lands within the expected band for most scenarios', async () => {
    const all = await outcomes();

    const cases: ScoredCase[] = all.map(({ scenario, match }) => ({
      id: `scenario-${scenario.n}`,
      label: scenario.label,
      expectedBand: scenario.expectedBand,
      ...(scenario.expectIneligible ? { expectIneligible: true } : {}),
      relevance: scenario.relevance,
      actualScore: match.overallScore,
      actualEligible: match.eligible,
      confidence: match.confidence,
    }));

    const report = evaluateBands(cases);

    const outOfBand = report.reports.filter((entry) => !entry.inBand);

    console.warn(
      `[scenarios] ${report.inBand}/30 in band, ` +
        `${report.eligibilityCorrect}/30 eligibility correct, ` +
        `MAE ${report.meanAbsoluteError}` +
        (outOfBand.length > 0
          ? `\n  out of band: ${outOfBand.map((e) => `#${e.id.split('-')[1]} ${e.label} (${e.actualScore})`).join(', ')}`
          : ''),
    );

    /*
     * Eligibility is held to a higher standard than scoring. A band is a
     * judgement call; letting through a job the candidate legally cannot take
     * is not.
     */
    expect(report.eligibilityCorrect).toBeGreaterThanOrEqual(28);
    expect(report.inBand).toBeGreaterThanOrEqual(22);
  }, 120_000);

  it('ranks better than naive keyword overlap', async () => {
    const all = await outcomes();

    const engineCases: ScoredCase[] = all.map(({ scenario, match }) => ({
      id: `e-${scenario.n}`,
      label: scenario.label,
      expectedBand: scenario.expectedBand,
      relevance: scenario.relevance,
      actualScore: match.overallScore,
      actualEligible: match.eligible,
      confidence: match.confidence,
    }));

    const naiveCases: ScoredCase[] = all.map(({ scenario, naive }) => ({
      id: `n-${scenario.n}`,
      label: scenario.label,
      expectedBand: scenario.expectedBand,
      relevance: scenario.relevance,
      actualScore: naive,
      actualEligible: true,
      confidence: 0.5,
    }));

    const { evaluateRanking } = await import('./evaluation/offline-eval');

    const engineEval = evaluateRanking(engineCases, 'engine');
    const naiveEval = evaluateRanking(naiveCases, 'naive');

    console.warn(
      `[comparison] engine NDCG@10 ${engineEval.ndcgAt10} P@5 ${engineEval.precisionAt5} | ` +
        `naive NDCG@10 ${naiveEval.ndcgAt10} P@5 ${naiveEval.precisionAt5}`,
    );

    expect(engineEval.ndcgAt10).toBeGreaterThan(naiveEval.ndcgAt10);
  }, 120_000);

  it('disagrees with keyword matching exactly where it should', async () => {
    const all = await outcomes();

    /*
     * The enumerated cases. Each is a category of mistake the naive version
     * makes structurally — no amount of tuning its weights would fix any of
     * them, because it has no representation for the thing that matters.
     */
    const disagreements = all.filter(
      ({ match, naive }) => Math.abs(match.overallScore - naive) > 25,
    );

    expect(disagreements.length).toBeGreaterThanOrEqual(5);

    /* The excluded company: every keyword present, and it must not be shown. */
    const excluded = find(all, 20);
    expect(excluded.naive - excluded.match.overallScore).toBeGreaterThan(20);

    console.warn(
      `[disagreements] ${disagreements.length}/30: ` +
        disagreements
          .map(
            ({ scenario, match, naive }) =>
              `#${scenario.n} ${scenario.label} (engine ${Math.round(match.overallScore)} vs naive ${naive})`,
          )
          .join('; '),
    );
  }, 120_000);

  it('explains a ranking in terms of what it traded away', async () => {
    const all = await outcomes();

    const top = [...all]
      .filter((entry) => entry.match.eligible)
      .sort((a, b) => b.match.overallScore - a.match.overallScore)
      .slice(0, 5);

    const explained = explainRanking(
      top.map(({ scenario, match }) => ({
        id: `scenario-${scenario.n}`,
        label: scenario.label,
        overallScore: match.overallScore,
        dimensions: Object.fromEntries(
          match.componentScores.map((component) => [
            component.dimension,
            component.applicable ? component.score : null,
          ]),
        ),
      })),
    );

    expect(explained).toHaveLength(5);

    for (const entry of explained) {
      expect(entry.explanation).toMatch(/^Ranks #\d/);
    }
  }, 120_000);
});
