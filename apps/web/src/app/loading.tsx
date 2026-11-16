import { Skeleton } from '@/components/ui';

/** Route-level loading state, shown while a server component streams. */
export default function Loading() {
  return (
    <div className="max-w-4xl">
      <div
        className="mb-6 h-7 w-48 animate-pulse rounded"
        style={{ background: 'var(--surface)' }}
      />
      <Skeleton rows={5} />
    </div>
  );
}
