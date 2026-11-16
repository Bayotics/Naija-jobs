import { describe, expect, it } from 'vitest';
import {
  candidateProfilePatchSchema,
  candidateProfilePayloadSchema,
  cronExpressionSchema,
  jobSourceSchema,
  normalizedJobSchema,
  timezoneSchema,
} from './index';
import { makeCandidateProfile, makeJobSource, makeNormalizedJob } from './factories/index';

describe('candidate profile validation', () => {
  it('fills every section with defaults from a minimal identity', () => {
    const profile = candidateProfilePayloadSchema.parse({
      identity: { fullName: 'A Person', email: 'a@example.com' },
    });
    expect(profile.preferences.location.countries).toEqual([]);
    expect(profile.exclusions.companies).toEqual([]);
    expect(profile.custom).toEqual({});
    expect(profile.schemaVersion).toBe(1);
  });

  it('rejects an invalid email rather than storing it', () => {
    expect(() =>
      candidateProfilePayloadSchema.parse({ identity: { fullName: 'X', email: 'nope' } }),
    ).toThrow();
  });

  it('normalises country and currency codes to upper case', () => {
    const profile = candidateProfilePayloadSchema.parse({
      identity: { fullName: 'X', email: 'x@example.com' },
      preferences: {
        location: { countries: ['de', 'nl'] },
        salary: { currency: 'eur' },
      },
    });
    expect(profile.preferences.location.countries).toEqual(['DE', 'NL']);
    expect(profile.preferences.salary.currency).toBe('EUR');
  });

  it('accepts arbitrary future preferences through the extensibility hatch', () => {
    // A preference the schema does not model yet must still round-trip, so it
    // can be introduced from the UI before it is formally added.
    const profile = candidateProfilePayloadSchema.parse({
      identity: { fullName: 'X', email: 'x@example.com' },
      custom: { fourDayWeekOnly: true, maxCommuteMinutes: 30 },
    });
    expect(profile.custom.fourDayWeekOnly).toBe(true);
  });

  it('requires a patch to change at least one section', () => {
    expect(() => candidateProfilePatchSchema.parse({})).toThrow();
    expect(() =>
      candidateProfilePatchSchema.parse({ preferences: { salary: { minimum: 90_000 } } }),
    ).not.toThrow();
  });

  it('validates an IANA timezone against the host database', () => {
    expect(() => timezoneSchema.parse('Africa/Lagos')).not.toThrow();
    expect(() => timezoneSchema.parse('Mars/Olympus_Mons')).toThrow();
  });
});

describe('job validation', () => {
  it('defaults unknown fields to null rather than guessing', () => {
    const job = normalizedJobSchema.parse({
      title: 'Engineer',
      company: { name: 'Acme' },
      sourceUrl: 'https://example.com/job/1',
    });
    // "Not stated" must be distinguishable from "no".
    expect(job.salary.normalizedAnnualUsd).toBeNull();
    expect(job.seniority).toBeNull();
    expect(job.visaSponsorship).toBe('unknown');
    expect(job.remoteType).toBe('unknown');
  });

  it('rejects a salary range whose minimum exceeds its maximum', () => {
    expect(() =>
      normalizedJobSchema.parse({
        title: 'Engineer',
        company: { name: 'Acme' },
        sourceUrl: 'https://example.com/1',
        salary: { min: 90_000, max: 50_000 },
      }),
    ).toThrow();
  });

  it('requires a valid source URL', () => {
    expect(() =>
      normalizedJobSchema.parse({ title: 'E', company: { name: 'A' }, sourceUrl: 'nope' }),
    ).toThrow();
  });
});

describe('source validation', () => {
  it('applies safe operational defaults', () => {
    const source = jobSourceSchema.parse({
      id: 's',
      connectorId: 'c',
      displayName: 'S',
      sourceType: 'job_api',
      accessTier: 'official_api',
    });
    expect(source.enabled).toBe(true);
    expect(source.scheduleCron).toBe('0 * * * *');
    expect(source.limits.requestsPerMinute).toBeGreaterThan(0);
    expect(source.credentialRefs).toEqual([]);
  });

  it('rejects a malformed cron expression', () => {
    expect(() => cronExpressionSchema.parse('* * *')).toThrow();
    expect(() => cronExpressionSchema.parse('*/15 * * * *')).not.toThrow();
  });

  it('rejects an unknown access tier', () => {
    expect(() =>
      jobSourceSchema.parse({
        id: 's',
        connectorId: 'c',
        displayName: 'S',
        sourceType: 'job_api',
        accessTier: 'scrape_everything',
      }),
    ).toThrow();
  });
});

describe('test factories', () => {
  it('produce values that satisfy the production schemas', () => {
    // Guards against fixtures drifting into shapes the real validators reject.
    expect(() => candidateProfilePayloadSchema.parse(makeCandidateProfile())).not.toThrow();
    expect(() => normalizedJobSchema.parse(makeNormalizedJob())).not.toThrow();
    expect(() => jobSourceSchema.parse(makeJobSource())).not.toThrow();
  });

  it('deep-merge overrides without dropping sibling defaults', () => {
    const profile = makeCandidateProfile({
      preferences: { salary: { minimum: 80_000 } },
    });
    expect(profile.preferences.salary.minimum).toBe(80_000);
    expect(profile.preferences.salary.currency).toBe('USD');
    expect(profile.identity.email).toContain('@');
  });
});
