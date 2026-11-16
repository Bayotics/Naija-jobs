import { FREQUENCY_INTERVAL_MINUTES, type SearchProfile } from '@job-intel/contracts';
import { getSearchConfigContext } from '@/lib/search-config';
import { Badge, Card, EmptyState, PageHeader, Stat, Table } from '@/components/ui';
import { CommandBar } from './command-bar';

export const dynamic = 'force-dynamic';

/**
 * The control centre.
 *
 * Everything a person can change about what the system looks for, in one place,
 * and none of it requiring a deploy. The organising claim of this page is that
 * the configuration shown here *is* what the engine reads — the resolver output
 * is rendered alongside the stored profile, so a setting that is being
 * overridden says so rather than looking inexplicably ignored.
 *
 * The command bar sits at the top because it is how most changes will actually
 * be made, and the structured sections below exist for the ones that are easier
 * to click than to describe.
 */

const summarise = (profile: SearchProfile): string[] => {
  const parts: string[] = [];

  if (profile.roles.length > 0) {
    parts.push(profile.roles.map((role) => role.title).slice(0, 3).join(', '));
  }

  if (profile.locations.length > 0) {
    parts.push(profile.locations.map((entry) => entry.label ?? entry.value).slice(0, 3).join(', '));
  }

  parts.push(profile.remotePreference.replace(/_/g, ' ').toLowerCase());

  if (profile.salary.minimum !== null) {
    parts.push(`${profile.salary.minimum.toLocaleString()}+ ${profile.salary.currency}`);
  }

  return parts;
};

export default async function ControlCenterPage() {
  const { service, repository, profileId } = await getSearchConfigContext();

  if (!profileId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Control centre" description="What the system is looking for." />
        <EmptyState title="No candidate profile yet" reason="Set up your profile to configure searching." />
      </div>
    );
  }

  const [profiles, configs, state, overrides, history] = await Promise.all([
    service.listProfiles(profileId),
    service.allEffectiveConfigurations(profileId),
    repository.getState(profileId),
    service.listOverrides(profileId, true),
    service.history(profileId, 15),
  ]);

  if (profiles.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Control centre" description="What the system is looking for." />
        <EmptyState
          title="No search profiles yet"
          reason="A search profile is one named strategy — 'Remote Frontend', 'Germany Full Stack'. You can run several at once, each with its own criteria, sources and cadence."
        />
      </div>
    );
  }

  const configByProfile = new Map(configs.map((config) => [config.profileId, config]));
  const active = profiles.find((profile) => profile.state === 'active') ?? profiles[0]!;
  const activeConfig = configByProfile.get(active.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Control centre"
        description="Change what the system looks for. Nothing here needs a deploy — every setting is data, and the next search reads it."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Profiles" value={profiles.length} hint={`${profiles.filter((p) => p.state === 'active').length} active`} />
        <Stat
          label="Search"
          value={state.paused ? 'Paused' : 'Running'}
          hint={state.pauseReason ?? undefined}
        />
        <Stat label="Overrides" value={overrides.length} hint="temporary, self-expiring" />
        <Stat label="Config version" value={state.configVersion} hint="bumped on every change" />
        <Stat label="Changes recorded" value={history.length} hint="last 15 shown" />
      </div>

      {/* ── The command bar ────────────────────────────────────────────── */}
      <CommandBar profileId={active.id} />

      {/* ── Profiles ───────────────────────────────────────────────────── */}
      <Card
        title="Search profiles"
        description="Each one is a separate strategy. They run independently, and the same job can score differently against each."
      >
        <ul className="space-y-4">
          {profiles.map((profile) => {
            const config = configByProfile.get(profile.id);
            const interval = FREQUENCY_INTERVAL_MINUTES[profile.searchFrequency];

            return (
              <li key={profile.id} className="border-b pb-4 last:border-0" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={profile.state === 'active' ? 'ok' : profile.state === 'paused' ? 'warn' : 'neutral'}>
                    {profile.state}
                  </Badge>
                  <span className="font-medium">{profile.profileName}</span>
                  <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>
                    {Number.isFinite(interval)
                      ? `every ${interval < 60 ? `${interval} min` : `${interval / 60} h`}`
                      : 'manual only'}
                  </span>
                </div>

                <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                  {summarise(profile).join(' · ')}
                </p>

                <div className="mt-2 flex flex-wrap gap-3 text-xs" style={{ color: 'var(--muted)' }}>
                  <span>
                    {profile.skills.filter((s) => s.tier === 'required').length} required skills
                  </span>
                  <span>{config?.resolvedSources.length ?? 0} sources</span>
                  {profile.excludedSkills.length > 0 && (
                    <span>{profile.excludedSkills.length} excluded skills</span>
                  )}
                  {config && !config.searchEnabled && (
                    <span style={{ color: 'var(--warn)' }}>{config.pauseReason}</span>
                  )}
                </div>

                {/* Where a value came from, when it was not the profile. */}
                {config && config.provenance.length > 0 && (
                  <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {config.provenance.slice(0, 3).map((entry) => (
                      <div key={entry.field}>
                        <span className="font-medium">{entry.field}</span> set by{' '}
                        {entry.layer.replace(/_/g, ' ')} — {entry.detail}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {/* ── What it would search ───────────────────────────────────────── */}
      {activeConfig && (
        <Card
          title={`Queries for "${activeConfig.profileName}"`}
          description="Generated from the configuration above. Change a location or a role and these change on the next pass — nothing here is a hardcoded search string."
        >
          <QueryList candidateId={profileId} profileId={active.id} />
        </Card>
      )}

      {/* ── Temporary overrides ────────────────────────────────────────── */}
      {overrides.length > 0 && (
        <Card
          title="Temporary overrides"
          description="Time-boxed changes that revert on their own. Your saved configuration underneath is untouched."
        >
          <Table head={['Field', 'Change', 'Until', 'Reason']}>
            {overrides.map((entry) => (
              <tr key={entry.id}>
                <td className="py-1">{entry.field}</td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {JSON.stringify(entry.oldValue)} → {JSON.stringify(entry.newValue)}
                </td>
                <td className="tabular py-1">
                  {entry.endTime.toISOString().slice(0, 16).replace('T', ' ')}
                </td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {entry.reason ?? '—'}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {/* ── History ────────────────────────────────────────────────────── */}
      <Card
        title="Configuration history"
        description="Every change, with what it was before. Natural language can be misread, so anything here can be put back."
      >
        {history.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Nothing has been changed yet.
          </p>
        ) : (
          <Table head={['When', 'Operation', 'Changed', 'Source', 'Status']}>
            {history.map((entry) => (
              <tr key={entry.id}>
                <td className="tabular py-1">
                  {entry.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                </td>
                <td className="py-1">{entry.operation.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {entry.changes.length === 0
                    ? entry.reason ?? '—'
                    : entry.changes.map((change) => change.field).join(', ')}
                </td>
                <td className="py-1 text-xs">{entry.source.replace(/_/g, ' ')}</td>
                <td className="py-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {entry.undoneAt ? 'undone' : '—'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Changing what you search for never touches your CV, your applications or the jobs already
        found. Those are separate records with separate owners, and a search change cannot reach
        them.
      </p>
    </div>
  );
}

/** The queries one profile would run, resolved server-side. */
async function QueryList({ candidateId, profileId }: { candidateId: string; profileId: string }) {
  const { service } = await getSearchConfigContext();
  const queries = await service.queriesFor(candidateId, profileId);

  if (queries.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        This profile generates no queries — it may be paused, or have no roles or locations set.
      </p>
    );
  }

  return (
    <ul className="space-y-1 text-sm">
      {queries.slice(0, 15).map((query) => (
        <li key={query.queryId} className="flex flex-wrap items-baseline gap-2">
          <Badge tone={query.priority === 'high' ? 'ok' : query.priority === 'medium' ? 'accent' : 'neutral'}>
            {query.priority}
          </Badge>
          <span className="font-mono text-xs">{query.text}</span>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {query.rationale}
          </span>
        </li>
      ))}
    </ul>
  );
}
