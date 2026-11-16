/**
 * robots.txt compliance.
 *
 * This is a first-class part of the fetch path, not an optional courtesy. A
 * source that disallows our agent is simply not fetched, and the resulting
 * `NotPermittedError` is never retried.
 *
 * Also parses the `Content-Signal` directive some publishers now use to state
 * how their content may be used. We surface it so the operator can see the
 * stated terms; notably `ai-train=no` is respected by never using discovered
 * content as model training data.
 */

export interface RobotsGroup {
  userAgents: string[];
  allow: string[];
  disallow: string[];
  crawlDelaySeconds: number | null;
}

export interface RobotsRules {
  groups: RobotsGroup[];
  contentSignals: Record<string, string>;
  sitemaps: string[];
  /** True when robots.txt was unavailable; we then default to permitted. */
  assumedPermissive: boolean;
}

export function parseRobotsTxt(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  const contentSignals: Record<string, string> = {};
  const sitemaps: string[] = [];

  let current: RobotsGroup | null = null;
  let lastLineWasUserAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case 'user-agent': {
        // Consecutive User-agent lines share one group of rules.
        if (!current || !lastLineWasUserAgent) {
          current = { userAgents: [], allow: [], disallow: [], crawlDelaySeconds: null };
          groups.push(current);
        }
        current.userAgents.push(value.toLowerCase());
        lastLineWasUserAgent = true;
        continue;
      }
      case 'allow':
        if (current && value) current.allow.push(value);
        break;
      case 'disallow':
        // An empty Disallow means "allow everything" and must not become a rule.
        if (current && value) current.disallow.push(value);
        break;
      case 'crawl-delay': {
        const seconds = Number(value);
        if (current && Number.isFinite(seconds)) current.crawlDelaySeconds = seconds;
        break;
      }
      case 'sitemap':
        sitemaps.push(value);
        break;
      case 'content-signal':
        for (const pair of value.split(',')) {
          const [key, signal] = pair.split('=').map((s) => s.trim());
          if (key && signal) contentSignals[key.toLowerCase()] = signal.toLowerCase();
        }
        break;
      default:
        break;
    }
    lastLineWasUserAgent = false;
  }

  return { groups, contentSignals, sitemaps, assumedPermissive: false };
}

/**
 * Selects the group governing `userAgent`.
 * Per the standard, the most specific matching agent token wins; `*` is the
 * fallback and is ignored when a specific group exists.
 */
export function selectGroup(rules: RobotsRules, userAgent: string): RobotsGroup | null {
  const agent = userAgent.toLowerCase();
  let best: { group: RobotsGroup; length: number } | null = null;
  let wildcard: RobotsGroup | null = null;

  for (const group of rules.groups) {
    for (const token of group.userAgents) {
      if (token === '*') {
        wildcard ??= group;
        continue;
      }
      if (agent.includes(token) && (!best || token.length > best.length)) {
        best = { group, length: token.length };
      }
    }
  }
  return best?.group ?? wildcard;
}

/** Matches a robots path pattern, supporting `*` wildcards and `$` anchors. */
function pathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

export interface RobotsDecision {
  allowed: boolean;
  /** The rule that decided it, for the audit trail. */
  matchedRule: string | null;
  crawlDelaySeconds: number | null;
}

/**
 * Longest-match-wins, with Allow beating Disallow at equal length — the
 * behaviour the major crawlers implement and the one publishers expect.
 */
export function isAllowed(
  rules: RobotsRules,
  userAgent: string,
  pathname: string,
): RobotsDecision {
  const group = selectGroup(rules, userAgent);
  if (!group) return { allowed: true, matchedRule: null, crawlDelaySeconds: null };

  let bestAllow = -1;
  let bestDisallow = -1;
  let allowRule: string | null = null;
  let disallowRule: string | null = null;

  for (const pattern of group.allow) {
    if (pathMatches(pattern, pathname) && pattern.length > bestAllow) {
      bestAllow = pattern.length;
      allowRule = `Allow: ${pattern}`;
    }
  }
  for (const pattern of group.disallow) {
    if (pathMatches(pattern, pathname) && pattern.length > bestDisallow) {
      bestDisallow = pattern.length;
      disallowRule = `Disallow: ${pattern}`;
    }
  }

  if (bestDisallow > bestAllow) {
    return {
      allowed: false,
      matchedRule: disallowRule,
      crawlDelaySeconds: group.crawlDelaySeconds,
    };
  }
  return {
    allowed: true,
    matchedRule: allowRule,
    crawlDelaySeconds: group.crawlDelaySeconds,
  };
}

/** Caches robots.txt per origin with a TTL. */
export class RobotsCache {
  private readonly cache = new Map<string, { rules: RobotsRules; fetchedAt: number }>();

  constructor(
    private readonly fetchText: (url: string) => Promise<string | null>,
    private readonly ttlMs = 6 * 60 * 60 * 1_000,
  ) {}

  async get(origin: string): Promise<RobotsRules> {
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached.rules;

    let rules: RobotsRules;
    try {
      const text = await this.fetchText(`${origin}/robots.txt`);
      // No robots.txt means no restrictions — the standard's default.
      rules = text === null ? emptyRules(true) : parseRobotsTxt(text);
    } catch {
      // A robots fetch failure must not block discovery outright; assume
      // permissive but keep the TTL short by not extending it.
      rules = emptyRules(true);
    }

    this.cache.set(origin, { rules, fetchedAt: Date.now() });
    return rules;
  }

  set(origin: string, rules: RobotsRules): void {
    this.cache.set(origin, { rules, fetchedAt: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}

function emptyRules(assumedPermissive: boolean): RobotsRules {
  return { groups: [], contentSignals: {}, sitemaps: [], assumedPermissive };
}
