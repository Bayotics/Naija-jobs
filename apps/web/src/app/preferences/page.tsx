import Link from 'next/link';
import { getServerContext } from '@/lib/db';
import { EmptyState, PageHeader } from '@/components/ui';
import { PreferencesForm } from './preferences-form';

export const dynamic = 'force-dynamic';

export default async function PreferencesPage() {
  const ctx = await getServerContext();
  const profile = await ctx.profiles.getActiveProfile();

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Preferences"
        description={
          profile
            ? `Editing profile v${profile.version}. Saving creates a new version; matching uses the active one immediately.`
            : 'Matching preferences for the candidate profile.'
        }
      />

      {!profile ? (
        <EmptyState
          title="No candidate profile yet"
          reason="Preferences belong to a profile. Create one from the Candidate Profile page, or run `pnpm db:seed` for a development fixture."
          action={
            <Link href="/profile" className="text-sm underline" style={{ color: 'var(--accent)' }}>
              Go to Candidate Profile
            </Link>
          }
        />
      ) : (
        <PreferencesForm payload={profile.payload} />
      )}
    </div>
  );
}
