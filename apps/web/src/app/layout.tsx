import type { Metadata } from 'next';
import { Nav } from '@/components/nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Naija Jobs',
  description: 'Autonomous job discovery, matching and notification',
};

/**
 * Application shell: a persistent sidebar plus a scrollable content column.
 * The sidebar collapses to a horizontal strip below the `md` breakpoint.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen flex-col md:flex-row">
          {/*
            Sticky, full-height, and scrolling on its own axis.

            Nineteen links plus the header overflow a laptop viewport. Before
            this the sidebar scrolled with the page, so reaching "Settings"
            meant scrolling the content away, and on a short window the last
            few links could not be reached at all.
          */}
          <aside
            className="shrink-0 border-b p-4 md:sticky md:top-0 md:h-screen md:w-64 md:overflow-y-auto md:border-b-0 md:border-r"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          >
            <div
              className="mb-5 border-b px-3 pb-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="text-sm font-semibold">Naija Jobs</span>
              <span className="block text-[11px]" style={{ color: 'var(--nav-heading)' }}>
                Nigeria &middot; hourly
              </span>
            </div>
            <Nav />
          </aside>

          <main className="min-w-0 flex-1 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
