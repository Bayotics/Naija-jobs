/**
 * Candidate intelligence CLI: `pnpm resume [--file PATH] [--fixtures] [--job ID] [--report]`
 *
 * Runs the whole layer end to end against the real database:
 *
 *   upload → validate → extract → sections → entities → evidence
 *          → merge → conflicts → publish → matrix → job view
 *
 * `--fixtures` ingests the synthetic corpus, which is the only way to exercise
 * the awkward cases (unusual headings, missing months, overlapping roles,
 * contradictory documents) without keeping a real person's resume in the repo.
 *
 * Every number printed afterwards is read back from the database rather than
 * carried over from the run, so the output is evidence that the data actually
 * persisted rather than that the functions returned.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadDotenv, loadEnv } from '@job-intel/config';
import { createLogger, EventRecorder } from '@job-intel/observability';
import {
  EnrichmentRepository,
  EventRepository,
  IntelligenceRepository,
  JobRepository,
  ProfileRepository,
  createDatabase,
  optionsFromEnv,
  schema,
} from '@job-intel/db';
import { HttpClient, GitHubPortfolioConnector, PersonalSiteConnector } from '@job-intel/connectors';
import { SKILL_TAXONOMY } from '@job-intel/resume';
import { FIXTURES, fixtureBytes } from '@job-intel/resume/testing';
import { desc, eq, sql } from 'drizzle-orm';
import { ResumeService } from '../resume-service';

interface Args {
  files: string[];
  fixtures: boolean;
  jobId: string | null;
  report: boolean;
  link: string | null;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    files: [],
    fixtures: false,
    jobId: null,
    report: false,
    link: null,
    reset: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--file') args.files.push(argv[++index] ?? '');
    else if (flag === '--fixtures') args.fixtures = true;
    else if (flag === '--job') args.jobId = argv[++index] ?? null;
    else if (flag === '--link') args.link = argv[++index] ?? null;
    else if (flag === '--report') args.report = true;
    else if (flag === '--reset') args.reset = true;
  }

  return args;
}

const bar = (value: number, width = 20): string => {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv(process.env, { role: 'worker' });
  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  const handle = await createDatabase(optionsFromEnv(env));
  const events = new EventRecorder(logger, new EventRepository(handle.db));

  const profiles = new ProfileRepository(handle.db);
  const active = await profiles.getActiveProfile().catch(() => null);

  if (!active) {
    console.error('No active candidate profile. Run the profile seed first.');
    await handle.close();
    process.exit(1);
  }

  const candidateId = active.profileId;
  const intelligence = new IntelligenceRepository(handle.db);

  const http = new HttpClient({
    userAgent: env.CRAWLER_USER_AGENT,
    contactEmail: env.CRAWLER_CONTACT_EMAIL,
  });

  const service = new ResumeService({
    intelligence,
    jobs: new JobRepository(handle.db),
    enrichments: new EnrichmentRepository(handle.db),
    logger,
    events,
    portfolioConnectors: [
      new GitHubPortfolioConnector(http, { token: process.env.GITHUB_TOKEN ?? null }),
      new PersonalSiteConnector(
        http,
        SKILL_TAXONOMY.filter((skill) => skill.category !== 'soft_skill').map((skill) => skill.name),
      ),
    ],
  });

  /*
   * `--reset` clears every candidate-intelligence table.
   *
   * Scoped deliberately: it never touches jobs, sources, preferences or
   * behavioural history. Re-running the demo should re-derive the profile, not
   * erase the rest of the system.
   */
  if (args.reset) {
    await handle.db.execute(sql`
      TRUNCATE TABLE
        requirement_matrices, profile_field_overrides, profile_conflicts,
        candidate_skill_facts, candidate_intelligence_profiles,
        document_extractions, document_sections, external_profiles,
        candidate_documents
      CASCADE
    `);
    console.log('Cleared the candidate intelligence tables. Jobs and preferences are untouched.');
  }

  // ── Ingest ────────────────────────────────────────────────────────────────
  const uploads: Array<{ label: string; accepted: boolean; detail: string }> = [];

  if (args.fixtures) {
    console.log(`\nIngesting ${FIXTURES.length} synthetic resumes…\n`);

    for (const fixture of FIXTURES) {
      const result = await service.upload({
        candidateId,
        bytes: fixtureBytes(fixture.text),
        filename: `${fixture.name}.txt`,
        declaredMimeType: 'text/plain',
        label: fixture.name,
      });

      uploads.push({
        label: fixture.name,
        accepted: result.accepted,
        detail: result.accepted
          ? `${result.pipeline?.experience.length ?? 0} roles, ${result.pipeline?.skills.length ?? 0} skills` +
            (result.duplicate ? ' (already had this file)' : '')
          : (result.document.rejectionReason ?? 'rejected'),
      });

      console.log(
        `  ${result.accepted ? '✓' : '✗'} ${fixture.name.padEnd(18)} ${uploads[uploads.length - 1]!.detail}`,
      );
      console.log(`      tests: ${fixture.tests}`);
    }
  }

  for (const path of args.files) {
    if (!path) continue;
    const bytes = new Uint8Array(await readFile(path));

    const result = await service.upload({
      candidateId,
      bytes,
      filename: basename(path),
      declaredMimeType: null,
      label: basename(path).replace(/\.[^.]+$/, ''),
    });

    console.log(
      `\n${result.accepted ? '✓' : '✗'} ${basename(path)} — ` +
        (result.accepted
          ? `${result.pipeline?.experience.length} roles, ${result.pipeline?.skills.length} skills`
          : result.document.rejectionReason),
    );

    if (result.pipeline) {
      for (const stage of result.pipeline.stages) {
        console.log(`    ${stage.ok ? '·' : '!'} ${stage.stage.padEnd(10)} ${stage.durationMs}ms  ${stage.detail}`);
        for (const warning of stage.warnings) console.log(`      warning: ${warning}`);
      }
    }
  }

  if (args.link) {
    const linked = await service.linkExternalProfile({ candidateId, url: args.link });
    console.log(
      `\n${linked.ok ? '✓' : '✗'} ${args.link} — ${
        linked.ok ? `${linked.skills} skills evidenced` : linked.error
      }`,
    );
    for (const limitation of linked.limitations) console.log(`    note: ${limitation}`);
  }

  // ── Read the profile back from the database ──────────────────────────────
  const profile = await service.getProfile(candidateId);

  if (!profile) {
    console.log('\nNo intelligence profile exists yet. Upload a document first.');
    await handle.close();
    return;
  }

  console.log('\n── Profile ' + '─'.repeat(58));
  console.log(`  version           v${profile.profileVersion} from ${profile.sourceDocumentIds.length} document(s)`);
  console.log(`  summary           ${profile.summary}`);
  console.log(
    `  seniority         ${profile.seniority.estimatedLevel ?? 'unknown'} ` +
      `(${Math.round(profile.seniority.confidence * 100)}% confidence, ${profile.seniority.signals.length} signals)`,
  );
  if (profile.seniority.titleVsEvidenceNote) {
    console.log(`                    ${profile.seniority.titleVsEvidenceNote}`);
  }
  console.log(
    `  experience        ${
      profile.trajectory.totalExperienceMonths === null
        ? 'not dated'
        : `${(profile.trajectory.totalExperienceMonths / 12).toFixed(1)} years (overlaps counted once)`
    }`,
  );
  console.log(`  skills            ${profile.skills.length}`);
  console.log(`  open conflicts    ${profile.openConflicts}`);

  if (profile.quality) {
    console.log('\n── Quality (three separate scores) ' + '─'.repeat(35));
    console.log(`  completeness      ${bar(profile.quality.completenessScore)} ${profile.quality.completenessScore}`);
    console.log(`  evidence quality  ${bar(profile.quality.evidenceQualityScore)} ${profile.quality.evidenceQualityScore}`);
    console.log(`  confidence        ${bar(profile.quality.confidenceScore)} ${profile.quality.confidenceScore}`);

    for (const gap of profile.quality.materialGaps.slice(0, 5)) {
      console.log(`  gap [${gap.impact}] ${gap.reason}`);
      console.log(`        → ${gap.action}`);
    }
  }

  // ── Skills with their evidence ───────────────────────────────────────────
  console.log('\n── Top skills, with where the evidence came from ' + '─'.repeat(21));
  for (const skill of profile.skills.slice(0, 12)) {
    const duration =
      skill.totalMonths === null
        ? 'not dated'
        : `${skill.monthsIsEstimate ? '~' : ''}${(skill.totalMonths / 12).toFixed(1)}y`;

    console.log(
      `  ${skill.name.padEnd(20)} ${(skill.proficiency ?? 'unknown').padEnd(11)} ${duration.padEnd(10)} ` +
        `${skill.evidence.length} item(s) via ${skill.strongestSource}`,
    );
    console.log(`      ${skill.proficiencyRationale}`);
  }

  // ── Conflicts ────────────────────────────────────────────────────────────
  const conflicts = await service.listConflicts(candidateId);
  if (conflicts.length > 0) {
    console.log(`\n── ${conflicts.length} unresolved contradiction(s) ` + '─'.repeat(38));
    for (const conflict of conflicts.slice(0, 8)) {
      console.log(`  ${conflict.kind}: ${conflict.subject}`);
      for (const position of conflict.positions) {
        console.log(`      "${position.value}" — ${position.documentLabel ?? 'unknown document'}`);
      }
      console.log(`      ${conflict.detail}`);
    }
  }

  // ── Document comparison ──────────────────────────────────────────────────
  const comparison = await service.compareDocuments(candidateId);
  if (comparison.documents.length > 1) {
    console.log('\n── Your documents compared ' + '─'.repeat(43));
    console.log(`  shared skills: ${comparison.sharedSkills.slice(0, 10).join(', ') || 'none'}`);
    for (const entry of comparison.documents) {
      console.log(`  ${entry.label.padEnd(18)} ${entry.skillCount} skills, ${entry.experienceCount} roles`);
      console.log(`      ${entry.positioning}`);
    }
    for (const difference of comparison.differences.slice(0, 5)) {
      console.log(`  · ${difference}`);
    }
  }

  // ── Against a job ────────────────────────────────────────────────────────
  let targetJobId = args.jobId;

  if (!targetJobId) {
    // Any enriched job will do; the point is to exercise the matrix against
    // real stored requirements rather than a fixture.
    const [row] = await handle.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .innerJoin(schema.jobEnrichments, eq(schema.jobEnrichments.jobId, schema.jobs.id))
      .orderBy(desc(schema.jobs.firstSeenAt))
      .limit(1);

    targetJobId = row?.id ?? null;
  }

  if (targetJobId) {
    const view = await service.jobView({ candidateId, jobId: targetJobId });

    if (view) {
      const [job] = await handle.db
        .select({ title: schema.jobs.title, company: schema.jobs.companyNameRaw })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, targetJobId))
        .limit(1);

      console.log(`\n── Against "${job?.title}" at ${job?.company} ` + '─'.repeat(20));
      console.log(
        `  coverage          ${bar(view.matrix.coverageScore)} ${view.matrix.coverageScore}/100`,
      );
      console.log(
        `  direct ${view.matrix.directMatches} · transferable ${view.matrix.transferableMatches} · ` +
          `unknown ${view.matrix.unknowns} · not supported ${view.matrix.missing}`,
      );
      console.log(`  evidence confidence ${(view.evidenceConfidence * 100).toFixed(0)}%`);

      console.log('\n  Requirement matrix:');
      for (const row of view.matrix.rows.slice(0, 15)) {
        const mark =
          row.support === 'SUPPORTED' ? '✓' : row.support === 'NOT_SUPPORTED' ? '✗' : '?';
        console.log(
          `    ${mark} ${row.requirement.slice(0, 44).padEnd(46)} ${row.evidenceKind.padEnd(22)} ${row.strength.toFixed(2)}`,
        );
      }

      console.log(`\n  Explanation:\n    ${view.explanation}`);

      if (view.resumeFits.length > 0) {
        console.log('\n  Which document argues this best:');
        for (const fit of view.resumeFits.slice(0, 5)) {
          console.log(`    ${fit.resumeFitScore.toString().padStart(3)}/100  ${fit.label}`);
        }
      }
    }
  } else {
    console.log('\n(No enriched job in the database, so the requirement matrix was not exercised.)');
  }

  // ── Persistence check ────────────────────────────────────────────────────
  if (args.report) {
    const counts = await handle.db.execute<{ table: string; count: number }>(sql`
      SELECT 'documents' AS table, count(*)::int AS count FROM candidate_documents
      UNION ALL SELECT 'sections', count(*)::int FROM document_sections
      UNION ALL SELECT 'extractions', count(*)::int FROM document_extractions
      UNION ALL SELECT 'profiles', count(*)::int FROM candidate_intelligence_profiles
      UNION ALL SELECT 'skill_facts', count(*)::int FROM candidate_skill_facts
      UNION ALL SELECT 'conflicts', count(*)::int FROM profile_conflicts
      UNION ALL SELECT 'overrides', count(*)::int FROM profile_field_overrides
      UNION ALL SELECT 'matrices', count(*)::int FROM requirement_matrices
      UNION ALL SELECT 'external', count(*)::int FROM external_profiles
    `);

    console.log('\n── Rows written ' + '─'.repeat(53));
    for (const row of counts.rows ?? []) {
      console.log(`  ${String(row.table).padEnd(16)} ${row.count}`);
    }
  }

  console.log('');
  await handle.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
