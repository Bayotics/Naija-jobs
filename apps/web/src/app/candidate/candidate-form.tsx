'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  EMPLOYMENT_TYPES,
  SALARY_PERIODS,
  SENIORITY_LEVELS,
  VISA_REQUIREMENTS,
  WORK_ARRANGEMENT_PREFERENCES,
  type CandidatePreferences,
  type WeightedPreference,
} from '@job-intel/contracts';
import { Badge, Card } from '@/components/ui';
import { Field, Select, SubmitBar, TextInput } from '@/components/form';
import { PreferenceListEditor, WeightSlider } from './preference-controls';

/**
 * Candidate configuration.
 *
 * Every control writes to the preference payload; none of them changes code.
 * The sections mirror the matching dimensions exactly, so a candidate can see
 * the whole surface the engine will read.
 *
 * Hard constraints are called out inline wherever a control creates one — the
 * difference between "prefer remote" and "remote only" is the difference
 * between ranking and excluding, and the UI has to say so.
 */

const LIST_SECTIONS = [
  { dimension: 'titles', title: 'Job titles', description: 'Roles you want. Excluded titles are rejected outright.', placeholder: 'Frontend Engineer' },
  { dimension: 'countries', title: 'Countries', description: 'ISO codes or names. Strength sets priority, not just permission.', placeholder: 'DE' },
  { dimension: 'cities', title: 'Cities', description: 'Optional, for on-site and hybrid roles.', placeholder: 'Berlin' },
  { dimension: 'regions', title: 'Regions', description: 'Broad areas a remote role may be restricted to.', placeholder: 'EU' },
  { dimension: 'technologies', title: 'Technologies', description: 'Excluded technologies reject a job that requires them.', placeholder: 'React' },
  { dimension: 'industries', title: 'Industries', description: 'Sectors you want or refuse.', placeholder: 'FinTech' },
  { dimension: 'companies', title: 'Companies', description: 'Named employers to seek out or avoid.', placeholder: 'Acme Corp' },
  { dimension: 'employmentTypes', title: 'Employment types', description: `One of: ${EMPLOYMENT_TYPES.join(', ')}.`, placeholder: 'full_time' },
  { dimension: 'companySizes', title: 'Company sizes', description: 'e.g. startup, scaleup, enterprise, nonprofit, government.', placeholder: 'startup' },
] as const;

const WEIGHT_LABELS: Array<{ key: keyof CandidatePreferences['weights']; label: string }> = [
  { key: 'technicalSkills', label: 'Technical skills' },
  { key: 'experience', label: 'Experience' },
  { key: 'location', label: 'Location' },
  { key: 'workArrangement', label: 'Work arrangement' },
  { key: 'salary', label: 'Salary' },
  { key: 'visa', label: 'Visa' },
  { key: 'seniority', label: 'Seniority' },
  { key: 'industry', label: 'Industry' },
  { key: 'companyPreference', label: 'Company' },
  { key: 'titleMatch', label: 'Title match' },
];

export function CandidateForm({
  initial,
  version,
}: {
  initial: CandidatePreferences;
  version: number;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<CandidatePreferences>(initial);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({ kind: 'idle' });
  const [instruction, setInstruction] = useState('');
  const [proposals, setProposals] = useState<Array<{ path: string; operation: string; value: unknown; summary: string; confidence: number; sourceText: string | null }>>([]);
  const [unparsed, setUnparsed] = useState<string[]>([]);

  const dirty = useMemo(() => JSON.stringify(prefs) !== JSON.stringify(initial), [prefs, initial]);

  const setList = (dimension: string, items: WeightedPreference[]) => {
    setPrefs((p) => ({ ...p, [dimension]: items }));
    setStatus({ kind: 'idle' });
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const lists = Object.fromEntries(
        LIST_SECTIONS.map((s) => [s.dimension, prefs[s.dimension as keyof CandidatePreferences]]),
      );
      const response = await fetch('/api/v1/candidate/preferences', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workArrangement: prefs.workArrangement,
          maxOfficeDaysPerWeek: prefs.maxOfficeDaysPerWeek,
          salary: prefs.salary,
          workAuthorization: prefs.workAuthorization,
          weights: prefs.weights,
          excludedKeywords: prefs.excludedKeywords,
          lists,
        }),
      });
      const body = (await response.json()) as { error?: { message: string }; version?: number };
      if (!response.ok) {
        setStatus({ kind: 'error', message: body.error?.message ?? 'Failed to save' });
        return;
      }
      setStatus({ kind: 'ok', message: `Saved as preference version ${body.version}` });
      router.refresh();
    } catch {
      setStatus({ kind: 'error', message: 'Network error — nothing was saved' });
    } finally {
      setSaving(false);
    }
  }

  /** Asks the server to interpret an instruction. Applies nothing. */
  async function propose() {
    if (instruction.trim().length < 3) return;
    setSaving(true);
    try {
      const response = await fetch('/api/v1/candidate/nl', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction }),
      });
      const body = (await response.json()) as { proposals?: typeof proposals; unparsed?: string[] };
      setProposals(body.proposals ?? []);
      setUnparsed(body.unparsed ?? []);
      setStatus({ kind: 'idle' });
    } finally {
      setSaving(false);
    }
  }

  /** Applies only what the candidate confirmed. */
  async function applyProposals() {
    setSaving(true);
    try {
      const response = await fetch('/api/v1/candidate/nl?apply=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposals, confirmed: true }),
      });
      const body = (await response.json()) as { error?: { message: string }; version?: number };
      if (!response.ok) {
        setStatus({ kind: 'error', message: body.error?.message ?? 'Failed to apply' });
        return;
      }
      setProposals([]);
      setInstruction('');
      setStatus({ kind: 'ok', message: `Applied — now at version ${body.version}` });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const isRemoteOnly = prefs.workArrangement === 'REMOTE_ONLY';

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Card
        title="Natural language"
        description="Describe a change in plain words. Nothing is applied until you confirm it."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <TextInput
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="I'm okay with hybrid jobs now"
              aria-label="Preference instruction"
            />
            <button
              type="button"
              onClick={propose}
              disabled={saving || instruction.trim().length < 3}
              className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}
            >
              Interpret
            </button>
          </div>

          {proposals.length > 0 && (
            <div className="rounded-md border p-3" style={{ borderColor: 'var(--accent)' }}>
              <p className="mb-2 text-xs font-semibold">Proposed changes — review before applying</p>
              <ul className="flex flex-col gap-1 text-sm">
                {proposals.map((p, i) => (
                  <li key={`${p.path}-${i}`} className="flex items-center gap-2">
                    <Badge tone="accent">{p.path}</Badge>
                    <span>{p.summary}</span>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      ({Math.round(p.confidence * 100)}% confident)
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={applyProposals}
                  disabled={saving}
                  className="rounded-md px-3 py-1.5 text-sm font-medium"
                  style={{ background: 'var(--accent)', color: '#fff' }}
                >
                  Apply these changes
                </button>
                <button
                  type="button"
                  onClick={() => setProposals([])}
                  className="rounded-md px-3 py-1.5 text-sm"
                  style={{ border: '1px solid var(--border)' }}
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          {unparsed.length > 0 && (
            <p className="text-xs" style={{ color: 'var(--warn)' }}>
              Not understood: {unparsed.join(' / ')}
            </p>
          )}
        </div>
      </Card>

      <Card
        title="Work arrangement"
        description="REMOTE_ONLY is a hard constraint — it excludes every non-remote role."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Arrangement" htmlFor="workArrangement">
            <Select
              id="workArrangement"
              value={prefs.workArrangement}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, workArrangement: e.target.value as CandidatePreferences['workArrangement'] }))
              }
            >
              {WORK_ARRANGEMENT_PREFERENCES.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
            <span className="mt-1 inline-block">
              {isRemoteOnly ? <Badge tone="ok">hard constraint</Badge> : <Badge tone="neutral">preference</Badge>}
            </span>
          </Field>
          <Field
            label="Maximum office days per week"
            htmlFor="maxOfficeDays"
            hint="Leave blank for no limit. Setting it creates a hard constraint."
          >
            <TextInput
              id="maxOfficeDays"
              inputMode="numeric"
              value={prefs.maxOfficeDaysPerWeek ?? ''}
              onChange={(e) =>
                setPrefs((p) => ({
                  ...p,
                  maxOfficeDaysPerWeek: e.target.value === '' ? null : Number(e.target.value),
                }))
              }
            />
          </Field>
        </div>
      </Card>

      <Card title="Salary" description="Marking the minimum as hard rejects anything below it.">
        <div className="grid gap-4 md:grid-cols-3">
          {(['minimum', 'target', 'ideal'] as const).map((key) => (
            <Field key={key} label={key[0]!.toUpperCase() + key.slice(1)} htmlFor={`salary-${key}`}>
              <TextInput
                id={`salary-${key}`}
                inputMode="numeric"
                value={prefs.salary[key] ?? ''}
                onChange={(e) =>
                  setPrefs((p) => ({
                    ...p,
                    salary: { ...p.salary, [key]: e.target.value === '' ? null : Number(e.target.value) },
                  }))
                }
              />
            </Field>
          ))}
          <Field label="Currency" htmlFor="salary-currency">
            <TextInput
              id="salary-currency"
              maxLength={3}
              value={prefs.salary.currency}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, salary: { ...p.salary, currency: e.target.value.toUpperCase() } }))
              }
            />
          </Field>
          <Field label="Period" htmlFor="salary-period">
            <Select
              id="salary-period"
              value={prefs.salary.period}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, salary: { ...p.salary, period: e.target.value as never } }))
              }
            >
              {SALARY_PERIODS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Enforcement" htmlFor="salary-hard">
            <label className="flex items-center gap-2 text-xs">
              <input
                id="salary-hard"
                type="checkbox"
                checked={prefs.salary.minimumIsHard}
                onChange={(e) =>
                  setPrefs((p) => ({ ...p, salary: { ...p.salary, minimumIsHard: e.target.checked } }))
                }
              />
              Minimum is a hard constraint
            </label>
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={prefs.salary.acceptUnstatedSalary}
                onChange={(e) =>
                  setPrefs((p) => ({ ...p, salary: { ...p.salary, acceptUnstatedSalary: e.target.checked } }))
                }
              />
              Still show jobs that state no salary
            </label>
          </Field>
        </div>
      </Card>

      <Card
        title="Visa and work authorisation"
        description="A posting that is silent about sponsorship is treated as unknown, never as a refusal."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Sponsorship" htmlFor="visa">
            <Select
              id="visa"
              value={prefs.workAuthorization.sponsorshipRequirement}
              onChange={(e) =>
                setPrefs((p) => ({
                  ...p,
                  workAuthorization: { ...p.workAuthorization, sponsorshipRequirement: e.target.value as never },
                }))
              }
            >
              {VISA_REQUIREMENTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
            {prefs.workAuthorization.sponsorshipRequirement === 'required' && (
              <span className="mt-1 inline-block">
                <Badge tone="ok">hard constraint</Badge>
              </span>
            )}
          </Field>
          <Field label="Unknown sponsorship" htmlFor="visa-unknown">
            <label className="flex items-center gap-2 text-xs">
              <input
                id="visa-unknown"
                type="checkbox"
                checked={prefs.workAuthorization.acceptUnknownSponsorship}
                onChange={(e) =>
                  setPrefs((p) => ({
                    ...p,
                    workAuthorization: { ...p.workAuthorization, acceptUnknownSponsorship: e.target.checked },
                  }))
                }
              />
              Show jobs that do not mention sponsorship
            </label>
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={prefs.workAuthorization.willingToRelocate}
                onChange={(e) =>
                  setPrefs((p) => ({
                    ...p,
                    workAuthorization: { ...p.workAuthorization, willingToRelocate: e.target.checked },
                  }))
                }
              />
              Willing to relocate
            </label>
          </Field>
        </div>
      </Card>

      <Card title="Seniority" description="Target levels. Empty means no constraint.">
        <div className="flex flex-wrap gap-2">
          {SENIORITY_LEVELS.map((level) => {
            const selected = prefs.seniorityLevels.includes(level);
            return (
              <label
                key={level}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                style={{ borderColor: selected ? 'var(--accent)' : 'var(--border)' }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() =>
                    setPrefs((p) => ({
                      ...p,
                      seniorityLevels: selected
                        ? p.seniorityLevels.filter((l) => l !== level)
                        : [...p.seniorityLevels, level],
                    }))
                  }
                />
                {level}
              </label>
            );
          })}
        </div>
      </Card>

      {LIST_SECTIONS.map((section) => (
        <Card key={section.dimension}>
          <PreferenceListEditor
            title={section.title}
            description={section.description}
            dimension={section.dimension}
            items={prefs[section.dimension as keyof CandidatePreferences] as WeightedPreference[]}
            placeholder={section.placeholder}
            onChange={setList}
            disabled={saving}
          />
        </Card>
      ))}

      <Card
        title="Excluded keywords"
        description="Always a hard constraint. Any job whose title or description contains one is rejected."
      >
        <Field label="Keywords" htmlFor="excludedKeywords" hint="Comma separated">
          <TextInput
            id="excludedKeywords"
            value={prefs.excludedKeywords.join(', ')}
            onChange={(e) =>
              setPrefs((p) => ({
                ...p,
                excludedKeywords: e.target.value
                  .split(',')
                  .map((k) => k.trim())
                  .filter(Boolean),
              }))
            }
          />
        </Field>
      </Card>

      <Card
        title="Matching weights"
        description="Relative importance of each soft dimension. Hard constraints ignore these entirely."
      >
        <div className="flex flex-col gap-2">
          {WEIGHT_LABELS.map(({ key, label }) => (
            <WeightSlider
              key={key}
              label={label}
              value={prefs.weights[key]}
              disabled={saving}
              onChange={(value) => setPrefs((p) => ({ ...p, weights: { ...p.weights, [key]: value } }))}
            />
          ))}
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <SubmitBar dirty={dirty} saving={saving} status={status} />
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          Current version: v{version}
        </span>
      </div>
    </form>
  );
}
