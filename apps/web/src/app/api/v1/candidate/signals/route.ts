import { NextResponse } from 'next/server';
import { behavioralSignalSchema } from '@job-intel/contracts';
import { requireProfile } from '@/lib/candidate';
import { handler, parseBody } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Behavioural signals.
 *
 * The response keeps explicit preferences and learned signals in separate
 * fields on purpose. They are never merged, and a caller has to opt into
 * treating a learned affinity as anything.
 */
export function GET() {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;

    const [counts, learned] = await Promise.all([
      guard.repository.signalCounts(guard.profileId),
      guard.service.getLearnedSignals(guard.profileId),
    ]);

    return NextResponse.json({
      eventCounts: counts,
      learnedSignals: learned.signals,
      suggestions: learned.suggestions,
      note: 'Learned signals are never applied automatically. Confirm a suggestion to change a preference.',
    });
  });
}

/** Records one interaction. Never modifies preferences. */
export function POST(request: Request) {
  return handler(async () => {
    const guard = await requireProfile();
    if (!guard.ok) return guard.response;

    const signal = await parseBody(request, behavioralSignalSchema);
    await guard.service.recordSignal(guard.profileId, signal);
    return NextResponse.json({ recorded: true, event: signal.event }, { status: 201 });
  });
}
