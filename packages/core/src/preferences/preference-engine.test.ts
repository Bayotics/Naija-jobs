import { describe, expect, it } from 'vitest';
import { makeCandidateProfile, makeNormalizedJob } from '@job-intel/contracts/factories';
import { PreferenceEngine } from './preference-engine';

/**
 * The requirement this file exists to prove:
 *
 *   "I must be able to change Remote → On-site, Germany → Netherlands,
 *    React → Vue, the minimum salary, and the visa requirement, WITHOUT
 *    changing application source code."
 *
 * Every test below changes only *data* — the profile payload — and asserts the
 * matching outcome flips. No branch in this suite is keyed to a hardcoded
 * country, technology or salary figure.
 */
describe('PreferenceEngine — preferences are data, not code', () => {
  const berlinOnsiteJob = makeNormalizedJob({
    title: 'Backend Engineer',
    remoteType: 'onsite',
    location: { raw: 'Berlin, Germany', city: 'Berlin', countryCode: 'DE' },
    techStack: ['react', 'typescript'],
    salary: { normalizedAnnualUsd: 75_000, currency: 'USD', period: 'year' },
    visaSponsorship: 'not_offered',
    employmentTypes: ['full_time'],
    seniority: 'mid',
  });

  it('flips remote → onsite by changing only the profile', () => {
    const remoteOnly = makeCandidateProfile({
      preferences: { location: { remoteTypes: ['remote'] } },
    });
    expect(new PreferenceEngine(remoteOnly).evaluate(berlinOnsiteJob).passed).toBe(false);

    const onsiteOk = makeCandidateProfile({
      preferences: { location: { remoteTypes: ['onsite'] } },
    });
    expect(new PreferenceEngine(onsiteOk).evaluate(berlinOnsiteJob).passed).toBe(true);
  });

  it('flips Germany → Netherlands by changing only the profile', () => {
    const wantsNl = makeCandidateProfile({
      preferences: { location: { countries: ['NL'], remoteTypes: ['onsite'] } },
    });
    const nlResult = new PreferenceEngine(wantsNl).evaluate(berlinOnsiteJob);
    expect(nlResult.passed).toBe(false);
    expect(nlResult.checks.find((c) => c.constraint === 'country')?.detail).toContain('DE');

    const wantsDe = makeCandidateProfile({
      preferences: { location: { countries: ['DE'], remoteTypes: ['onsite'] } },
    });
    expect(new PreferenceEngine(wantsDe).evaluate(berlinOnsiteJob).passed).toBe(true);
  });

  it('flips React → Vue by changing only the exclusion list', () => {
    const excludesVue = makeCandidateProfile({
      preferences: { location: { remoteTypes: ['onsite'] } },
      exclusions: { technologies: ['vue'] },
    });
    expect(new PreferenceEngine(excludesVue).evaluate(berlinOnsiteJob).passed).toBe(true);

    const excludesReact = makeCandidateProfile({
      preferences: { location: { remoteTypes: ['onsite'] } },
      exclusions: { technologies: ['react'] },
    });
    const result = new PreferenceEngine(excludesReact).evaluate(berlinOnsiteJob);
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.constraint === 'excluded_technologies')?.detail).toContain(
      'react',
    );
  });

  it('raises the salary floor by changing only the profile', () => {
    const floor70k = makeCandidateProfile({
      preferences: { location: { remoteTypes: ['onsite'] }, salary: { minimum: 70_000 } },
    });
    expect(new PreferenceEngine(floor70k).evaluate(berlinOnsiteJob).passed).toBe(true);

    const floor90k = makeCandidateProfile({
      preferences: { location: { remoteTypes: ['onsite'] }, salary: { minimum: 90_000 } },
    });
    expect(new PreferenceEngine(floor90k).evaluate(berlinOnsiteJob).passed).toBe(false);
  });

  it('toggles the visa sponsorship requirement by changing only the profile', () => {
    const notNeeded = makeCandidateProfile({
      preferences: { location: { remoteTypes: ['onsite'] }, visaSponsorship: 'not_needed' },
    });
    expect(new PreferenceEngine(notNeeded).evaluate(berlinOnsiteJob).passed).toBe(true);

    const required = makeCandidateProfile({
      preferences: { location: { remoteTypes: ['onsite'] }, visaSponsorship: 'required' },
    });
    const result = new PreferenceEngine(required).evaluate(berlinOnsiteJob);
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.constraint === 'visa_sponsorship')?.detail).toContain(
      'does not offer',
    );
  });
});

describe('PreferenceEngine — semantics of absent data', () => {
  it('treats an empty preference list as "no constraint", not "match nothing"', () => {
    const empty = makeCandidateProfile();
    const job = makeNormalizedJob({
      remoteType: 'onsite',
      location: { countryCode: 'NG', city: 'Lagos' },
    });
    const result = new PreferenceEngine(empty).evaluate(job);

    expect(result.passed).toBe(true);
    // Every check should report as skipped rather than silently passing.
    expect(result.checks.every((c) => c.skipped || c.passed)).toBe(true);
    expect(result.checks.some((c) => c.skipped)).toBe(true);
  });

  it('does not reject a posting that omits salary, unless explicitly required', () => {
    const job = makeNormalizedJob({ salary: { normalizedAnnualUsd: null } });

    const lenient = makeCandidateProfile({
      preferences: { salary: { minimum: 100_000, requireStatedSalary: false } },
    });
    const lenientResult = new PreferenceEngine(lenient).evaluate(job);
    expect(lenientResult.passed).toBe(true);
    expect(lenientResult.checks.find((c) => c.constraint === 'salary_floor')?.skipped).toBe(true);

    const strict = makeCandidateProfile({
      preferences: { salary: { minimum: 100_000, requireStatedSalary: true } },
    });
    expect(new PreferenceEngine(strict).evaluate(job).passed).toBe(false);
  });

  it('passes unknown visa status when sponsorship is required', () => {
    // Most postings say nothing about sponsorship. Rejecting silence would
    // discard most of the corpus, so `unknown` must pass and be raised later
    // as a concern instead.
    const job = makeNormalizedJob({ visaSponsorship: 'unknown' });
    const profile = makeCandidateProfile({
      preferences: { visaSponsorship: 'required' },
    });
    const result = new PreferenceEngine(profile).evaluate(job);
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.constraint === 'visa_sponsorship')?.skipped).toBe(true);
  });

  it('ignores the country constraint for a fully remote role', () => {
    const job = makeNormalizedJob({
      remoteType: 'remote',
      location: { countryCode: 'NG' },
    });
    const profile = makeCandidateProfile({
      preferences: { location: { countries: ['DE'], remoteTypes: ['remote'] } },
    });
    expect(new PreferenceEngine(profile).evaluate(job).passed).toBe(true);
  });

  it('honours relocation countries only when willing to relocate', () => {
    const job = makeNormalizedJob({
      remoteType: 'onsite',
      location: { countryCode: 'NL' },
    });
    const notWilling = makeCandidateProfile({
      preferences: {
        location: { countries: ['DE'], relocationCountries: ['NL'], willingToRelocate: false },
      },
    });
    expect(new PreferenceEngine(notWilling).evaluate(job).passed).toBe(false);

    const willing = makeCandidateProfile({
      preferences: {
        location: { countries: ['DE'], relocationCountries: ['NL'], willingToRelocate: true },
      },
    });
    expect(new PreferenceEngine(willing).evaluate(job).passed).toBe(true);
  });
});

describe('PreferenceEngine — evaluation reporting', () => {
  it('reports every failing constraint, not just the first', () => {
    const job = makeNormalizedJob({
      title: 'Unpaid Sales Intern',
      remoteType: 'onsite',
      location: { countryCode: 'US' },
      company: { name: 'Bad Corp' },
    });
    const profile = makeCandidateProfile({
      preferences: { location: { countries: ['DE'], remoteTypes: ['remote'] } },
      exclusions: { companies: ['Bad Corp'], titles: ['intern'] },
    });

    const result = new PreferenceEngine(profile).evaluate(job);
    const failed = result.checks.filter((c) => !c.passed).map((c) => c.constraint);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('hard_rule');
    expect(failed).toEqual(
      expect.arrayContaining(['excluded_companies', 'excluded_titles', 'remote_type', 'country']),
    );
  });

  it('scores zero when hard constraints fail, and in range otherwise', () => {
    const profile = makeCandidateProfile({
      preferences: { desiredTitles: ['Backend Engineer'] },
      professional: { technologies: ['typescript'] },
    });
    const good = makeNormalizedJob({ title: 'Backend Engineer', techStack: ['typescript'] });
    const bad = makeNormalizedJob({ title: 'Backend Engineer', company: { name: 'Nope Inc' } });

    const goodScore = new PreferenceEngine(profile).evaluate(good).score;
    expect(goodScore).toBeGreaterThan(0);
    expect(goodScore).toBeLessThanOrEqual(100);

    const excluded = makeCandidateProfile({ exclusions: { companies: ['Nope Inc'] } });
    expect(new PreferenceEngine(excluded).evaluate(bad).score).toBe(0);
  });

  it('exposes a per-signal score breakdown for the UI', () => {
    const profile = makeCandidateProfile({ preferences: { desiredTitles: ['Backend Engineer'] } });
    const breakdown = new PreferenceEngine(profile).explainScore(
      makeNormalizedJob({ title: 'Backend Engineer' }),
    );

    expect(breakdown.length).toBeGreaterThan(0);
    expect(breakdown.every((s) => s.value >= 0 && s.value <= 1)).toBe(true);
    expect(breakdown.find((s) => s.id === 'title_match')?.value).toBe(1);
  });
});
