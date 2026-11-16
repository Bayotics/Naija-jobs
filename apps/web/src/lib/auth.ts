import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import type { NextResponse } from 'next/server';
import { apiError } from './api';
import { getServerContext } from './db';

/**
 * Operations-console security.
 *
 * The console can disable connectors, trigger runs and read every job in the
 * system, so it is the most privileged surface here. Four controls, each doing
 * one job:
 *
 *  - **Session cookie**, HMAC-signed with `AUTH_SECRET`, `httpOnly`, `sameSite:
 *    lax`, `secure` outside development. Signed rather than stored so a restart
 *    does not log the operator out, and short-lived so a leaked cookie expires.
 *  - **Authorisation** by role, checked per route rather than per page — a page
 *    that only hides a button is not access control.
 *  - **CSRF**: `sameSite: lax` blocks cross-site form posts, and mutating
 *    routes additionally require a same-origin `Origin` header. Belt and
 *    braces, because `lax` still permits top-level GET navigation.
 *  - **Rate limiting** on the login route, so the shared secret cannot be
 *    brute-forced at request speed.
 *
 * No secret is ever returned to the client. The session carries a role and an
 * expiry and nothing else.
 */

export const SESSION_COOKIE = 'jobintel_ops';
const SESSION_TTL_HOURS = 12;

export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Higher may do everything lower may. */
const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2 };

export interface Session {
  actor: string;
  role: Role;
  expiresAt: number;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

export function createSession(session: Session, secret: string): string {
  const payload = base64url(JSON.stringify(session));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | undefined, secret: string): Session | null {
  if (!token || !secret) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Constant-time: `===` leaks the first differing byte, which is enough to
  // forge a signature given enough attempts.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
    if (typeof session.actor !== 'string' || !ROLES.includes(session.role)) return null;
    if (session.expiresAt < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function issueSession(actor: string, role: Role, secret: string): string {
  return createSession(
    { actor, role, expiresAt: Date.now() + SESSION_TTL_HOURS * 3_600_000 },
    secret,
  );
}

export async function currentSession(): Promise<Session | null> {
  const ctx = await getServerContext();
  const secret = ctx.env.AUTH_SECRET;
  if (!secret) return null;

  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value, secret);
}

/**
 * Whether the console is protected at all.
 *
 * Without `AUTH_SECRET` there is no way to sign a session, so the console runs
 * open. That is acceptable for a single-user local deployment and dangerous
 * anywhere else, so it is reported rather than silently assumed — the UI shows
 * an explicit warning.
 */
export async function authConfigured(): Promise<boolean> {
  const ctx = await getServerContext();
  return Boolean(ctx.env.AUTH_SECRET);
}

/**
 * A discriminated union, not an optional field.
 *
 * `{ ok: boolean; response?: … }` forces every caller to non-null-assert the
 * response, which is exactly the kind of assertion that eventually returns
 * `undefined` from an API route.
 */
export type AuthResult =
  | { ok: true; session: Session }
  | { ok: false; session: Session | null; response: NextResponse<unknown> };

/**
 * Guards an API route.
 *
 * `minimumRole` is the authorisation half: reading the dashboard is `viewer`,
 * triggering a run is `operator`, changing configuration is `admin`.
 */
export async function requireRole(minimumRole: Role = 'viewer'): Promise<AuthResult> {
  const ctx = await getServerContext();
  const secret = ctx.env.AUTH_SECRET;

  if (!secret) {
    // Open mode. Every action still audits, attributed to `local`.
    return { ok: true, session: { actor: 'local', role: 'admin', expiresAt: Date.now() + 3_600_000 } };
  }

  const session = await currentSession();
  if (!session) {
    return {
      ok: false,
      session: null,
      response: apiError(401, 'UNAUTHENTICATED', 'Sign in to use the operations console'),
    };
  }

  if (ROLE_RANK[session.role] < ROLE_RANK[minimumRole]) {
    return {
      ok: false,
      session,
      response: apiError(
        403,
        'FORBIDDEN',
        `This action requires the ${minimumRole} role; you have ${session.role}`,
      ),
    };
  }

  return { ok: true, session };
}

/**
 * Same-origin check for mutating requests.
 *
 * `sameSite: lax` already blocks cross-site form posts, but it permits
 * top-level GET navigation, and a mis-specified route could act on one. This
 * makes the guarantee explicit for anything that changes state.
 */
export async function requireSameOrigin(): Promise<NextResponse<unknown> | null> {
  const ctx = await getServerContext();
  const headerList = await headers();

  const origin = headerList.get('origin');
  // Same-origin fetches from a server component carry no Origin header; only a
  // *mismatched* one is a problem.
  if (!origin) return null;

  try {
    const expected = new URL(ctx.env.APP_URL);
    const actual = new URL(origin);
    if (expected.host !== actual.host) {
      return apiError(403, 'CROSS_ORIGIN', 'Cross-origin requests are not accepted');
    }
  } catch {
    return apiError(403, 'CROSS_ORIGIN', 'Origin header could not be parsed');
  }

  return null;
}

/**
 * A small fixed-window rate limiter.
 *
 * In-process and therefore per-instance — enough to stop a login brute-force on
 * a single-node deployment, and honest about not being a distributed limiter.
 * The discovery layer's per-domain limiter is the durable one; this guards a
 * single route.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  options: { limit: number; windowMs: number },
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + options.windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: options.limit - 1, resetAt };
  }

  bucket.count += 1;
  return {
    allowed: bucket.count <= options.limit,
    remaining: Math.max(0, options.limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

/** Opaque per-request id, for correlating an audit entry with a log line. */
export function requestId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The standard guard for a mutating ops route.
 *
 * Combines authentication, authorisation and the same-origin check so a route
 * cannot accidentally implement two of the three.
 */
export async function guardMutation(minimumRole: Role = 'operator'): Promise<
  { ok: true; session: Session; requestId: string } | { ok: false; response: NextResponse<unknown> }
> {
  const csrf = await requireSameOrigin();
  if (csrf) return { ok: false, response: csrf };

  const auth = await requireRole(minimumRole);
  if (!auth.ok) return { ok: false, response: auth.response };

  return { ok: true, session: auth.session, requestId: requestId() };
}
