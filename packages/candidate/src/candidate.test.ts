import { describe, expect, it } from 'vitest';
import {
  candidatePreferencesSchema,
  jobEnrichmentSchema,
  type CandidatePreferences,
  type JobEnrichment,
} from '@job-intel/contracts';
import { ConstraintEvaluator, explainExclusion } from './constraints/constraint-evaluator';
import { PreferenceService } from './preferences/preference-service';
import { buildCanonicalProfile, isEmbeddingStale } from './embedding/canonical-profile';
import { parsePreferenceInstruction } from './nl/preference-parser';
import { aggregateSignals, suggestFromSignals } from './behavior/signal-aggregator';
import { SkillGraph } from './skills/skill-graph';

/**
 * A preference payload built from data, never from literals in the evaluator.
 *
 * Takes schema *input* (partial nested sections) rather than the parsed output,
 * so a test can set just `salary.minimum` without restating every sibling.
 */
function preferences(overrides: Record<string, unknown> = {}): CandidatePreferences {
  return candidatePreferencesSchema.parse(overrides);
}

/** A minimal enrichment; individual tests override only what they exercise. */
function enrichment(overrides: Record<string, unknown> = {}): JobEnrichment {
  return jobEnrichmentSchema.parse({
    enrichmentVersion: 1,
    normalizedTitle: 'Backend Engineer',
    titleConfidence: 0.85,
    roleSlug: 'backend-engineer',
    seniority: 'senior',
    seniorityConfidence: 0.9,
    experience: { minimumYears: 5, maximumYears: null, confidence: 0.9, method: 'pattern', rawText: '5+ years', qualitativeOnly: false },
    workArrangement: { mode: 'remote', confidence: 0.9, method: 'pattern' },
    location: { countryCode: 'DE', city: 'Berlin', confidence: 0.9, method: 'pattern' },
    compensation: { stated: false, confidence: 0, method: 'default' },
    workAuthorization: {
      sponsorship: 'not_mentioned',
      sponsorshipConfidence: 0.95,
      relocationSupport: 'not_mentioned',
    },
    education: { requirement: 'not_specified', confidence: 0.9, method: 'default' },
    classification: { jobFunction: 'software_engineering', functionConfidence: 0.9, industries: [], industryConfidence: 0, method: 'pattern' },
    quality: { qualityScore: 0.8, scamScore: 0, qualityConfidence: 0.8 },
    applicationTarget: { sourceUrl: 'https://example.com/job/1', confidence: 0.7, kind: 'board' },
    totalDurationMs: 5,
    ...overrides,
  });
}

const job = { title: 'Senior Backend Engineer', companyName: 'Acme Corp', description: 'Build things.' };

function evaluate(prefs: CandidatePreferences, enr: JobEnrichment = enrichment()) {
  return new ConstraintEvaluator(prefs).evaluate({
    preferences: prefs,
    profileVersion: 1,
    enrichment: enr,
    job,
  });
}

describe('hard constraints vs soft preferences', () => {
  it('treats REMOTE_ONLY as hard and REMOTE_PREFERRED as soft', () => {
    const onsite = enrichment({ workArrangement: { mode: 'onsite', confidence: 0.9, method: 'pattern' } });

    const hard = evaluate(preferences({ workArrangement: 'REMOTE_ONLY' }), onsite);
    expect(hard.eligible).toBe(false);
    expect(hard.hardFailures[0]?.dimension).toBe('work_arrangement');

    const soft = evaluate(preferences({ workArrangement: 'REMOTE_PREFERRED' }), onsite);
    expect(soft.eligible).toBe(true);
    // Still penalised, just not excluded.
    expect(soft.outcomes.find((o) => o.dimension === 'work_arrangement')?.score).toBeLessThan(0);
  });

  it('lets an exclusion override an otherwise excellent match', () => {
    const excellent = enrichment({
      skills: [
        { slug: 'react', displayName: 'React', category: 'framework', requirement: 'required', confidence: 0.95, method: 'taxonomy' },
      ],
    });
    const prefs = preferences({
      technologies: [
        { value: 'react', strength: 'strongly_preferred', hard: false, note: null, source: 'explicit' },
      ],
      companies: [{ value: 'Acme Corp', strength: 'excluded', hard: true, note: null, source: 'explicit' }],
    });

    const result = evaluate(prefs, excellent);
    expect(result.eligible).toBe(false);
    expect(result.softScore).toBe(0);
    expect(explainExclusion(result).join(' ')).toMatch(/Acme Corp/);
  });

  it('makes a hard salary floor hard and a soft one soft', () => {
    const paid = enrichment({
      compensation: {
        stated: true, minimum: 50_000, maximum: 60_000, currency: 'USD', period: 'year',
        confidence: 0.9, method: 'pattern',
        conversion: { annualUsd: 60_000, rate: 1, rateSource: 'test', rateTimestamp: new Date(), periodInferred: false },
      },
    });

    const hard = evaluate(
      preferences({ salary: { minimum: 90_000, currency: 'USD', period: 'year', minimumIsHard: true } }),
      paid,
    );
    expect(hard.eligible).toBe(false);

    const soft = evaluate(
      preferences({ salary: { minimum: 90_000, currency: 'USD', period: 'year', minimumIsHard: false } }),
      paid,
    );
    expect(soft.eligible).toBe(true);
  });
});

describe('unknown is never a refusal', () => {
  it('does not exclude a posting that is silent about sponsorship', () => {
    const prefs = preferences({
      workAuthorization: { sponsorshipRequirement: 'required', acceptUnknownSponsorship: true },
    });
    const result = evaluate(prefs);
    expect(result.eligible).toBe(true);
    expect(result.outcomes.find((o) => o.dimension === 'visa')?.explanation).toMatch(/not mentioned/);
  });

  it('does exclude a posting that explicitly refuses sponsorship', () => {
    const refused = enrichment({
      workAuthorization: { sponsorship: 'not_offered', sponsorshipConfidence: 0.9, relocationSupport: 'not_mentioned' },
    });
    const prefs = preferences({ workAuthorization: { sponsorshipRequirement: 'required' } });
    expect(evaluate(prefs, refused).eligible).toBe(false);
  });

  it('does not penalise a posting that states no salary by default', () => {
    const prefs = preferences({ salary: { minimum: 90_000, currency: 'USD', period: 'year' } });
    const result = evaluate(prefs);
    expect(result.eligible).toBe(true);
    expect(result.outcomes.find((o) => o.dimension === 'salary')?.skipped).toBe(true);
  });
});

describe('preference strength', () => {
  it('scores higher for a strongly preferred country than a merely acceptable one', () => {
    const strong = evaluate(
      preferences({ countries: [{ value: 'DE', strength: 'strongly_preferred', hard: false, note: null, source: 'explicit' }] }),
    );
    const weak = evaluate(
      preferences({ countries: [{ value: 'DE', strength: 'preferred', hard: false, note: null, source: 'explicit' }] }),
    );
    const strongScore = strong.outcomes.find((o) => o.dimension === 'location')?.score ?? 0;
    const weakScore = weak.outcomes.find((o) => o.dimension === 'location')?.score ?? 0;
    expect(strongScore).toBeGreaterThan(weakScore);
  });

  it('does not treat an unlisted value as excluded', () => {
    // Absence of an opinion must never behave like a refusal.
    const result = evaluate(
      preferences({ technologies: [{ value: 'rust', strength: 'preferred', hard: false, note: null, source: 'explicit' }] }),
    );
    expect(result.eligible).toBe(true);
  });
});

describe('preference mutations', () => {
  it('changes work arrangement and reports the diff', () => {
    const before = preferences({ workArrangement: 'REMOTE_ONLY' });
    const result = PreferenceService.updateWorkArrangement(before, 'HYBRID_ACCEPTED');

    expect(result.preferences.workArrangement).toBe('HYBRID_ACCEPTED');
    expect(result.changes[0]?.summary).toMatch(/REMOTE_ONLY to HYBRID_ACCEPTED/);
    // Work arrangement is not semantic content, so no re-embed.
    expect(result.embeddingStale).toBe(false);
  });

  it('marks the embedding stale only for semantic changes', () => {
    const base = preferences();
    expect(PreferenceService.updateSalary(base, { minimum: 90_000 }).embeddingStale).toBe(false);
    expect(
      PreferenceService.upsertListEntry(base, 'technologies', {
        value: 'rust', strength: 'preferred', hard: false, note: null, source: 'explicit',
      }).embeddingStale,
    ).toBe(true);
  });

  it('upserts one entry without disturbing the rest', () => {
    const base = preferences({
      countries: [
        { value: 'DE', strength: 'preferred', hard: false, note: null, source: 'explicit' },
        { value: 'NL', strength: 'preferred', hard: false, note: null, source: 'explicit' },
      ],
    });
    const result = PreferenceService.upsertListEntry(base, 'countries', {
      value: 'DE', strength: 'required', hard: true, note: null, source: 'explicit',
    });

    expect(result.preferences.countries).toHaveLength(2);
    expect(result.preferences.countries.find((c) => c.value === 'DE')?.strength).toBe('required');
    expect(result.preferences.countries.find((c) => c.value === 'NL')?.strength).toBe('preferred');
  });

  it('rejects an invalid strength rather than coercing it', () => {
    expect(() => PreferenceService.updateStrength(preferences(), 'countries', 'DE', 'sort-of')).toThrow();
  });

  it('rejects an out-of-range weight', () => {
    expect(() => PreferenceService.updateWeights(preferences(), { salary: 500 })).toThrow();
  });
});

/**
 * The requirement stated explicitly in the brief: changing stored preferences
 * must change what future matching sees, with no code change.
 */
describe('change propagation (Part 26)', () => {
  const onsiteDutch = enrichment({
    workArrangement: { mode: 'hybrid', confidence: 0.9, method: 'pattern', officeDaysPerWeek: 2 },
    location: { countryCode: 'NL', city: 'Amsterdam', confidence: 0.9, method: 'pattern' },
    compensation: {
      stated: true, minimum: 65_000, maximum: 65_000, currency: 'EUR', period: 'year',
      confidence: 0.9, method: 'pattern',
      conversion: { annualUsd: 70_200, rate: 1.08, rateSource: 'test', rateTimestamp: new Date(), periodInferred: false },
    },
  });

  it('rejects, then accepts, the same job after preferences change', () => {
    // Before: remote-only, Germany only, EUR 70k hard floor.
    const before = preferences({
      workArrangement: 'REMOTE_ONLY',
      countries: [{ value: 'DE', strength: 'required', hard: true, note: null, source: 'explicit' }],
      salary: { minimum: 70_000, currency: 'EUR', period: 'year', minimumIsHard: true },
    });

    const first = evaluate(before, onsiteDutch);
    expect(first.eligible).toBe(false);
    const reasons = explainExclusion(first).join(' | ');
    expect(reasons).toMatch(/remote-only/i);

    // The candidate relaxes their preferences — data only, no code touched.
    let next = PreferenceService.updateWorkArrangement(before, 'HYBRID_ACCEPTED', 3).preferences;
    next = PreferenceService.updateList(next, 'countries', [
      { value: 'DE', strength: 'preferred', hard: false, note: null, source: 'explicit' },
      { value: 'NL', strength: 'preferred', hard: false, note: null, source: 'explicit' },
    ]).preferences;
    next = PreferenceService.updateSalary(next, { minimum: 60_000 }).preferences;

    const second = evaluate(next, onsiteDutch);
    expect(second.eligible).toBe(true);
    expect(second.softScore).toBeGreaterThan(0);
  });

  it('uses the evaluator with no literals of its own', () => {
    // Same job, opposite preferences: the verdict follows the data, proving the
    // evaluator holds no built-in opinion about remote work or countries.
    const remoteOnly = evaluate(preferences({ workArrangement: 'REMOTE_ONLY' }), onsiteDutch);
    const onsitePreferred = evaluate(preferences({ workArrangement: 'ONSITE_PREFERRED' }), onsiteDutch);
    expect(remoteOnly.eligible).toBe(false);
    expect(onsitePreferred.eligible).toBe(true);
  });
});

describe('canonical profile and embedding staleness', () => {
  const profile = {
    schemaVersion: 1 as const,
    identity: { fullName: 'Test Candidate', email: 'test@example.com', timezone: 'UTC' },
    professional: {
      currentTitle: 'Frontend Engineer', yearsOfExperience: 5, seniority: 'senior' as const,
      education: [], industries: ['SaaS'], skills: [], technologies: [], languages: [],
    },
    preferences: {} as never,
    exclusions: {} as never,
    custom: {},
  };

  const skills = [
    { name: 'React', slug: 'react', category: 'framework', proficiency: 'advanced' as const, yearsOfExperience: 4, lastUsedYear: 2026, importance: 'primary' as const, evidence: null, source: 'explicit' as const },
  ];

  it('produces identical text for identical input', () => {
    const a = buildCanonicalProfile({ profile: profile as never, preferences: preferences(), skills });
    const b = buildCanonicalProfile({ profile: profile as never, preferences: preferences(), skills });
    expect(a.hash).toBe(b.hash);
    expect(a.text).toContain('React');
  });

  it('changes the hash when semantic content changes', () => {
    const before = buildCanonicalProfile({ profile: profile as never, preferences: preferences(), skills });
    const after = buildCanonicalProfile({
      profile: profile as never,
      preferences: preferences({
        titles: [{ value: 'Platform Engineer', strength: 'preferred', hard: false, note: null, source: 'explicit' }],
      }),
      skills,
    });
    expect(after.hash).not.toBe(before.hash);
  });

  it('excludes negative preferences from the semantic profile', () => {
    // Embedding an excluded technology would pull the vector towards the very
    // thing the candidate is avoiding.
    const canonical = buildCanonicalProfile({
      profile: profile as never,
      preferences: preferences({
        technologies: [{ value: 'COBOL', strength: 'excluded', hard: true, note: null, source: 'explicit' }],
      }),
      skills,
    });
    expect(canonical.text).not.toMatch(/COBOL/i);
  });

  it('reports staleness for a new profile, a content change and a model change', () => {
    const canonical = buildCanonicalProfile({ profile: profile as never, preferences: preferences(), skills });

    expect(isEmbeddingStale(canonical, { storedHash: null, storedModel: null, currentModel: 'm1' }).stale).toBe(true);
    expect(isEmbeddingStale(canonical, { storedHash: 'other', storedModel: 'm1', currentModel: 'm1' }).stale).toBe(true);
    expect(isEmbeddingStale(canonical, { storedHash: canonical.hash, storedModel: 'm1', currentModel: 'm2' }).stale).toBe(true);
    expect(isEmbeddingStale(canonical, { storedHash: canonical.hash, storedModel: 'm1', currentModel: 'm1' }).stale).toBe(false);
  });
});

describe('natural-language proposals', () => {
  it('proposes without applying anything', () => {
    const bundle = parsePreferenceInstruction("I'm okay with hybrid jobs now.", preferences());
    expect(bundle.requiresConfirmation).toBe(true);
    expect(bundle.proposals[0]?.path).toBe('workArrangement');
    expect(bundle.proposals[0]?.value).toBe('HYBRID_ACCEPTED');
  });

  it.each([
    ["Don't show me anything below €70,000.", 'salary.minimum'],
    ['I need visa sponsorship.', 'workAuthorization.sponsorshipRequirement'],
    ["I'd rather work in Germany or the Netherlands.", 'countries'],
  ])('parses %s', (instruction, expectedPath) => {
    const bundle = parsePreferenceInstruction(instruction, preferences());
    expect(bundle.proposals.some((p) => p.path === expectedPath)).toBe(true);
  });

  it('reports text it could not interpret rather than dropping it', () => {
    const bundle = parsePreferenceInstruction(
      'I like companies with good coffee and table tennis.',
      preferences(),
    );
    expect(bundle.proposals).toHaveLength(0);
    expect(bundle.unparsed.length).toBeGreaterThan(0);
  });

  it('routes an applied proposal through the normal validated mutation', () => {
    const bundle = parsePreferenceInstruction("I'm okay with hybrid jobs now.", preferences());
    const proposal = bundle.proposals[0];
    expect(proposal).toBeDefined();

    const result = PreferenceService.applyProposal(preferences(), proposal!);
    expect(result.preferences.workArrangement).toBe('HYBRID_ACCEPTED');
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it('refuses a proposal targeting an unknown path', () => {
    expect(() =>
      PreferenceService.applyProposal(preferences(), {
        path: 'dropTables', operation: 'set', value: 'anything',
      }),
    ).toThrow(/Unsupported preference path/);
  });
});

describe('behavioural signals stay separate from preferences', () => {
  const attributes = {
    countryCode: 'DE', workMode: 'remote', companyName: 'Acme',
    jobFunction: 'software_engineering', seniority: 'senior',
    technologies: ['react'], industries: ['SaaS'],
  };

  it('aggregates affinity with recency decay', () => {
    const now = new Date('2026-08-18T00:00:00Z');
    const signals = aggregateSignals(
      [
        { event: 'job_applied', attributes, occurredAt: now },
        { event: 'job_saved', attributes, occurredAt: now },
        { event: 'job_saved', attributes, occurredAt: now },
      ],
      preferences(),
      { now },
    );
    const germany = signals.find((s) => s.dimension === 'countries' && s.value === 'DE');
    expect(germany?.affinity).toBeGreaterThan(0);
    expect(germany?.observations).toBe(3);
  });

  it('flags a learned signal that contradicts an explicit preference', () => {
    const now = new Date('2026-08-18T00:00:00Z');
    const prefs = preferences({
      countries: [{ value: 'DE', strength: 'preferred', hard: false, note: null, source: 'explicit' }],
    });
    const signals = aggregateSignals(
      Array.from({ length: 5 }, () => ({
        event: 'job_marked_irrelevant' as const, attributes, occurredAt: now,
      })),
      prefs,
      { now },
    );
    const germany = signals.find((s) => s.dimension === 'countries' && s.value === 'DE');
    expect(germany?.conflictsWithExplicit).toBe(true);
  });

  it('produces suggestions marked as suggested, never explicit', () => {
    const now = new Date('2026-08-18T00:00:00Z');
    const signals = aggregateSignals(
      Array.from({ length: 15 }, () => ({ event: 'job_applied' as const, attributes, occurredAt: now })),
      preferences(),
      { now },
    );
    const suggestions = suggestFromSignals(signals, preferences());
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect((suggestion.value as { source: string }).source).toBe('suggested');
    }
  });

  it('never suggests something the candidate already has an opinion on', () => {
    const now = new Date('2026-08-18T00:00:00Z');
    const prefs = preferences({
      countries: [{ value: 'DE', strength: 'excluded', hard: true, note: null, source: 'explicit' }],
    });
    const signals = aggregateSignals(
      Array.from({ length: 15 }, () => ({ event: 'job_applied' as const, attributes, occurredAt: now })),
      prefs,
      { now },
    );
    const suggestions = suggestFromSignals(signals, prefs);
    expect(suggestions.some((s) => s.path === 'countries' && (s.value as { value: string }).value === 'DE')).toBe(false);
  });
});

describe('skill graph', () => {
  const graph = new SkillGraph();

  it('transfers credit from a framework to its base technology', () => {
    const coverage = graph.coverage(['nextjs'], 'react');
    expect(coverage).not.toBeNull();
    expect(coverage!.strength).toBeGreaterThan(0.8);
    // Indirect credit must remain distinguishable from direct evidence.
    expect(coverage!.strength).toBeLessThan(1);
  });

  it('gives full credit for a direct match', () => {
    expect(graph.coverage(['react'], 'react')?.strength).toBe(1);
  });

  it('traverses more than one hop with damping', () => {
    const coverage = graph.coverage(['nextjs'], 'javascript');
    expect(coverage).not.toBeNull();
    expect(coverage!.via.length).toBeGreaterThan(2);
  });

  it('does not connect unrelated skills', () => {
    expect(graph.coverage(['cobol'], 'react')).toBeNull();
  });

  it('accepts new relationships at runtime', () => {
    const extensible = new SkillGraph([]);
    expect(extensible.coverage(['svelte'], 'javascript')).toBeNull();
    extensible.add({ fromSlug: 'svelte', toSlug: 'javascript', type: 'implies', weight: 0.9 });
    expect(extensible.coverage(['svelte'], 'javascript')?.strength).toBeCloseTo(0.9);
  });
});
