import { revalidatePath } from 'next/cache';
import {
  DIGEST_FREQUENCIES,
  WEEKEND_BEHAVIORS,
  notificationPreferencesSchema,
} from '@job-intel/contracts';
import { verifyPreferenceToken } from '@job-intel/notifications';
import { getNotificationContext } from '@/lib/notifications';
import { getServerContext } from '@/lib/db';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Notification settings.
 *
 * Every value here is stored data — changing the digest hour is a database
 * write, not a deploy. The form posts to a server action rather than a GET, so
 * a mail scanner pre-fetching the link from an email cannot alter anything.
 *
 * A signed `?token=` from an email is *verified* and used only to identify the
 * profile the link was issued for; it never grants a write on its own.
 */
export default async function NotificationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await getServerContext();
  const { repository, profileId } = await getNotificationContext();

  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const tokenState = rawToken
    ? verifyPreferenceToken(rawToken, ctx.env.FEEDBACK_TOKEN_SECRET ?? '')
    : null;

  if (!profileId) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Notification settings" />
        <EmptyState
          title="No candidate profile yet"
          reason="Notification preferences belong to a profile. Create one first."
        />
      </div>
    );
  }

  const { preferences, lastDigestAt } = await repository.getPreferences(profileId);

  async function save(formData: FormData) {
    'use server';

    const { repository: repo, profileId: id } = await getNotificationContext();
    if (!id) return;

    const current = (await repo.getPreferences(id)).preferences;
    const value = (key: string) => {
      const raw = formData.get(key);
      return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
    };
    const checked = (key: string) => formData.get(key) === 'on';
    const number = (key: string) => {
      const raw = value(key);
      return raw === undefined ? undefined : Number(raw);
    };

    // Parsed through the schema, so an out-of-range value is rejected rather
    // than stored and surfaced later as a mysterious notification bug.
    const merged = notificationPreferencesSchema.parse({
      ...current,
      email: value('email') ?? null,
      timezone: value('timezone') ?? current.timezone,
      digestEnabled: checked('digestEnabled'),
      digestFrequency: value('digestFrequency') ?? current.digestFrequency,
      digestTime: value('digestTime') ?? current.digestTime,
      maxJobsPerDigest: number('maxJobsPerDigest') ?? current.maxJobsPerDigest,
      maxPerCompanyPerDigest: number('maxPerCompanyPerDigest') ?? current.maxPerCompanyPerDigest,
      immediateAlertsEnabled: checked('immediateAlertsEnabled'),
      maxAlertsPerDay: number('maxAlertsPerDay') ?? current.maxAlertsPerDay,
      minimumMatchScore: number('minimumMatchScore') ?? current.minimumMatchScore,
      minimumConfidence: number('minimumConfidence') ?? current.minimumConfidence,
      minimumRecommendationScore:
        number('minimumRecommendationScore') ?? current.minimumRecommendationScore,
      weekendBehavior: value('weekendBehavior') ?? current.weekendBehavior,
      weeklySummaryEnabled: checked('weeklySummaryEnabled'),
      systemAlertsEnabled: checked('systemAlertsEnabled'),
      quietHours: {
        enabled: checked('quietHoursEnabled'),
        start: value('quietStart') ?? current.quietHours.start,
        end: value('quietEnd') ?? current.quietHours.end,
        allowUrgentOverride: checked('allowUrgentOverride'),
      },
      excludedSourceIds: (value('excludedSourceIds') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });

    await repo.savePreferences(id, merged);
    revalidatePath('/settings/notifications');
  }

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Notification settings"
        description="Everything here is stored data. Changing it takes effect on the next run — no restart, no deploy."
      />

      {tokenState && !tokenState.valid && (
        <Card>
          <p className="text-sm" style={{ color: 'var(--warn)' }}>
            The link you followed is no longer valid ({tokenState.reason}). You are seeing your
            settings because you are signed in.
          </p>
        </Card>
      )}

      <form action={save} className="space-y-6">
        <Card title="Delivery" description="Where notifications go, and in whose clock.">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Email address" name="email" defaultValue={preferences.email ?? ''} type="email" />
            <TextField
              label="Timezone"
              name="timezone"
              defaultValue={preferences.timezone}
              hint="An IANA name, e.g. Europe/Berlin. Digest times are local to this."
            />
          </div>
        </Card>

        <Card
          title="Digest"
          description={
            lastDigestAt
              ? `Last sent ${lastDigestAt.toISOString().slice(0, 16).replace('T', ' ')}.`
              : 'No digest sent yet.'
          }
        >
          <div className="space-y-3">
            <Checkbox name="digestEnabled" label="Send digests" defaultChecked={preferences.digestEnabled} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Select
                label="Frequency"
                name="digestFrequency"
                options={DIGEST_FREQUENCIES.map((f) => ({ value: f, label: f.replace(/_/g, ' ') }))}
                defaultValue={preferences.digestFrequency}
              />
              <TextField
                label="Send at (local)"
                name="digestTime"
                defaultValue={preferences.digestTime}
                hint="Daily and weekly only"
              />
              <TextField
                label="Max jobs"
                name="maxJobsPerDigest"
                type="number"
                defaultValue={String(preferences.maxJobsPerDigest)}
              />
            </div>
            <TextField
              label="Max per company in one digest"
              name="maxPerCompanyPerDigest"
              type="number"
              defaultValue={String(preferences.maxPerCompanyPerDigest)}
            />
          </div>
        </Card>

        <Card
          title="Immediate alerts"
          description="For opportunities that genuinely should not wait for the next digest."
        >
          <div className="space-y-3">
            <Checkbox
              name="immediateAlertsEnabled"
              label="Send immediate alerts"
              defaultChecked={preferences.immediateAlertsEnabled}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Max alerts per day" name="maxAlertsPerDay" type="number" defaultValue={String(preferences.maxAlertsPerDay)} hint="Overflow falls through to the next digest rather than being dropped." />
              <Select
                label="Weekends"
                name="weekendBehavior"
                options={WEEKEND_BEHAVIORS.map((b) => ({ value: b, label: b.replace(/_/g, ' ') }))}
                defaultValue={preferences.weekendBehavior}
              />
            </div>
          </div>
        </Card>

        <Card title="Thresholds" description="Below any of these, a job is never notified.">
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="Minimum match score"
              name="minimumMatchScore"
              type="number"
              defaultValue={String(preferences.minimumMatchScore)}
            />
            <TextField
              label="Minimum recommendation score"
              name="minimumRecommendationScore"
              type="number"
              defaultValue={String(preferences.minimumRecommendationScore)}
            />
            <TextField
              label="Minimum confidence (0-1)"
              name="minimumConfidence"
              defaultValue={String(preferences.minimumConfidence)}
            />
          </div>
        </Card>

        <Card title="Quiet hours" description="Digests wait. Whether urgent alerts wait is your call.">
          <div className="space-y-3">
            <Checkbox
              name="quietHoursEnabled"
              label="Enable quiet hours"
              defaultChecked={preferences.quietHours.enabled}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="From" name="quietStart" defaultValue={preferences.quietHours.start} />
              <TextField label="Until" name="quietEnd" defaultValue={preferences.quietHours.end} />
            </div>
            <Checkbox
              name="allowUrgentOverride"
              label="Let urgent alerts through during quiet hours"
              defaultChecked={preferences.quietHours.allowUrgentOverride}
            />
          </div>
        </Card>

        <Card title="Sources and other mail">
          <div className="space-y-3">
            <TextField
              label="Excluded sources"
              name="excludedSourceIds"
              defaultValue={preferences.excludedSourceIds.join(', ')}
              hint="Comma-separated source ids. Jobs from these are never notified."
            />
            <Checkbox
              name="weeklySummaryEnabled"
              label="Send a weekly summary"
              defaultChecked={preferences.weeklySummaryEnabled}
            />
            <Checkbox
              name="systemAlertsEnabled"
              label="Send operational alerts (source failures, provider problems)"
              defaultChecked={preferences.systemAlertsEnabled}
            />
          </div>
        </Card>

        <button
          type="submit"
          className="rounded-md px-3 py-1.5 text-sm font-medium"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Save notification settings
        </button>
      </form>
    </div>
  );
}

/**
 * Local form primitives.
 *
 * The shared `form.tsx` kit is client-side and state-driven; this page is a
 * server component posting to a server action, so it carries its own plain
 * inputs rather than pulling the whole page into the client for four fields.
 */
function TextField({
  label,
  name,
  defaultValue,
  type = 'text',
  hint,
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        className="w-full rounded border px-2 py-1.5 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      />
      {hint && (
        <span className="mt-1 block text-[11px]" style={{ color: 'var(--muted)' }}>
          {hint}
        </span>
      )}
    </label>
  );
}

function Checkbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  );
}

function Select({
  label,
  name,
  options,
  defaultValue,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
  defaultValue: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="w-full rounded border px-2 py-1.5 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
