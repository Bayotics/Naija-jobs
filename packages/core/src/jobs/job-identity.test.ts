import { describe, expect, it } from 'vitest';
import { makeNormalizedJob } from '@job-intel/contracts/factories';
import { JobIdentityService, canonicalJson, simhashDistance } from './job-identity';
import { normalizeCompanyName, normalizeTitle, normalizeUrl } from '../normalize/text';

/**
 * Job identity foundations.
 *
 * The scenario these exist for: the same opening arriving from LinkedIn,
 * Google, Reddit, X, Hot Nigerian Jobs and the company's own careers page.
 * The resolver in prompt 12 will decide the merges; these tests pin down the
 * signals it will block on.
 */
describe('normalizeCompanyName', () => {
  it('collapses legal suffixes and punctuation to one key', () => {
    const expected = 'acme';
    for (const variant of ['Acme Inc.', 'ACME, Inc', 'Acme Limited', 'Acme GmbH', '  acme  ']) {
      expect(normalizeCompanyName(variant)).toBe(expected);
    }
  });

  it('keeps genuinely different companies distinct', () => {
    expect(normalizeCompanyName('Acme')).not.toBe(normalizeCompanyName('Acme Labs'));
  });

  it('strips diacritics so accented spellings unify', () => {
    expect(normalizeCompanyName('Zalandó SE')).toBe(normalizeCompanyName('Zalando SE'));
  });
});

describe('normalizeTitle', () => {
  it('is insensitive to word order and punctuation', () => {
    expect(normalizeTitle('Backend Engineer')).toBe(normalizeTitle('Engineer, Backend'));
  });

  it('strips gender markers and parentheticals used in EU postings', () => {
    expect(normalizeTitle('Backend Engineer (m/w/d)')).toBe(normalizeTitle('Backend Engineer'));
    expect(normalizeTitle('Backend Engineer (Remote)')).toBe(normalizeTitle('Backend Engineer'));
  });

  it('preserves technology punctuation that carries meaning', () => {
    expect(normalizeTitle('C++ Developer')).toContain('c++');
    expect(normalizeTitle('.NET Engineer')).toContain('.net');
  });

  it('does not merge different roles', () => {
    expect(normalizeTitle('Backend Engineer')).not.toBe(normalizeTitle('Frontend Engineer'));
  });
});

describe('normalizeUrl', () => {
  it('collapses tracking parameters, host case and scheme', () => {
    const a = normalizeUrl('https://Boards.Greenhouse.io/acme/jobs/123?utm_source=linkedin&gh_src=x');
    const b = normalizeUrl('http://boards.greenhouse.io/acme/jobs/123');
    expect(a).toBe(b);
  });

  it('drops www and trailing slashes but preserves meaningful query params', () => {
    expect(normalizeUrl('https://www.example.com/jobs/1/')).toBe('https://example.com/jobs/1');
    expect(normalizeUrl('https://example.com/j?id=7')).toContain('id=7');
  });

  it('sorts query parameters so ordering is not a difference', () => {
    expect(normalizeUrl('https://x.com/j?b=2&a=1')).toBe(normalizeUrl('https://x.com/j?a=1&b=2'));
  });

  it('returns null for unparseable or non-http input rather than throwing', () => {
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('JobIdentityService', () => {
  const service = new JobIdentityService();

  it('produces a stable content hash regardless of key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(service.contentHash({ a: 1, b: 2 })).toBe(service.contentHash({ b: 2, a: 1 }));
  });

  it('gives the same fingerprint to the same job seen on different sources', () => {
    const posted = new Date('2026-08-10T00:00:00Z');
    const fromBoard = makeNormalizedJob({
      title: 'Backend Engineer (m/w/d)',
      company: { name: 'Acme GmbH' },
      location: { city: 'Berlin', countryCode: 'DE' },
      postedAt: posted,
    });
    const fromCareers = makeNormalizedJob({
      title: 'Engineer, Backend',
      company: { name: 'Acme' },
      location: { city: 'Berlin', countryCode: 'DE' },
      postedAt: posted,
    });

    expect(service.fingerprint(fromBoard).hash).toBe(service.fingerprint(fromCareers).hash);
  });

  it('separates the same role in different countries', () => {
    const posted = new Date('2026-08-10T00:00:00Z');
    const berlin = makeNormalizedJob({
      title: 'Backend Engineer',
      company: { name: 'Acme' },
      location: { city: 'Berlin', countryCode: 'DE' },
      postedAt: posted,
    });
    const amsterdam = makeNormalizedJob({
      title: 'Backend Engineer',
      company: { name: 'Acme' },
      location: { city: 'Amsterdam', countryCode: 'NL' },
      postedAt: posted,
    });

    expect(service.fingerprint(berlin).hash).not.toBe(service.fingerprint(amsterdam).hash);
  });

  it('exposes readable fingerprint parts for debugging', () => {
    const { parts } = service.fingerprint(
      makeNormalizedJob({
        title: 'Senior Backend Engineer',
        company: { name: 'Acme Inc' },
        location: { countryCode: 'DE' },
        postedAt: new Date('2026-08-10T00:00:00Z'),
      }),
    );
    expect(parts.company).toBe('acme');
    expect(parts.location).toBe('de');
    expect(parts.postedWeek).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('matches near-identical descriptions with a small simhash distance', () => {
    const base =
      'We are looking for a backend engineer to build and operate distributed systems ' +
      'using TypeScript and PostgreSQL. You will own services end to end and work with ' +
      'a small focused team on high traffic infrastructure.';
    const reworded = `${base} Apply today via our careers page.`;

    const a = service.simhash(base);
    const b = service.simhash(reworded);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(simhashDistance(a as string, b as string)).toBeLessThan(12);
  });

  it('gives unrelated descriptions a large simhash distance', () => {
    const a = service.simhash(
      'Backend engineer building distributed systems with TypeScript and PostgreSQL ' +
        'for a high traffic payments platform in a small focused team.',
    );
    const b = service.simhash(
      'Registered nurse needed for night shifts at a community hospital providing ' +
        'patient care and medication administration on a busy ward.',
    );
    expect(simhashDistance(a as string, b as string)).toBeGreaterThan(12);
  });

  it('returns null simhash for text too short to be meaningful', () => {
    expect(service.simhash('Engineer')).toBeNull();
    expect(service.simhash(null)).toBeNull();
  });

  it('computes a complete identity for a normalized job', () => {
    const identity = service.compute(
      makeNormalizedJob({
        sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=x',
        description: 'A reasonably long description about building backend services at scale.',
      }),
    );

    expect(identity.contentHash).toHaveLength(64);
    expect(identity.fingerprint).toHaveLength(64);
    expect(identity.normalizedUrl).not.toContain('utm_source');
    expect(identity.urlHash).toHaveLength(64);
  });
});
