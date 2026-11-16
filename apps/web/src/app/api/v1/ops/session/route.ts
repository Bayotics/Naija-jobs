import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { SESSION_COOKIE, issueSession, rateLimit, requireSameOrigin } from '@/lib/auth';
import { getServerContext } from '@/lib/db';
import { apiError, handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

const loginSchema = z.object({ password: z.string().min(1).max(512) });

/**
 * Console sign-in and sign-out.
 *
 * Four things this route is careful about:
 *
 *  - **Constant-time comparison.** `===` on a secret leaks the first differing
 *    byte through timing, which is enough to recover a password given patience.
 *  - **Rate limiting per client.** Five attempts a minute makes an online
 *    brute-force uninteresting without locking out a person who mistyped.
 *  - **Same-origin.** Sign-in is a mutation; a cross-site POST must not be able
 *    to plant a session cookie.
 *  - **No echo.** The response never contains the credential, the secret, or
 *    any hint about which of the two was wrong.
 */
export function POST(request: Request) {
  return handler(async () => {
    const csrf = await requireSameOrigin();
    if (csrf) return csrf;

    const ctx = await getServerContext();
    const secret = ctx.env.AUTH_SECRET;
    const expected = ctx.env.OPS_PASSWORD;

    if (!secret || !expected) {
      return apiError(
        503,
        'AUTH_NOT_CONFIGURED',
        'Sign-in is unavailable because AUTH_SECRET or OPS_PASSWORD is not set. The console is running unauthenticated.',
      );
    }

    const headerList = await headers();
    const client =
      headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? headerList.get('x-real-ip') ?? 'local';

    const limit = rateLimit(`ops-login:${client}`, { limit: 5, windowMs: 60_000 });
    if (!limit.allowed) {
      return apiError(
        429,
        'RATE_LIMITED',
        `Too many sign-in attempts. Try again after ${new Date(limit.resetAt).toISOString().slice(11, 19)} UTC.`,
      );
    }

    const { password } = await parseBody(request, loginSchema);

    const supplied = Buffer.from(password);
    const target = Buffer.from(expected);
    const matches = supplied.length === target.length && timingSafeEqual(supplied, target);

    if (!matches) {
      return apiError(401, 'INVALID_CREDENTIALS', 'That is not the console password.');
    }

    const token = issueSession('operator', ctx.env.OPS_ROLE, secret);
    const store = await cookies();
    store.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 12 * 3600,
    });

    return NextResponse.json({ ok: true, role: ctx.env.OPS_ROLE });
  });
}

/** Sign-out. Clearing the cookie is sufficient — sessions are stateless. */
export function DELETE() {
  return handler(async () => {
    const csrf = await requireSameOrigin();
    if (csrf) return csrf;

    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return NextResponse.json({ ok: true });
  });
}
