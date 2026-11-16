import { describe, expect, it } from 'vitest';
import {
  ALL_FIXTURES,
  atsApplicationJob,
  conflictingSeniorityJob,
  hybridJob,
  internationalJob,
  longJob,
  multiCurrencyJobs,
  multiLocationJob,
  nigerianJob,
  normalJob,
  onsiteJob,
  remoteWorldwideJob,
  salaryMissingJob,
  salaryRangeJob,
  scamJob,
  socialPostJob,
  veryShortJob,
  visaNotOfferedJob,
  visaOfferedJob,
  visaUnspecifiedJob,
} from './testing/fixtures';
import { enrichJob } from './pipeline/enrichment-pipeline';
import { cleanJobDescription, segmentSections } from './cleaning/content-cleaner';
import { normalizeJobTitle } from './extractors/title';
import { extractExperience } from './extractors/experience';
import { detectSeniority } from './extractors/seniority';
import { extractCompensation } from './extractors/compensation';
import { extractWorkAuthorization } from './extractors/work-authorization';
import { detectAts, resolveApplicationTarget } from './extractors/application-url';
import type { AiExtractionProvider, AiExtractionResult } from './ai/extraction-provider';
import { shouldUseAi, validateAiExtraction, NullAiProvider } from './ai/extraction-provider';

describe('content cleaning', () => {
  it('removes site furniture without touching the job content', () => {
    const result = cleanJobDescription(longJob.description);
    expect(result.cleaned).not.toMatch(/We use cookies/i);
    expect(result.cleaned).not.toMatch(/All rights reserved/i);
    expect(result.cleaned).not.toMatch(/Similar jobs/i);
    // The actual requirements must survive.
    expect(result.cleaned).toMatch(/8 years of experience/i);
    expect(result.cleaned).toMatch(/PostgreSQL and Kafka/i);
    expect(result.removedChars).toBeGreaterThan(0);
  });

  it('reverts rather than gutting a description when rules over-match', () => {
    // A pathological posting where almost every line looks like navigation.
    // The safety valve must return the original rather than an empty husk.
    const hostile = Array.from({ length: 200 }, () => 'Home').join('\n');
    const result = cleanJobDescription(hostile);
    expect(result.removedBlocks).toContain('cleaning_reverted_excessive_removal');
    expect(result.cleaned.length).toBeGreaterThan(hostile.length * 0.4);
  });

  it('separates requirements from nice-to-haves', () => {
    const sections = segmentSections(cleanJobDescription(normalJob.description).cleaned);
    expect(sections.requirements.join(' ')).toMatch(/5\+ years/);
    expect(sections.preferredQualifications.join(' ')).toMatch(/Next\.js/);
    // "Nice to have" must not leak into hard requirements.
    expect(sections.requirements.join(' ')).not.toMatch(/Next\.js/);
    expect(sections.responsibilities.length).toBeGreaterThan(0);
    expect(sections.benefits.join(' ')).toMatch(/holiday|equity/i);
  });
});

describe('title normalization', () => {
  it('collapses phrasings of the same role onto one slug', () => {
    const variants = [
      'Frontend Engineer',
      'Front-End Engineer',
      'Frontend Developer',
      'Software Engineer, Frontend',
      'Senior Front End Developer (m/w/d)',
    ];
    const slugs = variants.map((t) => normalizeJobTitle(t).value.roleSlug);
    expect(new Set(slugs).size).toBe(1);
    expect(slugs[0]).toBe('frontend-engineer');
  });

  it('keeps genuinely different roles apart', () => {
    expect(normalizeJobTitle('Backend Engineer').value.roleSlug).not.toBe(
      normalizeJobTitle('Frontend Engineer').value.roleSlug,
    );
    expect(normalizeJobTitle('Data Scientist').value.roleSlug).toBe('data-scientist');
  });

  it('does not invent a role when nothing matches', () => {
    const result = normalizeJobTitle('Chief Happiness Officer');
    // Executive decoration is stripped; no discipline noun remains.
    expect(result.value.roleSlug).toBeNull();
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('experience extraction', () => {
  it.each([
    ['5+ years of professional experience', 5, null],
    ['at least 3 years experience', 3, null],
    ['2-4 years of experience', 2, 4],
    ['minimum of 7 years experience', 7, null],
    ['up to 3 years of experience', null, 3],
    ['three years of experience', 3, null],
  ])('parses %s', (text, min, max) => {
    const result = extractExperience(text);
    expect(result.minimumYears).toBe(min);
    expect(result.maximumYears).toBe(max);
  });

  it('does not read unrelated numbers as experience', () => {
    expect(extractExperience('2 days in office per week').minimumYears).toBeNull();
    expect(extractExperience('founded in 2015').minimumYears).toBeNull();
  });

  it('flags qualitative phrasing instead of inventing a number', () => {
    const result = extractExperience('Strong professional experience in distributed systems');
    expect(result.minimumYears).toBeNull();
    expect(result.qualitativeOnly).toBe(true);
  });
});

describe('seniority with conflicting signals', () => {
  it('keeps the title but drops confidence when experience disagrees', () => {
    const result = detectSeniority({
      title: 'Senior Software Engineer',
      description: 'Requirements: 1 year of experience.',
      experience: { minimumYears: 1, maximumYears: null, confidence: 0.9, method: 'pattern', rawText: '1 year', qualitativeOnly: false },
    });
    expect(result.value).toBe('senior');
    // The whole point: not confidently senior.
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.conflict).toMatch(/1 year/);
  });

  it('raises confidence when experience corroborates the title', () => {
    const result = detectSeniority({
      title: 'Senior Software Engineer',
      description: '',
      experience: { minimumYears: 6, maximumYears: null, confidence: 0.9, method: 'pattern', rawText: '6 years', qualitativeOnly: false },
    });
    expect(result.value).toBe('senior');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.conflict).toBeNull();
  });

  it('returns null rather than guessing when there is no signal', () => {
    const result = detectSeniority({ title: 'Engineer', description: 'Build things.' });
    expect(result.value).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

describe('compensation', () => {
  it('parses a plain annual range', () => {
    const comp = extractCompensation({
      salaryText: '$120,000 - $150,000 per year',
      salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null,
      title: 'Engineer', description: null,
    });
    expect(comp.stated).toBe(true);
    expect(comp.minimum).toBe(120_000);
    expect(comp.maximum).toBe(150_000);
    expect(comp.currency).toBe('USD');
    expect(comp.period).toBe('year');
  });

  it.each([
    ['£500/day', 'GBP', 'day', 500],
    ['N300,000 monthly', 'NGN', 'month', 300_000],
    ['€70,000–€90,000 per year', 'EUR', 'year', 70_000],
  ])('parses %s', (text, currency, period, min) => {
    const comp = extractCompensation({
      salaryText: text, salaryMin: null, salaryMax: null, salaryCurrency: null,
      salaryPeriod: null, title: 'Role', description: null,
    });
    expect(comp.currency).toBe(currency);
    expect(comp.period).toBe(period);
    expect(comp.minimum).toBe(min);
  });

  it('never invents a figure from "competitive salary"', () => {
    const comp = extractCompensation({
      salaryText: null, salaryMin: null, salaryMax: null, salaryCurrency: null,
      salaryPeriod: null, title: 'PM',
      description: 'We offer a competitive salary commensurate with experience.',
    });
    expect(comp.stated).toBe(false);
    expect(comp.minimum).toBeNull();
    expect(comp.maximum).toBeNull();
    // Confident that nothing was stated, which is itself information.
    expect(comp.confidence).toBeGreaterThan(0.8);
  });

  it('records the rate, source and timestamp for every conversion', () => {
    const comp = extractCompensation({
      salaryText: '€80,000 per year', salaryMin: null, salaryMax: null,
      salaryCurrency: null, salaryPeriod: null, title: 'Engineer', description: null,
    });
    expect(comp.conversion).not.toBeNull();
    expect(comp.conversion?.rate).toBeGreaterThan(0);
    expect(comp.conversion?.rateSource).toBeTruthy();
    expect(comp.conversion?.rateTimestamp).toBeInstanceOf(Date);
    // The original is preserved untouched.
    expect(comp.currency).toBe('EUR');
    expect(comp.minimum).toBe(80_000);
  });

  it('does not convert when no rate is available', () => {
    const comp = extractCompensation(
      { salaryText: '$100,000', salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, title: 'X', description: null },
      null,
    );
    expect(comp.conversion).toBeNull();
    expect(comp.minimum).toBe(100_000);
  });

  it('flags an inferred period rather than presenting it as stated', () => {
    const comp = extractCompensation({
      salaryText: null, salaryMin: 90_000, salaryMax: null, salaryCurrency: 'USD',
      salaryPeriod: null, title: 'X', description: null,
    });
    expect(comp.conversion?.periodInferred).toBe(true);
  });
});

describe('work authorization', () => {
  it('distinguishes all four sponsorship states', () => {
    expect(extractWorkAuthorization({ description: visaOfferedJob.description }).sponsorship).toBe('offered');
    expect(extractWorkAuthorization({ description: visaNotOfferedJob.description }).sponsorship).toBe('not_offered');
    expect(extractWorkAuthorization({ description: visaUnspecifiedJob.description }).sponsorship).toBe('not_mentioned');
    expect(
      extractWorkAuthorization({ description: 'Sponsorship may be available for exceptional candidates.' }).sponsorship,
    ).toBe('unclear');
  });

  it('never reads silence as refusal', () => {
    const result = extractWorkAuthorization({ description: 'Great role at a global company with offices worldwide.' });
    expect(result.sponsorship).toBe('not_mentioned');
    expect(result.sponsorship).not.toBe('not_offered');
  });

  it('does not let "cannot offer sponsorship" match as positive', () => {
    const result = extractWorkAuthorization({
      description: 'Unfortunately we cannot offer visa sponsorship for this position.',
    });
    expect(result.sponsorship).toBe('not_offered');
  });

  it('extracts clearance and citizenship requirements', () => {
    const result = extractWorkAuthorization({ description: visaNotOfferedJob.description });
    expect(result.citizenshipRequired).toBe(true);
    expect(result.securityClearanceRequired).toBe(true);
    expect(result.securityClearanceLevel).toMatch(/secret/i);
  });
});

describe('application URL resolution', () => {
  it('recognises ATS vendors', () => {
    expect(detectAts('https://boards.greenhouse.io/acme/jobs/1')?.vendor).toBe('greenhouse');
    expect(detectAts('https://jobs.lever.co/finco/abc')?.vendor).toBe('lever');
    expect(detectAts('https://acme.myworkdayjobs.com/en-US/careers')?.vendor).toBe('workday');
    expect(detectAts('https://example.com/jobs/1')).toBeNull();
  });

  it('prefers a direct ATS link over the board listing', () => {
    const target = resolveApplicationTarget({
      sourceUrl: 'https://remotive.com/remote-jobs/devops/platform-engineer-12345',
      applyUrl: 'https://boards.greenhouse.io/widgets/jobs/4567',
      companyName: 'Widgets Inc',
    });
    expect(target.applicationUrl).toContain('greenhouse.io');
    expect(target.atsVendor).toBe('greenhouse');
    expect(target.kind).toBe('ats_direct');
  });

  it('lowers confidence when the ATS slug does not match the company', () => {
    const matching = resolveApplicationTarget({
      sourceUrl: 'https://boards.greenhouse.io/widgets/jobs/1',
      companyName: 'Widgets Inc',
    });
    const mismatched = resolveApplicationTarget({
      sourceUrl: 'https://boards.greenhouse.io/totallyunrelated/jobs/1',
      companyName: 'Widgets Inc',
    });
    expect(mismatched.confidence).toBeLessThan(matching.confidence);
  });
});

describe('AI strategy', () => {
  const failingProvider: AiExtractionProvider = {
    id: 'failing',
    isAvailable: () => true,
    extract: () => Promise.reject(new Error('provider exploded')),
  };

  const malformedProvider: AiExtractionProvider = {
    id: 'malformed',
    isAvailable: () => true,
    extract: () =>
      Promise.resolve({
        extraction: { seniority: 'wizard', confidence: 5 },
        usage: { model: 'test', inputTokens: 1, outputTokens: 1, costUsd: 0 },
      } as unknown as AiExtractionResult),
  };

  it('skips the model when deterministic extraction already resolved things', () => {
    const decision = shouldUseAi(
      { descriptionLength: 5000, ambiguousFields: ['skills'], callsMade: 0 },
      { enabled: true, minDescriptionLength: 400, minAmbiguousFields: 2, maxCallsPerRun: 10 },
      { id: 'x', isAvailable: () => true, extract: () => Promise.reject(new Error('unused')) },
    );
    expect(decision.use).toBe(false);
  });

  it('skips the model for descriptions too short to help', () => {
    const decision = shouldUseAi(
      { descriptionLength: 50, ambiguousFields: ['seniority', 'skills', 'work_mode'], callsMade: 0 },
      { enabled: true, minDescriptionLength: 400, minAmbiguousFields: 2, maxCallsPerRun: 10 },
      { id: 'x', isAvailable: () => true, extract: () => Promise.reject(new Error('unused')) },
    );
    expect(decision.use).toBe(false);
  });

  it('respects the per-run call budget', () => {
    const decision = shouldUseAi(
      { descriptionLength: 5000, ambiguousFields: ['a', 'b', 'c'], callsMade: 10 },
      { enabled: true, minDescriptionLength: 400, minAmbiguousFields: 2, maxCallsPerRun: 10 },
      { id: 'x', isAvailable: () => true, extract: () => Promise.reject(new Error('unused')) },
    );
    expect(decision.use).toBe(false);
    expect(decision.reason).toMatch(/budget/);
  });

  it('rejects malformed model output instead of coercing it', () => {
    const result = validateAiExtraction({ seniority: 'wizard', confidence: 5 });
    expect(result.ok).toBe(false);
  });

  it('degrades gracefully when the provider throws', async () => {
    const enriched = await enrichJob(veryShortJob, {
      aiProvider: failingProvider,
      aiGate: { enabled: true, minDescriptionLength: 0, minAmbiguousFields: 0, maxCallsPerRun: 5 },
    });
    // Deterministic extraction survived; the failure is recorded, not fatal.
    expect(enriched.aiUsed).toBe(false);
    expect(enriched.aiError).toMatch(/provider exploded/);
    expect(enriched.normalizedTitle).toBeTruthy();
  });

  it('discards schema-invalid model output', async () => {
    const enriched = await enrichJob(veryShortJob, {
      aiProvider: malformedProvider,
      aiGate: { enabled: true, minDescriptionLength: 0, minAmbiguousFields: 0, maxCallsPerRun: 5 },
    });
    expect(enriched.aiUsed).toBe(false);
    expect(enriched.aiError).toMatch(/schema validation failed/);
  });

  it('works with no provider at all', async () => {
    const enriched = await enrichJob(normalJob, { aiProvider: new NullAiProvider() });
    expect(enriched.aiUsed).toBe(false);
    expect(enriched.aiError).toBeNull();
    expect(enriched.skills.length).toBeGreaterThan(0);
  });
});

describe('full pipeline', () => {
  it('extracts structured fields from a well-formed posting', async () => {
    const e = await enrichJob(normalJob);

    expect(e.roleSlug).toBe('frontend-engineer');
    expect(e.seniority).toBe('senior');
    expect(e.experience.minimumYears).toBe(5);
    expect(e.location.countryCode).toBe('DE');
    expect(e.location.city).toBe('Berlin');
    expect(e.education.level).toBe('bachelors');
    expect(e.classification.jobFunction).toBe('software_engineering');
    expect(e.workAuthorization.relocationSupport).toBe('offered');

    const react = e.skills.find((s) => s.slug === 'react');
    expect(react?.requirement).toBe('required');
    const nextjs = e.skills.find((s) => s.slug === 'nextjs');
    expect(nextjs?.requirement).toBe('optional');
  });

  it('separates required, preferred and inferred skills', async () => {
    const e = await enrichJob(internationalJob);
    const byRequirement = (slug: string) => e.skills.find((s) => s.slug === slug)?.requirement;
    expect(byRequirement('kubernetes')).toBe('required');
    expect(byRequirement('terraform')).toBe('required');
    expect(byRequirement('go')).toBe('optional');
  });

  it('infers skills from contextual phrases', async () => {
    const e = await enrichJob(socialPostJob);
    const react = e.skills.find((s) => s.slug === 'react');
    expect(react).toBeDefined();
    // "modern React ecosystem" implies TypeScript, but only as inferred.
    const ts = e.skills.find((s) => s.slug === 'typescript');
    expect(ts?.requirement).toBe('inferred');
  });

  it('preserves remote scope rather than collapsing it to "remote"', async () => {
    const worldwide = await enrichJob(remoteWorldwideJob);
    expect(worldwide.workArrangement.mode).toBe('remote');
    expect(worldwide.workArrangement.remoteWorldwide).toBe(true);

    const restricted = await enrichJob(socialPostJob);
    expect(restricted.workArrangement.remoteRegions).toContain('US');
    expect(restricted.workArrangement.remoteWorldwide).toBe(false);
  });

  it('captures hybrid office cadence', async () => {
    const e = await enrichJob(hybridJob);
    expect(e.workArrangement.mode).toBe('hybrid');
    expect(e.workArrangement.officeDaysPerWeek).toBe(2);
  });

  it('captures on-site geographic restrictions', async () => {
    const e = await enrichJob(onsiteJob);
    expect(e.workArrangement.mode).toBe('onsite');
    expect(e.workArrangement.geographicRestriction).toMatch(/commutable/i);
    expect(e.location.countryCode).toBe('NG');
  });

  it('reads an EU timezone constraint', async () => {
    const e = await enrichJob(internationalJob);
    expect(e.location.timezoneHint).toBe('CET');
    expect(e.workArrangement.remoteRegions).toContain('EU');
  });

  it('scores a scam posting without deleting it', async () => {
    const e = await enrichJob(scamJob);
    expect(e.quality.scamScore).toBeGreaterThan(0.8);
    const flags = e.quality.flags.map((f) => f.flag);
    expect(flags).toContain('payment_requested');
    expect(flags).toContain('personal_documents_requested');
    expect(flags).toContain('suspicious_contact_method');
    // Still a full record: flagged, never discarded.
    expect(e.normalizedTitle).toBeTruthy();
  });

  it('keeps quality and scam scores independent', async () => {
    const thin = await enrichJob(veryShortJob);
    expect(thin.quality.qualityScore).toBeLessThan(0.5);
    // A short posting is low quality but not fraudulent.
    expect(thin.quality.scamScore).toBe(0);
  });

  it('handles a Nigerian posting end to end', async () => {
    const e = await enrichJob(nigerianJob);
    expect(e.location.countryCode).toBe('NG');
    expect(e.experience.minimumYears).toBe(3);
    expect(e.education.level).toBe('bachelors');
    expect(e.skills.some((s) => s.slug === 'java')).toBe(true);
  });

  it('resolves the ATS application URL', async () => {
    const e = await enrichJob(atsApplicationJob);
    expect(e.applicationTarget.atsVendor).toBe('greenhouse');
    expect(e.applicationTarget.applicationUrl).toContain('greenhouse.io');
  });

  it('is deterministic and idempotent', async () => {
    const a = await enrichJob(normalJob);
    const b = await enrichJob(normalJob);
    // Timings differ; everything else must not.
    const strip = (e: typeof a) => ({ ...e, totalDurationMs: 0, stageReports: [] });
    expect(strip(a)).toEqual(strip(b));
  });

  it('never throws on any fixture, however malformed', async () => {
    for (const fixture of ALL_FIXTURES) {
      const e = await enrichJob(fixture);
      expect(e.enrichmentVersion).toBeGreaterThan(0);
      expect(e.normalizedTitle.length).toBeGreaterThan(0);
      expect(e.stageReports.length).toBeGreaterThan(5);
    }
  });

  it('survives null and empty inputs', async () => {
    const e = await enrichJob({
      jobId: 'x', title: 'Engineer', companyName: 'Co', companyWebsite: null,
      description: null, descriptionHtml: null, locationText: null, remoteFlag: null,
      sourceUrl: 'https://example.com/j', applyUrl: null, salaryText: null,
      salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, tags: [],
    });
    expect(e.workArrangement.mode).toBe('unknown');
    expect(e.compensation.stated).toBe(false);
    expect(e.workAuthorization.sponsorship).toBe('not_mentioned');
  });

  it('records a per-stage performance report', async () => {
    const e = await enrichJob(longJob);
    const stages = e.stageReports.map((s) => s.stage);
    expect(stages).toContain('content_cleaning');
    expect(stages).toContain('skill_extraction');
    expect(stages).toContain('quality_analysis');
    expect(e.stageReports.every((s) => s.ok)).toBe(true);
    expect(e.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles multi-location and salary-less postings without inventing data', async () => {
    const multi = await enrichJob(multiLocationJob);
    expect(multi.workArrangement.mode).toBe('remote');

    const noSalary = await enrichJob(salaryMissingJob);
    expect(noSalary.compensation.stated).toBe(false);
    expect(noSalary.compensation.conversion).toBeNull();

    const withSalary = await enrichJob(salaryRangeJob);
    expect(withSalary.compensation.stated).toBe(true);
    expect(withSalary.compensation.conversion?.annualUsd).toBe(150_000);
  });

  it('converts each currency fixture with an auditable rate', async () => {
    for (const fixture of multiCurrencyJobs) {
      const e = await enrichJob(fixture);
      expect(e.compensation.stated).toBe(true);
      expect(e.compensation.conversion?.rateSource).toBeTruthy();
    }
  });

  it('records the seniority conflict on the enrichment', async () => {
    const e = await enrichJob(conflictingSeniorityJob);
    expect(e.seniority).toBe('senior');
    expect(e.seniorityConflict).toBeTruthy();
    expect(e.seniorityConfidence).toBeLessThan(0.6);
  });
});
