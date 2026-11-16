'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  EDUCATION_LEVELS,
  SENIORITY_LEVELS,
  candidateProfilePatchSchema,
  type CandidateProfilePayload,
} from '@job-intel/contracts';
import { Card } from '@/components/ui';
import { Field, Select, SubmitBar, TextInput, formatList, parseList } from '@/components/form';

/**
 * Identity and professional background.
 *
 * Split from the preferences form on purpose: this describes who the candidate
 * *is*, which changes rarely; preferences describe what they *want*, which
 * changes often. Both write to the same versioned profile payload.
 */
interface FormState {
  fullName: string;
  email: string;
  timezone: string;
  locationCity: string;
  locationCountry: string;
  currentTitle: string;
  yearsOfExperience: string;
  seniority: string;
  highestEducationLevel: string;
  summary: string;
  technologies: string;
  industries: string;
  languages: string;
}

function toFormState(payload: CandidateProfilePayload): FormState {
  return {
    fullName: payload.identity.fullName,
    email: payload.identity.email,
    timezone: payload.identity.timezone,
    locationCity: payload.identity.locationCity ?? '',
    locationCountry: payload.identity.locationCountry ?? '',
    currentTitle: payload.professional.currentTitle ?? '',
    yearsOfExperience: payload.professional.yearsOfExperience?.toString() ?? '',
    seniority: payload.professional.seniority ?? '',
    highestEducationLevel: payload.professional.highestEducationLevel ?? '',
    summary: payload.professional.summary ?? '',
    technologies: formatList(payload.professional.technologies),
    industries: formatList(payload.professional.industries),
    languages: formatList(payload.professional.languages),
  };
}

export function ProfileForm({ payload }: { payload: CandidateProfilePayload }) {
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

    const years = state.yearsOfExperience.trim();
    const patch = {
      identity: {
        fullName: state.fullName,
        email: state.email,
        timezone: state.timezone,
        ...(state.locationCity ? { locationCity: state.locationCity } : {}),
        ...(state.locationCountry ? { locationCountry: state.locationCountry } : {}),
      },
      professional: {
        ...(state.currentTitle ? { currentTitle: state.currentTitle } : {}),
        ...(years !== '' && Number.isFinite(Number(years))
          ? { yearsOfExperience: Number(years) }
          : {}),
        ...(state.seniority
          ? { seniority: state.seniority as CandidateProfilePayload['professional']['seniority'] }
          : {}),
        ...(state.highestEducationLevel
          ? {
              highestEducationLevel:
                state.highestEducationLevel as CandidateProfilePayload['professional']['highestEducationLevel'],
            }
          : {}),
        ...(state.summary ? { summary: state.summary } : {}),
        technologies: parseList(state.technologies),
        industries: parseList(state.industries),
        languages: parseList(state.languages),
      },
      changeSummary: 'Updated candidate profile from dashboard',
    };

    const parsed = candidateProfilePatchSchema.safeParse(patch);
    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message] as const)),
      );
      setStatus({ kind: 'error', message: 'Please fix the highlighted fields' });
      setSaving(false);
      return;
    }

    try {
      const response = await fetch('/api/v1/profile', {
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
      router.refresh();
    } catch {
      setStatus({ kind: 'error', message: 'Network error — changes were not saved' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Card title="Identity">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Full name" htmlFor="fullName" error={fieldErrors['identity.fullName']}>
            <TextInput
              id="fullName"
              value={state.fullName}
              onChange={(e) => set('fullName', e.target.value)}
              required
            />
          </Field>
          <Field label="Email" htmlFor="email" error={fieldErrors['identity.email']}>
            <TextInput
              id="email"
              type="email"
              value={state.email}
              onChange={(e) => set('email', e.target.value)}
              required
            />
          </Field>
          <Field
            label="Timezone"
            htmlFor="timezone"
            hint="IANA name, e.g. Africa/Lagos"
            error={fieldErrors['identity.timezone']}
          >
            <TextInput
              id="timezone"
              value={state.timezone}
              onChange={(e) => set('timezone', e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City" htmlFor="locationCity">
              <TextInput
                id="locationCity"
                value={state.locationCity}
                onChange={(e) => set('locationCity', e.target.value)}
              />
            </Field>
            <Field
              label="Country"
              htmlFor="locationCountry"
              hint="ISO code"
              error={fieldErrors['identity.locationCountry']}
            >
              <TextInput
                id="locationCountry"
                maxLength={2}
                value={state.locationCountry}
                onChange={(e) => set('locationCountry', e.target.value.toUpperCase())}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Professional background">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Current title" htmlFor="currentTitle">
            <TextInput
              id="currentTitle"
              value={state.currentTitle}
              onChange={(e) => set('currentTitle', e.target.value)}
            />
          </Field>
          <Field
            label="Years of experience"
            htmlFor="yearsOfExperience"
            error={fieldErrors['professional.yearsOfExperience']}
          >
            <TextInput
              id="yearsOfExperience"
              inputMode="decimal"
              value={state.yearsOfExperience}
              onChange={(e) => set('yearsOfExperience', e.target.value)}
            />
          </Field>
          <Field label="Seniority" htmlFor="seniority">
            <Select
              id="seniority"
              value={state.seniority}
              onChange={(e) => set('seniority', e.target.value)}
            >
              <option value="">Not specified</option>
              {SENIORITY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Highest education" htmlFor="highestEducationLevel">
            <Select
              id="highestEducationLevel"
              value={state.highestEducationLevel}
              onChange={(e) => set('highestEducationLevel', e.target.value)}
            >
              <option value="">Not specified</option>
              {EDUCATION_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Technologies" htmlFor="technologies" hint="Comma separated">
            <TextInput
              id="technologies"
              value={state.technologies}
              onChange={(e) => set('technologies', e.target.value)}
            />
          </Field>
          <Field label="Industries" htmlFor="industries" hint="Comma separated">
            <TextInput
              id="industries"
              value={state.industries}
              onChange={(e) => set('industries', e.target.value)}
            />
          </Field>
          <Field label="Languages" htmlFor="languages" hint="Comma separated">
            <TextInput
              id="languages"
              value={state.languages}
              onChange={(e) => set('languages', e.target.value)}
            />
          </Field>
          <Field label="Summary" htmlFor="summary">
            <textarea
              id="summary"
              value={state.summary}
              onChange={(e) => set('summary', e.target.value)}
              rows={4}
              className="rounded-md border px-2.5 py-1.5 text-sm outline-none"
              style={{
                background: 'var(--bg)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          </Field>
        </div>
      </Card>

      <SubmitBar dirty={dirty} saving={saving} status={status} />
    </form>
  );
}
