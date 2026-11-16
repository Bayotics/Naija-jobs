import type {
  CandidatePreferences,
  CandidateProfilePayload,
  CandidateSkillEntry,
  ComponentScore,
  JobEnrichment,
  LearnedSignal,
} from '@job-intel/contracts';
import type { SkillGraph } from '@job-intel/candidate';

/**
 * The inputs every scorer sees.
 *
 * Assembled once per match by the engine and passed unchanged to each scorer,
 * so no scorer can reach for the database, a cache or a clock. That is what
 * makes each of them a pure function and therefore testable in isolation.
 */

/** A vector plus the model that produced it. Comparing across models is invalid. */
export interface EmbeddingRef {
  model: string;
  vector: number[];
}

export interface MatchCandidateContext {
  profileId: string;
  /** Version of the profile payload the match was computed against. */
  profileVersion: number;
  /** Version of the preference payload — moves independently of the profile. */
  preferenceVersion: number;
  profile: CandidateProfilePayload;
  preferences: CandidatePreferences;
  skills: CandidateSkillEntry[];
  skillGraph: SkillGraph;
  embedding: EmbeddingRef | null;
  /** What behaviour suggests. Never merged into `preferences`. */
  learnedSignals: LearnedSignal[];
}

export interface MatchJobContext {
  jobId: string;
  jobVersion: number;
  title: string;
  companyName: string;
  description: string | null;
  enrichment: JobEnrichment;
  embedding: EmbeddingRef | null;
}

export interface ScorerInput {
  candidate: MatchCandidateContext;
  job: MatchJobContext;
}

/** Every dimension scorer has this shape, which is what lets the engine loop. */
export type Scorer = (input: ScorerInput) => ComponentScore;
