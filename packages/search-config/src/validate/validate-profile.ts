import {
  REMOTE_PREFERENCE_ACCEPTS,
  validationResultSchema,
  type SearchProfile,
  type ValidationIssue,
  type ValidationResult,
} from '@job-intel/contracts';

/**
 * Configuration validation.
 *
 * Part 39's requirement: contradictions must not be silently accepted. A
 * minimum salary above the maximum, React both required and excluded,
 * remote-only against an onsite-only city list — each of these is a profile
 * that cannot match anything, and storing one produces a search that quietly
 * returns nothing while looking perfectly configured.
 *
 * The distinction between the two severities carries real weight:
 *
 *   `error`   — incoherent. The write is refused.
 *   `warning` — coherent but probably not what was meant. The write proceeds.
 *
 * Being strict about the second would be worse than useless. A profile narrow
 * enough to match almost nothing is a legitimate thing to want — someone
 * hunting one specific role at one specific company — and refusing it would
 * mean the system deciding what searches a person is allowed to run.
 */

export function validateProfile(profile: SearchProfile): ValidationResult {
  const issues: ValidationIssue[] = [];

  const error = (field: string, message: string, suggestion: string | null = null): void => {
    issues.push({ severity: 'error', field, message, suggestion });
  };

  const warn = (field: string, message: string, suggestion: string | null = null): void => {
    issues.push({ severity: 'warning', field, message, suggestion });
  };

  // ── Salary ──────────────────────────────────────────────────────────────
  const { minimum, maximum } = profile.salary;

  if (minimum !== null && maximum !== null && minimum > maximum) {
    error(
      'salary',
      `Your minimum (${minimum.toLocaleString()}) is above your maximum (${maximum.toLocaleString()}), so no salary could ever satisfy both.`,
      'Raise the maximum or lower the minimum.',
    );
  }

  if (profile.salary.strictness === 'strict' && profile.salary.acceptUnstated) {
    /*
     * Not an error, but worth saying.
     *
     * "Strictly at least €70k" combined with "and jobs that mention no salary
     * are fine" is coherent — most postings are silent and excluding them all
     * would empty the search — but people are frequently surprised by it.
     */
    warn(
      'salary.strictness',
      'Your salary rule is strict, but postings that state no salary are still accepted. Most postings state none.',
      'Turn off "accept unstated salary" if you only want jobs that publish a range.',
    );
  }

  if (minimum === null && profile.salary.strictness === 'strict') {
    warn(
      'salary.minimum',
      'Salary strictness is set to strict but no minimum is set, so nothing is being enforced.',
      'Set a minimum, or relax the strictness.',
    );
  }

  // ── Experience ──────────────────────────────────────────────────────────
  const { minimumExperienceYears: minYears, maximumExperienceYears: maxYears } = profile;

  if (minYears !== null && maxYears !== null && minYears > maxYears) {
    error(
      'experience',
      `Minimum experience (${minYears} years) is above the maximum (${maxYears}).`,
      'Swap the two values, or clear one of them.',
    );
  }

  // ── Skills ──────────────────────────────────────────────────────────────
  const excludedSkills = new Set(profile.excludedSkills.map((value) => value.toLowerCase()));

  for (const skill of profile.skills) {
    if (excludedSkills.has(skill.value.toLowerCase())) {
      error(
        'skills',
        `"${skill.label ?? skill.value}" is listed as a ${skill.tier} skill and also excluded.`,
        'Remove it from one of the two lists.',
      );
    }
  }

  // ── Keywords ────────────────────────────────────────────────────────────
  const banned = new Set(profile.keywords.mustNotContain.map((value) => value.toLowerCase()));

  for (const keyword of profile.keywords.mustContain) {
    if (banned.has(keyword.toLowerCase())) {
      error(
        'keywords',
        `"${keyword}" must both appear and never appear.`,
        'Remove it from one of the two lists.',
      );
    }
  }

  for (const skill of profile.skills) {
    if (skill.tier === 'required' && banned.has(skill.value.toLowerCase())) {
      error(
        'keywords.mustNotContain',
        `"${skill.label ?? skill.value}" is a required skill but is also a banned keyword.`,
        'Remove the keyword ban, or drop the skill requirement.',
      );
    }
  }

  // ── Locations against work arrangement ──────────────────────────────────
  const accepts = REMOTE_PREFERENCE_ACCEPTS[profile.remotePreference] ?? [];
  const remoteOnly = profile.remotePreference === 'REMOTE_ONLY';
  const physicalLocations = profile.locations.filter(
    (entry) => entry.kind === 'city' || entry.kind === 'state',
  );

  if (remoteOnly && physicalLocations.length > 0 && profile.locationStrictness === 'strict') {
    /*
     * Remote-only plus a strict city list is *nearly* always a mistake, but not
     * always: "remote, but I must be able to reach the Berlin office" is a real
     * requirement some contracts impose. A warning rather than an error.
     */
    warn(
      'remotePreference',
      'This profile is remote-only but strictly limited to specific cities, which will match very little.',
      'Relax the location strictness, or allow hybrid roles.',
    );
  }

  if (!accepts.includes('remote') && profile.remoteScope.worldwide) {
    warn(
      'remoteScope',
      'Remote roles are not accepted by this profile, so the remote scope settings have no effect.',
      null,
    );
  }

  const excludedLocationValues = new Set(
    profile.excludedLocations.map((entry) => `${entry.kind}:${entry.value.toLowerCase()}`),
  );

  for (const location of profile.locations) {
    if (excludedLocationValues.has(`${location.kind}:${location.value.toLowerCase()}`)) {
      error(
        'locations',
        `${location.label ?? location.value} is both included and excluded.`,
        'Remove it from one of the two lists.',
      );
    }
  }

  // ── Companies ───────────────────────────────────────────────────────────
  const excludedCompanies = new Set(
    profile.companies.excluded.map((value) => value.toLowerCase()),
  );

  for (const company of [...profile.companies.favourites, ...profile.companies.preferred]) {
    if (excludedCompanies.has(company.toLowerCase())) {
      error(
        'companies',
        `"${company}" is both preferred and excluded.`,
        'Remove it from one of the two lists.',
      );
    }
  }

  for (const type of profile.companies.types) {
    if (profile.companies.excludedTypes.includes(type)) {
      error('companies.types', `Company type "${type}" is both wanted and excluded.`, null);
    }
  }

  // ── Industries ──────────────────────────────────────────────────────────
  const excludedIndustries = new Set(
    profile.industries.excluded.map((value) => value.toLowerCase()),
  );

  for (const industry of profile.industries.preferred) {
    if (excludedIndustries.has(industry.toLowerCase())) {
      error('industries', `"${industry}" is both preferred and excluded.`, null);
    }
  }

  // ── Sources ─────────────────────────────────────────────────────────────
  const excludedSources = new Set(profile.excludedSources.map((value) => value.toLowerCase()));
  const enabledSources = profile.sources.filter((entry) => entry.enabled);

  for (const selection of enabledSources) {
    if (excludedSources.has(selection.sourceId.toLowerCase())) {
      warn(
        'sources',
        `"${selection.sourceId}" is enabled and excluded. The exclusion wins.`,
        'Remove it from the excluded list if you want it searched.',
      );
    }
  }

  const usableSources = enabledSources.filter(
    (entry) => !excludedSources.has(entry.sourceId.toLowerCase()),
  );

  if (profile.sources.length > 0 && usableSources.length === 0) {
    error(
      'sources',
      'Every source this profile lists is either disabled or excluded, so it can never find anything.',
      'Enable at least one source, or clear the list to search everything available.',
    );
  }

  // ── Visa ────────────────────────────────────────────────────────────────
  if (profile.visa.stance === 'sponsorship_required' && !profile.visa.rejectNoSponsorship) {
    warn(
      'visa',
      'You need sponsorship but postings that refuse to sponsor are not being rejected.',
      'Turn on "reject roles without sponsorship" to filter them out.',
    );
  }

  if (
    profile.visa.stance === 'already_authorized' &&
    profile.visa.authorisedCountries.length === 0
  ) {
    warn(
      'visa.authorisedCountries',
      'You are marked as already authorised but have not said where.',
      'Add the countries you can work in so location filtering can use them.',
    );
  }

  // ── Emptiness ───────────────────────────────────────────────────────────
  if (profile.roles.length === 0 && profile.skills.length === 0 && profile.keywords.mustContain.length === 0) {
    warn(
      'roles',
      'This profile names no roles, skills or keywords, so it will match on location and little else.',
      'Add at least one target role.',
    );
  }

  const parsed = validationResultSchema.safeParse({
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues: issues.slice(0, 40),
  });

  return parsed.success ? parsed.data : { valid: false, issues: [] };
}

/**
 * Whether two profiles overlap enough to be worth mentioning.
 *
 * Not an error — running "Remote Frontend" and "Germany Frontend" together is
 * perfectly sensible and they will overlap. Surfaced so someone who created a
 * near-duplicate by accident can see it.
 */
export function profileOverlap(a: SearchProfile, b: SearchProfile): number {
  const overlap = (left: readonly string[], right: readonly string[]): number => {
    if (left.length === 0 || right.length === 0) return 0;
    const set = new Set(right.map((value) => value.toLowerCase()));
    const hits = left.filter((value) => set.has(value.toLowerCase())).length;
    return hits / Math.max(left.length, right.length);
  };

  const roles = overlap(
    a.roles.map((role) => role.title),
    b.roles.map((role) => role.title),
  );

  const locations = overlap(
    a.locations.map((entry) => entry.value),
    b.locations.map((entry) => entry.value),
  );

  const skills = overlap(
    a.skills.map((entry) => entry.value),
    b.skills.map((entry) => entry.value),
  );

  const sameArrangement = a.remotePreference === b.remotePreference ? 1 : 0;

  return Math.round(((roles * 0.4 + locations * 0.3 + skills * 0.2 + sameArrangement * 0.1)) * 100) / 100;
}
