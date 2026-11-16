import { randomUUID } from 'node:crypto';
import {
  learningConfigSchema,
  preferenceSuggestionSchema,
  type CandidatePreferences,
  type FeatureAffinity,
  type LearningConfig,
  type PreferenceSuggestion,
} from '@job-intel/contracts';
import { bandFloor } from './features';
import { explicitValuesFor } from './affinity';

/**
 * Preference suggestions.
 *
 * The only legitimate route from "your behaviour suggests X" to "your
 * preferences say X" — and it runs through the candidate. Every function here
 * returns *rows*, never mutations. Nothing in this file can write a preference,
 * and that is a property of what it returns rather than a promise about how it
 * is called.
 *
 * The bar for offering a suggestion is deliberately higher than the bar for
 * applying a behavioural ranking nudge. A nudge is reversible and invisible; a
 * suggestion asks for the candidate's attention and implies the system is
 * confident. Offering weak ones trains people to dismiss all of them.
 */

export interface SuggestionInput {
  candidateId: string;
  preferences: CandidatePreferences;
  affinities: readonly FeatureAffinity[];
  config?: Partial<LearningConfig>;
  /** Suggestions the candidate already declined; never re-offered. */
  declinedPaths?: readonly string[];
  windowDays?: number;
  now?: Date;
}

const DIMENSION_PATH: Readonly<Record<string, string>> = {
  technology: 'technologies',
  company: 'companies',
  country: 'countries',
  location: 'cities',
  industry: 'industries',
  title_token: 'titles',
  employment_type: 'employmentTypes',
  company_size: 'companySizes',
};

/**
 * Generates suggestions from learned affinities.
 *
 * Three kinds, in descending order of how confident the evidence must be:
 *
 *  - **Add** something they engage with but never stated.
 *  - **Change** a preference their behaviour consistently contradicts. This is
 *    the case the brief calls out — the remote/onsite example — and it is the
 *    only place a *contradiction* is surfaced rather than silently suppressed.
 *  - **Raise a salary floor** their behaviour implies. Deliberately never
 *    lowers one: inferring that someone would accept less money than they asked
 *    for is a suggestion no system should make.
 */
export function generateSuggestions(input: SuggestionInput): PreferenceSuggestion[] {
  const config = learningConfigSchema.parse(input.config ?? {});
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? 30;
  const declined = new Set(input.declinedPaths ?? []);

  if (!config.enabled) return [];

  const suggestions: PreferenceSuggestion[] = [];

  const qualifies = (affinity: FeatureAffinity): boolean =>
    affinity.sampleSize >= config.suggestionMinObservations &&
    affinity.confidence >= config.suggestionMinConfidence;

  for (const affinity of input.affinities) {
    if (!qualifies(affinity)) continue;

    const path = DIMENSION_PATH[affinity.dimension];
    const explicit = explicitValuesFor(input.preferences, affinity.dimension);
    const value = affinity.value;

    // ── Contradiction: they said one thing and do another ─────────────────
    if (affinity.conflictsWithExplicit) {
      /*
       * `workArrangement` is a single-valued enum, so it can produce at most
       * one meaningful suggestion. Handled separately after this loop:
       * generating one per conflicting *value* asked the candidate two
       * contradictory questions about the same setting.
       */
      if (affinity.dimension === 'work_arrangement') continue;
      if (!path || declined.has(path)) continue;

      const wantsIt = affinity.affinity > 0;
      suggestions.push(
        build({
          candidateId: input.candidateId,
          path,
          operation: 'update_strength',
          currentValue: wantsIt ? 'excluded or undesirable' : 'preferred',
          suggestedValue: wantsIt ? 'preferred' : 'undesirable',
          message:
            wantsIt
              ? `You have engaged with ${affinity.positiveEvents} "${value}" role(s) recently, ` +
                `but your preferences currently rule them out. Would you like to allow them?`
              : `You have passed over ${affinity.negativeEvents} "${value}" role(s) recently, ` +
                `though your preferences ask for them. Would you like to change that?`,
          supporting: wantsIt ? affinity.positiveEvents : affinity.negativeEvents,
          contradicting: wantsIt ? affinity.negativeEvents : affinity.positiveEvents,
          windowDays,
          examples: [value],
          confidence: affinity.confidence,
          now,
          algorithmVersion: config.algorithmVersion,
        }),
      );
      continue;
    }

    // ── Addition: consistently engaged, never stated ──────────────────────
    if (
      path &&
      affinity.affinity > 0.5 &&
      !explicit.positives.has(value.toLowerCase()) &&
      !explicit.negatives.has(value.toLowerCase()) &&
      !declined.has(`${path}.${value}`)
    ) {
      suggestions.push(
        build({
          candidateId: input.candidateId,
          path: `${path}.${value}`,
          operation: 'add',
          currentValue: null,
          suggestedValue: { value, strength: 'preferred' },
          message:
            `You have engaged with ${affinity.positiveEvents} role(s) involving "${value}" over ` +
            `the last ${windowDays} days but have not listed it. Add it to your preferences?`,
          supporting: affinity.positiveEvents,
          contradicting: affinity.negativeEvents,
          windowDays,
          examples: [value],
          confidence: affinity.confidence,
          now,
          algorithmVersion: config.algorithmVersion,
        }),
      );
    }
  }

  const arrangement = workArrangementSuggestion(input, config, windowDays, now, declined);
  if (arrangement) suggestions.push(arrangement);

  const salary = salarySuggestion(input, config, windowDays, now, declined);
  if (salary) suggestions.push(salary);

  // Most confident first, and bounded: a wall of suggestions is ignored wholesale.
  return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 6);
}

/** The stated preference expressed as the mode it favours. */
const ARRANGEMENT_FOR_MODE: Readonly<Record<string, string>> = {
  remote: 'REMOTE_PREFERRED',
  hybrid: 'HYBRID_ACCEPTED',
  onsite: 'ONSITE_PREFERRED',
};

const MODE_OF_ARRANGEMENT: Readonly<Record<string, string | null>> = {
  REMOTE_ONLY: 'remote',
  REMOTE_PREFERRED: 'remote',
  HYBRID_ACCEPTED: 'hybrid',
  ONSITE_ACCEPTED: 'onsite',
  ONSITE_PREFERRED: 'onsite',
  ANY: null,
};

/**
 * One work-arrangement suggestion, or none.
 *
 * `workArrangement` is a single enum, so the useful question is "should this
 * setting change, and to what" — asked once, naming the current value
 * accurately. The previous per-value version produced two simultaneous
 * suggestions saying the preference "rules out" both onsite and remote, which
 * was untrue for every setting except `REMOTE_ONLY`.
 */
function workArrangementSuggestion(
  input: SuggestionInput,
  config: LearningConfig,
  windowDays: number,
  now: Date,
  declined: ReadonlySet<string>,
): PreferenceSuggestion | null {
  if (declined.has('workArrangement')) return null;

  const current = input.preferences.workArrangement;
  const currentMode = MODE_OF_ARRANGEMENT[current] ?? null;

  const modes = input.affinities.filter(
    (affinity) =>
      affinity.dimension === 'work_arrangement' &&
      affinity.sampleSize >= config.suggestionMinObservations &&
      affinity.confidence >= config.suggestionMinConfidence,
  );
  if (modes.length === 0) return null;

  // The mode they actually favour, by strength of signal.
  const favoured = modes
    .filter((mode) => mode.affinity > 0.2)
    .sort((a, b) => b.affinity * b.confidence - a.affinity * a.confidence)[0];

  if (!favoured || favoured.value === currentMode) return null;

  const target = ARRANGEMENT_FOR_MODE[favoured.value];
  if (!target || target === current) return null;

  const contrary = currentMode
    ? modes.find((mode) => mode.value === currentMode)
    : undefined;

  return build({
    candidateId: input.candidateId,
    path: 'workArrangement',
    operation: 'set',
    currentValue: current,
    suggestedValue: target,
    message:
      `Your work preference is set to ${current.toLowerCase().replace(/_/g, ' ')}, but you have ` +
      `engaged with ${favoured.positiveEvents} ${favoured.value} role(s)` +
      (contrary && contrary.negativeEvents > 0
        ? ` and passed over ${contrary.negativeEvents} ${contrary.value} role(s)`
        : '') +
      ` over the last ${windowDays} days. Would you like to change it to ` +
      `${target.toLowerCase().replace(/_/g, ' ')}?`,
    supporting: favoured.positiveEvents,
    contradicting: contrary?.positiveEvents ?? 0,
    windowDays,
    examples: [favoured.value],
    confidence: favoured.confidence,
    now,
    algorithmVersion: config.algorithmVersion,
  });
}

/**
 * Salary sensitivity.
 *
 * Compares the bands they engage with against the band their stated minimum
 * sits in. Only ever suggests raising the floor — a system that suggests
 * someone lower their salary expectations because they clicked a cheap job has
 * misunderstood whose side it is on.
 */
function salarySuggestion(
  input: SuggestionInput,
  config: LearningConfig,
  windowDays: number,
  now: Date,
  declined: ReadonlySet<string>,
): PreferenceSuggestion | null {
  if (declined.has('salary.minimum')) return null;

  const bands = input.affinities.filter(
    (affinity) => affinity.dimension === 'salary_band' && affinity.sampleSize >= 3,
  );
  if (bands.length < 2) return null;

  const liked = bands.filter((band) => band.affinity > 0.3);
  const disliked = bands.filter((band) => band.affinity < -0.2);
  if (liked.length === 0 || disliked.length === 0) return null;

  const lowestLikedFloor = Math.min(
    ...liked.map((band) => bandFloor(band.value) ?? Number.POSITIVE_INFINITY),
  );
  const highestDislikedFloor = Math.max(...disliked.map((band) => bandFloor(band.value) ?? 0));

  // Only meaningful when the pattern is clean: everything they like sits above
  // everything they dislike.
  if (!Number.isFinite(lowestLikedFloor) || lowestLikedFloor <= highestDislikedFloor) return null;

  const currentMinimum = input.preferences.salary?.minimum ?? null;
  if (currentMinimum !== null && currentMinimum >= lowestLikedFloor) return null;

  const confidence = Math.min(
    config.maxConfidence,
    Math.min(...liked.map((band) => band.confidence)),
  );
  if (confidence < config.suggestionMinConfidence) return null;

  const supporting = liked.reduce((sum, band) => sum + band.positiveEvents, 0);
  const contradicting = disliked.reduce((sum, band) => sum + band.positiveEvents, 0);

  return build({
    candidateId: input.candidateId,
    path: 'salary.minimum',
    operation: 'set',
    currentValue: currentMinimum,
    suggestedValue: lowestLikedFloor,
    message:
      `Your behaviour suggests you may prefer roles above ${formatMoney(lowestLikedFloor)}: ` +
      `you engaged with ${supporting} role(s) at or above that and passed over roles below it. ` +
      `Would you like to raise your salary minimum?`,
    supporting,
    contradicting,
    windowDays,
    examples: liked.map((band) => band.value).slice(0, 3),
    confidence,
    now,
    algorithmVersion: config.algorithmVersion,
  });
}

function formatMoney(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}

function build(input: {
  candidateId: string;
  path: string;
  operation: PreferenceSuggestion['operation'];
  currentValue: unknown;
  suggestedValue: unknown;
  message: string;
  supporting: number;
  contradicting: number;
  windowDays: number;
  examples: string[];
  confidence: number;
  now: Date;
  algorithmVersion: string;
}): PreferenceSuggestion {
  return preferenceSuggestionSchema.parse({
    id: randomUUID(),
    candidateId: input.candidateId,
    path: input.path,
    operation: input.operation,
    currentValue: input.currentValue,
    suggestedValue: input.suggestedValue,
    message: input.message,
    evidence: {
      supporting: input.supporting,
      contradicting: input.contradicting,
      windowDays: input.windowDays,
      examples: input.examples,
    },
    confidence: input.confidence,
    status: 'pending',
    createdAt: input.now,
    algorithmVersion: input.algorithmVersion,
  });
}
