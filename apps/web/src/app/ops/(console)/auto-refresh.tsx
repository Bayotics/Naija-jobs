'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Polling refresh.
 *
 * The brief says not to reach for SSE or WebSockets where polling is enough,
 * and for a single operator on a single screen it is: `router.refresh()` re-runs
 * the server components and swaps in new data without losing scroll position or
 * open detail panels.
 *
 * Pauses when the tab is hidden — a dashboard left open in a background tab
 * polling every thirty seconds is a slow, invisible load on the database.
 */
export function OpsAutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, intervalMs]);

  return null;
}
