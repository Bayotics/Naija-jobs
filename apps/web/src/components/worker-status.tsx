import 'server-only';
import { OpsRepository } from '@job-intel/db';
import { getServerContext } from '@/lib/db';

/**
 * Is anything actually running?
 *
 * This exists because of a day the corpus did not move. Every page looked
 * healthy — 687 jobs, nine sources enabled, green badges, a candidate profile,
 * a config card — and the number simply stopped changing. The worker had been
 * stopped for twenty-two hours, and nothing in the product said so. The only
 * way to find out was to query the heartbeat table by hand.
 *
 * A dashboard that cannot tell you its engine is off is worse than no
 * dashboard, because it looks like reassurance. The worker writes a heartbeat
 * every few seconds; if the newest one is old, that is the single most
 * important fact on the screen and it belongs at the top of it.
 *
 * Rendered on the dashboard and on the job list — the two pages anyone opens.
 */

const STALE_AFTER_MS = 10 * 60 * 1000;

function since(at: Date): string {
  const minutes = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export async function WorkerStatus() {
  const ctx = await getServerContext();

  const ops = new OpsRepository(ctx.handle.db);
  const [worker, startFailure] = await Promise.all([
    ops.latestWorkerHeartbeat(),
    ops.latestStartFailure(),
  ]);

  /*
   * A worker that crashed on boot outranks every other reading on this page.
   *
   * It is also the case the heartbeat alone cannot describe: a process that
   * dies during startup writes no heartbeat, so "crashed ten minutes ago"
   * and "stopped cleanly two days ago" and "never deployed" all look
   * identical from the heartbeat table. Only the failing process knows, and
   * it records what it knew on the way out.
   *
   * Shown only when it is newer than the last heartbeat; otherwise it is an
   * old crash the worker has since recovered from, and reporting it as
   * current would be its own kind of lie.
   */
  const crashedOnBoot =
    startFailure !== null &&
    (worker === null || startFailure.at.getTime() > worker.lastHeartbeatAt.getTime());

  if (crashedOnBoot) {
    return (
      <Banner tone="danger" title={`The worker failed to start ${since(startFailure.at)}`}>
        It reached the database to report this and got no further, so nothing is being
        discovered, enriched or ranked. It said:
        <span
          className="mt-2 block overflow-x-auto whitespace-pre-wrap p-2 text-[12px]"
          style={{ background: 'var(--surface-2)', borderRadius: '4px' }}
        >
          {startFailure.message ?? 'no detail recorded'}
        </span>
      </Banner>
    );
  }

  // Never seen a worker at all: a fresh install, not a failure. Say which.
  if (!worker) {
    return (
      <Banner tone="warn" title="No worker has ever connected">
        Nothing is discovering jobs. Start one with <Code>pnpm dev:worker</Code>, or deploy the
        worker service.
      </Banner>
    );
  }

  const age = Date.now() - worker.lastHeartbeatAt.getTime();
  if (age <= STALE_AFTER_MS && worker.state !== 'STOPPED') return null;

  return (
    <Banner
      tone="danger"
      title={`The worker stopped ${since(worker.lastHeartbeatAt)}`}
    >
      Nothing is being discovered, enriched or ranked while it is down, so these numbers are
      frozen at whatever they were. Check the worker service on your host — its last state was{' '}
      <Code>{worker.state}</Code>.
    </Banner>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'danger';
  title: string;
  children: React.ReactNode;
}) {
  const color = tone === 'danger' ? 'var(--danger)' : 'var(--warn)';
  const background = tone === 'danger' ? 'var(--danger-soft)' : 'var(--warn-soft)';

  return (
    <div
      role="status"
      className="mb-5 flex items-start gap-3 p-4"
      style={{ background, borderRadius: 'var(--radius)', border: `1px solid ${color}` }}
    >
      <span aria-hidden className="text-lg leading-none">
        ⚠
      </span>
      <div>
        <p className="text-sm font-semibold" style={{ color }}>
          {title}
        </p>
        <p className="mt-0.5 text-sm">{children}</p>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="px-1 py-0.5 text-[12px]"
      style={{ background: 'var(--surface-2)', borderRadius: '4px' }}
    >
      {children}
    </code>
  );
}
