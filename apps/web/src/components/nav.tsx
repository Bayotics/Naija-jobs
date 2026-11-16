'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Primary navigation.
 *
 * Rewritten after the first real session with nineteen links in it. Three
 * things were wrong, and the first was a bug rather than a matter of taste:
 *
 * **The active item was invisible.** It set `background: var(--surface)` while
 * sitting inside an `<aside>` already painted `var(--surface)`, so the only cue
 * that survived was a slightly heavier font. There was no reliable way to see
 * which page you were on.
 *
 * **Inactive labels sat at `--muted` on `--surface`**, which is roughly 3:1 in
 * dark mode — under the 4.5:1 needed for text this size, and the reason the
 * list read as grey mush.
 *
 * **Nineteen equal-weight labels do not scan.** Icons give each row a fixed
 * shape to aim at, so finding "Sources" becomes recognition rather than
 * reading. The two groups are now visually separated as well as labelled.
 *
 * The sidebar also scrolls independently of the page. Nineteen items plus a
 * header overflow a laptop viewport, and the page-level scroll left the bottom
 * of the list unreachable while the top was pinned.
 */

/**
 * Icons.
 *
 * Inline single-path SVGs rather than an icon package: nineteen glyphs do not
 * justify a dependency, and inlining keeps them themeable with `currentColor`
 * and immune to the CSP rules that block external assets.
 */
const ICONS: Readonly<Record<string, string>> = {
  dashboard: 'M3 12h7V3H3v9zm0 9h7v-7H3v7zm11 0h7V12h-7v9zm0-18v7h7V3h-7z',
  jobs: 'M4 7h16v13H4zM9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2',
  recommendations: 'M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z',
  matches: 'M20 6L9 17l-5-5',
  opportunities: 'M3 17l6-6 4 4 8-8M21 7h-5m5 0v5',
  saved: 'M6 3h12v18l-6-4-6 4z',
  applications: 'M8 3h8l4 4v14H4V3h4zm0 0v5h8',
  notifications: 'M18 8a6 6 0 1 0-12 0c0 7-2 8-2 8h16s-2-1-2-8M13.7 21a2 2 0 0 1-3.4 0',
  intelligence: 'M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2zM9 21h6',
  control: 'M4 6h16M4 12h16M4 18h16M8 4v4m8 4v4M6 16v4',
  profile: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  candidate: 'M12 2a7 7 0 0 1 7 7c0 3-2 4-2 7H7c0-3-2-4-2-7a7 7 0 0 1 7-7zM9 21h6',
  documents: 'M14 2H6v20h12V6zm0 0v4h4M9 13h6M9 17h6',
  learning: 'M22 9L12 4 2 9l10 5 10-5zM6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5',
  preferences: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  sources: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7.5a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  operations: 'M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0H5a2 2 0 0 1-2-2V9m6 12h10a2 2 0 0 0 2-2V9M3 9h18',
  alerts: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};

function Icon({ name }: { name: string }) {
  const path = ICONS[name] ?? ICONS['jobs']!;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4 shrink-0"
    >
      <path d={path} />
    </svg>
  );
}

const SECTIONS: Array<{
  group: string;
  items: Array<{ href: string; label: string; icon: string; pending?: boolean }>;
}> = [
  {
    group: 'Discovery',
    items: [
      { href: '/', label: 'Dashboard', icon: 'dashboard' },
      { href: '/jobs', label: 'Jobs', icon: 'jobs' },
      { href: '/recommendations', label: 'Recommendations', icon: 'recommendations' },
      { href: '/matches', label: 'Matches', icon: 'matches' },
      { href: '/opportunities', label: 'Opportunities', icon: 'opportunities' },
      { href: '/saved', label: 'Saved', icon: 'saved' },
      { href: '/applications', label: 'Applications', icon: 'applications' },
    ],
  },
  {
    group: 'Configuration',
    items: [
      { href: '/control-center', label: 'Control Centre', icon: 'control' },
      { href: '/profile', label: 'Candidate Profile', icon: 'profile' },
      { href: '/candidate', label: 'Candidate Intelligence', icon: 'candidate' },
      { href: '/resume', label: 'Documents & Evidence', icon: 'documents' },
      { href: '/learning', label: 'What We Learned', icon: 'learning' },
      { href: '/preferences', label: 'Preferences', icon: 'preferences' },
      { href: '/sources', label: 'Sources', icon: 'sources' },
      { href: '/ops', label: 'Operations', icon: 'operations' },
      { href: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

/**
 * Which link owns the current URL.
 *
 * Longest-prefix rather than "any prefix matches". `/notifications` and
 * `/notifications/intelligence` both prefix-match the intelligence page, and
 * the naive rule lit up both — so the sidebar showed two active items and
 * neither told you where you were.
 */
function activeHref(pathname: string): string | null {
  const candidates = SECTIONS.flatMap((section) => section.items.map((item) => item.href))
    .filter((href) => (href === '/' ? pathname === '/' : pathname.startsWith(href)))
    .sort((a, b) => b.length - a.length);

  return candidates[0] ?? null;
}

export function Nav() {
  const pathname = usePathname();
  const current = activeHref(pathname);

  return (
    <nav aria-label="Primary" className="flex flex-col gap-5">
      {SECTIONS.map((section) => (
        <div key={section.group}>
          <h2
            className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: 'var(--nav-heading)' }}
          >
            {section.group}
          </h2>

          <ul className="flex flex-col gap-px">
            {section.items.map((item) => {
              const active = item.href === current;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    data-active={active ? 'true' : undefined}
                    className="nav-link group flex items-center gap-2.5 rounded-md py-[7px] pl-3 pr-2 text-[13px] leading-5"
                    title={item.label}
                  >
                    <Icon name={item.icon} />

                    {/*
                      Labels are allowed to truncate rather than wrap. "Candidate
                      Intelligence" wraps to two lines at this width, and a list
                      where some rows are twice as tall as others is measurably
                      harder to scan; the full text stays available as a tooltip.
                    */}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>

                    {item.pending && (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide"
                        style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                      >
                        soon
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
