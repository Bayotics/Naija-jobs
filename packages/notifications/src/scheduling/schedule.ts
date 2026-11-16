import {
  FREQUENCY_MINUTES,
  type NotificationPreferences,
  type QuietHours,
  type WeekendBehavior,
} from '@job-intel/contracts';

/**
 * Scheduling in the candidate's timezone.
 *
 * The requirement is stated plainly in the brief and is the one thing most
 * schedulers get wrong: **the server's timezone is not the user's.** A digest
 * configured for 08:00 must arrive at 08:00 where the person lives, through
 * daylight-saving transitions, on a server running UTC.
 *
 * `Intl.DateTimeFormat` with a named zone does that correctly and is in the
 * standard library. Reimplementing offsets by hand — or worse, storing a fixed
 * `+01:00` — is how a digest starts arriving an hour early every March.
 */

export interface LocalClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * The wall-clock reading in a timezone.
 *
 * Falls back to UTC on an unknown zone rather than throwing: a bad timezone in
 * stored preferences must not stop every notification in the system, and the
 * caller can see the fallback in the returned zone.
 */
export function localClock(at: Date, timeZone: string): LocalClock & { timeZone: string } {
  let zone = timeZone;
  let parts: Intl.DateTimeFormatPart[];

  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(at);
  } catch {
    zone = 'UTC';
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(at);
  }

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = Number(get('hour')) % 24;

  return {
    timeZone: zone,
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

function parseClockTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

/** Minutes since local midnight. */
function minutesOfDay(clock: { hour: number; minute: number }): number {
  return clock.hour * 60 + clock.minute;
}

// ── Quiet hours ─────────────────────────────────────────────────────────────

export interface QuietHoursVerdict {
  active: boolean;
  /** When the window ends, in absolute time. Null when not active. */
  until: Date | null;
  reason: string;
}

/**
 * Whether the candidate is inside their quiet window.
 *
 * Windows that cross midnight (23:00 → 07:00) are the normal case, not the edge
 * case, so the comparison is written for them: when start > end the window is
 * the *union* of the two spans rather than the empty intersection a naive
 * `start <= now && now < end` produces.
 */
export function evaluateQuietHours(
  at: Date,
  quietHours: QuietHours,
  timeZone: string,
): QuietHoursVerdict {
  if (!quietHours.enabled) {
    return { active: false, until: null, reason: 'quiet hours disabled' };
  }

  const clock = localClock(at, timeZone);
  const now = minutesOfDay(clock);
  const start = minutesOfDay(parseClockTime(quietHours.start));
  const end = minutesOfDay(parseClockTime(quietHours.end));

  const crossesMidnight = start > end;
  const active = crossesMidnight ? now >= start || now < end : now >= start && now < end;

  if (!active) {
    return {
      active: false,
      until: null,
      reason: `outside quiet hours (${quietHours.start}–${quietHours.end} ${clock.timeZone})`,
    };
  }

  // Minutes remaining until the window ends, wrapping past midnight.
  const minutesUntilEnd = now < end ? end - now : 24 * 60 - now + end;

  return {
    active: true,
    until: new Date(at.getTime() + minutesUntilEnd * 60_000),
    reason: `inside quiet hours (${quietHours.start}–${quietHours.end} ${clock.timeZone})`,
  };
}

// ── Weekend behaviour ───────────────────────────────────────────────────────

export interface WeekendVerdict {
  allowDigest: boolean;
  allowImmediate: boolean;
  /** Immediate alerts restricted to URGENT only. */
  urgentOnly: boolean;
  reason: string;
}

export function evaluateWeekend(
  at: Date,
  behavior: WeekendBehavior,
  timeZone: string,
): WeekendVerdict {
  const clock = localClock(at, timeZone);
  const isWeekend = clock.weekday === 0 || clock.weekday === 6;

  if (!isWeekend || behavior === 'normal') {
    return {
      allowDigest: true,
      allowImmediate: true,
      urgentOnly: false,
      reason: isWeekend ? 'weekend behaviour is normal' : 'weekday',
    };
  }

  switch (behavior) {
    case 'digest_only':
      return {
        allowDigest: true,
        allowImmediate: false,
        urgentOnly: false,
        reason: 'weekend: digests only',
      };
    case 'urgent_only':
      return {
        allowDigest: false,
        allowImmediate: true,
        urgentOnly: true,
        reason: 'weekend: urgent alerts only',
      };
    default:
      return {
        allowDigest: false,
        allowImmediate: false,
        urgentOnly: false,
        reason: 'weekend: silent',
      };
  }
}

// ── Digest cadence ──────────────────────────────────────────────────────────

export interface DigestDueVerdict {
  due: boolean;
  nextRunAt: Date;
  reason: string;
}

/**
 * Whether a digest is due, and when the next one is.
 *
 * Interval frequencies are measured from the last send, so a worker that missed
 * a tick catches up rather than skipping a period. Time-of-day frequencies
 * (`daily`, `weekly`) are measured against the *local* clock, so the send lands
 * at the configured hour in the candidate's zone whatever the server thinks.
 */
export function isDigestDue(
  preferences: NotificationPreferences,
  lastSentAt: Date | null,
  at: Date = new Date(),
): DigestDueVerdict {
  if (!preferences.digestEnabled) {
    return { due: false, nextRunAt: at, reason: 'digests are disabled' };
  }

  const frequency = preferences.digestFrequency;
  const clock = localClock(at, preferences.timezone);

  if (frequency === 'daily' || frequency === 'weekly') {
    const target = parseClockTime(preferences.digestTime);
    const atTargetTime =
      clock.hour > target.hour || (clock.hour === target.hour && clock.minute >= target.minute);

    const correctDay = frequency === 'weekly' ? clock.weekday === preferences.digestDayOfWeek : true;

    const periodMs = FREQUENCY_MINUTES[frequency] * 60_000;
    // 90% of the period, so a run that fires slightly early on a scheduler tick
    // still counts rather than silently skipping the day.
    const elapsedEnough =
      lastSentAt === null || at.getTime() - lastSentAt.getTime() >= periodMs * 0.9;

    const due = correctDay && atTargetTime && elapsedEnough;
    return {
      due,
      nextRunAt: nextTimeOfDay(at, preferences, target),
      reason: due
        ? `due: local time ${clock.hour}:${String(clock.minute).padStart(2, '0')} is at or past ${preferences.digestTime}`
        : !correctDay
          ? `not the configured day (${preferences.digestDayOfWeek})`
          : !atTargetTime
            ? `local time is before ${preferences.digestTime} ${clock.timeZone}`
            : 'a digest was already sent this period',
    };
  }

  const intervalMs = FREQUENCY_MINUTES[frequency] * 60_000;
  if (lastSentAt === null) {
    return { due: true, nextRunAt: new Date(at.getTime() + intervalMs), reason: 'no digest sent yet' };
  }

  const elapsed = at.getTime() - lastSentAt.getTime();
  const due = elapsed >= intervalMs;
  return {
    due,
    nextRunAt: new Date(lastSentAt.getTime() + intervalMs),
    reason: due
      ? `${Math.round(elapsed / 60_000)} minutes since the last digest`
      : `only ${Math.round(elapsed / 60_000)} of ${FREQUENCY_MINUTES[frequency]} minutes elapsed`,
  };
}

/**
 * The next occurrence of a local time-of-day, as an absolute instant.
 *
 * Found by probing forward in one-minute steps from the next candidate hour
 * rather than by arithmetic on an offset — which is what makes it correct
 * across a DST boundary, where the local hour genuinely does not exist or
 * happens twice.
 */
function nextTimeOfDay(
  at: Date,
  preferences: NotificationPreferences,
  target: { hour: number; minute: number },
): Date {
  const stepMs = 60_000;
  const maxSteps = 8 * 24 * 60;

  for (let step = 1; step <= maxSteps; step += 1) {
    const candidate = new Date(at.getTime() + step * stepMs);
    const clock = localClock(candidate, preferences.timezone);
    if (clock.hour !== target.hour || clock.minute !== target.minute) continue;
    if (preferences.digestFrequency === 'weekly' && clock.weekday !== preferences.digestDayOfWeek) {
      continue;
    }
    return candidate;
  }

  // Unreachable for any real configuration; a sane fallback beats a throw.
  return new Date(at.getTime() + FREQUENCY_MINUTES[preferences.digestFrequency] * 60_000);
}

/** Human label for the period a digest covers. */
export function periodLabel(since: Date | null, until: Date): string {
  if (!since) return 'since we started watching';
  const hours = Math.max(1, Math.round((until.getTime() - since.getTime()) / 3_600_000));
  if (hours < 24) return `the last ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `the last ${days} day${days === 1 ? '' : 's'}`;
}
