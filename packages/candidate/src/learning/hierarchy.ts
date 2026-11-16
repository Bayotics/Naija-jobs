import {
  LEARNING_ALGORITHM_VERSION,
  PREFERENCE_AUTHORITY,
  behavioralAdjustmentSchema,
  learningConfigSchema,
  type BehavioralAdjustment,
  type BehavioralContribution,
  type CandidatePreferences,
  type FeatureAffinity,
  type FeatureDimension,
  type JobFeature,
  type LearningConfig,
  type PreferenceLayer,
} from '@job-intel/contracts';
import { featureKey } from './features';
import { explicitValuesFor } from './affinity';

/**
 * The preference hierarchy.
 *
 * This module is the absolute principle expressed as code. The rule —
 * *learned behaviour never silently overrides an explicit preference* — is not
 * a convention observed at call sites; it is `resolveAuthority`, which every
 * behavioural adjustment must pass through, and which records in the returned
 * trace exactly which layer decided and why.
 *
 * The ordering, highest authority first:
 *
 *   1. explicit hard constraints  — never negotiable, and not this module's job
 *      (the matching engine enforces them before ranking begins)
 *   2. explicit preferences        — what the candidate said they want
 *   3. explicit exclusions         — what they said they do not want
 *   4. learned behavioural signals — what their clicks suggest
 *   5. general optimization        — quality, freshness, diversity
 *
 * A learned signal that contradicts a higher layer is *suppressed and
 * reported*, never applied. The report is what becomes a preference suggestion:
 * the candidate is told what their behaviour suggests and offered the change,
 * which is the only legitimate way for layer 4 to affect layer 2.
 */

export interface AuthorityDecision {
  /** Whether the learned signal may be applied at all. */
  applied: boolean;
  /** The layer that decided. */
  layer: PreferenceLayer;
  detail: string;
}

/**
 * Decides whether one learned affinity may influence ranking.
 *
 * Note what this deliberately does *not* do: it never adjusts the explicit
 * preference, never averages the two, and never "compromises". A contradiction
 * is resolved entirely in favour of the explicit statement, and the
 * contradiction itself is surfaced elsewhere as a suggestion.
 */
export function resolveAuthority(
  affinity: FeatureAffinity,
  preferences: CandidatePreferences | null,
): AuthorityDecision {
  const explicit = explicitValuesFor(preferences, affinity.dimension);
  const value = affinity.value.toLowerCase();

  // Layer 3: an explicit exclusion. Behaviour cannot resurrect it.
  if (explicit.negatives.has(value)) {
    return affinity.affinity > 0
      ? {
          applied: false,
          layer: 'explicit_exclusion',
          detail:
            `You excluded "${affinity.value}", so the positive signal from your behaviour is ` +
            `not applied. It is offered as a suggestion instead.`,
        }
      : {
          applied: true,
          layer: 'explicit_exclusion',
          detail: `Your behaviour agrees with your exclusion of "${affinity.value}".`,
        };
  }

  // Layer 2: an explicit preference. Behaviour cannot demote it.
  if (explicit.positives.has(value)) {
    return affinity.affinity < 0
      ? {
          applied: false,
          layer: 'explicit_preference',
          detail:
            `You asked for "${affinity.value}", so the negative signal from your behaviour is ` +
            `not applied. It is offered as a suggestion instead.`,
        }
      : {
          applied: true,
          layer: 'explicit_preference',
          detail: `Your behaviour reinforces your stated preference for "${affinity.value}".`,
        };
  }

  // Layer 4: nothing explicit covers this value, so behaviour may speak.
  return {
    applied: true,
    layer: 'learned_behavioral',
    detail: `Learned from your interactions; you have not stated a preference either way.`,
  };
}

export interface AdjustmentInput {
  jobId: string;
  features: readonly JobFeature[];
  affinities: readonly FeatureAffinity[];
  preferences: CandidatePreferences | null;
  config?: Partial<LearningConfig>;
  /** False during cold start; produces a zero adjustment with a stated reason. */
  hasSufficientData?: boolean;
  coldStartReason?: string | null;
}

/** Human-readable dimension names for the explanations. */
const DIMENSION_LABEL: Readonly<Record<FeatureDimension, string>> = {
  technology: 'technology',
  company: 'company',
  location: 'location',
  country: 'country',
  industry: 'industry',
  title_token: 'role',
  seniority: 'seniority',
  work_arrangement: 'work arrangement',
  employment_type: 'employment type',
  salary_band: 'salary range',
  source: 'source',
  company_size: 'company size',
};

/**
 * Computes the behavioural adjustment for one job.
 *
 * Returns points to *add* to the recommendation score. It never returns a
 * replacement score, and nothing here reads or writes `matchScore` — keeping
 * them separate is what makes "this job moved up because of your behaviour"
 * a statement anyone can verify by subtracting.
 */
export function computeBehavioralAdjustment(input: AdjustmentInput): BehavioralAdjustment {
  const config = learningConfigSchema.parse(input.config ?? {});
  const authorityTrace: BehavioralAdjustment['authorityTrace'] = [];

  // Layer 1 is enforced before ranking: an ineligible job never reaches here.
  authorityTrace.push({
    layer: 'explicit_hard_constraint',
    applied: true,
    detail: 'Hard constraints were enforced by the matching engine before ranking.',
  });

  if (!config.enabled) {
    return behavioralAdjustmentSchema.parse({
      jobId: input.jobId,
      adjustment: 0,
      rawAffinity: 0,
      confidence: 0,
      contributions: [],
      explanation: 'Personalization is switched off. Only your explicit preferences apply.',
      authorityTrace: [
        ...authorityTrace,
        {
          layer: 'learned_behavioral',
          applied: false,
          detail: 'Learning is disabled in your settings.',
        },
      ],
      algorithmVersion: config.algorithmVersion || LEARNING_ALGORITHM_VERSION,
    });
  }

  if (input.hasSufficientData === false) {
    return behavioralAdjustmentSchema.parse({
      jobId: input.jobId,
      adjustment: 0,
      rawAffinity: 0,
      confidence: 0,
      contributions: [],
      explanation:
        input.coldStartReason ??
        'Not enough interaction history yet, so ranking uses your explicit preferences, skills, ' +
          'job quality and freshness.',
      authorityTrace: [
        ...authorityTrace,
        {
          layer: 'learned_behavioral',
          applied: false,
          detail: 'Cold start: insufficient behavioural data.',
        },
      ],
      algorithmVersion: config.algorithmVersion || LEARNING_ALGORITHM_VERSION,
    });
  }

  const byKey = new Map(
    input.affinities.map((affinity) => [featureKey(affinity.dimension, affinity.value), affinity]),
  );

  const contributions: BehavioralContribution[] = [];
  const suppressed: string[] = [];
  let weighted = 0;
  let totalWeight = 0;

  for (const feature of input.features) {
    const affinity = byKey.get(featureKey(feature.dimension, feature.value));
    if (!affinity) continue;

    const decision = resolveAuthority(affinity, input.preferences);
    if (!decision.applied) {
      suppressed.push(decision.detail);
      authorityTrace.push({ layer: decision.layer, applied: false, detail: decision.detail });
      continue;
    }

    // Confidence and salience both scale the contribution. A confident signal
    // about a peripheral attribute should not outweigh an uncertain one about
    // the job's headline technology, and vice versa.
    const weight = affinity.confidence * feature.salience;
    if (weight <= 0) continue;

    weighted += affinity.affinity * weight;
    totalWeight += weight;

    contributions.push({
      dimension: affinity.dimension,
      value: affinity.value,
      affinity: affinity.affinity,
      confidence: affinity.confidence,
      contribution: 0, // filled in below, once the scale is known
      explanation: describeContribution(affinity, feature.dimension),
    });
  }

  if (totalWeight === 0) {
    return behavioralAdjustmentSchema.parse({
      jobId: input.jobId,
      adjustment: 0,
      rawAffinity: 0,
      confidence: 0,
      contributions: [],
      explanation:
        suppressed.length > 0
          ? `Your behaviour suggested a change here, but your explicit preferences take priority. ${suppressed[0]}`
          : 'Nothing in your interaction history relates to this job yet.',
      authorityTrace,
      algorithmVersion: config.algorithmVersion || LEARNING_ALGORITHM_VERSION,
    });
  }

  const rawAffinity = Math.max(-1, Math.min(1, weighted / totalWeight));
  // Overall confidence is the mean weight, capped: many weak signals should not
  // add up to certainty.
  const confidence = Math.min(config.maxConfidence, totalWeight / input.features.length);

  const adjustment = Number(
    (rawAffinity * confidence * config.maxBehavioralAdjustment).toFixed(2),
  );

  // Distribute the adjustment across contributions proportionally, so the
  // displayed numbers sum to the applied one rather than merely gesturing at it.
  for (const contribution of contributions) {
    const share = (contribution.affinity * contribution.confidence) / (weighted || 1);
    contribution.contribution = Number((adjustment * Math.abs(share)).toFixed(2)) *
      (contribution.affinity >= 0 ? 1 : -1);
  }

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  authorityTrace.push({
    layer: 'learned_behavioral',
    applied: true,
    detail: `${contributions.length} learned signal(s) applied, bounded to ±${config.maxBehavioralAdjustment} points.`,
  });

  return behavioralAdjustmentSchema.parse({
    jobId: input.jobId,
    adjustment,
    rawAffinity: Number(rawAffinity.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    contributions: contributions.slice(0, 8),
    explanation: explain(adjustment, contributions, suppressed),
    authorityTrace,
    algorithmVersion: config.algorithmVersion || LEARNING_ALGORITHM_VERSION,
  });
}

/**
 * One structured sentence per signal.
 *
 * Generated from the stored numbers, never from a model. The brief rules out
 * exposing chain-of-thought, and this is the alternative: an explanation that
 * is a rendering of the data rather than a narration of a process.
 */
function describeContribution(affinity: FeatureAffinity, dimension: FeatureDimension): string {
  const label = DIMENSION_LABEL[dimension] ?? dimension;
  const strength =
    Math.abs(affinity.affinity) > 0.6 ? 'strongly' : Math.abs(affinity.affinity) > 0.3 ? '' : 'slightly';
  const direction = affinity.affinity >= 0 ? 'engaged with' : 'passed over';

  return (
    `You have ${strength} ${direction} ${label} "${affinity.value}" ` +
    `across ${affinity.sampleSize} interaction(s) (confidence ${Math.round(affinity.confidence * 100)}%).`
  ).replace(/\s+/g, ' ');
}

function explain(
  adjustment: number,
  contributions: readonly BehavioralContribution[],
  suppressed: readonly string[],
): string {
  if (contributions.length === 0) {
    return 'No behavioural signal applied to this job.';
  }

  const top = contributions
    .slice(0, 3)
    .map((contribution) => `${contribution.value}`)
    .join(', ');

  const base =
    adjustment > 0
      ? `Ranked ${adjustment.toFixed(1)} points higher because you have previously engaged with similar roles (${top}).`
      : adjustment < 0
        ? `Ranked ${Math.abs(adjustment).toFixed(1)} points lower because you have repeatedly passed over similar roles (${top}).`
        : `Your behaviour is neutral on this job.`;

  return suppressed.length > 0 ? `${base} ${suppressed[0]}` : base;
}

/** Authority ordering, for callers that need to sort or compare layers. */
export function compareLayers(a: PreferenceLayer, b: PreferenceLayer): number {
  return PREFERENCE_AUTHORITY[a] - PREFERENCE_AUTHORITY[b];
}
