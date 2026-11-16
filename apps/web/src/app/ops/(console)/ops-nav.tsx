'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Console sub-navigation.
 *
 * The control centre has enough surfaces that returning to `/ops` between every
 * one of them is friction. A horizontal strip rather than a second sidebar:
 * these pages are dense, and the width is worth more than the affordance.
 */
const TABS: Array<{ href: string; label: string }> = [
  { href: '/ops', label: 'Overview' },
  { href: '/ops/runs', label: 'Runs' },
  { href: '/ops/sources', label: 'Sources' },
  { href: '/ops/acquisition', label: 'Acquisition' },
  { href: '/ops/execution', label: 'Execution' },
  { href: '/ops/jobs', label: 'Jobs' },
  { href: '/ops/discovery', label: 'Discovery' },
  { href: '/ops/queues', label: 'Queues' },
  { href: '/ops/logs', label: 'Logs' },
  { href: '/ops/metrics', label: 'Metrics' },
  { href: '/ops/analytics', label: 'Analytics' },
  { href: '/ops/learning', label: 'Learning' },
  { href: '/ops/config', label: 'Configuration' },
  { href: '/ops/audit', label: 'Audit' },
  { href: '/ops/control', label: 'Controls' },
];

export function OpsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Operations" className="scroll-x -mx-1 mb-4">
      <ul className="flex min-w-max items-center gap-0.5 px-1">
        {TABS.map((tab) => {
          const active = tab.href === '/ops' ? pathname === '/ops' : pathname.startsWith(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className="block whitespace-nowrap rounded-md px-2.5 py-1 text-xs transition-colors"
                style={{
                  background: active ? 'var(--surface)' : 'transparent',
                  border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
                  color: active ? 'var(--text)' : 'var(--muted)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
