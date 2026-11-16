import { z } from 'zod';
import { ValidationError } from '@job-intel/core';
import {
  candidatePreferencesSchema,
  matchingWeightsSchema,
  salaryPreferenceSchema,
  weightedPreferenceSchema,
  workAuthorizationPreferenceSchema,
  WORK_ARRANGEMENT_PREFERENCES,
  PREFERENCE_STRENGTHS,
  type CandidatePreferences,
  type PreferenceStrength,
  type WeightedPreference,
} from '@job-intel/contracts';

/**
 * Validated preference mutations.
 *
 * The frontend never touches the database. Every change goes through a named
 * operation here, which:
 *
 *   1. validates the change against the schema
 *   2. produces the next payload (pure — no I/O)
 *   3. reports a field-level diff for the change log
 *   4. reports whether the canonical profile text changed, so the embedding can
 *      be invalidated
 *
 * Keeping this pure makes it exhaustively testable and lets the repository stay
 * a thin persistence shell.
 */

/** The list dimensions that share `WeightedPreference[]` semantics. */
export const PREFERENCE_LIST_DIMENSIONS = [
  'titles',
  'countries',
  'cities',
  'regions',
  'timezones',
  'employmentTypes',
  'industries',
  'companies',
  'companySizes',
  'technologies',
] as const;
export type PreferenceListDimension = (typeof PREFERENCE_LIST_DIMENSIONS)[number];

export interface PreferenceChange {
  /** Dot path into the payload, e.g. "salary.minimum" or "countries". */
  path: string;
  before: unknown;
  after: unknown;
  summary: string;
}

export interface MutationResult {
  preferences: CandidatePreferences;
  changes: PreferenceChange[];
  /**
   * True when the change alters the canonical profile text, meaning the stored
   * embedding no longer represents the candidate and must be regenerated.
   */
  embeddingStale: boolean;
}

/**
 * Dimensions that feed the canonical profile text.
 *
 * Changing a salary floor does not change *who the candidate is* semantically,
 * so it must not trigger an expensive re-embed. Changing target titles or
 * technologies does.
 */
const EMBEDDING_RELEVANT = new Set([
  'titles',
  'technologies',
  'industries',
  'seniorityLevels',
  'skills',
  'professional',
]);

function summarise(values: readonly WeightedPreference[]): string {
  if (values.length === 0) return 'none';
  return values.map((v) => `${v.value} (${v.strength})`).join(', ');
}

export class PreferenceService {
  /** Applies a whole-payload replacement, validating the result. */
  static replace(current: CandidatePreferences, next: unknown): MutationResult {
    const parsed = candidatePreferencesSchema.parse(next);
    const changes: PreferenceChange[] = [];
    let embeddingStale = false;

    for (const key of Object.keys(parsed) as Array<keyof CandidatePreferences>) {
      const before = JSON.stringify(current[key]);
      const after = JSON.stringify(parsed[key]);
      if (before === after) continue;
      changes.push({
        path: String(key),
        before: current[key],
        after: parsed[key],
        summary: `${String(key)} updated`,
      });
      if (EMBEDDING_RELEVANT.has(String(key))) embeddingStale = true;
    }

    return { preferences: parsed, changes, embeddingStale };
  }

  /**
   * Sets the work arrangement.
   *
   * The named example from the requirements: switching REMOTE_ONLY to
   * HYBRID_ACCEPTED must take effect on the next matching run with no code
   * change. It does, because the evaluator reads this value at evaluation time.
   */
  static updateWorkArrangement(
    current: CandidatePreferences,
    value: unknown,
    maxOfficeDaysPerWeek?: number | null,
  ): MutationResult {
    const arrangement = z.enum(WORK_ARRANGEMENT_PREFERENCES).parse(value);
    const days =
      maxOfficeDaysPerWeek === undefined
        ? current.maxOfficeDaysPerWeek
        : z.number().int().min(0).max(7).nullable().parse(maxOfficeDaysPerWeek);

    const changes: PreferenceChange[] = [];
    if (arrangement !== current.workArrangement) {
      changes.push({
        path: 'workArrangement',
        before: current.workArrangement,
        after: arrangement,
        summary: `Work arrangement changed from ${current.workArrangement} to ${arrangement}`,
      });
    }
    if (days !== current.maxOfficeDaysPerWeek) {
      changes.push({
        path: 'maxOfficeDaysPerWeek',
        before: current.maxOfficeDaysPerWeek,
        after: days,
        summary: `Maximum office days changed to ${days ?? 'no limit'}`,
      });
    }

    return {
      preferences: { ...current, workArrangement: arrangement, maxOfficeDaysPerWeek: days },
      changes,
      embeddingStale: false,
    };
  }

  /** Replaces a whole weighted list dimension. */
  static updateList(
    current: CandidatePreferences,
    dimension: PreferenceListDimension,
    values: unknown,
  ): MutationResult {
    const parsed = z.array(weightedPreferenceSchema).parse(values);
    const before = current[dimension];

    const changes: PreferenceChange[] =
      JSON.stringify(before) === JSON.stringify(parsed)
        ? []
        : [
            {
              path: dimension,
              before,
              after: parsed,
              summary: `${dimension}: ${summarise(before)} → ${summarise(parsed)}`,
            },
          ];

    return {
      preferences: { ...current, [dimension]: parsed },
      changes,
      embeddingStale: changes.length > 0 && EMBEDDING_RELEVANT.has(dimension),
    };
  }

  /** Adds or updates one entry in a list dimension, leaving the rest untouched. */
  static upsertListEntry(
    current: CandidatePreferences,
    dimension: PreferenceListDimension,
    entry: unknown,
  ): MutationResult {
    const parsed = weightedPreferenceSchema.parse(entry);
    const list = [...current[dimension]];
    const index = list.findIndex(
      (p) => p.value.trim().toLowerCase() === parsed.value.trim().toLowerCase(),
    );

    const before = index >= 0 ? list[index] : null;
    if (index >= 0) list[index] = parsed;
    else list.push(parsed);

    return {
      preferences: { ...current, [dimension]: list },
      changes: [
        {
          path: `${dimension}[${parsed.value}]`,
          before,
          after: parsed,
          summary: before
            ? `${dimension}: "${parsed.value}" changed from ${before.strength} to ${parsed.strength}`
            : `${dimension}: added "${parsed.value}" as ${parsed.strength}`,
        },
      ],
      embeddingStale: EMBEDDING_RELEVANT.has(dimension),
    };
  }

  static removeListEntry(
    current: CandidatePreferences,
    dimension: PreferenceListDimension,
    value: string,
  ): MutationResult {
    const list = current[dimension];
    const target = list.find((p) => p.value.trim().toLowerCase() === value.trim().toLowerCase());
    if (!target) return { preferences: current, changes: [], embeddingStale: false };

    return {
      preferences: {
        ...current,
        [dimension]: list.filter((p) => p !== target),
      },
      changes: [
        {
          path: `${dimension}[${value}]`,
          before: target,
          after: null,
          summary: `${dimension}: removed "${value}"`,
        },
      ],
      embeddingStale: EMBEDDING_RELEVANT.has(dimension),
    };
  }

  /** Changes only the strength of an existing entry. */
  static updateStrength(
    current: CandidatePreferences,
    dimension: PreferenceListDimension,
    value: string,
    strength: unknown,
  ): MutationResult {
    const parsedStrength = z.enum(PREFERENCE_STRENGTHS).parse(strength) as PreferenceStrength;
    const list = [...current[dimension]];
    const index = list.findIndex(
      (p) => p.value.trim().toLowerCase() === value.trim().toLowerCase(),
    );
    if (index < 0) {
      throw new ValidationError(`No "${value}" in ${dimension}; add it before changing its strength`);
    }

    const before = list[index] as WeightedPreference;
    list[index] = { ...before, strength: parsedStrength };

    return {
      preferences: { ...current, [dimension]: list },
      changes: [
        {
          path: `${dimension}[${value}].strength`,
          before: before.strength,
          after: parsedStrength,
          summary: `${dimension}: "${value}" ${before.strength} → ${parsedStrength}`,
        },
      ],
      embeddingStale: false,
    };
  }

  static updateSalary(current: CandidatePreferences, patch: unknown): MutationResult {
    const parsed = salaryPreferenceSchema.parse({ ...current.salary, ...(patch as object) });
    const changes: PreferenceChange[] = [];

    for (const key of Object.keys(parsed) as Array<keyof typeof parsed>) {
      if (current.salary[key] === parsed[key]) continue;
      changes.push({
        path: `salary.${String(key)}`,
        before: current.salary[key],
        after: parsed[key],
        summary: `Salary ${String(key)}: ${String(current.salary[key])} → ${String(parsed[key])}`,
      });
    }

    // Salary is not part of the semantic profile, so no re-embed.
    return { preferences: { ...current, salary: parsed }, changes, embeddingStale: false };
  }

  static updateWorkAuthorization(current: CandidatePreferences, patch: unknown): MutationResult {
    const parsed = workAuthorizationPreferenceSchema.parse({
      ...current.workAuthorization,
      ...(patch as object),
    });
    const changes: PreferenceChange[] = [];

    for (const key of Object.keys(parsed) as Array<keyof typeof parsed>) {
      const before = JSON.stringify(current.workAuthorization[key]);
      const after = JSON.stringify(parsed[key]);
      if (before === after) continue;
      changes.push({
        path: `workAuthorization.${String(key)}`,
        before: current.workAuthorization[key],
        after: parsed[key],
        summary: `Work authorization ${String(key)} updated`,
      });
    }

    return { preferences: { ...current, workAuthorization: parsed }, changes, embeddingStale: false };
  }

  static updateWeights(current: CandidatePreferences, patch: unknown): MutationResult {
    const parsed = matchingWeightsSchema.parse({ ...current.weights, ...(patch as object) });
    const changes: PreferenceChange[] = [];

    for (const key of Object.keys(parsed) as Array<keyof typeof parsed>) {
      if (current.weights[key] === parsed[key]) continue;
      changes.push({
        path: `weights.${String(key)}`,
        before: current.weights[key],
        after: parsed[key],
        summary: `Weight ${String(key)}: ${current.weights[key]} → ${parsed[key]}`,
      });
    }

    return { preferences: { ...current, weights: parsed }, changes, embeddingStale: false };
  }

  static updateExcludedKeywords(current: CandidatePreferences, values: unknown): MutationResult {
    const parsed = z.array(z.string().trim().min(1).max(120)).parse(values);
    if (JSON.stringify(parsed) === JSON.stringify(current.excludedKeywords)) {
      return { preferences: current, changes: [], embeddingStale: false };
    }
    return {
      preferences: { ...current, excludedKeywords: parsed },
      changes: [
        {
          path: 'excludedKeywords',
          before: current.excludedKeywords,
          after: parsed,
          summary: `Excluded keywords: ${parsed.join(', ') || 'none'}`,
        },
      ],
      embeddingStale: false,
    };
  }

  /**
   * Applies a validated proposal produced by the natural-language layer.
   *
   * Routed through the same named operations as any other change, so a proposal
   * cannot reach the database by a different path than a UI edit would.
   */
  static applyProposal(
    current: CandidatePreferences,
    proposal: { path: string; operation: string; value?: unknown },
  ): MutationResult {
    const [head, ...rest] = proposal.path.split('.');

    if (head === 'workArrangement') {
      return PreferenceService.updateWorkArrangement(current, proposal.value);
    }
    if (head === 'maxOfficeDaysPerWeek') {
      return PreferenceService.updateWorkArrangement(
        current,
        current.workArrangement,
        proposal.value as number | null,
      );
    }
    if (head === 'salary') {
      const field = rest[0];
      return PreferenceService.updateSalary(
        current,
        field ? { [field]: proposal.value } : (proposal.value as object),
      );
    }
    if (head === 'workAuthorization') {
      const field = rest[0];
      return PreferenceService.updateWorkAuthorization(
        current,
        field ? { [field]: proposal.value } : (proposal.value as object),
      );
    }
    if (head === 'excludedKeywords') {
      return PreferenceService.updateExcludedKeywords(current, proposal.value);
    }
    if (head && (PREFERENCE_LIST_DIMENSIONS as readonly string[]).includes(head)) {
      const dimension = head as PreferenceListDimension;
      if (proposal.operation === 'remove') {
        return PreferenceService.removeListEntry(current, dimension, String(proposal.value));
      }
      if (proposal.operation === 'set') {
        return PreferenceService.updateList(current, dimension, proposal.value);
      }
      return PreferenceService.upsertListEntry(current, dimension, proposal.value);
    }

    // A well-formed request naming an unknown path is a client error, not a
    // server fault, and must not surface as a 500.
    throw new ValidationError(`Unsupported preference path: ${proposal.path}`, [
      { path: proposal.path, message: 'not a recognised preference dimension' },
    ]);
  }
}
