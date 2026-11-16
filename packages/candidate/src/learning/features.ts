import {
  FEATURE_DIMENSIONS,
  PROHIBITED_INFERENCE_DIMENSIONS,
  jobFeatureSchema,
  type FeatureDimension,
  type JobFeature,
} from '@job-intel/contracts';

/**
 * Feature extraction.
 *
 * Turns a job into the handful of attributes behaviour can meaningfully attach
 * to. Two properties matter more than the extraction itself:
 *
 *  1. **Salience, not presence.** A job's primary technology is not the same
 *     evidence as the tenth entry in its "nice to have" list. Without salience,
 *     every posting that mentions Git teaches the system that the candidate
 *     loves Git, and the top of the affinity table fills with noise that
 *     appears in everything.
 *
 *  2. **A closed dimension set.** Features can only be emitted on
 *     `FEATURE_DIMENSIONS`, every one of which is a property of the *job*.
 *     There is no dimension in which a protected characteristic could be
 *     recorded, which is a stronger guarantee than a filter — a filter can be
 *     bypassed by a caller, an absent dimension cannot.
 */

export interface JobAttributes {
  jobId: string;
  title: string | null;
  companyName: string | null;
  countryCode: string | null;
  city: string | null;
  remoteType: string | null;
  employmentTypes: readonly string[];
  seniority: string | null;
  /** Ordered by relevance where the source provides an order. */
  technologies: readonly string[];
  industries: readonly string[];
  salaryAnnualUsd: number | null;
  sourceId: string | null;
  companySize: string | null;
}

/**
 * Salary buckets.
 *
 * Bucketed rather than continuous because behaviour is about ranges: someone
 * who ignores everything under €60k and saves things over €75k has a *band*
 * preference, and a continuous affinity over exact figures would spread the
 * evidence across dozens of values that never repeat.
 */
export const SALARY_BANDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '<40k', min: 0, max: 40_000 },
  { label: '40-60k', min: 40_000, max: 60_000 },
  { label: '60-80k', min: 60_000, max: 80_000 },
  { label: '80-100k', min: 80_000, max: 100_000 },
  { label: '100-130k', min: 100_000, max: 130_000 },
  { label: '130-160k', min: 130_000, max: 160_000 },
  { label: '160k+', min: 160_000, max: Number.POSITIVE_INFINITY },
];

export function salaryBand(annualUsd: number | null): string | null {
  if (annualUsd === null || !Number.isFinite(annualUsd) || annualUsd <= 0) return null;
  return SALARY_BANDS.find((band) => annualUsd >= band.min && annualUsd < band.max)?.label ?? null;
}

/** The lower bound of a band, so bands can be compared numerically. */
export function bandFloor(label: string): number | null {
  return SALARY_BANDS.find((band) => band.label === label)?.min ?? null;
}

/**
 * Meaningful words in a job title.
 *
 * Titles are compared token-wise rather than whole, because "Senior Frontend
 * Engineer" and "Frontend Platform Engineer" share the signal that matters and
 * differ in the parts that do not. Seniority words are stripped — they are
 * already their own dimension, and leaving them in would double-count.
 */
const TITLE_STOPWORDS = new Set([
  'senior',
  'junior',
  'staff',
  'principal',
  'lead',
  'head',
  'chief',
  'i',
  'ii',
  'iii',
  'iv',
  'sr',
  'jr',
  'and',
  'of',
  'the',
  'for',
  'a',
  'an',
  'in',
  'at',
  'to',
  'with',
  'remote',
  'hybrid',
  'onsite',
  'contract',
  'permanent',
  'fulltime',
  'parttime',
  'm/f/d',
  'mfd',
  'w/m/d',
]);

export function titleTokens(title: string | null, limit = 4): string[] {
  if (!title) return [];
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[()[\]{}/|,–—-]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.replace(/[^a-z0-9+#.]/g, ''))
        .filter((token) => token.length >= 2 && !TITLE_STOPWORDS.has(token)),
    ),
  ].slice(0, limit);
}

const norm = (value: string): string => value.trim().toLowerCase();

/**
 * Tags that are not technologies.
 *
 * Several sources populate `techStack` from their own category taxonomy, so it
 * arrives holding "Remote", "Software Engineering" and "QA & Testing" alongside
 * real technologies. Left in, these become the highest-confidence "technology"
 * affinities in the profile — and the system ends up suggesting the candidate
 * add "remote" to their list of preferred technologies, which is nonsense the
 * candidate has to read.
 *
 * They are dropped from the technology dimension only: work arrangement is
 * already its own dimension and is extracted from the structured field.
 */
const NON_TECHNOLOGY_TAGS = new Set([
  'remote',
  'hybrid',
  'onsite',
  'on-site',
  'anywhere',
  'worldwide',
  'full time',
  'full-time',
  'part time',
  'part-time',
  'contract',
  'freelance',
  'permanent',
  'internship',
  'engineering',
  'software engineering',
  'software development',
  'development',
  'programming',
  'qa & testing',
  'qa &amp; testing',
  'testing',
  'design',
  'marketing',
  'sales',
  'finance',
  'management',
  'other',
  'all',
  'general',
]);

/** Whether a `techStack` entry is plausibly a technology at all. */
export function isTechnologyTag(value: string): boolean {
  const cleaned = norm(value).replace(/&amp;/g, '&');
  if (cleaned.length < 2 || cleaned.length > 60) return false;
  return !NON_TECHNOLOGY_TAGS.has(cleaned);
}

/**
 * Extracts every feature of a job.
 *
 * Ordered lists decay in salience: the first technology listed is the one the
 * posting leads with, and the eighth is usually filler.
 */
export function extractFeatures(job: JobAttributes): JobFeature[] {
  const features: JobFeature[] = [];

  const add = (dimension: FeatureDimension, value: string | null, salience: number): void => {
    if (!value) return;
    const cleaned = value.trim();
    if (cleaned.length === 0 || cleaned.length > 160) return;

    const parsed = jobFeatureSchema.safeParse({ dimension, value: norm(cleaned), salience });
    if (parsed.success) features.push(parsed.data);
  };

  add('company', job.companyName, 1);
  add('country', job.countryCode, 1);
  add('location', job.city, 1);
  add('work_arrangement', job.remoteType, 1);
  add('seniority', job.seniority, 1);
  add('source', job.sourceId, 0.6);
  add('company_size', job.companySize, 0.5);
  add('salary_band', salaryBand(job.salaryAnnualUsd), 0.9);

  for (const [index, token] of titleTokens(job.title).entries()) {
    // The first token of a title carries most of its meaning.
    add('title_token', token, Math.max(0.4, 1 - index * 0.2));
  }

  const technologies = job.technologies.filter(isTechnologyTag).slice(0, 8);
  for (const [index, technology] of technologies.entries()) {
    add('technology', technology, Math.max(0.3, 1 - index * 0.12));
  }

  for (const [index, industry] of job.industries.slice(0, 3).entries()) {
    add('industry', industry, Math.max(0.5, 1 - index * 0.25));
  }

  for (const type of job.employmentTypes.slice(0, 2)) {
    add('employment_type', type, 0.7);
  }

  return assertNoProhibitedDimensions(features);
}

/**
 * Defence in depth on the prohibited-inference rule.
 *
 * The dimension set already makes a protected characteristic unrepresentable.
 * This checks anyway, because the cost of the check is nothing and the cost of
 * being wrong is a system that discriminates.
 */
export function assertNoProhibitedDimensions(features: readonly JobFeature[]): JobFeature[] {
  const prohibited = new Set<string>(PROHIBITED_INFERENCE_DIMENSIONS);
  const allowed = new Set<string>(FEATURE_DIMENSIONS);

  return features.filter(
    (feature) => allowed.has(feature.dimension) && !prohibited.has(feature.dimension),
  );
}

/**
 * The interaction matrix, as a lookup.
 *
 * Conceptually candidate × dimension × value. Represented as a keyed map
 * rather than a dense matrix because it is extremely sparse — a candidate
 * interacts with a few hundred values out of an unbounded space, and a dense
 * representation would be almost entirely zeroes.
 */
export function featureKey(dimension: FeatureDimension, value: string): string {
  return `${dimension}::${norm(value)}`;
}

export function parseFeatureKey(key: string): { dimension: FeatureDimension; value: string } | null {
  const index = key.indexOf('::');
  if (index === -1) return null;

  const dimension = key.slice(0, index) as FeatureDimension;
  if (!FEATURE_DIMENSIONS.includes(dimension)) return null;

  return { dimension, value: key.slice(index + 2) };
}
