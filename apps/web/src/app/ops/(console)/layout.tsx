import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { authConfigured, currentSession } from '@/lib/auth';
import { OpsNav } from './ops-nav';

/**
 * Console shell, and the page-level authentication boundary.
 *
 * A route group rather than a check repeated on eleven pages: a guard you have
 * to remember to add is a guard that eventually gets forgotten on the twelfth
 * page. `/ops/login` deliberately sits outside this group, so the sign-in page
 * is reachable without a session.
 *
 * The API routes guard themselves independently. This is not defence in depth
 * for its own sake — a page that only hides a button is not access control, and
 * a route that trusts the page that called it is not either.
 */
export default async function OpsConsoleLayout({ children }: { children: ReactNode }) {
  const [protectedConsole, session] = await Promise.all([authConfigured(), currentSession()]);

  // Unprotected mode is a deliberate single-user local deployment, warned about
  // on the dashboard rather than blocked here.
  if (protectedConsole && !session) redirect('/ops/login');

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-4">
        <OpsNav />
        {session && (
          <span className="whitespace-nowrap text-[11px]" style={{ color: 'var(--muted)' }}>
            {session.actor} · {session.role} ·{' '}
            <Link href="/ops/login" style={{ color: 'var(--accent)' }}>
              session
            </Link>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
