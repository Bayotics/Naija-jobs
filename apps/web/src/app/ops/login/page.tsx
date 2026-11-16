import { timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, currentSession, issueSession, rateLimit } from '@/lib/auth';
import { getServerContext } from '@/lib/db';
import { Card, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Console sign-in.
 *
 * A server action rather than a client fetch: the password never enters
 * client-side JavaScript, so it cannot be read by an extension, logged by an
 * error reporter, or left in a fetch body in a devtools tab.
 *
 * The failure message is deliberately uniform. "Wrong password" and "no such
 * user" are different sentences that together enumerate valid accounts; here
 * there is one account, but the same discipline keeps the rate limiter from
 * being a confirmation oracle.
 */
export default async function OpsLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  const ctx = await getServerContext();
  const configured = Boolean(ctx.env.AUTH_SECRET && ctx.env.OPS_PASSWORD);
  const session = await currentSession();

  async function signIn(formData: FormData) {
    'use server';
    const server = await getServerContext();
    const secret = server.env.AUTH_SECRET;
    const expected = server.env.OPS_PASSWORD;
    if (!secret || !expected) redirect('/ops/login?error=unconfigured');

    const headerList = await headers();
    const client =
      headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      headerList.get('x-real-ip') ??
      'local';

    if (!rateLimit(`ops-login-form:${client}`, { limit: 5, windowMs: 60_000 }).allowed) {
      redirect('/ops/login?error=rate_limited');
    }

    const supplied = Buffer.from(String(formData.get('password') ?? ''));
    const target = Buffer.from(expected);
    // Length is compared first because timingSafeEqual throws on a mismatch;
    // the length of a password is not the secret worth protecting here.
    const matches = supplied.length === target.length && timingSafeEqual(supplied, target);
    if (!matches) redirect('/ops/login?error=invalid');

    const store = await cookies();
    store.set(SESSION_COOKIE, issueSession('operator', server.env.OPS_ROLE, secret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: server.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 12 * 3600,
    });

    redirect('/ops');
  }

  async function signOut() {
    'use server';
    const store = await cookies();
    store.delete(SESSION_COOKIE);
    redirect('/ops/login');
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader title="Operations console" description="Sign in to control the pipeline." />

      {!configured && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
        >
          <strong>Sign-in is not configured.</strong> Set <code>AUTH_SECRET</code> and{' '}
          <code>OPS_PASSWORD</code> to protect this console. Until then it runs open and every
          action is attributed to <code>local</code>.
        </div>
      )}

      {error && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          {error === 'rate_limited'
            ? 'Too many attempts. Wait a minute and try again.'
            : error === 'unconfigured'
              ? 'Sign-in is unavailable because no credential is configured.'
              : 'Sign-in failed.'}
        </div>
      )}

      {session ? (
        <Card title="Signed in" description={`${session.actor} · ${session.role}`}>
          <p className="mb-3 text-xs" style={{ color: 'var(--muted)' }}>
            Session expires {new Date(session.expiresAt).toISOString().slice(0, 16).replace('T', ' ')}{' '}
            UTC.
          </p>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md px-3 py-1.5 text-xs font-medium"
              style={{ border: '1px solid var(--border)' }}
            >
              Sign out
            </button>
          </form>
        </Card>
      ) : (
        <Card title="Sign in">
          <form action={signIn} className="space-y-3">
            <label className="block text-xs">
              <span className="mb-1 block font-medium">Console password</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={!configured}
                className="w-full rounded border px-2 py-1.5 text-xs"
                style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
              />
            </label>
            <button
              type="submit"
              disabled={!configured}
              className="w-full rounded-md px-3 py-1.5 text-xs font-medium"
              style={{
                background: configured ? 'var(--accent)' : 'var(--surface)',
                color: configured ? '#fff' : 'var(--muted)',
                border: '1px solid var(--border)',
              }}
            >
              Sign in
            </button>
          </form>
          <p className="mt-3 text-[10px]" style={{ color: 'var(--muted)' }}>
            The session cookie is HMAC-signed, http-only and expires after 12 hours. It carries a
            role and an expiry and nothing else — no secret is ever sent to the browser.
          </p>
        </Card>
      )}
    </div>
  );
}
