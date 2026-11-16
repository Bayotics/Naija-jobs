'use client';

import { useEffect } from 'react';
import { ErrorNotice } from '@/components/ui';

/**
 * Route-level error boundary.
 *
 * Shows a recovery action and the digest only — never the raw message, which
 * can contain connection strings or internal identifiers.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[ui] render error:', error);
  }, [error]);

  return (
    <div className="max-w-xl">
      <ErrorNotice
        title="Something went wrong loading this page"
        detail={
          error.digest
            ? `Reference: ${error.digest}. Check the server logs for details.`
            : 'Check the server logs for details.'
        }
      />
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-md px-3 py-1.5 text-sm font-medium"
        style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
      >
        Try again
      </button>
    </div>
  );
}
