import {
  EDITABLE_FIELDS,
  searchProfileSchema,
  type ConfigChange,
  type SearchProfile,
  type ValidationResult,
} from '@job-intel/contracts';
import { validateProfile } from '../validate/validate-profile';

/**
 * Applying configuration changes.
 *
 * Three properties, all of them load-bearing.
 *
 * **Nothing is written unless everything validates.** A bundle that would leave
 * the profile incoherent — React both required and excluded — is rejected
 * whole. Applying the coherent half would leave a profile nobody asked for and
 * nobody can explain.
 *
 * **The allowlist is checked again here.** The intent parser checks it too, and
 * that is not redundant: this function is reachable from the API as well, and a
 * guard that only exists on one path is a guard that will eventually be
 * bypassed.
 *
 * **The result is a new object.** The caller keeps the original to store as the
 * undo snapshot, which is what makes Part 38 a restore rather than a
 * reconstruction.
 */

export interface ApplyResult {
  ok: boolean;
  profile: SearchProfile;
  /** The profile as it was, for the history snapshot. */
  previous: SearchProfile;
  applied: ConfigChange[];
  rejected: Array<{ change: ConfigChange; reason: string }>;
  validation: ValidationResult;
}

function readPath(target: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cursor, segment) => {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    return (cursor as Record<string, unknown>)[segment];
  }, target);
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (cursor[segment] === null || typeof cursor[segment] !== 'object') cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]!] = value;
}

/** Identity for list entries, so `remove` can find what it is removing. */
function entryKey(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const identity = record.value ?? record.title ?? record.sourceId ?? record.language;
    if (typeof identity === 'string') return identity.toLowerCase();
  }

  return JSON.stringify(value);
}

export function applyChanges(
  profile: SearchProfile,
  changes: readonly ConfigChange[],
): ApplyResult {
  const previous = searchProfileSchema.parse(structuredClone(profile));
  const working = structuredClone(profile) as unknown as Record<string, unknown>;

  const applied: ConfigChange[] = [];
  const rejected: ApplyResult['rejected'] = [];

  for (const entry of changes) {
    if (!EDITABLE_FIELDS.includes(entry.field)) {
      rejected.push({ change: entry, reason: `"${entry.field}" is not an editable field.` });
      continue;
    }

    const current = readPath(working, entry.field);

    switch (entry.action) {
      case 'set': {
        writePath(working, entry.field, entry.to);
        applied.push(entry);
        break;
      }

      case 'add': {
        if (!Array.isArray(current)) {
          rejected.push({ change: entry, reason: `"${entry.field}" is not a list.` });
          break;
        }

        const key = entryKey(entry.to);
        const exists = current.some((existing) => entryKey(existing) === key);

        if (exists) {
          // Adding something already present is a no-op, not a failure.
          rejected.push({ change: entry, reason: 'Already present.' });
          break;
        }

        writePath(working, entry.field, [...current, entry.to]);
        applied.push(entry);
        break;
      }

      case 'remove': {
        if (!Array.isArray(current)) {
          rejected.push({ change: entry, reason: `"${entry.field}" is not a list.` });
          break;
        }

        const key = entryKey(entry.to ?? entry.from);
        const next = current.filter((existing) => entryKey(existing) !== key);

        if (next.length === current.length) {
          rejected.push({ change: entry, reason: 'Not found in the list.' });
          break;
        }

        writePath(working, entry.field, next);
        applied.push(entry);
        break;
      }

      case 'clear': {
        writePath(working, entry.field, Array.isArray(current) ? [] : null);
        applied.push(entry);
        break;
      }

      default:
        rejected.push({ change: entry, reason: `Unsupported action "${entry.action}".` });
    }
  }

  working.updatedAt = new Date();

  const parsed = searchProfileSchema.safeParse(working);

  if (!parsed.success) {
    /*
     * The changes produced something the schema will not accept.
     *
     * Nothing is written. The rejected list carries the schema's own complaint
     * so the UI can say which field went wrong rather than "invalid".
     */
    return {
      ok: false,
      profile: previous,
      previous,
      applied: [],
      rejected: changes.map((entry) => ({
        change: entry,
        reason: parsed.error.issues[0]?.message ?? 'The result was not a valid profile.',
      })),
      validation: {
        valid: false,
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          severity: 'error' as const,
          field: issue.path.join('.') || '(root)',
          message: issue.message,
          suggestion: null,
        })),
      },
    };
  }

  const validation = validateProfile(parsed.data);

  /*
   * All or nothing.
   *
   * A bundle that leaves the profile contradictory is refused whole rather than
   * partially applied — half a change is a configuration nobody chose.
   */
  if (!validation.valid) {
    return {
      ok: false,
      profile: previous,
      previous,
      applied: [],
      rejected: applied.map((entry) => ({
        change: entry,
        reason: validation.issues.find((issue) => issue.severity === 'error')?.message ?? 'Invalid.',
      })),
      validation,
    };
  }

  return { ok: true, profile: parsed.data, previous, applied, rejected, validation };
}

/**
 * Undo, as a restore rather than an inverse.
 *
 * Computing the inverse of a change set is possible and fragile — a `remove`
 * whose target was already absent has no inverse, and two changes to one list
 * do not invert independently. Storing the whole profile and putting it back
 * has neither problem, and the storage cost of a JSON blob per change is
 * irrelevant next to being able to say "that is exactly what it was".
 */
export function restoreSnapshot(snapshot: unknown): SearchProfile | null {
  const parsed = searchProfileSchema.safeParse(snapshot);
  if (!parsed.success) return null;

  return { ...parsed.data, updatedAt: new Date() };
}

/** A human-readable preview of what a bundle would do. */
export function describeChanges(changes: readonly ConfigChange[]): string[] {
  return changes.map((entry) => entry.summary);
}

/**
 * Whether a change set would actually change anything.
 *
 * Worth checking before writing history: an instruction that resolves to the
 * configuration already in place should not produce an audit entry claiming
 * something happened.
 */
export function isNoOp(profile: SearchProfile, changes: readonly ConfigChange[]): boolean {
  const result = applyChanges(profile, changes);
  if (!result.ok) return false;

  return JSON.stringify({ ...result.profile, updatedAt: null }) ===
    JSON.stringify({ ...profile, updatedAt: null });
}
