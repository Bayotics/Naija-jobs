import {
  DEFAULT_CONTEXT_WEIGHTS,
  DEFAULT_SIGNAL_WEIGHTS,
  FEATURE_VERSION,
  LEARNING_ALGORITHM_VERSION,
  REJECTION_DIMENSION,
  behavioralProfileSchema,
  featureAffinitySchema,
  learningConfigSchema,
  type BehaviorEvent,
  type BehaviorEventType,
  type BehavioralProfile,
  type CandidatePreferences,
  type EventContext,
  type FeatureAffinity,
  type FeatureDimension,
  type JobFeature,
  type LearningConfig,
  type SignalWeight,
} from '@job-intel/contracts';
import { featureKey, parseFeatureKey } from './features';

/**
 * The affinity engine.
 *
 * Turns a stream of interactions into per-feature affinities. Deliberately
 * deterministic arithmetic rather than a model: it runs on every event ingest,
 * it has to be explainable to the person it is describing, and a gradient step
 * nobody can read is not something to point at someone's job search.
 *
 * Three ideas do the work:
 *
 *  1. **Affinity and confidence are separate numbers.** Affinity is what the
 *     behaviour says; confidence is how much to believe it. One save yields
 *     affinity 0.7 at confidence ~0.13 — a strong opinion held weakly. The
 *     ranking layer multiplies by confidence, so one click cannot move
 *     anything. This is the single most important property here, and it is
 *     what "do not infer a strong preference from one event" means in code.
 *
 *  2. **Evidence decays, opinions do not.** Old events contribute less weight,
 *     via a half-life. A candidate who spent March saving fintech roles and has
 *     ignored them since is not still a fintech candidate.
 *
 *  3. **Salience scales evidence, not direction.** A job mentioning React
 *     first and Git eighth teaches more about React. Salience multiplies the
 *     evidence weight; it never changes the sign.
 */

export interface AffinityEventInput {
  event: BehaviorEvent;
  /** Features of the job at the time of the interaction. */
  features: readonly JobFeature[];
}

export interface AffinityOptions {
  config?: Partial<LearningConfig>;
  /** Explicit preferences, to flag conflicts. Never modified. */
  preferences?: CandidatePreferences | null;
  now?: Date;
  /**
   * Skips the minimum-evidence floor.
   *
   * Used by `mergeAffinities`, and it matters: the queue processes events one
   * at a time, so applying the floor per *batch* would silently discard every
   * signal weaker than the floor before it ever had a chance to accumulate. A
   * single click would never become ten clicks. The floor belongs on the merged
   * total, which is where `mergeAffinities` applies it.
   */
  skipEvidenceFloor?: boolean;
}

interface Bucket {
  dimension: FeatureDimension;
  value: string;
  /** Σ polarity × evidence. */
  weighted: number;
  /** Σ evidence. The denominator, and the basis for confidence. */
  evidence: number;
  events: number;
  positives: number;
  negatives: number;
  first: Date | null;
  last: Date | null;
}

function weightFor(
  type: BehaviorEventType,
  config: LearningConfig,
): SignalWeight {
  const override = config.signalWeights[type];
  return override ?? DEFAULT_SIGNAL_WEIGHTS[type];
}

function contextWeight(context: EventContext, config: LearningConfig): number {
  return config.contextWeights[context] ?? DEFAULT_CONTEXT_WEIGHTS[context] ?? 1;
}

/**
 * Confidence from accumulated evidence.
 *
 * Saturating exponential: `1 - e^(-evidence / saturation)`, capped. Chosen over
 * a linear ramp because the difference between one observation and three is
 * enormous while the difference between thirty and forty is nearly nothing —
 * which is exactly how belief from evidence actually behaves.
 *
 * The cap matters independently: behaviour is inference, and inference should
 * never reach certainty. Even a hundred consistent saves leave room for the
 * candidate to mean something else.
 */
export function confidenceFromEvidence(evidence: number, config: LearningConfig): number {
  if (evidence <= 0) return 0;
  const raw = 1 - Math.exp(-evidence / config.confidenceSaturation);
  return Math.min(config.maxConfidence, Number(raw.toFixed(4)));
}

/** Exponential recency decay. Explicit preferences never pass through this. */
export function recencyWeight(occurredAt: Date, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - occurredAt.getTime()) / 86_400_000);
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

/**
 * Explicit values per dimension, for conflict detection.
 *
 * Read-only: this function exists so a learned signal can be *labelled* as
 * contradicting an explicit preference. It never reconciles them — that is the
 * hierarchy's job, and reconciliation here would be exactly the silent override
 * the whole design forbids.
 */
export function explicitValuesFor(
  preferences: CandidatePreferences | null,
  dimension: FeatureDimension,
): { positives: Set<string>; negatives: Set<string> } {
  const positives = new Set<string>();
  const negatives = new Set<string>();
  if (!preferences) return { positives, negatives };

  const collect = (
    entries: ReadonlyArray<{ value: string; strength: string }>,
  ): void => {
    for (const entry of entries) {
      const value = entry.value.trim().toLowerCase();
      if (entry.strength === 'excluded' || entry.strength === 'undesirable') negatives.add(value);
      else if (entry.strength !== 'neutral') positives.add(value);
    }
  };

  switch (dimension) {
    case 'technology':
      collect(preferences.technologies);
      break;
    case 'company':
      collect(preferences.companies);
      break;
    case 'country':
      collect(preferences.countries);
      break;
    case 'location':
      collect(preferences.cities);
      break;
    case 'industry':
      collect(preferences.industries);
      break;
    case 'title_token':
      collect(preferences.titles);
      break;
    case 'employment_type':
      collect(preferences.employmentTypes);
      break;
    case 'company_size':
      collect(preferences.companySizes);
      break;
    case 'seniority':
      for (const level of preferences.seniorityLevels) positives.add(level.toLowerCase());
      break;
    case 'work_arrangement': {
      // The one dimension where the preference is an enum rather than a list.
      const arrangement = preferences.workArrangement;
      if (arrangement === 'REMOTE_ONLY' || arrangement === 'REMOTE_PREFERRED') {
        positives.add('remote');
        if (arrangement === 'REMOTE_ONLY') {
          negatives.add('onsite');
          negatives.add('hybrid');
        }
      } else if (arrangement === 'ONSITE_PREFERRED') {
        positives.add('onsite');
      } else if (arrangement === 'HYBRID_ACCEPTED') {
        positives.add('hybrid');
      }
      break;
    }
    default:
      break;
  }

  return { positives, negatives };
}

/**
 * The single preferred mode, for enum-valued preferences.
 *
 * `workArrangement` is one value rather than a weighted list, so "contradicts"
 * means something different from the list dimensions: stating a preferred mode
 * says nothing negative about the others, but consistently engaging with a
 * *different* mode is exactly the case the brief names —
 * "you've saved 14 remote roles and ignored 12 onsite roles".
 */
const PREFERRED_ARRANGEMENT: Readonly<Record<string, string | null>> = {
  REMOTE_ONLY: 'remote',
  REMOTE_PREFERRED: 'remote',
  HYBRID_ACCEPTED: 'hybrid',
  ONSITE_ACCEPTED: 'onsite',
  ONSITE_PREFERRED: 'onsite',
  ANY: null,
};

/**
 * Whether a learned signal contradicts something the candidate said.
 *
 * Deliberately separate from `explicitValuesFor`, which the *hierarchy* uses to
 * decide suppression. A contradiction is not always a suppression: preferring
 * onsite does not forbid remote, so a remote job may still receive a
 * behavioural boost while the system asks whether the preference should change.
 * Merging the two concepts would either suppress signals it should not, or fail
 * to flag the conflict the candidate most needs to see.
 */
export function contradictsExplicit(
  dimension: FeatureDimension,
  value: string,
  affinity: number,
  preferences: CandidatePreferences | null,
): boolean {
  if (!preferences) return false;

  if (dimension === 'work_arrangement') {
    const preferred = PREFERRED_ARRANGEMENT[preferences.workArrangement] ?? null;
    if (!preferred) return false;
    // Engaging with a mode they did not choose, or avoiding the one they did.
    if (affinity > 0.2 && value !== preferred) return true;
    if (affinity < -0.2 && value === preferred) return true;
    return false;
  }

  const explicit = explicitValuesFor(preferences, dimension);
  return (
    (affinity > 0.2 && explicit.negatives.has(value)) ||
    (affinity < -0.2 && explicit.positives.has(value))
  );
}

/**
 * Computes affinities from a stream of events.
 *
 * Pure and replayable: given the same events and config it returns the same
 * result, which is what makes an algorithm-version bump safe — history can be
 * recomputed rather than migrated.
 */
export function computeAffinities(
  inputs: readonly AffinityEventInput[],
  options: AffinityOptions = {},
): FeatureAffinity[] {
  const config = learningConfigSchema.parse(options.config ?? {});
  const now = options.now ?? new Date();
  const buckets = new Map<string, Bucket>();

  for (const { event, features } of inputs) {
    const weight = weightFor(event.eventType, config);
    if (!weight || weight.evidenceWeight === 0) continue;

    const decay = recencyWeight(event.occurredAt, now, config.halfLifeDays);
    if (decay <= 0.001) continue;

    const context = contextWeight(event.context, config);

    /*
     * A structured rejection reason is far better evidence than the rejection.
     *
     * "Rejected: salary too low" says something specific about the salary band
     * and nothing about the company. Applying the generic rejection polarity to
     * every feature would teach the system to dislike a company because its
     * salary was low, which is the over-inference the brief singles out.
     */
    const reason = event.rejectionReason ? REJECTION_DIMENSION[event.rejectionReason] : null;

    // A reason with zero polarity is about *state*, not preference:
    // `ALREADY_APPLIED` and `DUPLICATE` say nothing about what the candidate
    // wants. Falling through to the generic rejection weight would teach the
    // system to dislike a job because they had already applied to it.
    if (reason && reason.polarity === 0) continue;

    const targetedDimension = reason?.dimension ?? null;

    for (const feature of features) {
      // A targeted rejection only speaks to its own dimension.
      if (targetedDimension !== null && feature.dimension !== targetedDimension) continue;

      const polarity =
        targetedDimension !== null && reason ? reason.polarity : weight.polarity;
      if (polarity === 0) continue;

      const evidence = weight.evidenceWeight * context * decay * feature.salience;
      if (evidence <= 0) continue;

      const key = featureKey(feature.dimension, feature.value);
      const bucket = buckets.get(key) ?? {
        dimension: feature.dimension,
        value: feature.value,
        weighted: 0,
        evidence: 0,
        events: 0,
        positives: 0,
        negatives: 0,
        first: null,
        last: null,
      };

      bucket.weighted += polarity * evidence;
      bucket.evidence += evidence;
      bucket.events += 1;
      if (polarity > 0) bucket.positives += 1;
      else bucket.negatives += 1;
      if (!bucket.first || event.occurredAt < bucket.first) bucket.first = event.occurredAt;
      if (!bucket.last || event.occurredAt > bucket.last) bucket.last = event.occurredAt;

      buckets.set(key, bucket);
    }
  }

  const affinities: FeatureAffinity[] = [];

  for (const [key, bucket] of buckets) {
    if (!options.skipEvidenceFloor && bucket.evidence < config.minEvidence) continue;

    const parsed = parseFeatureKey(key);
    if (!parsed) continue;

    const affinity = Math.max(-1, Math.min(1, bucket.weighted / bucket.evidence));
    const confidence = confidenceFromEvidence(bucket.evidence, config);

    const conflicts = contradictsExplicit(
      bucket.dimension,
      bucket.value,
      affinity,
      options.preferences ?? null,
    );

    const parsedAffinity = featureAffinitySchema.safeParse({
      dimension: bucket.dimension,
      value: bucket.value,
      affinity: Number(affinity.toFixed(4)),
      confidence,
      sampleSize: bucket.events,
      positiveEvents: bucket.positives,
      negativeEvents: bucket.negatives,
      evidence: Number(bucket.evidence.toFixed(4)),
      firstObservedAt: bucket.first,
      lastObservedAt: bucket.last,
      lastUpdated: now,
      conflictsWithExplicit: conflicts,
      explicitValue: conflicts ? bucket.value : null,
      algorithmVersion: config.algorithmVersion,
      featureVersion: config.featureVersion,
    });

    if (parsedAffinity.success) affinities.push(parsedAffinity.data);
  }

  // Strongest belief first — confidence before magnitude, because a confident
  // moderate signal is more actionable than an uncertain extreme one.
  return affinities.sort(
    (a, b) =>
      b.confidence * Math.abs(b.affinity) - a.confidence * Math.abs(a.affinity) ||
      b.sampleSize - a.sampleSize,
  );
}

/**
 * Builds the behavioural profile.
 *
 * Cold start is a first-class state, not an empty profile: `hasSufficientData`
 * is false with a stated reason, and the ranking layer applies no adjustment at
 * all. Inventing weak preferences from three clicks would be worse than having
 * none, because they would look like knowledge.
 */
export function buildBehavioralProfile(
  candidateId: string,
  inputs: readonly AffinityEventInput[],
  options: AffinityOptions = {},
): BehavioralProfile {
  const config = learningConfigSchema.parse(options.config ?? {});
  const now = options.now ?? new Date();

  const distinctJobs = new Set(
    inputs.map((input) => input.event.jobId).filter((id): id is string => Boolean(id)),
  ).size;

  const timestamps = inputs.map((input) => input.event.occurredAt.getTime());
  const affinities = config.enabled ? computeAffinities(inputs, options) : [];

  const sufficient = inputs.length >= config.minEventsForPersonalization;

  return behavioralProfileSchema.parse({
    candidateId,
    affinities,
    totalEvents: inputs.length,
    distinctJobs,
    firstEventAt: timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null,
    lastEventAt: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null,
    hasSufficientData: sufficient && config.enabled,
    coldStartReason: !config.enabled
      ? 'Personalization is switched off; explicit preferences continue to apply.'
      : sufficient
        ? null
        : `Only ${inputs.length} interaction(s) recorded; ${config.minEventsForPersonalization} are ` +
          `needed before behaviour is used. Ranking currently uses your explicit preferences, ` +
          `skills, job quality and freshness.`,
    algorithmVersion: config.algorithmVersion || LEARNING_ALGORITHM_VERSION,
    featureVersion: config.featureVersion || FEATURE_VERSION,
    computedAt: now,
  });
}

/**
 * Folds one batch of events into existing affinities.
 *
 * Incremental so that ingesting an event does not re-read a candidate's whole
 * history. The decay applied to the stored evidence is the elapsed time since
 * it was last computed, which makes this equivalent to a full recomputation as
 * long as batches arrive in order — and periodic full recomputation corrects
 * any drift when they do not.
 */
export function mergeAffinities(
  existing: readonly FeatureAffinity[],
  batch: readonly AffinityEventInput[],
  options: AffinityOptions = {},
): FeatureAffinity[] {
  const config = learningConfigSchema.parse(options.config ?? {});
  const now = options.now ?? new Date();

  if (config.frozen) return [...existing];

  // The floor is applied to the merged total below, never to the batch.
  const fresh = computeAffinities(batch, { ...options, skipEvidenceFloor: true });
  const byKey = new Map<string, FeatureAffinity>();

  for (const affinity of existing) {
    const decay = recencyWeight(affinity.lastUpdated, now, config.halfLifeDays);
    const decayedEvidence = affinity.evidence * decay;

    byKey.set(featureKey(affinity.dimension, affinity.value), {
      ...affinity,
      evidence: decayedEvidence,
      confidence: confidenceFromEvidence(decayedEvidence, config),
    });
  }

  for (const incoming of fresh) {
    const key = featureKey(incoming.dimension, incoming.value);
    const previous = byKey.get(key);

    if (!previous) {
      byKey.set(key, incoming);
      continue;
    }

    const evidence = previous.evidence + incoming.evidence;
    // Evidence-weighted mean of the two affinities: a long history is not
    // overturned by one new event, and a new direction still moves the needle
    // in proportion to how much evidence it brought.
    const affinity =
      evidence > 0
        ? (previous.affinity * previous.evidence + incoming.affinity * incoming.evidence) / evidence
        : previous.affinity;

    byKey.set(key, {
      ...previous,
      affinity: Number(Math.max(-1, Math.min(1, affinity)).toFixed(4)),
      evidence: Number(evidence.toFixed(4)),
      confidence: confidenceFromEvidence(evidence, config),
      sampleSize: previous.sampleSize + incoming.sampleSize,
      positiveEvents: previous.positiveEvents + incoming.positiveEvents,
      negativeEvents: previous.negativeEvents + incoming.negativeEvents,
      lastObservedAt: incoming.lastObservedAt ?? previous.lastObservedAt,
      lastUpdated: now,
      conflictsWithExplicit: incoming.conflictsWithExplicit,
      explicitValue: incoming.explicitValue,
    });
  }

  return [...byKey.values()]
    .filter((affinity) => affinity.evidence >= config.minEvidence)
    .sort(
      (a, b) =>
        b.confidence * Math.abs(b.affinity) - a.confidence * Math.abs(a.affinity) ||
        b.sampleSize - a.sampleSize,
    );
}
