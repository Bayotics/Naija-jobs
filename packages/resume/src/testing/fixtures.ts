/**
 * Synthetic resume corpus.
 *
 * Every one of these is invented. No real person's document is used, and none
 * of the names, companies, emails or URLs belong to anyone — testing an
 * extraction pipeline on real resumes would mean keeping real resumes in a
 * repository, which is exactly the thing the privacy requirements rule out.
 *
 * The corpus is chosen to break things rather than to flatter the parser. It
 * covers the awkward cases the brief names — unusual section headings, missing
 * months, overlapping roles, a career change, a document with no headings at
 * all — because a parser that only handles the tidy case will look excellent in
 * tests and fail on the first document a real person uploads.
 */

export interface ResumeFixture {
  name: string;
  /** What this fixture is designed to exercise. */
  tests: string;
  text: string;
}

/** A conventional, well-structured resume. The baseline. */
export const STANDARD_RESUME = `Alex Morgan
alex.morgan@example.invalid | +44 7700 900000 | London, UK
github.com/example-handle

SUMMARY
Frontend-leaning full-stack engineer with eight years building product software
for consumer and B2B teams.

WORK EXPERIENCE

Meridian Labs — Senior Software Engineer
London, UK | March 2021 – Present
• Led the migration of the customer dashboard from Angular to React, reducing
  median page load from 4.1s to 1.3s
• Mentored three junior engineers through their first year
• Designed the event ingestion pipeline handling 40M events per day using
  Node.js, PostgreSQL and Redis
• Introduced TypeScript across four repositories

Harbourview Systems — Software Engineer
Manchester, UK | June 2018 – February 2021
• Built and maintained internal tooling in Python and Django
• Shipped the billing integration that cut manual reconciliation by 70%
• Owned the CI/CD pipeline on GitHub Actions and Docker

Kestrel Digital — Junior Developer
Leeds, UK | September 2016 – May 2018
• Developed marketing sites in JavaScript, HTML and CSS
• Assisted the team with WordPress theme maintenance

EDUCATION

University of Leeds
BSc Computer Science, 2013 – 2016
Grade: First Class Honours

SKILLS
Languages: JavaScript, TypeScript, Python, SQL
Frameworks: React, Next.js, Node.js, Django, Express
Cloud: AWS, Docker, Kubernetes, Terraform
Databases: PostgreSQL, Redis, MongoDB

CERTIFICATIONS
AWS Certified Solutions Architect – Associate, Amazon Web Services, 2022
Certified Kubernetes Application Developer, CNCF, March 2023

PROJECTS
Tidepool — An open-source CLI for managing local Postgres instances. Built in Go.
Chartsmith — A React component library for accessible data visualisation, 2020.

LANGUAGES
English (Native), Spanish (Professional working proficiency)
`;

/** Unconventional headings — the case the brief calls out by name. */
export const UNUSUAL_HEADINGS_RESUME = `Jordan Ellis
jordan.ellis@example.invalid

WHO I AM
Backend engineer who likes systems that are boring in production.

PROFESSIONAL JOURNEY

Northgate Analytics | Staff Engineer | 2020 - present
• Architected the multi-tenant data platform serving 200 enterprise customers
• Set the standards for service ownership across eight teams
• Reduced infrastructure spend by $400k annually

Bellweather Software | Backend Engineer | 2017 - 2020
• Built payment processing services in Java and Spring Boot
• Led the migration from monolith to services

WHAT I BRING
Java, Kotlin, Go, PostgreSQL, Kafka, Kubernetes, AWS, System Design,
Distributed Systems, Mentoring

THINGS I'VE BUILT
Quillmark — A self-hosted bookmarking service written in Go and SQLite.

ACADEMIC BACKGROUND
MSc Distributed Computing, Imperial College London, 2017
BEng Software Engineering, University of Bristol, 2015
`;

/** Missing months everywhere: durations must be flagged as estimates. */
export const YEAR_ONLY_RESUME = `Sam Rivera
sam.rivera@example.invalid

EXPERIENCE

Foxglove Interactive, Product Engineer
2021 – 2024
Worked on the checkout experience using React and TypeScript.

Ridgeline Co, Developer
2019 – 2021
Maintained internal Python services.

EDUCATION
BA Mathematics, 2015 – 2019

SKILLS
React, TypeScript, Python, SQL
`;

/**
 * Overlapping roles.
 *
 * The React spans here are 2021–2023 and 2022–2024. A parser that adds them
 * reports four years; the correct answer is three. This is the Part 15 case.
 */
export const OVERLAPPING_ROLES_RESUME = `Priya Raman
priya.raman@example.invalid

EXPERIENCE

Lumen Health — Contract Frontend Engineer
January 2021 – December 2023
• Built patient-facing dashboards in React and TypeScript
• Integrated with FHIR APIs

Sable Studio — Part-time Frontend Consultant
January 2022 – January 2024
• Advised on React architecture for three client products
• Ran accessibility audits against WCAG 2.1

SKILLS
React, TypeScript, Accessibility, GraphQL
`;

/** A career change: trajectory and transferable skills should notice. */
export const CAREER_CHANGE_RESUME = `Tomas Nowak
tomas.nowak@example.invalid

PROFESSIONAL EXPERIENCE

Vantage Cloud — Software Engineer
August 2022 – Present
• Build internal tooling in Python and FastAPI
• Automated the reporting pipeline, saving 15 hours per week

Fairmount Secondary School — Mathematics Teacher
September 2014 – July 2022
• Taught A-level mathematics and further mathematics
• Led the department's data reporting and timetabling
• Mentored four newly qualified teachers

EDUCATION
PGCE Secondary Mathematics, University of Nottingham, 2014
BSc Mathematics, University of Warwick, 2013

SKILLS
Python, SQL, FastAPI, Data Analysis, Communication, Mentoring
`;

/** No headings at all — a single prose block. */
export const NO_HEADINGS_RESUME = `Casey Lin is a data engineer based in Dublin with six years of experience.
Casey currently works at Ashford Data as a Senior Data Engineer, where they have
built streaming pipelines in Python and Apache Kafka since March 2019, and
previously worked at Trellis Analytics as a Data Analyst from 2017 to 2019 using
SQL and Tableau. Casey holds a BSc in Statistics from Trinity College Dublin.
`;

/** Skills asserted but never evidenced: proficiency must stay capped. */
export const SKILLS_ONLY_RESUME = `Morgan Blake
morgan.blake@example.invalid

SKILLS
Rust, Kubernetes, Terraform, Go, Elasticsearch, GraphQL, Machine Learning,
Kafka, Spark, Scala

EXPERIENCE

Cobalt Retail — Support Engineer
May 2022 – Present
• Handled customer support tickets and escalations
• Wrote internal documentation
`;

/**
 * A second document for the same person as `STANDARD_RESUME`, with a different
 * end date and a different title for the same role — the conflict case.
 */
export const CONFLICTING_RESUME = `Alex Morgan
alex.morgan@example.invalid | London, UK

PROFESSIONAL EXPERIENCE

Meridian Labs — Lead Engineer
London, UK | March 2021 – Present
• Owned the platform roadmap across four teams
• Led architecture reviews

Harbourview Systems — Senior Software Engineer
Manchester, UK | June 2018 – August 2021
• Built internal tooling in Python and Django
• Managed a team of two

SKILLS
Python, Django, PostgreSQL, AWS, Leadership, System Design
`;

/** No dates anywhere: duration must be null rather than zero. */
export const UNDATED_RESUME = `Riley Chen

EXPERIENCE

Ardent Media — Web Developer
Built and maintained client websites using JavaScript and PHP.

Bramble Agency — Junior Developer
Assisted with WordPress builds.

SKILLS
JavaScript, PHP, WordPress, CSS
`;

export const FIXTURES: readonly ResumeFixture[] = [
  { name: 'standard', tests: 'conventional structure, full extraction', text: STANDARD_RESUME },
  {
    name: 'unusual-headings',
    tests: '"Professional Journey", "What I Bring", "Things I\'ve Built"',
    text: UNUSUAL_HEADINGS_RESUME,
  },
  { name: 'year-only', tests: 'missing months; durations must be estimates', text: YEAR_ONLY_RESUME },
  {
    name: 'overlapping',
    tests: 'concurrent roles must not double-count skill duration',
    text: OVERLAPPING_ROLES_RESUME,
  },
  { name: 'career-change', tests: 'transferable skills and trajectory', text: CAREER_CHANGE_RESUME },
  { name: 'no-headings', tests: 'single prose block, no section boundaries', text: NO_HEADINGS_RESUME },
  {
    name: 'skills-only',
    tests: 'asserted skills with no supporting evidence',
    text: SKILLS_ONLY_RESUME,
  },
  { name: 'conflicting', tests: 'contradicts the standard resume', text: CONFLICTING_RESUME },
  { name: 'undated', tests: 'no dates at all; duration must be null', text: UNDATED_RESUME },
];

/** UTF-8 bytes for a fixture, for driving the pipeline as a text/plain upload. */
export function fixtureBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * A minimal, valid PDF containing one line of text.
 *
 * Hand-built rather than generated so the test suite has no binary fixture and
 * no dependency on a PDF writer. Small enough to read, real enough to parse.
 */
export function minimalPdf(line = 'Hello resume'): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${line.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }

  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

/**
 * A PDF declaring embedded JavaScript.
 *
 * Used to prove the validator rejects active content rather than handing it to
 * a parser. Not itself malicious — it declares the marker and nothing else.
 */
export function pdfWithJavaScript(): Uint8Array {
  const base = new TextDecoder().decode(minimalPdf());
  const injected = base.replace(
    '/Type /Catalog',
    '/Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>',
  );
  return new TextEncoder().encode(injected);
}

/**
 * A ZIP whose central directory claims an enormous uncompressed size.
 *
 * The zip-bomb case: the validator must reject it by reading the directory,
 * without decompressing anything.
 */
export function zipBomb(): Uint8Array {
  const name = 'word/document.xml';
  const nameBytes = new TextEncoder().encode(name);

  // Local file header, then a central directory entry claiming a 200MB member
  // compressed into 100 bytes.
  const local = new Uint8Array(30 + nameBytes.length + 100);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(10, 8, true); // deflate
  centralView.setUint32(20, 100, true); // compressed size
  centralView.setUint32(24, 200 * 1024 * 1024, true); // uncompressed size
  centralView.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}

/** A file whose extension and declared type disagree with its bytes. */
export function mislabelledFile(): { bytes: Uint8Array; filename: string; declared: string } {
  return {
    bytes: minimalPdf('actually a pdf'),
    filename: 'resume.docx',
    declared: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}
