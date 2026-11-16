'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  EMPLOYMENT_TYPES,
  REMOTE_TYPES,
  SENIORITY_LEVELS,
  candidateProfilePatchSchema,
  type CandidateProfilePayload,
} from '@job-intel/contracts';
import { Card } from '@/components/ui';
import {
  CheckboxGroup,
  Field,
  Select,
  SubmitBar,
  TextInput,
  formatList,
  parseList,
} from '@/components/form';

/**
 * Preference editor.
 *
 * This form is the user-facing proof of the system's central promise: every
 * control here writes *data*, and the matching engine reads that data on the
 * next evaluation. Changing "remote" to "onsite", or Germany to the
 * Netherlands, or the salary floor, requires no code change and no redeploy.
 *
 * `remoteTypes` is excluded from `REMOTE_TYPES`' "unknown" member on purpose —
 * "unknown" is a property of a *posting*, not something a candidate can prefer.
 */
const SELECTABLE_REMOTE_TYPES = REMOTE_TYPES.filter((t) => t !== 'unknown');

interface FormState {
  desiredTitles: string;
  countries: string;
  cities: string;
  remoteTypes: string[];
  willingToRelocate: boolean;
  relocationCountries: string;
  salaryMinimum: string;
  salaryTarget: string;
  salaryCurrency: string;
  requireStatedSalary: boolean;
  employmentTypes: string[];
  seniorityLevels: string[];
  visaSponsorship: 'required' | 'preferred' | 'not_needed';
  preferredIndustries: string;
  preferredCompanies: string;
  preferredTechnologies: string;
  exTitles: string;
  exTechnologies: string;
  exIndustries: string;
  exCompanies: string;
  exCountries: string;
  exKeywords: string;
}

function toFormState(payload: CandidateProfilePayload): FormState {
  const p = payload.preferences;
  const x = payload.exclusions;
  return {
    desiredTitles: formatList(p.desiredTitles),
    countries: formatList(p.location.countries),
    cities: formatList(p.location.cities),
    remoteTypes: [...p.location.remoteTypes],
    willingToRelocate: p.location.willingToRelocate,
    relocationCountries: formatList(p.location.relocationCountries),
    salaryMinimum: p.salary.minimum?.toString() ?? '',
    salaryTarget: p.salary.target?.toString() ?? '',
    salaryCurrency: p.salary.currency,
    requireStatedSalary: p.salary.requireStatedSalary,
    employmentTypes: [...p.employmentTypes],
    seniorityLevels: [...p.seniorityLevels],
    visaSponsorship: p.visaSponsorship,
    preferredIndustries: formatList(p.preferredIndustries),
    preferredCompanies: formatList(p.preferredCompanies),
    preferredTechnologies: formatList(p.preferredTechnologies),
    exTitles: formatList(x.titles),
    exTechnologies: formatList(x.technologies),
    exIndustries: formatList(x.industries),
    exCompanies: formatList(x.companies),
    exCountries: formatList(x.countries),
    exKeywords: formatList(x.keywords),
  };
}

function toPatch(state: FormState) {
  const numeric = (value: string): number | undefined => {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    preferences: {
      desiredTitles: parseList(state.desiredTitles),
      location: {
        countries: parseList(state.countries),
        cities: parseList(state.cities),
        remoteTypes: state.remoteTypes as CandidateProfilePayload['preferences']['location']['remoteTypes'],
        willingToRelocate: state.willingToRelocate,
        relocationCountries: parseList(state.relocationCountries),
      },
      salary: {
        minimum: numeric(state.salaryMinimum),
        target: numeric(state.salaryTarget),
        currency: state.salaryCurrency,
        requireStatedSalary: state.requireStatedSalary,
      },
      employmentTypes:
        state.employmentTypes as CandidateProfilePayload['preferences']['employmentTypes'],
      seniorityLevels:
        state.seniorityLevels as CandidateProfilePayload['preferences']['seniorityLevels'],
      visaSponsorship: state.visaSponsorship,
      preferredIndustries: parseList(state.preferredIndustries),
      preferredCompanies: parseList(state.preferredCompanies),
      preferredTechnologies: parseList(state.preferredTechnologies),
    },
    exclusions: {
      titles: parseList(state.exTitles),
      technologies: parseList(state.exTechnologies),
      industries: parseList(state.exIndustries),
      companies: parseList(state.exCompanies),
      countries: parseList(state.exCountries),
      keywords: parseList(state.exKeywords),
    },
  };
}

export function PreferencesForm({ payload }: { payload: CandidateProfilePayload }) {
  const router = useRouter();
  const initial = useMemo(() => toFormState(payload), [payload]);
  const [state, setState] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const dirty = JSON.stringify(state) !== JSON.stringify(initial);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
    setStatus({ kind: 'idle' });
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFieldErrors({});

    const patch = { ...toPatch(state), changeSummary: 'Updated preferences from dashboard' };

    // Validate client-side against the same schema the server uses, so the
    // common mistakes are caught without a round trip.
    const parsed = candidateProfilePatchSchema.safeParse(patch);
    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.'), i.message] as const),
        ),
      );
      setStatus({ kind: 'error', message: 'Please fix the highlighted fields' });
      setSaving(false);
      return;
    }

    try {
      const response = await fetch('/api/v1/preferences', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = (await response.json()) as {
        error?: { message: string; issues?: Array<{ path: string; message: string }> };
        version?: number;
      };

      if (!response.ok) {
        setFieldErrors(
          Object.fromEntries((body.error?.issues ?? []).map((i) => [i.path, i.message])),
        );
        setStatus({ kind: 'error', message: body.error?.message ?? 'Failed to save' });
        return;
      }

      setStatus({ kind: 'ok', message: `Saved as profile version ${body.version}` });
      // Re-render the server component so the new version is reflected.
      router.refresh();
    } catch {
      setStatus({ kind: 'error', message: 'Network error — changes were not saved' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Card title="Target roles" description="Empty means no constraint.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Desired job titles"
            htmlFor="desiredTitles"
            hint="Comma separated"
            error={fieldErrors['preferences.desiredTitles']}
          >
            <TextInput
              id="desiredTitles"
              value={state.desiredTitles}
              onChange={(e) => set('desiredTitles', e.target.value)}
              placeholder="Backend Engineer, Platform Engineer"
            />
          </Field>
          <Field label="Seniority levels" htmlFor="seniorityLevels">
            <CheckboxGroup
              name="seniority"
              options={SENIORITY_LEVELS}
              selected={state.seniorityLevels}
              onChange={(v) => set('seniorityLevels', v)}
            />
          </Field>
        </div>
      </Card>

      <Card title="Location & work arrangement">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label="Work arrangements"
            htmlFor="remoteTypes"
            hint="Change this to flip remote ⇄ onsite — no code change required."
          >
            <CheckboxGroup
              name="remote"
              options={SELECTABLE_REMOTE_TYPES}
              selected={state.remoteTypes}
              onChange={(v) => set('remoteTypes', v)}
            />
          </Field>
          <Field
            label="Countries"
            htmlFor="countries"
            hint="ISO codes, comma separated (DE, NL, IE)"
            error={fieldErrors['preferences.location.countries']}
          >
            <TextInput
              id="countries"
              value={state.countries}
              onChange={(e) => set('countries', e.target.value)}
              placeholder="DE, NL, IE"
            />
          </Field>
          <Field label="Cities" htmlFor="cities" hint="Comma separated">
            <TextInput
              id="cities"
              value={state.cities}
              onChange={(e) => set('cities', e.target.value)}
              placeholder="Berlin, Amsterdam"
            />
          </Field>
          <Field label="Relocation" htmlFor="willingToRelocate">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs">
                <input
                  id="willingToRelocate"
                  type="checkbox"
                  checked={state.willingToRelocate}
                  onChange={(e) => set('willingToRelocate', e.target.checked)}
                />
                Willing to relocate
              </label>
              <TextInput
                aria-label="Relocation countries"
                value={state.relocationCountries}
                onChange={(e) => set('relocationCountries', e.target.value)}
                placeholder="Relocation countries, e.g. NL, IE"
                disabled={!state.willingToRelocate}
              />
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Compensation & contract">
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            label="Minimum salary"
            htmlFor="salaryMinimum"
            error={fieldErrors['preferences.salary.minimum']}
          >
            <TextInput
              id="salaryMinimum"
              inputMode="numeric"
              value={state.salaryMinimum}
              onChange={(e) => set('salaryMinimum', e.target.value)}
              placeholder="70000"
            />
          </Field>
          <Field label="Target salary" htmlFor="salaryTarget">
            <TextInput
              id="salaryTarget"
              inputMode="numeric"
              value={state.salaryTarget}
              onChange={(e) => set('salaryTarget', e.target.value)}
              placeholder="90000"
            />
          </Field>
          <Field
            label="Currency"
            htmlFor="salaryCurrency"
            error={fieldErrors['preferences.salary.currency']}
          >
            <TextInput
              id="salaryCurrency"
              value={state.salaryCurrency}
              onChange={(e) => set('salaryCurrency', e.target.value.toUpperCase())}
              maxLength={3}
              placeholder="USD"
            />
          </Field>
          <Field
            label="Require stated salary"
            htmlFor="requireStatedSalary"
            hint="Most postings omit salary. Leaving this off keeps them eligible."
          >
            <label className="flex items-center gap-2 text-xs">
              <input
                id="requireStatedSalary"
                type="checkbox"
                checked={state.requireStatedSalary}
                onChange={(e) => set('requireStatedSalary', e.target.checked)}
              />
              Reject postings with no salary
            </label>
          </Field>
          <Field label="Employment types" htmlFor="employmentTypes">
            <CheckboxGroup
              name="employment"
              options={EMPLOYMENT_TYPES}
              selected={state.employmentTypes}
              onChange={(v) => set('employmentTypes', v)}
            />
          </Field>
          <Field
            label="Visa sponsorship"
            htmlFor="visaSponsorship"
            hint="'Required' still admits postings that are silent about sponsorship."
          >
            <Select
              id="visaSponsorship"
              value={state.visaSponsorship}
              onChange={(e) => set('visaSponsorship', e.target.value as FormState['visaSponsorship'])}
            >
              <option value="not_needed">Not needed</option>
              <option value="preferred">Preferred</option>
              <option value="required">Required</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card title="Preferred" description="Positive signals. These influence score, never reject.">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Technologies" htmlFor="preferredTechnologies">
            <TextInput
              id="preferredTechnologies"
              value={state.preferredTechnologies}
              onChange={(e) => set('preferredTechnologies', e.target.value)}
              placeholder="TypeScript, Go"
            />
          </Field>
          <Field label="Industries" htmlFor="preferredIndustries">
            <TextInput
              id="preferredIndustries"
              value={state.preferredIndustries}
              onChange={(e) => set('preferredIndustries', e.target.value)}
            />
          </Field>
          <Field label="Companies" htmlFor="preferredCompanies">
            <TextInput
              id="preferredCompanies"
              value={state.preferredCompanies}
              onChange={(e) => set('preferredCompanies', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card title="Excluded" description="Absolute. Any match here rejects the job outright.">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Job titles" htmlFor="exTitles">
            <TextInput
              id="exTitles"
              value={state.exTitles}
              onChange={(e) => set('exTitles', e.target.value)}
              placeholder="Sales, Intern"
            />
          </Field>
          <Field label="Technologies" htmlFor="exTechnologies">
            <TextInput
              id="exTechnologies"
              value={state.exTechnologies}
              onChange={(e) => set('exTechnologies', e.target.value)}
              placeholder="PHP, Vue"
            />
          </Field>
          <Field label="Industries" htmlFor="exIndustries">
            <TextInput
              id="exIndustries"
              value={state.exIndustries}
              onChange={(e) => set('exIndustries', e.target.value)}
              placeholder="Gambling, Tobacco"
            />
          </Field>
          <Field label="Companies" htmlFor="exCompanies">
            <TextInput
              id="exCompanies"
              value={state.exCompanies}
              onChange={(e) => set('exCompanies', e.target.value)}
            />
          </Field>
          <Field
            label="Countries"
            htmlFor="exCountries"
            error={fieldErrors['exclusions.countries']}
          >
            <TextInput
              id="exCountries"
              value={state.exCountries}
              onChange={(e) => set('exCountries', e.target.value)}
              placeholder="ISO codes"
            />
          </Field>
          <Field label="Keywords" htmlFor="exKeywords">
            <TextInput
              id="exKeywords"
              value={state.exKeywords}
              onChange={(e) => set('exKeywords', e.target.value)}
              placeholder="unpaid, commission only"
            />
          </Field>
        </div>
      </Card>

      <SubmitBar dirty={dirty} saving={saving} status={status} />
    </form>
  );
}
