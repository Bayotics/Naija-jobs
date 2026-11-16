import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { NotPermittedError } from '../errors';

/**
 * SSRF protection.
 *
 * This system fetches URLs that ultimately come from third parties: search
 * results, sitemap entries, links on a careers page, and URLs an operator
 * types in. Any of those can point at the machine the worker runs on.
 *
 * A hostname denylist is not sufficient, and the three ways it fails are all
 * routinely exploited:
 *
 *  1. **DNS.** `evil.example.com` is a perfectly ordinary public hostname that
 *     resolves to `169.254.169.254`. Nothing about the string reveals that, so
 *     the address must be checked *after* resolution, not before.
 *  2. **Alternate literal encodings.** `http://2130706433/`, `http://0177.0.0.1/`
 *     and `http://0x7f.1/` are all loopback. A regex written against dotted
 *     decimal matches none of them.
 *  3. **Redirects.** A public URL may 302 to a private one. `fetch` with
 *     `redirect: 'follow'` performs that hop inside the runtime, where no guard
 *     can see it — so redirects must be followed manually, one validated hop at
 *     a time.
 *
 * The guard is deliberately not configurable. An operator who can make the
 * system fetch `http://localhost:5432` has a database, and one who can make it
 * fetch the cloud metadata endpoint has the machine's credentials.
 */

/** Reserved IPv4 ranges, as [start, end] of the 32-bit address space. */
const IPV4_BLOCKS: Array<{ start: number; end: number; label: string }> = [
  { start: 0x00000000, end: 0x00ffffff, label: 'this-network (0.0.0.0/8)' },
  { start: 0x0a000000, end: 0x0affffff, label: 'private (10.0.0.0/8)' },
  { start: 0x64400000, end: 0x647fffff, label: 'carrier-grade NAT (100.64.0.0/10)' },
  { start: 0x7f000000, end: 0x7fffffff, label: 'loopback (127.0.0.0/8)' },
  { start: 0xa9fe0000, end: 0xa9feffff, label: 'link-local / cloud metadata (169.254.0.0/16)' },
  { start: 0xac100000, end: 0xac1fffff, label: 'private (172.16.0.0/12)' },
  { start: 0xc0000000, end: 0xc00000ff, label: 'IETF protocol assignments (192.0.0.0/24)' },
  { start: 0xc0000200, end: 0xc00002ff, label: 'documentation (192.0.2.0/24)' },
  { start: 0xc0a80000, end: 0xc0a8ffff, label: 'private (192.168.0.0/16)' },
  { start: 0xc6120000, end: 0xc613ffff, label: 'benchmarking (198.18.0.0/15)' },
  { start: 0xe0000000, end: 0xefffffff, label: 'multicast (224.0.0.0/4)' },
  { start: 0xf0000000, end: 0xffffffff, label: 'reserved / broadcast (240.0.0.0/4)' },
];

/** Hostname suffixes that are internal by convention, checked before DNS. */
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa', '.lan'];

/** Ports that are never a public web endpoint worth fetching. */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 143, 445, 465, 587, 993, 995, 1433, 1521, 2049, 3306, 3389, 5432, 5984, 6379,
  9200, 11211, 27017,
]);

export interface SsrfCheckResult {
  allowed: boolean;
  reason: string | null;
  /** Addresses the hostname resolved to, when resolution happened. */
  addresses: string[];
}

/** Host resolution, injectable so tests need no network and no DNS fixtures. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const dnsResolver: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/**
 * Canonicalises the many ways an IPv4 address can be written.
 *
 * `curl` and most HTTP stacks accept decimal (`2130706433`), octal
 * (`0177.0.0.1`), hex (`0x7f000001`) and short forms (`127.1`). Node's `fetch`
 * accepts several of them too, so all of them must reduce to the same 32-bit
 * value before the range check runs.
 */
export function canonicaliseIpv4(host: string): string | null {
  if (isIP(host) === 4) return host;

  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }

  // Short forms pack the remaining octets into the final part: `127.1` is
  // 127.0.0.1, `10.0.513` is 10.0.2.1.
  const last = values.pop()!;
  const maxLast = 256 ** (4 - values.length);
  if (last >= maxLast) return null;
  if (values.some((value) => value > 255)) return null;

  let total = 0;
  for (const value of values) total = total * 256 + value;
  total = total * maxLast + last;
  if (total > 0xffffffff) return null;

  return [
    (total >>> 24) & 0xff,
    (total >>> 16) & 0xff,
    (total >>> 8) & 0xff,
    total & 0xff,
  ].join('.');
}

/** Whether a literal address is in a reserved or private range. */
export function classifyAddress(address: string): { private: boolean; label: string | null } {
  const version = isIP(address);

  if (version === 4) {
    const value = ipv4ToNumber(address);
    if (value === null) return { private: true, label: 'unparseable IPv4 address' };
    const block = IPV4_BLOCKS.find((b) => value >= b.start && value <= b.end);
    return block ? { private: true, label: block.label } : { private: false, label: null };
  }

  if (version === 6) {
    const normalised = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalised === '::' || normalised === '::1') {
      return { private: true, label: 'IPv6 loopback / unspecified' };
    }
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(normalised)) return { private: true, label: 'IPv6 unique-local (fc00::/7)' };
    if (/^fe[89ab]/.test(normalised)) return { private: true, label: 'IPv6 link-local (fe80::/10)' };
    // IPv4-mapped (::ffff:127.0.0.1) inherits the IPv4 verdict.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
    if (mapped?.[1]) {
      const inner = classifyAddress(mapped[1]);
      return inner.private
        ? { private: true, label: `IPv4-mapped ${inner.label}` }
        : { private: false, label: null };
    }
    return { private: false, label: null };
  }

  return { private: true, label: 'not an IP address' };
}

export interface SsrfOptions {
  resolve?: HostResolver;
  /** Extra hostnames or suffixes to refuse, from configuration. */
  blockedHosts?: readonly string[];
  /** Skips DNS. Only for callers that already resolved, or for tests. */
  skipResolution?: boolean;
}

/**
 * Decides whether one URL may be fetched.
 *
 * Returns a result rather than throwing so callers can log a refusal as a
 * normal outcome — a user-submitted URL pointing at localhost is a data
 * problem, not an exception.
 */
export async function checkUrl(url: URL, options: SsrfOptions = {}): Promise<SsrfCheckResult> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `unsupported protocol ${url.protocol}`, addresses: [] };
  }

  // Credentials in a URL are a common SSRF and phishing vector, and no
  // legitimate public job source needs them.
  if (url.username || url.password) {
    return { allowed: false, reason: 'URL carries embedded credentials', addresses: [] };
  }

  if (url.port && BLOCKED_PORTS.has(Number(url.port))) {
    return { allowed: false, reason: `port ${url.port} is not a public web port`, addresses: [] };
  }

  // A trailing dot is a distinct hostname to DNS but the same host, and is a
  // standard way to slip past a suffix denylist.
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { allowed: false, reason: 'loopback hostname', addresses: [] };
  }
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { allowed: false, reason: `internal hostname suffix (${host})`, addresses: [] };
  }
  for (const blocked of options.blockedHosts ?? []) {
    const needle = blocked.toLowerCase().replace(/^\./, '');
    if (host === needle || host.endsWith(`.${needle}`)) {
      return { allowed: false, reason: `host is blocked by configuration (${blocked})`, addresses: [] };
    }
  }

  // Literal address, in any notation.
  const literal = isIP(host) ? host : canonicaliseIpv4(host);
  if (literal) {
    const verdict = classifyAddress(literal);
    return verdict.private
      ? { allowed: false, reason: `address is ${verdict.label}`, addresses: [literal] }
      : { allowed: true, reason: null, addresses: [literal] };
  }

  if (options.skipResolution) return { allowed: true, reason: null, addresses: [] };

  // Resolve, and refuse if *any* answer is private. A hostname with one public
  // and one private address is exactly the shape of a rebinding attack, and
  // there is no way to bind the subsequent connection to the address we
  // approved.
  let addresses: string[];
  try {
    addresses = await (options.resolve ?? dnsResolver)(host);
  } catch (error) {
    return {
      allowed: false,
      reason: `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      addresses: [],
    };
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: 'hostname resolved to no addresses', addresses: [] };
  }

  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (verdict.private) {
      return {
        allowed: false,
        reason: `${host} resolves to ${address}, which is ${verdict.label}`,
        addresses,
      };
    }
  }

  return { allowed: true, reason: null, addresses };
}

/** Throwing form, for the fetch path where a refusal must abort the request. */
export async function assertPublicUrl(url: URL, options: SsrfOptions = {}): Promise<void> {
  const result = await checkUrl(url, options);
  if (!result.allowed) {
    throw new NotPermittedError(`Refusing to fetch ${url.host}: ${result.reason}`, {
      url: url.toString(),
      reason: result.reason,
    });
  }
}
