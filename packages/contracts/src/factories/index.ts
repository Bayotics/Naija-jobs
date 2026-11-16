import { randomUUID } from 'node:crypto';
import {
  candidateProfilePayloadSchema,
  type CandidateProfilePayload,
} from '../profile';
import { normalizedJobSchema, type NormalizedJob } from '../job';
import { jobSourceSchema, type JobSource } from '../source';

/**
 * Test factories.
 *
 * Every factory runs its output through the real Zod schema, so a fixture can
 * never drift into a shape the production validators would reject — which is
 * the usual way fixture-based suites start passing against a system that no
 * longer works.
 *
 * These are for tests and seeding only. Nothing in the runtime path imports
 * this module.
 */

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function merge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (!override) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = merge(current, value as DeepPartial<typeof current>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export function makeCandidateProfile(
  overrides?: DeepPartial<CandidateProfilePayload>,
): CandidateProfilePayload {
  const base = candidateProfilePayloadSchema.parse({
    identity: {
      fullName: 'Test Candidate',
      email: 'test.candidate@example.com',
      timezone: 'UTC',
    },
  });
  return candidateProfilePayloadSchema.parse(merge(base, overrides));
}

export function makeNormalizedJob(overrides?: DeepPartial<NormalizedJob>): NormalizedJob {
  const base = normalizedJobSchema.parse({
    title: 'Backend Engineer',
    company: { name: 'Example Corp' },
    sourceUrl: `https://boards.example.com/jobs/${randomUUID()}`,
    description: 'We are hiring a backend engineer to work on distributed systems.',
  });
  return normalizedJobSchema.parse(merge(base, overrides));
}

export function makeJobSource(overrides?: DeepPartial<JobSource>): JobSource {
  const base = jobSourceSchema.parse({
    id: 'test-source',
    connectorId: 'test-connector',
    displayName: 'Test Source',
    sourceType: 'job_api',
    accessTier: 'official_api',
  });
  return jobSourceSchema.parse(merge(base, overrides));
}
