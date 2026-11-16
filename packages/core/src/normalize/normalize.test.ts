import { describe, expect, it } from 'vitest';
import { sourceJobDraftSchema, type SourceJobDraftInput } from '@job-intel/contracts';
import {
  htmlToText,
  sanitizeHtml,
  detectHiddenContent,
  normalizeEmploymentTypes,
  normalizeRemoteType,
  normalizeSeniority,
  parseLocation,
  parseSalaryText,
  toAnnualUsd,
  normalizeJobDraft,
  normalizeUrl,
} from '../index';

const draft = (over: Partial<SourceJobDraftInput> = {}) =>
  sourceJobDraftSchema.parse({
    title: 'Backend Engineer',
    companyName: 'Acme',
    url: 'https://example.test/jobs/1',
    ...over,
  });

describe('remote type normalization', () => {
  it('maps every common phrasing onto one value', () => {
    for (const text of ['Remote', '100% remote', 'Fully-Remote', 'Work from home', 'WFH', 'Remote-first', 'Telecommuting']) {
      expect(normalizeRemoteType({ location: text }).value).toBe('remote');
    }
  });

  it('recognises hybrid and does not read it as remote', () => {
    // "Hybrid — 2 days remote" read as fully remote is the classic error here.
    expect(normalizeRemoteType({ location: 'Hybrid' }).value).toBe('hybrid');
    expect(normalizeRemoteType({ location: 'Hybrid (2 days remote)' }).value).toBe('hybrid');
    expect(normalizeRemoteType({ location: 'Partially remote' }).value).toBe('hybrid');
  });

  it('recognises on-site phrasings', () => {
    for (const text of ['On-site', 'Onsite', 'In-office', 'Office-based']) {
      expect(normalizeRemoteType({ location: text }).value).toBe('onsite');
    }
  });

  it('returns unknown rather than guessing', () => {
    const result = normalizeRemoteType({ location: 'Berlin' });
    expect(result.value).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('trusts a structured flag over prose', () => {
    expect(normalizeRemoteType({ explicitRemote: true }).value).toBe('remote');
    expect(normalizeRemoteType({ explicitRemote: false, location: 'Berlin' }).value).toBe('onsite');
  });

  it('weights a description far below a title or location', () => {
    const fromLocation = normalizeRemoteType({ location: 'Remote' });
    const fromDescription = normalizeRemoteType({ description: 'occasional remote work allowed' });
    expect(fromDescription.confidence).toBeLessThan(fromLocation.confidence);
  });

  it('preserves the raw value alongside the interpretation', () => {
    const result = normalizeRemoteType({ location: '100% Remote' });
    expect(result.raw).toBe('100% Remote');
    expect(result.evidence).toContain('matched');
  });
});

describe('employment type normalization', () => {
  it('maps spelling variants onto one value', () => {
    for (const text of ['Full-time', 'Full Time', 'full_time', 'Permanent', 'Vollzeit']) {
      expect(normalizeEmploymentTypes([text]).value).toEqual(['full_time']);
    }
  });

  it('recognises the other types', () => {
    expect(normalizeEmploymentTypes(['Part Time']).value).toEqual(['part_time']);
    expect(normalizeEmploymentTypes(['Contract']).value).toEqual(['contract']);
    expect(normalizeEmploymentTypes(['Internship']).value).toEqual(['internship']);
    expect(normalizeEmploymentTypes(['Freelance']).value).toEqual(['freelance']);
  });

  it('returns several types when a posting genuinely offers several', () => {
    const result = normalizeEmploymentTypes(['Full-time', 'Contract']);
    expect(result.value).toEqual(expect.arrayContaining(['full_time', 'contract']));
  });

  it('returns an empty list rather than guessing', () => {
    expect(normalizeEmploymentTypes(['Something odd']).value).toEqual([]);
    expect(normalizeEmploymentTypes([]).confidence).toBe(0);
  });
});

describe('seniority inference', () => {
  it('reads seniority from the title', () => {
    expect(normalizeSeniority('Senior Backend Engineer').value).toBe('senior');
    expect(normalizeSeniority('Junior Developer').value).toBe('junior');
    expect(normalizeSeniority('Staff Engineer').value).toBe('staff');
    expect(normalizeSeniority('Engineering Manager').value).toBe('manager');
    expect(normalizeSeniority('Software Engineering Intern').value).toBe('intern');
  });

  it('prefers the more senior term when several appear', () => {
    expect(normalizeSeniority('Senior Engineering Director').value).toBe('director');
  });

  it('returns null for a title with no signal', () => {
    expect(normalizeSeniority('Software Engineer').value).toBeNull();
    expect(normalizeSeniority(null).value).toBeNull();
  });
});

describe('salary parsing', () => {
  it('parses ranges with symbols and periods', () => {
    const result = parseSalaryText('$120 - $170 /hour');
    expect(result.value.min).toBe(120);
    expect(result.value.max).toBe(170);
    expect(result.value.currency).toBe('USD');
    expect(result.value.period).toBe('hour');
    expect(result.value.normalizedAnnualUsd).toBe(170 * 2080);
  });

  it('parses thousands separators and k suffixes', () => {
    expect(parseSalaryText('€60,000 – €80,000 per year').value.max).toBe(80_000);
    expect(parseSalaryText('120k-170k USD').value.max).toBe(170_000);
  });

  it('parses naira, which Nigerian boards use', () => {
    const result = parseSalaryText('₦250,000 monthly');
    expect(result.value.currency).toBe('NGN');
    expect(result.value.period).toBe('month');
    expect(result.value.normalizedAnnualUsd).toBeGreaterThan(0);
  });

  it('returns nulls for prose rather than inventing a number', () => {
    for (const text of ['Competitive', 'Negotiable', 'DOE', null]) {
      expect(parseSalaryText(text).value.min).toBeNull();
    }
  });

  it('does not read a bare year as a salary', () => {
    expect(parseSalaryText('Posted in 2026').value.min).toBeNull();
  });

  it('converts currencies to a comparable annual USD figure', () => {
    expect(toAnnualUsd(100, 'USD', 'hour').value).toBe(208_000);
    expect(toAnnualUsd(50_000, 'EUR', 'year').value).toBe(54_000);
    expect(toAnnualUsd(null, 'USD', 'year').value).toBeNull();
    expect(toAnnualUsd(1000, 'XYZ', 'year').value).toBeNull();
  });

  it('infers a plausible period from magnitude when none is stated', () => {
    // 150 with no period is an hourly rate, not an annual salary.
    expect(toAnnualUsd(150, 'USD', null).value).toBe(150 * 2080);
    expect(toAnnualUsd(120_000, 'USD', null).value).toBe(120_000);
  });
});

describe('location parsing', () => {
  it('splits city and country', () => {
    const result = parseLocation('Berlin, Germany');
    expect(result.value.city).toBe('Berlin');
    expect(result.value.countryCode).toBe('DE');
  });

  it('recognises ISO codes and aliases', () => {
    expect(parseLocation('London, UK').value.countryCode).toBe('GB');
    expect(parseLocation('Austin, USA').value.countryCode).toBe('US');
    expect(parseLocation('Lagos, Nigeria').value.countryCode).toBe('NG');
  });

  it('infers Nigeria from a city or state alone', () => {
    expect(parseLocation('Lagos').value.countryCode).toBe('NG');
    expect(parseLocation('Lekki, Lagos').value.countryCode).toBe('NG');
  });

  it('does not invent a city from a non-place term', () => {
    for (const text of ['Anywhere', 'Worldwide', 'Remote']) {
      expect(parseLocation(text).value.city).toBeNull();
      expect(parseLocation(text).value.countryCode).toBeNull();
    }
  });

  it('strips a remote prefix and keeps the real place', () => {
    expect(parseLocation('Remote, Germany').value.countryCode).toBe('DE');
  });
});

describe('URL normalization', () => {
  it('strips tracking parameters but keeps meaningful ones', () => {
    const normalized = normalizeUrl('https://x.test/jobs/1?utm_source=rss&gh_src=abc&id=42');
    expect(normalized).toContain('id=42');
    expect(normalized).not.toContain('utm_source');
    expect(normalized).not.toContain('gh_src');
  });

  it('does not remove a parameter the job needs to resolve', () => {
    // Dropping this would break the link entirely.
    expect(normalizeUrl('https://x.test/view?jobId=99')).toContain('jobId=99');
  });

  it('collapses host case, www and scheme differences', () => {
    expect(normalizeUrl('http://WWW.X.test/a')).toBe(normalizeUrl('https://x.test/a'));
  });

  it('sorts parameters so ordering is not a difference', () => {
    expect(normalizeUrl('https://x.test/a?b=2&a=1')).toBe(normalizeUrl('https://x.test/a?a=1&b=2'));
  });

  it('rejects unparseable or dangerous URLs', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('nonsense')).toBeNull();
  });
});

describe('HTML handling', () => {
  it('converts markup to readable text with block structure', () => {
    const text = htmlToText('<p>One</p><ul><li>Two</li><li>Three</li></ul>');
    expect(text).toBe('One\nTwo\nThree');
  });

  it('drops script and style contents entirely', () => {
    expect(htmlToText('<p>Keep</p><script>alert(1)</script>')).toBe('Keep');
  });

  it('decodes entities', () => {
    expect(htmlToText('<p>A &amp; B &#8212; C</p>')).toBe('A & B — C');
  });

  it('sanitizes to an allowlist and neutralises javascript URLs', () => {
    const clean = sanitizeHtml('<p onclick="evil()">Hi</p><script>bad()</script><a href="javascript:x">l</a>');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('<p>Hi</p>');
  });

  it('keeps http links and adds safe rel attributes', () => {
    const clean = sanitizeHtml('<a href="https://ok.test">go</a>');
    expect(clean).toContain('href="https://ok.test"');
    expect(clean).toContain('noopener');
  });

  it('detects hidden-text tricks', () => {
    expect(detectHiddenContent('<div style="display:none">x</div>')).toContain('display_none');
    expect(detectHiddenContent('<p>a​b</p>')).toContain('zero_width_characters');
    // Repeated calls must agree — a stateful /g regex would alternate.
    expect(detectHiddenContent('<p>a​b</p>')).toContain('zero_width_characters');
  });
});

describe('normalizeJobDraft', () => {
  it('produces a complete job from a minimal draft', () => {
    const result = normalizeJobDraft(draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.title).toBe('Backend Engineer');
    expect(result.job.remoteType).toBe('unknown');
    expect(result.job.salary.normalizedAnnualUsd).toBeNull();
  });

  it('normalizes every field and keeps the raw values in the report', () => {
    const result = normalizeJobDraft(
      draft({
        title: 'Senior Backend Engineer (m/w/d)',
        locationText: 'Berlin, Germany',
        employmentTypeTexts: ['Vollzeit'],
        salaryText: '€70,000 - €90,000 per year',
        remoteFlag: false,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.job.title).toBe('Senior Backend Engineer');
    expect(result.job.location.countryCode).toBe('DE');
    expect(result.job.employmentTypes).toEqual(['full_time']);
    expect(result.job.seniority).toBe('senior');
    expect(result.job.salary.max).toBe(90_000);
    // The interpretation never destroys what it came from.
    expect(result.report.salary.raw).toBe('€70,000 - €90,000 per year');
    expect(result.report.location.raw).toBe('Berlin, Germany');
  });

  it('prefers a structured salary over parsing prose', () => {
    const result = normalizeJobDraft(
      draft({ salaryMin: 100_000, salaryMax: 150_000, salaryCurrency: 'usd', salaryPeriod: 'year', salaryText: 'ignore me' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.salary.min).toBe(100_000);
    expect(result.job.salary.currency).toBe('USD');
    expect(result.report.salary.evidence).toContain('structured');
  });

  it('converts HTML descriptions into both text and safe markup', () => {
    const result = normalizeJobDraft(
      draft({ description: '<p>Build <script>x</script>things</p>', descriptionFormat: 'html' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.description).toBe('Build things');
    expect(result.job.descriptionHtml).not.toContain('script');
  });

  it('rejects a draft whose URL cannot be parsed, without throwing', () => {
    const bad = sourceJobDraftSchema.parse({
      title: 'X',
      companyName: 'Y',
      url: 'https://ok.test/1',
    });
    const result = normalizeJobDraft({ ...bad, url: 'http://[bad' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('URL');
  });

  it('ignores a posted date in the future and records why', () => {
    const future = new Date(Date.now() + 30 * 86_400_000);
    const result = normalizeJobDraft(draft({ postedAt: future }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.postedAt).toBeNull();
    expect(result.report.warnings.join(' ')).toContain('future');
  });
});
