import { createHash } from 'node:crypto';
import {
  IDENTITY_MATCH_THRESHOLD,
  IDENTITY_SIGNAL_WEIGHTS,
  jobIdentitySignalsSchema,
  type IdentitySignal,
  type JobIdentitySignals,
} from '@job-intel/contracts';
import { detectAts } from '../ats/providers';

/**
 * Whether two postings describe the same opening.
 *
 * Part 47 is emphatic that URL alone is not enough, and it is right in both
 * directions. The same Greenhouse posting appears under a company vanity
 * domain, a board's redirect wrapper and a search result, all with different
 * URLs and all one job. Conversely a single URL gets reused when a company
 * reopens a role six months later, which is two jobs at one address.
 *
 * So identity is agreement between several independent signals, weighted by how
 * hard each is to match by accident. An ATS identifier is nearly conclusive —
 * two postings with the same Greenhouse job id *are* the same posting. A
 * company-and-title match is a hint: "Software Engineer at Google" describes
 * hundreds of distinct openings.
 *
 * The output is a score and the signals behind it, never a bare boolean. When a
 * deduplication decision turns out wrong, the reason it was made is the only
 * thing that makes it fixable.
 */

/** Tracking parameters that change per visit and mean nothing about the job. */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'msclkid',
  'ref',
  'referrer',
  'source',
  'src',
  'trk',
  'trkCampaign',
  'lever-source',
  'gh_src',
  'mc_cid',
  'mc_eid',
];

/**
 * Strips everything about a URL that does not identify the posting.
 *
 * Order matters slightly: parameters are dropped before the trailing slash is
 * normalised, so `?utm_source=x` on a bare path does not leave a stray `?`.
 */
export function normalizeUrl(rawUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);

  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.protocol = 'https:';

  if ((url.port === '80' || url.port === '443')) url.port = '';

  let path = url.pathname.replace(/\/+$/, '');
  if (path === '') path = '/';
  url.pathname = path;

  // A stable parameter order, so two orderings of the same query agree.
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);

  return url.toString();
}

/** Lowercase, punctuation-free, whitespace-collapsed. */
export function slugify(value: string | null | undefined): string | null {
  if (!value) return null;

  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length === 0 ? null : slug;
}

/**
 * A fingerprint over the description's content, not its formatting.
 *
 * Whitespace and case are dropped, and only the first few thousand characters
 * are read: boards append their own boilerplate — equal-opportunity statements,
 * application instructions — which differs between copies of an identical
 * posting. Reading the opening prose compares what the employer wrote.
 */
export function descriptionFingerprint(description: string | null): string | null {
  if (!description) return null;

  const text = description
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 3_000);

  if (text.length < 80) return null;

  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * The *posting* id inside an ATS URL, as opposed to the board it lives on.
 *
 * `detectAts` answers "whose board is this" and returns the company slug, which
 * is the right answer to that question and the wrong one for identity: every
 * posting on Northwind's Greenhouse board shares it. Two openings on the same
 * team would collapse into one job and one of them would never be applied to.
 *
 * Each provider puts the posting id in a different place, so the patterns are
 * per provider rather than one hopeful regex.
 */
const ATS_JOB_ID_PATTERNS: Readonly<Record<string, RegExp>> = {
  greenhouse: /\/jobs\/(\d+)/i,
  lever: /\/[^/]+\/([0-9a-f-]{8,})/i,
  ashby: /\/[^/]+\/([0-9a-f-]{8,})/i,
  smartrecruiters: /\/([0-9]{6,})(?:-|$|\/)/i,
  workable: /\/j\/([A-Z0-9]{6,})/i,
  recruitee: /\/o\/([a-z0-9-]+)/i,
  personio: /\/job\/(\d+)/i,
};

export function atsJobIdFrom(provider: string, url: string): string | null {
  const pattern = ATS_JOB_ID_PATTERNS[provider];
  if (!pattern) return null;

  try {
    return pattern.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface IdentityInput {
  url: string;
  canonicalUrl?: string | null;
  externalId?: string | null;
  companyName?: string | null;
  title?: string | null;
  locationText?: string | null;
  description?: string | null;
}

/** Everything identity-bearing about one posting. */
export function buildIdentitySignals(input: IdentityInput): JobIdentitySignals {
  const atsUrl = input.canonicalUrl ?? input.url;
  const ats = detectAts({ url: atsUrl });

  /*
   * Board *and* posting, joined.
   *
   * The board alone is not an identity — every posting on it would share one.
   * When the posting id cannot be read the signal is dropped entirely rather
   * than falling back to the board, because a signal weighted at 0.45 must not
   * be allowed to fire on something that weak.
   */
  const atsJobId = ats ? atsJobIdFrom(ats.provider.id, atsUrl) : null;

  return jobIdentitySignalsSchema.parse({
    atsProvider: ats && atsJobId ? ats.provider.id : null,
    atsJobId: ats && atsJobId ? `${ats.identifier}:${atsJobId}` : null,
    sourceJobId: input.externalId ?? null,
    canonicalUrl: input.canonicalUrl ? normalizeUrl(input.canonicalUrl) : null,
    normalizedUrl: normalizeUrl(input.url),
    companySlug: slugify(input.companyName),
    titleSlug: slugify(input.title),
    locationSlug: slugify(input.locationText),
    descriptionFingerprint: descriptionFingerprint(input.description ?? null),
  });
}

/**
 * A single opaque key for the strongest identity a posting has.
 *
 * Used as a database unique constraint, which is why it is a single string
 * rather than the full signal set: idempotency belongs in the schema, not in
 * application logic that races with itself. The prefix records which signal
 * produced it, so a key collision can be explained.
 */
export function canonicalJobKey(signals: JobIdentitySignals): string {
  if (signals.atsProvider && signals.atsJobId) {
    return `ats:${signals.atsProvider}:${signals.atsJobId}`;
  }

  if (signals.canonicalUrl) return `url:${hash(signals.canonicalUrl)}`;
  if (signals.normalizedUrl) return `url:${hash(signals.normalizedUrl)}`;

  /*
   * The weakest key, and used only when a posting has no URL identity at all —
   * a social post, a mailbox item. Company plus title plus location is not a
   * reliable identity, so a fingerprint is folded in when one exists to stop
   * two genuinely different openings from colliding.
   */
  const parts = [
    signals.companySlug ?? 'unknown',
    signals.titleSlug ?? 'unknown',
    signals.locationSlug ?? 'anywhere',
    signals.descriptionFingerprint ?? '',
  ];

  return `weak:${hash(parts.join('|'))}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

export interface IdentityComparison {
  score: number;
  same: boolean;
  agreed: IdentitySignal[];
  conflicted: IdentitySignal[];
}

/**
 * Scores two postings against each other.
 *
 * Conflicts are tracked separately from disagreements-by-absence, and the
 * difference is the tri-state rule this codebase applies everywhere: two
 * postings where one states a location and the other does not are not in
 * conflict, they are differently complete. Only two *stated* and *different*
 * values conflict.
 *
 * A conflicting ATS id is decisive on its own — two different Greenhouse ids
 * are two different postings, whatever else agrees.
 */
export function compareIdentities(
  left: JobIdentitySignals,
  right: JobIdentitySignals,
): IdentityComparison {
  const agreed: IdentitySignal[] = [];
  const conflicted: IdentitySignal[] = [];
  let score = 0;

  const check = (
    signal: IdentitySignal,
    a: string | null,
    b: string | null,
  ): void => {
    if (a === null || b === null) return;

    if (a === b) {
      agreed.push(signal);
      score += IDENTITY_SIGNAL_WEIGHTS[signal];
    } else {
      conflicted.push(signal);
    }
  };

  const sameAts =
    left.atsProvider !== null && left.atsProvider === right.atsProvider;

  check('atsId', sameAts ? left.atsJobId : null, sameAts ? right.atsJobId : null);

  /*
   * Each side's best URL, not each side's *same-named* URL.
   *
   * A board links a posting through a redirect wrapper and records the real
   * address as canonical; a search result reaches the same posting directly and
   * has only a normalized URL. Comparing canonical-to-canonical finds nothing,
   * and comparing normalized-to-normalized finds a conflict — between a wrapper
   * and the thing it wraps, which is not a disagreement about identity at all.
   */
  check(
    'canonicalUrl',
    left.canonicalUrl ?? left.normalizedUrl,
    right.canonicalUrl ?? right.normalizedUrl,
  );

  check('sourceJobId', left.sourceJobId, right.sourceJobId);
  check('descriptionFingerprint', left.descriptionFingerprint, right.descriptionFingerprint);

  const leftTriple =
    left.companySlug && left.titleSlug
      ? `${left.companySlug}|${left.titleSlug}|${left.locationSlug ?? ''}`
      : null;
  const rightTriple =
    right.companySlug && right.titleSlug
      ? `${right.companySlug}|${right.titleSlug}|${right.locationSlug ?? ''}`
      : null;

  check('companyTitleLocation', leftTriple, rightTriple);

  /*
   * A conflicting ATS id overrides everything.
   *
   * Two postings can share a company, a title, a location and most of a
   * description and still be two openings on the same team — which is exactly
   * what different ATS ids mean. Letting the weaker signals outvote that would
   * merge two real jobs into one and lose an application.
   */
  if (conflicted.includes('atsId')) {
    return { score: 0, same: false, agreed, conflicted };
  }

  /*
   * And an agreeing one is decisive in the other direction.
   *
   * Symmetry with the rule above. If two different posting ids on one board
   * mean two different jobs, then the same posting id on one board means one
   * job — whatever the URLs look like, and whatever a board did to the company
   * name on its way through.
   */
  if (agreed.includes('atsId')) {
    return { score: 1, same: true, agreed, conflicted };
  }

  return {
    score: Math.min(1, score),
    same: score >= IDENTITY_MATCH_THRESHOLD,
    agreed,
    conflicted,
  };
}
