import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed preference links.
 *
 * The email needs a link to the notification settings, and the obvious
 * implementation — `?email=me@example.com&unsubscribe=1` — lets anyone who sees
 * the address change the account's settings. Anyone includes every mail relay
 * the message passed through and every corporate scanner that pre-fetches links.
 *
 * So the link carries an HMAC over the profile id, a scope and an expiry. It
 * grants exactly one capability, expires, and cannot be edited into a different
 * one. The secret lives in the environment.
 *
 * The token authorises *opening the settings page*. Actually changing a
 * preference still goes through the normal write path, and a GET never mutates
 * anything — a scanner pre-fetching the link must not unsubscribe anyone.
 */

export const PREFERENCE_LINK_SCOPES = ['manage', 'unsubscribe'] as const;
export type PreferenceLinkScope = (typeof PREFERENCE_LINK_SCOPES)[number];

export interface PreferenceToken {
  profileId: string;
  scope: PreferenceLinkScope;
  expiresAt: number;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

export function createPreferenceToken(
  input: { profileId: string; scope?: PreferenceLinkScope; ttlDays?: number },
  secret: string,
  now: Date = new Date(),
): string {
  if (!secret || secret.trim().length < 16) {
    throw new Error('A preference-link secret of at least 16 characters is required');
  }

  const token: PreferenceToken = {
    profileId: input.profileId,
    scope: input.scope ?? 'manage',
    // Long enough to survive an email sitting unread for a fortnight, short
    // enough that a leaked archive stops working.
    expiresAt: now.getTime() + (input.ttlDays ?? 30) * 86_400_000,
  };

  const payload = base64url(JSON.stringify(token));
  return `${payload}.${sign(payload, secret)}`;
}

export interface TokenVerification {
  valid: boolean;
  token: PreferenceToken | null;
  reason: string;
}

/**
 * Verifies a token.
 *
 * The signature is compared with `timingSafeEqual` — a plain `===` leaks the
 * position of the first differing byte, which is enough to forge one over
 * enough requests.
 *
 * `now` mirrors `createPreferenceToken`, which has always taken one. The pair
 * being asymmetric meant a token could be minted at a chosen instant but only
 * ever checked against the wall clock, so a test that signed a link at a fixed
 * fixture date passed until that date fell more than the token's 30-day
 * lifetime in the past, and then reported the signing code broken.
 */
export function verifyPreferenceToken(
  value: string,
  secret: string,
  now: Date = new Date(),
): TokenVerification {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) {
    return { valid: false, token: null, reason: 'malformed token' };
  }

  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, token: null, reason: 'signature does not verify' };
  }

  let token: PreferenceToken;
  try {
    token = JSON.parse(fromBase64url(payload).toString('utf8')) as PreferenceToken;
  } catch {
    return { valid: false, token: null, reason: 'payload is not valid JSON' };
  }

  if (typeof token.profileId !== 'string' || typeof token.expiresAt !== 'number') {
    return { valid: false, token: null, reason: 'payload is missing required fields' };
  }
  if (token.expiresAt < now.getTime()) {
    return { valid: false, token: null, reason: 'token has expired' };
  }

  return { valid: true, token, reason: 'valid' };
}

export function preferenceUrl(
  appUrl: string,
  input: { profileId: string; scope?: PreferenceLinkScope },
  secret: string | null,
  now: Date = new Date(),
): string {
  const base = appUrl.replace(/\/+$/, '');
  // Without a secret configured the link degrades to the plain settings page:
  // it still works when signed in, and it grants nothing to anyone else.
  if (!secret || secret.trim().length < 16) return `${base}/settings/notifications`;

  const token = createPreferenceToken(
    { profileId: input.profileId, scope: input.scope ?? 'manage' },
    secret,
    now,
  );
  return `${base}/settings/notifications?token=${encodeURIComponent(token)}`;
}
