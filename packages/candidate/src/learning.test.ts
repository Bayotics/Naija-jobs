import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNAL_WEIGHTS,
  FEATURE_DIMENSIONS,
  LEARNING_ALGORITHM_VERSION,
  PREFERENCE_AUTHORITY,
  PROHIBITED_INFERENCE_DIMENSIONS,
  behaviorEventSchema,
  candidatePreferencesSchema,
  learningConfigSchema,
  type BehaviorEventInput,
  type BehaviorEventType,
  type CandidatePreferences,
  type EventContext,
  type FeatureAffinity,
} from '@job-intel/contracts';
import {
  buildBehavioralProfile,
  computeAffinities,
  computeBehavioralAdjustment,
  computeEngagementMetrics,
  computeRankingQuality,
  confidenceFromEvidence,
  extractFeatures,
  generateSuggestions,
  mergeAffinities,
  noveltyScore,
  recencyWeight,
  resolveAuthority,
  salaryBand,
  scoreQueryPerformance,
  scoreSourceUserValue,
  selectExploration,
  titleTokens,
  type AffinityEventInput,
  type JobAttributes,
} from './index';

/**
 * Feedback-loop behaviour.
 *
 * The tests are organised around the properties the brief treats as
 * non-negotiable rather than around the modules. The first group is the
 * absolute principle, and it is first because everything else is only
 * acceptable if that holds.
 */

const CANDIDATE = '11111111-1111-4111-8111-111111111111';

let jobCounter = 0;
const jobId = (): string =>
  `22222222-2222-4222-8222-${String(++jobCounter).padStart(12, '0')}`;

const job = (over: Partial<JobAttributes> = {}): JobAttributes => ({
  jobId: jobId(),
  title: 'Senior Frontend Engineer',
  companyName: 'Northwind',
  countryCode: 'DE',
  city: 'Berlin',
  remoteType: 'remote',
  employmentTypes: ['full_time'],
  seniority: 'senior',
  technologies: ['React', 'TypeScript'],
  industries: ['fintech'],
  salaryAnnualUsd: 95_000,
  sourceId: 'greenhouse',
  companySize: null,
  ...over,
});

const event = (
  eventType: BehaviorEventType,
  over: Partial<BehaviorEventInput> = {},
): ReturnType<typeof behaviorEventSchema.parse> =>
  behaviorEventSchema.parse({
    eventId: crypto.randomUUID(),
    candidateId: CANDIDATE,
    jobId: jobId(),
    eventType,
    occurredAt: new Date('2026-08-19T12:00:00Z'),
    context: 'DASHBOARD' as EventContext,
    ...over,
  });

const interaction = (
  eventType: BehaviorEventType,
  attributes: JobAttributes,
  over: Partial<BehaviorEventInput> = {},
): AffinityEventInput => ({
  event: event(eventType, { jobId: attributes.jobId, ...over }),
  features: extractFeatures(attributes),
});

const preferences = (over: Partial<CandidatePreferences> = {}): CandidatePreferences =>
  candidatePreferencesSchema.parse({
    titles: [{ value: 'Frontend Engineer', strength: 'required' }],
    technologies: [{ value: 'React', strength: 'strongly_preferred' }],
    workArrangement: 'ONSITE_PREFERRED',
    ...over,
  });

const NOW = new Date('2026-08-19T12:00:00Z');

// ── The absolute principle ──────────────────────────────────────────────────

describe('explicit preferences always win', () => {
  it('never lets behaviour resurrect an explicit exclusion', () => {
    const explicit = preferences({
      technologies: [
        { value: 'PHP', strength: 'excluded', hard: false, note: null, source: 'explicit' },
      ],
    });

    // The candidate has clicked PHP jobs repeatedly. That must not matter.
    const affinity: FeatureAffinity = {
      dimension: 'technology',
      value: 'php',
      affinity: 0.9,
      confidence: 0.85,
      sampleSize: 20,
      positiveEvents: 20,
      negativeEvents: 0,
      evidence: 12,
      firstObservedAt: NOW,
      lastObservedAt: NOW,
      lastUpdated: NOW,
      conflictsWithExplicit: true,
      explicitValue: 'php',
      algorithmVersion: LEARNING_ALGORITHM_VERSION,
      featureVersion: '1.0.0',
    };

    const decision = resolveAuthority(affinity, explicit);
    expect(decision.applied).toBe(false);
    expect(decision.layer).toBe('explicit_exclusion');
    expect(decision.detail).toContain('not applied');
  });

  it('never lets behaviour demote an explicit preference', () => {
    const affinity: FeatureAffinity = {
      dimension: 'technology',
      value: 'react',
      affinity: -0.8,
      confidence: 0.9,
      sampleSize: 30,
      positiveEvents: 0,
      negativeEvents: 30,
      evidence: 20,
      firstObservedAt: NOW,
      lastObservedAt: NOW,
      lastUpdated: NOW,
      conflictsWithExplicit: true,
      explicitValue: 'react',
      algorithmVersion: LEARNING_ALGORITHM_VERSION,
      featureVersion: '1.0.0',
    };

    const decision = resolveAuthority(affinity, preferences());
    expect(decision.applied).toBe(false);
    expect(decision.layer).toBe('explicit_preference');
  });

  it('applies behaviour where the candidate stated nothing', () => {
    const affinity: FeatureAffinity = {
      dimension: 'technology',
      value: 'rust',
      affinity: 0.6,
      confidence: 0.5,
      sampleSize: 8,
      positiveEvents: 8,
      negativeEvents: 0,
      evidence: 4,
      firstObservedAt: NOW,
      lastObservedAt: NOW,
      lastUpdated: NOW,
      conflictsWithExplicit: false,
      explicitValue: null,
      algorithmVersion: LEARNING_ALGORITHM_VERSION,
      featureVersion: '1.0.0',
    };

    const decision = resolveAuthority(affinity, preferences());
    expect(decision.applied).toBe(true);
    expect(decision.layer).toBe('learned_behavioral');
  });

  it('orders the hierarchy exactly as the brief specifies', () => {
    expect(PREFERENCE_AUTHORITY.explicit_hard_constraint).toBeLessThan(
      PREFERENCE_AUTHORITY.explicit_preference,
    );
    expect(PREFERENCE_AUTHORITY.explicit_preference).toBeLessThan(
      PREFERENCE_AUTHORITY.explicit_exclusion,
    );
    expect(PREFERENCE_AUTHORITY.explicit_exclusion).toBeLessThan(
      PREFERENCE_AUTHORITY.learned_behavioral,
    );
    expect(PREFERENCE_AUTHORITY.learned_behavioral).toBeLessThan(
      PREFERENCE_AUTHORITY.general_optimization,
    );
  });

  it('suppresses a conflicting signal in the ranking adjustment and says so', () => {
    const explicit = preferences({
      technologies: [
        { value: 'PHP', strength: 'excluded', hard: false, note: null, source: 'explicit' },
      ],
    });

    const attributes = job({ technologies: ['PHP'], title: 'PHP Developer' });

    const adjustment = computeBehavioralAdjustment({
      jobId: attributes.jobId,
      features: extractFeatures(attributes),
      affinities: [
        {
          dimension: 'technology',
          value: 'php',
          affinity: 0.95,
          confidence: 0.9,
          sampleSize: 25,
          positiveEvents: 25,
          negativeEvents: 0,
          evidence: 15,
          firstObservedAt: NOW,
          lastObservedAt: NOW,
          lastUpdated: NOW,
          conflictsWithExplicit: true,
          explicitValue: 'php',
          algorithmVersion: LEARNING_ALGORITHM_VERSION,
          featureVersion: '1.0.0',
        },
      ],
      preferences: explicit,
      hasSufficientData: true,
    });

    // The technology signal is suppressed; only unrelated features may apply.
    const applied = adjustment.contributions.some(
      (contribution) => contribution.dimension === 'technology' && contribution.value === 'php',
    );
    expect(applied).toBe(false);

    const trace = adjustment.authorityTrace.find((entry) => entry.layer === 'explicit_exclusion');
    expect(trace?.applied).toBe(false);
    expect(trace?.detail).toContain('excluded');
  });
});

// ── Guardrails ──────────────────────────────────────────────────────────────

describe('guardrails', () => {
  it('has no dimension in which a protected characteristic could be recorded', () => {
    for (const prohibited of PROHIBITED_INFERENCE_DIMENSIONS) {
      expect(FEATURE_DIMENSIONS).not.toContain(prohibited as never);
    }
  });

  it('extracts only job attributes, never person attributes', () => {
    const features = extractFeatures(job());
    for (const feature of features) {
      expect(FEATURE_DIMENSIONS).toContain(feature.dimension);
    }
  });
});

// ── Signals and confidence ──────────────────────────────────────────────────

describe('signal strength and confidence', () => {
  it('weights actions in ascending order of commitment', () => {
    const w = DEFAULT_SIGNAL_WEIGHTS;
    expect(w.JOB_VIEWED.polarity).toBeLessThan(w.JOB_CLICKED.polarity);
    expect(w.JOB_CLICKED.polarity).toBeLessThan(w.JOB_SAVED.polarity);
    expect(w.JOB_SAVED.polarity).toBeLessThan(w.JOB_APPLIED.polarity);

    // Ignoring is a far weaker negative than dismissing or rejecting.
    expect(Math.abs(w.JOB_IGNORED.polarity)).toBeLessThan(Math.abs(w.JOB_DISMISSED.polarity));
    expect(Math.abs(w.JOB_DISMISSED.polarity)).toBeLessThan(Math.abs(w.JOB_REJECTED.polarity));
    expect(w.JOB_IGNORED.evidenceWeight).toBeLessThan(w.JOB_REJECTED.evidenceWeight);
  });

  it('does not infer a strong preference from one event', () => {
    const attributes = job();
    const affinities = computeAffinities([interaction('JOB_SAVED', attributes)], { now: NOW });

    const react = affinities.find((a) => a.dimension === 'technology' && a.value === 'react');
    expect(react).toBeDefined();
    // Strong opinion, weakly held. Confidence is what ranking multiplies by.
    expect(react!.affinity).toBeGreaterThan(0.5);
    expect(react!.confidence).toBeLessThan(0.2);
  });

  it('raises confidence with repeated independent evidence', () => {
    const once = computeAffinities([interaction('JOB_SAVED', job())], { now: NOW });
    const many = computeAffinities(
      Array.from({ length: 12 }, () => interaction('JOB_SAVED', job())),
      { now: NOW },
    );

    const first = once.find((a) => a.value === 'react')!;
    const repeated = many.find((a) => a.value === 'react')!;

    expect(repeated.confidence).toBeGreaterThan(first.confidence * 3);
    expect(repeated.sampleSize).toBe(12);
  });

  it('never reaches certainty, however much evidence accumulates', () => {
    const config = learningConfigSchema.parse({});
    expect(confidenceFromEvidence(1_000, config)).toBeLessThanOrEqual(config.maxConfidence);
    expect(confidenceFromEvidence(0, config)).toBe(0);
  });

  it('weights an email click above a search click', () => {
    // Three each, so both clear the evidence floor and the comparison is about
    // context weighting rather than about which one survived filtering.
    const fromEmail = computeAffinities(
      Array.from({ length: 3 }, () => interaction('JOB_CLICKED', job(), { context: 'EMAIL' })),
      { now: NOW },
    );
    const fromSearch = computeAffinities(
      Array.from({ length: 3 }, () => interaction('JOB_CLICKED', job(), { context: 'SEARCH' })),
      { now: NOW },
    );

    const email = fromEmail.find((a) => a.value === 'react')!;
    const search = fromSearch.find((a) => a.value === 'react')!;
    expect(email.evidence).toBeGreaterThan(search.evidence);
  });
});

// ── Decay and recency ───────────────────────────────────────────────────────

describe('decay and recency', () => {
  it('halves evidence weight after one half-life', () => {
    const halfLife = 45;
    const recent = recencyWeight(NOW, NOW, halfLife);
    const old = recencyWeight(new Date(NOW.getTime() - halfLife * 86_400_000), NOW, halfLife);

    expect(recent).toBeCloseTo(1, 5);
    expect(old).toBeCloseTo(0.5, 5);
  });

  it('lets recent behaviour outweigh older contrary behaviour', () => {
    const old = new Date(NOW.getTime() - 180 * 86_400_000);

    const affinities = computeAffinities(
      [
        // Six months of fintech saves…
        ...Array.from({ length: 8 }, () =>
          interaction('JOB_SAVED', job({ industries: ['fintech'] }), { occurredAt: old }),
        ),
        // …then recent dismissals.
        ...Array.from({ length: 4 }, () =>
          interaction('JOB_DISMISSED', job({ industries: ['fintech'] }), { occurredAt: NOW }),
        ),
      ],
      { now: NOW },
    );

    const fintech = affinities.find((a) => a.dimension === 'industry' && a.value === 'fintech')!;
    // Without decay the eight old saves would still dominate.
    expect(fintech.affinity).toBeLessThan(0);
  });

  it('does not decay explicit preferences — they are not in this system at all', () => {
    // Structural: preferences are a separate store. Affinities decay; the
    // preference object passed in is returned untouched by every function here.
    const explicit = preferences();
    const before = JSON.stringify(explicit);
    computeAffinities([interaction('JOB_SAVED', job())], { preferences: explicit, now: NOW });
    expect(JSON.stringify(explicit)).toBe(before);
  });
});

// ── Rejection reasons ───────────────────────────────────────────────────────

describe('rejection reasons', () => {
  it('applies a targeted rejection only to its own dimension', () => {
    const attributes = job({ companyName: 'Northwind', salaryAnnualUsd: 45_000 });

    const affinities = computeAffinities(
      [
        interaction('JOB_REJECTED', attributes, { rejectionReason: 'SALARY_TOO_LOW' }),
      ],
      { now: NOW },
    );

    // The salary band is marked down…
    const band = affinities.find((a) => a.dimension === 'salary_band');
    expect(band?.affinity).toBeLessThan(0);

    // …and the company is not, because the rejection said nothing about it.
    expect(affinities.some((a) => a.dimension === 'company')).toBe(false);
  });

  it('treats "already applied" as state rather than a preference signal', () => {
    const affinities = computeAffinities(
      [interaction('JOB_REJECTED', job(), { rejectionReason: 'ALREADY_APPLIED' })],
      { now: NOW },
    );
    expect(affinities).toHaveLength(0);
  });

  it('spreads an untargeted rejection across the job’s features', () => {
    const affinities = computeAffinities(
      [interaction('JOB_REJECTED', job(), { rejectionReason: 'NOT_INTERESTED' })],
      { now: NOW },
    );
    expect(affinities.length).toBeGreaterThan(1);
    expect(affinities.every((a) => a.affinity < 0)).toBe(true);
  });
});

// ── Affinity dimensions ─────────────────────────────────────────────────────

describe('affinity by dimension', () => {
  const repeated = (attributes: () => JobAttributes, count: number, type: BehaviorEventType) =>
    computeAffinities(
      Array.from({ length: count }, () => interaction(type, attributes())),
      { now: NOW },
    );

  it('builds company affinity without recommending everything from that company', () => {
    const affinities = repeated(() => job({ companyName: 'Northwind' }), 10, 'JOB_SAVED');
    const company = affinities.find((a) => a.dimension === 'company')!;

    expect(company.affinity).toBeGreaterThan(0.5);
    // Bounded: affinity is one input to a score, never a bypass.
    expect(company.confidence).toBeLessThanOrEqual(0.9);
  });

  it('builds technology affinity separately from skill', () => {
    const affinities = repeated(() => job({ technologies: ['Rust'] }), 10, 'JOB_CLICKED');
    const rust = affinities.find((a) => a.value === 'rust')!;

    expect(rust.dimension).toBe('technology');
    // Interest, not expertise: nothing here writes to the skills profile.
    expect(rust.affinity).toBeGreaterThan(0);
  });

  it('builds location affinity', () => {
    const affinities = repeated(() => job({ city: 'Berlin' }), 8, 'JOB_SAVED');
    expect(affinities.find((a) => a.dimension === 'location' && a.value === 'berlin')).toBeDefined();
  });

  it('learns salary bands from opposing behaviour', () => {
    const affinities = computeAffinities(
      [
        ...Array.from({ length: 6 }, () =>
          interaction('JOB_SAVED', job({ salaryAnnualUsd: 95_000 })),
        ),
        ...Array.from({ length: 6 }, () =>
          interaction('JOB_DISMISSED', job({ salaryAnnualUsd: 45_000 })),
        ),
      ],
      { now: NOW },
    );

    const high = affinities.find((a) => a.dimension === 'salary_band' && a.value === '80-100k')!;
    const low = affinities.find((a) => a.dimension === 'salary_band' && a.value === '40-60k')!;

    expect(high.affinity).toBeGreaterThan(0);
    expect(low.affinity).toBeLessThan(0);
  });

  it('weights a primary technology above a peripheral one', () => {
    const attributes = job({ technologies: ['React', 'A', 'B', 'C', 'D', 'E', 'F', 'Git'] });
    const features = extractFeatures(attributes);

    const react = features.find((f) => f.value === 'react')!;
    const git = features.find((f) => f.value === 'git')!;
    expect(react.salience).toBeGreaterThan(git.salience);
  });

  it('strips seniority words from title tokens to avoid double-counting', () => {
    expect(titleTokens('Senior Frontend Engineer')).toEqual(['frontend', 'engineer']);
    expect(salaryBand(95_000)).toBe('80-100k');
    expect(salaryBand(null)).toBeNull();
  });
});

// ── Cold start ──────────────────────────────────────────────────────────────

describe('cold start', () => {
  it('reports insufficient data rather than inventing preferences', () => {
    const profile = buildBehavioralProfile(
      CANDIDATE,
      [interaction('JOB_VIEWED', job())],
      { now: NOW },
    );

    expect(profile.hasSufficientData).toBe(false);
    expect(profile.coldStartReason).toContain('interaction');
    expect(profile.coldStartReason).toContain('explicit preferences');
  });

  it('applies no adjustment at all during cold start', () => {
    const attributes = job();
    const adjustment = computeBehavioralAdjustment({
      jobId: attributes.jobId,
      features: extractFeatures(attributes),
      affinities: [
        {
          dimension: 'technology',
          value: 'react',
          affinity: 0.9,
          confidence: 0.8,
          sampleSize: 3,
          positiveEvents: 3,
          negativeEvents: 0,
          evidence: 2,
          firstObservedAt: NOW,
          lastObservedAt: NOW,
          lastUpdated: NOW,
          conflictsWithExplicit: false,
          explicitValue: null,
          algorithmVersion: LEARNING_ALGORITHM_VERSION,
          featureVersion: '1.0.0',
        },
      ],
      preferences: preferences(),
      hasSufficientData: false,
      coldStartReason: 'Only 3 interactions recorded.',
    });

    expect(adjustment.adjustment).toBe(0);
    expect(adjustment.contributions).toHaveLength(0);
    expect(adjustment.explanation).toContain('3 interactions');
  });

  it('becomes sufficient once enough events accumulate', () => {
    const profile = buildBehavioralProfile(
      CANDIDATE,
      Array.from({ length: 12 }, () => interaction('JOB_SAVED', job())),
      { now: NOW },
    );
    expect(profile.hasSufficientData).toBe(true);
    expect(profile.coldStartReason).toBeNull();
  });
});

// ── Freeze and reset ────────────────────────────────────────────────────────

describe('freeze and reset', () => {
  it('stops updating affinities when frozen, without discarding them', () => {
    const existing = computeAffinities(
      Array.from({ length: 10 }, () => interaction('JOB_SAVED', job())),
      { now: NOW },
    );

    const merged = mergeAffinities(
      existing,
      Array.from({ length: 10 }, () => interaction('JOB_DISMISSED', job({ technologies: ['Rust'] }))),
      { config: { frozen: true }, now: NOW },
    );

    // Unchanged: same values, and nothing new learned.
    expect(merged).toEqual(existing);
    expect(merged.some((a) => a.value === 'rust')).toBe(false);
  });

  it('applies no adjustment when personalization is switched off', () => {
    const attributes = job();
    const adjustment = computeBehavioralAdjustment({
      jobId: attributes.jobId,
      features: extractFeatures(attributes),
      affinities: computeAffinities(
        Array.from({ length: 20 }, () => interaction('JOB_SAVED', job())),
        { now: NOW },
      ),
      preferences: preferences(),
      config: { enabled: false },
      hasSufficientData: true,
    });

    expect(adjustment.adjustment).toBe(0);
    expect(adjustment.explanation).toContain('switched off');
    expect(adjustment.explanation).toContain('explicit preferences');
  });

  it('learns nothing while disabled', () => {
    const profile = buildBehavioralProfile(
      CANDIDATE,
      Array.from({ length: 30 }, () => interaction('JOB_SAVED', job())),
      { config: { enabled: false }, now: NOW },
    );

    expect(profile.affinities).toHaveLength(0);
    expect(profile.hasSufficientData).toBe(false);
    expect(profile.coldStartReason).toContain('switched off');
  });
});

// ── Merging ─────────────────────────────────────────────────────────────────

describe('incremental merging', () => {
  it('combines batches by evidence rather than overwriting', () => {
    const first = computeAffinities(
      Array.from({ length: 10 }, () => interaction('JOB_SAVED', job())),
      { now: NOW },
    );
    const merged = mergeAffinities(
      first,
      [interaction('JOB_DISMISSED', job())],
      { now: NOW },
    );

    const react = merged.find((a) => a.value === 'react')!;
    // Ten saves are not overturned by one dismissal, but the dismissal does
    // register — the evidence floor applies to the merged total, not the batch,
    // so a weak signal can still accumulate one event at a time.
    expect(react.affinity).toBeGreaterThan(0.3);
    expect(react.sampleSize).toBe(11);
  });

  it('decays stored evidence when time has passed', () => {
    const first = computeAffinities(
      Array.from({ length: 10 }, () => interaction('JOB_SAVED', job())),
      { now: NOW },
    );

    const later = new Date(NOW.getTime() + 90 * 86_400_000);
    const merged = mergeAffinities(first, [], { now: later });

    const before = first.find((a) => a.value === 'react')!;
    const after = merged.find((a) => a.value === 'react')!;
    expect(after.evidence).toBeLessThan(before.evidence);
    expect(after.confidence).toBeLessThan(before.confidence);
  });
});

// ── Exploration ─────────────────────────────────────────────────────────────

describe('exploration', () => {
  const affinities = computeAffinities(
    Array.from({ length: 15 }, () => interaction('JOB_SAVED', job())),
    { now: NOW },
  );

  it('scores an unfamiliar job as novel', () => {
    const familiar = noveltyScore(extractFeatures(job()), affinities);
    const unfamiliar = noveltyScore(
      extractFeatures(
        job({
          companyName: 'Unknown Co',
          technologies: ['Elixir'],
          city: 'Lisbon',
          countryCode: 'PT',
          industries: ['healthcare'],
          title: 'Backend Engineer',
          sourceId: 'other',
        }),
      ),
      affinities,
    );

    expect(unfamiliar.score).toBeGreaterThan(familiar.score);
    expect(unfamiliar.novel.length).toBeGreaterThan(0);
  });

  it('never explores something the candidate confidently dislikes', () => {
    const disliked = computeAffinities(
      Array.from({ length: 20 }, () => interaction('JOB_REJECTED', job({ technologies: ['PHP'] }))),
      { now: NOW },
    );

    const novelty = noveltyScore(extractFeatures(job({ technologies: ['PHP'] })), disliked);
    expect(novelty.score).toBe(0);
  });

  it('reserves the configured share of slots', () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      jobId: jobId(),
      rank: index + 1,
      score: 100 - index,
      features: extractFeatures(
        job({
          companyName: `Company ${index}`,
          technologies: [`Tech${index}`],
          city: `City ${index}`,
          title: `Role ${index}`,
        }),
      ),
      eligible: true,
    }));

    const result = selectExploration(candidates, affinities, {
      config: { exploration: 'balanced' },
      resultSize: 20,
    });

    expect(result.slots).toBe(3);
    expect(result.selected.length).toBeGreaterThan(0);
    // Only from below the exploitation cut.
    expect(result.selected.every((entry) => entry.originalRank > 17)).toBe(true);
  });

  it('honours aggressiveness levels and the off switch', () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      jobId: jobId(),
      rank: index + 1,
      score: 100 - index,
      features: extractFeatures(job({ companyName: `C${index}`, technologies: [`T${index}`] })),
      eligible: true,
    }));

    const conservative = selectExploration(candidates, affinities, {
      config: { exploration: 'conservative' },
      resultSize: 20,
    });
    const aggressive = selectExploration(candidates, affinities, {
      config: { exploration: 'aggressive' },
      resultSize: 20,
    });
    const off = selectExploration(candidates, affinities, {
      config: { exploration: 'off' },
      resultSize: 20,
    });

    expect(conservative.slots).toBeLessThan(aggressive.slots);
    expect(off.slots).toBe(0);
    expect(off.selected).toHaveLength(0);
  });

  it('never explores an ineligible job', () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      jobId: jobId(),
      rank: index + 1,
      score: 100 - index,
      features: extractFeatures(job({ companyName: `C${index}`, technologies: [`T${index}`] })),
      // Everything below the cut failed a hard constraint.
      eligible: index < 17,
    }));

    const result = selectExploration(candidates, affinities, { resultSize: 20 });
    expect(result.selected).toHaveLength(0);
  });
});

// ── Suggestions ─────────────────────────────────────────────────────────────

describe('preference suggestions', () => {
  it('suggests rather than applies a contradicted preference', () => {
    const explicit = preferences({ workArrangement: 'ONSITE_PREFERRED' });
    const before = JSON.stringify(explicit);

    const affinities = computeAffinities(
      [
        ...Array.from({ length: 14 }, () =>
          interaction('JOB_SAVED', job({ remoteType: 'remote' })),
        ),
        ...Array.from({ length: 12 }, () =>
          interaction('JOB_DISMISSED', job({ remoteType: 'onsite' })),
        ),
      ],
      { preferences: explicit, now: NOW },
    );

    const suggestions = generateSuggestions({
      candidateId: CANDIDATE,
      preferences: explicit,
      affinities,
      now: NOW,
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.status === 'pending')).toBe(true);
    // The preferences object is untouched — this is the whole point.
    expect(JSON.stringify(explicit)).toBe(before);
  });

  it('states the evidence, not just the conclusion', () => {
    const affinities = computeAffinities(
      Array.from({ length: 14 }, () => interaction('JOB_SAVED', job({ technologies: ['Rust'] }))),
      { now: NOW },
    );

    const suggestions = generateSuggestions({
      candidateId: CANDIDATE,
      preferences: preferences(),
      affinities,
      now: NOW,
    });

    const rust = suggestions.find((s) => s.path.includes('rust'));
    expect(rust).toBeDefined();
    expect(rust!.evidence.supporting).toBeGreaterThan(0);
    expect(rust!.message).toMatch(/\d+ role\(s\)/);
  });

  it('never suggests lowering a salary floor', () => {
    const explicit = candidatePreferencesSchema.parse({
      salary: { minimum: 100_000, currency: 'USD', period: 'year' },
    });

    const affinities = computeAffinities(
      [
        ...Array.from({ length: 8 }, () =>
          interaction('JOB_SAVED', job({ salaryAnnualUsd: 45_000 })),
        ),
        ...Array.from({ length: 8 }, () =>
          interaction('JOB_DISMISSED', job({ salaryAnnualUsd: 150_000 })),
        ),
      ],
      { now: NOW },
    );

    const suggestions = generateSuggestions({
      candidateId: CANDIDATE,
      preferences: explicit,
      affinities,
      now: NOW,
    });

    expect(suggestions.some((s) => s.path === 'salary.minimum')).toBe(false);
  });

  it('suggests raising a salary floor when behaviour is clean', () => {
    const explicit = candidatePreferencesSchema.parse({
      salary: { minimum: 40_000, currency: 'USD', period: 'year' },
    });

    const affinities = computeAffinities(
      [
        ...Array.from({ length: 10 }, () =>
          interaction('JOB_SAVED', job({ salaryAnnualUsd: 95_000 })),
        ),
        ...Array.from({ length: 10 }, () =>
          interaction('JOB_DISMISSED', job({ salaryAnnualUsd: 45_000 })),
        ),
      ],
      { now: NOW },
    );

    const suggestions = generateSuggestions({
      candidateId: CANDIDATE,
      preferences: explicit,
      affinities,
      now: NOW,
    });

    const salary = suggestions.find((s) => s.path === 'salary.minimum');
    expect(salary).toBeDefined();
    expect(Number(salary!.suggestedValue)).toBeGreaterThan(40_000);
    expect(salary!.message).toContain('Would you like');
  });

  it('never re-offers a declined suggestion', () => {
    const affinities = computeAffinities(
      Array.from({ length: 14 }, () => interaction('JOB_SAVED', job({ technologies: ['Rust'] }))),
      { now: NOW },
    );

    const suggestions = generateSuggestions({
      candidateId: CANDIDATE,
      preferences: preferences(),
      affinities,
      declinedPaths: ['technologies.rust'],
      now: NOW,
    });

    expect(suggestions.some((s) => s.path === 'technologies.rust')).toBe(false);
  });

  it('offers nothing on thin evidence', () => {
    const affinities = computeAffinities([interaction('JOB_SAVED', job())], { now: NOW });
    expect(
      generateSuggestions({
        candidateId: CANDIDATE,
        preferences: preferences(),
        affinities,
        now: NOW,
      }),
    ).toHaveLength(0);
  });
});

// ── Ranking adjustment ──────────────────────────────────────────────────────

describe('behavioral ranking adjustment', () => {
  const learned = computeAffinities(
    [
      ...Array.from({ length: 15 }, () => interaction('JOB_SAVED', job())),
      ...Array.from({ length: 12 }, () =>
        interaction(
          'JOB_DISMISSED',
          job({
            technologies: ['Go'],
            title: 'Backend Engineer',
            companyName: 'Helios',
            city: 'Munich',
            countryCode: 'AT',
            remoteType: 'onsite',
            seniority: 'junior',
            industries: ['logistics'],
            salaryAnnualUsd: 45_000,
            sourceId: 'other-board',
          }),
        ),
      ),
    ],
    { now: NOW },
  );

  it('boosts a job resembling what the candidate engages with', () => {
    const attributes = job();
    const adjustment = computeBehavioralAdjustment({
      jobId: attributes.jobId,
      features: extractFeatures(attributes),
      affinities: learned,
      preferences: null,
      hasSufficientData: true,
    });

    expect(adjustment.adjustment).toBeGreaterThan(0);
    expect(adjustment.explanation).toContain('higher');
    expect(adjustment.contributions.length).toBeGreaterThan(0);
  });

  it('lowers a job resembling what they pass over', () => {
    // Differs from the liked jobs on every learned dimension, not just the
    // technology — otherwise the shared location, seniority and source would
    // (correctly) outweigh one negative signal.
    const attributes = job({
      technologies: ['Go'],
      title: 'Backend Engineer',
      companyName: 'Helios',
      city: 'Munich',
      countryCode: 'AT',
      remoteType: 'onsite',
      seniority: 'junior',
      industries: ['logistics'],
      salaryAnnualUsd: 45_000,
      sourceId: 'other-board',
    });

    const adjustment = computeBehavioralAdjustment({
      jobId: attributes.jobId,
      features: extractFeatures(attributes),
      affinities: learned,
      preferences: null,
      hasSufficientData: true,
    });

    expect(adjustment.adjustment).toBeLessThan(0);
    expect(adjustment.explanation).toContain('lower');
  });

  it('stays within the configured bound', () => {
    const attributes = job();
    const adjustment = computeBehavioralAdjustment({
      jobId: attributes.jobId,
      features: extractFeatures(attributes),
      affinities: learned,
      preferences: null,
      config: { maxBehavioralAdjustment: 5 },
      hasSufficientData: true,
    });

    expect(Math.abs(adjustment.adjustment)).toBeLessThanOrEqual(5);
  });

  it('explains itself from structured data, never as model prose', () => {
    const attributes = job();
    const adjustment = computeBehavioralAdjustment({
      jobId: attributes.jobId,
      features: extractFeatures(attributes),
      affinities: learned,
      preferences: null,
      hasSufficientData: true,
    });

    for (const contribution of adjustment.contributions) {
      // Every explanation names the value and cites a count.
      expect(contribution.explanation).toContain(contribution.value);
      expect(contribution.explanation).toMatch(/\d+ interaction/);
    }
    expect(adjustment.algorithmVersion).toBe(LEARNING_ALGORITHM_VERSION);
  });
});

// ── Query, source and analytics ─────────────────────────────────────────────

describe('query and source learning', () => {
  it('ranks a productive query above a high-volume one', () => {
    const productive = scoreQueryPerformance({
      queryId: 'react-germany',
      candidateId: CANDIDATE,
      counts: {
        jobsDiscovered: 20,
        jobsShown: 20,
        views: 12,
        clicks: 5,
        saves: 3,
        applications: 2,
        rejections: 0,
      },
    });

    const noisy = scoreQueryPerformance({
      queryId: 'javascript-germany',
      candidateId: CANDIDATE,
      counts: {
        jobsDiscovered: 100,
        jobsShown: 100,
        views: 0,
        clicks: 0,
        saves: 0,
        applications: 0,
        rejections: 0,
      },
    });

    expect(productive.valueScore).toBeGreaterThan(noisy.valueScore);
    expect(noisy.valueScore).toBe(0);
    expect(productive.explanation).toContain('application');
  });

  it('separates user value from technical reliability', () => {
    const reliableButUseless = scoreSourceUserValue({
      sourceId: 'high-volume-board',
      candidateId: CANDIDATE,
      counts: {
        jobsDiscovered: 1_000,
        jobsShown: 200,
        views: 3,
        clicks: 3,
        saves: 0,
        applications: 0,
        rejections: 0,
      },
    });

    const smallButValuable = scoreSourceUserValue({
      sourceId: 'niche-board',
      candidateId: CANDIDATE,
      counts: {
        jobsDiscovered: 100,
        jobsShown: 60,
        views: 20,
        clicks: 10,
        saves: 4,
        applications: 2,
        rejections: 0,
      },
    });

    expect(smallButValuable.userValueScore).toBeGreaterThan(reliableButUseless.userValueScore);
    expect(reliableButUseless.explanation).toContain('not useful to you');
  });

  it('computes funnel rates against what was shown', () => {
    const metrics = computeEngagementMetrics({
      candidateId: CANDIDATE,
      windowDays: 30,
      recommendationsShown: 100,
      views: 40,
      clicks: 20,
      saves: 8,
      rejections: 5,
      applications: 3,
      acceptedJobs: 22,
    });

    expect(metrics.clickRate).toBeCloseTo(0.2, 3);
    expect(metrics.saveRate).toBeCloseTo(0.08, 3);
    expect(metrics.acceptanceRate).toBeCloseTo(0.22, 3);
  });

  it('computes Precision@K and names recall for what it measures', () => {
    const quality = computeRankingQuality({
      candidateId: CANDIDATE,
      k: 10,
      windowDays: 30,
      shownAtK: 10,
      interactions: [
        { jobId: 'a', rank: 1, clicked: true, saved: true, applied: false },
        { jobId: 'b', rank: 3, clicked: true, saved: false, applied: false },
        { jobId: 'c', rank: 9, clicked: false, saved: true, applied: true },
        { jobId: 'd', rank: 25, clicked: true, saved: false, applied: false },
      ],
    });

    expect(quality.precisionAtK).toBeCloseTo(0.3, 3);
    expect(quality.saveAtK).toBeCloseTo(0.2, 3);
    expect(quality.applyAtK).toBeCloseTo(0.1, 3);
    // Three of four engaged jobs were in the top ten.
    expect(quality.recallOfEngaged).toBeCloseTo(0.75, 3);
  });
});

// ── Versioning ──────────────────────────────────────────────────────────────

describe('algorithm versioning', () => {
  it('stamps every affinity and adjustment with its versions', () => {
    const affinities = computeAffinities(
      Array.from({ length: 10 }, () => interaction('JOB_SAVED', job())),
      { now: NOW },
    );

    for (const affinity of affinities) {
      expect(affinity.algorithmVersion).toBe(LEARNING_ALGORITHM_VERSION);
      expect(affinity.featureVersion).toBeTruthy();
    }

    const profile = buildBehavioralProfile(CANDIDATE, [], { now: NOW });
    expect(profile.algorithmVersion).toBe(LEARNING_ALGORITHM_VERSION);
  });

  it('lets a config version be carried through to stored values', () => {
    const affinities = computeAffinities(
      Array.from({ length: 10 }, () => interaction('JOB_SAVED', job())),
      { config: { algorithmVersion: '2.0.0' }, now: NOW },
    );
    expect(affinities[0]!.algorithmVersion).toBe('2.0.0');
  });
});

/**
 * The bridge into ranking.
 *
 * `computeBehavioralAdjustment` existed and was correct from prompt 11, but
 * nothing called it — the recommendation service still used only the older
 * per-job signal, so a learned affinity for a technology could never influence
 * a job the candidate had not already interacted with. These tests pin the
 * properties the ranker now depends on.
 */
describe('adjustment as a ranking input', () => {
  const affinityFor = (value: string, affinity: number): FeatureAffinity => ({
    dimension: 'technology',
    value,
    affinity,
    confidence: 0.8,
    sampleSize: 25,
    positiveEvents: affinity > 0 ? 25 : 0,
    negativeEvents: affinity > 0 ? 0 : 25,
    evidence: 15,
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    lastUpdated: NOW,
    conflictsWithExplicit: false,
    explicitValue: null,
    algorithmVersion: LEARNING_ALGORITHM_VERSION,
    featureVersion: '1.0.0',
  });

  const jobWith = (technologies: string[]): JobAttributes => ({
    jobId: '11111111-2222-4333-8444-555555555555',
    title: 'Senior Engineer',
    companyName: 'Acme',
    countryCode: 'GB',
    city: 'London',
    remoteType: 'remote',
    employmentTypes: ['full_time'],
    seniority: 'senior',
    technologies,
    industries: [],
    salaryAnnualUsd: 120_000,
    sourceId: 'greenhouse',
    companySize: null,
  });

  it('moves a job the candidate has never seen, on a learned technology', () => {
    const adjustment = computeBehavioralAdjustment({
      jobId: '11111111-2222-4333-8444-555555555555',
      features: extractFeatures(jobWith(['Rust'])),
      affinities: [affinityFor('rust', 0.8)],
      preferences: null,
      hasSufficientData: true,
    });

    expect(adjustment.adjustment).toBeGreaterThan(0);
    expect(adjustment.contributions.length).toBeGreaterThan(0);
  });

  it('stays inside the configured ceiling in both directions', () => {
    const config = learningConfigSchema.parse({ maxBehavioralAdjustment: 6 });

    const strong = [
      affinityFor('rust', 1),
      affinityFor('go', 1),
      affinityFor('kubernetes', 1),
      affinityFor('terraform', 1),
    ];

    const up = computeBehavioralAdjustment({
      jobId: '11111111-2222-4333-8444-555555555555',
      features: extractFeatures(jobWith(['Rust', 'Go', 'Kubernetes', 'Terraform'])),
      affinities: strong,
      preferences: null,
      config,
      hasSufficientData: true,
    });

    const down = computeBehavioralAdjustment({
      jobId: '11111111-2222-4333-8444-555555555555',
      features: extractFeatures(jobWith(['Rust', 'Go', 'Kubernetes', 'Terraform'])),
      affinities: strong.map((entry) => ({ ...entry, affinity: -1 })),
      preferences: null,
      config,
      hasSufficientData: true,
    });

    // The ranker divides by this ceiling to reach its -1..1 input, so a value
    // outside it would silently exceed the influence the config permits.
    expect(Math.abs(up.adjustment)).toBeLessThanOrEqual(6);
    expect(Math.abs(down.adjustment)).toBeLessThanOrEqual(6);
    expect(up.adjustment).toBeGreaterThan(0);
    expect(down.adjustment).toBeLessThan(0);
  });

  it('returns zero with a stated reason when learning is switched off', () => {
    const adjustment = computeBehavioralAdjustment({
      jobId: '11111111-2222-4333-8444-555555555555',
      features: extractFeatures(jobWith(['Rust'])),
      affinities: [affinityFor('rust', 0.9)],
      preferences: null,
      config: learningConfigSchema.parse({ enabled: false }),
      hasSufficientData: true,
    });

    expect(adjustment.adjustment).toBe(0);
    expect(adjustment.explanation).toMatch(/switched off/i);
  });

  it('returns zero during cold start rather than guessing', () => {
    const adjustment = computeBehavioralAdjustment({
      jobId: '11111111-2222-4333-8444-555555555555',
      features: extractFeatures(jobWith(['Rust'])),
      affinities: [],
      preferences: null,
      hasSufficientData: false,
    });

    expect(adjustment.adjustment).toBe(0);
    expect(adjustment.authorityTrace.length).toBeGreaterThan(0);
  });

  it('refuses to move a job on a dimension the candidate stated explicitly', () => {
    const explicit = preferences({
      technologies: [
        { value: 'Rust', strength: 'excluded', hard: false, note: null, source: 'explicit' },
      ],
    });

    const adjustment = computeBehavioralAdjustment({
      jobId: '11111111-2222-4333-8444-555555555555',
      features: extractFeatures(jobWith(['Rust'])),
      affinities: [{ ...affinityFor('rust', 0.95), conflictsWithExplicit: true, explicitValue: 'rust' }],
      preferences: explicit,
      hasSufficientData: true,
    });

    // The absolute principle, at the exact point where ranking would apply it.
    expect(adjustment.adjustment).toBe(0);
  });
});
