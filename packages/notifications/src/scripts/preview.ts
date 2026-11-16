/**
 * Email preview: `pnpm preview:email [digest|alert|system|weekly|all] [--open]`
 *
 * Renders every template to `.preview/` with realistic fixture data and sends
 * nothing. Email HTML cannot be judged from a test assertion — a layout that
 * passes `toContain('Apply')` can still be unreadable — so the only way to know
 * the emails are good is to look at them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  renderAlert,
  renderDigest,
  renderSystemAlert,
  renderWeeklySummary,
} from '../templates/renderer';
import {
  makeAlertData,
  makeDigestData,
  makeSystemAlertData,
  makeWeeklySummaryData,
} from '../testing/fixtures';

type PreviewKind = 'digest' | 'alert' | 'system' | 'weekly';

const RENDERERS: Record<PreviewKind, () => { subject: string; html: string; text: string }> = {
  digest: () => renderDigest(makeDigestData(), { scope: 'preview' }),
  alert: () => renderAlert(makeAlertData(), { scope: 'preview' }),
  system: () => renderSystemAlert(makeSystemAlertData(), { scope: 'preview' }),
  weekly: () => renderWeeklySummary(makeWeeklySummaryData(), { scope: 'preview' }),
};

function main(): void {
  const requested = (process.argv[2] ?? 'all') as PreviewKind | 'all';
  const kinds: PreviewKind[] =
    requested === 'all' ? (Object.keys(RENDERERS) as PreviewKind[]) : [requested];

  const outputDir = resolve(process.cwd(), '.preview');
  mkdirSync(outputDir, { recursive: true });

  const index: string[] = [];

  for (const kind of kinds) {
    const render = RENDERERS[kind];
    if (!render) {
      console.error(`Unknown preview "${kind}". Try: ${Object.keys(RENDERERS).join(', ')}, all`);
      process.exitCode = 1;
      return;
    }

    const email = render();
    const htmlPath = join(outputDir, `${kind}.html`);
    const textPath = join(outputDir, `${kind}.txt`);

    writeFileSync(htmlPath, email.html, 'utf8');
    // The text part is written too: it is what several clients and every spam
    // filter actually read, and it is the half nobody remembers to check.
    writeFileSync(textPath, email.text, 'utf8');

    index.push(
      `<li><a href="./${kind}.html">${kind}</a> — <code>${email.subject}</code> ` +
        `(<a href="./${kind}.txt">text</a>)</li>`,
    );

    console.log(`${kind.padEnd(8)} → ${htmlPath}`);
    console.log(`${' '.repeat(8)}   ${textPath}`);
    console.log(`${' '.repeat(8)}   subject: ${email.subject}`);
  }

  writeFileSync(
    join(outputDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Email previews</title>
<body style="font-family:system-ui;padding:24px;max-width:640px;margin:0 auto;">
<h1>Email previews</h1>
<p>Rendered from fixture data. Nothing was sent.</p>
<ul>${index.join('')}</ul>
</body>`,
    'utf8',
  );

  console.log(`\nOpen ${join(outputDir, 'index.html')}`);
}

main();
