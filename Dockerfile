# Production image for the worker.
#
# The dashboard is not built here any more — it deploys on Vercel, which builds
# it from `vercel.json`. Building it here too cost a couple of minutes on every
# worker deploy and, worse, meant a failed `next build` could stop the worker
# from shipping. Nothing else in the monorepo has a build step: the worker runs
# TypeScript directly through tsx, which is why there is no compile stage below.
#
# To self-host the dashboard instead of using Vercel:
#   pnpm --filter @job-intel/web build && pnpm --filter @job-intel/web start
#
#   docker build -t naijajobs .
#   docker run naijajobs

FROM node:22-slim AS base

# corepack pins pnpm to the version in package.json, so a local build and a CI
# build resolve the same tree rather than whatever pnpm the image happened to
# ship with.
RUN corepack enable
WORKDIR /app

# ── Dependencies ────────────────────────────────────────────────────────────
#
# Manifests first, sources second. Dependencies change far less often than code,
# so this layer survives most rebuilds and turns a two-minute install into a
# cache hit.
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/application/package.json packages/application/
COPY packages/candidate/package.json packages/candidate/
COPY packages/config/package.json packages/config/
COPY packages/connectors/package.json packages/connectors/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/discovery/package.json packages/discovery/
COPY packages/enrichment/package.json packages/enrichment/
COPY packages/matching/package.json packages/matching/
COPY packages/observability/package.json packages/observability/
COPY packages/ops/package.json packages/ops/
COPY packages/queue/package.json packages/queue/
COPY packages/recommendation/package.json packages/recommendation/
COPY packages/resume/package.json packages/resume/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/search-config/package.json packages/search-config/

RUN pnpm install --frozen-lockfile

# ── Source ──────────────────────────────────────────────────────────────────
#
# No compile step. `pnpm build` used to run here and only ever built the Next
# app, which now builds on Vercel.
FROM deps AS build

COPY . .

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime

ENV NODE_ENV=production

# A non-root user. The process reads job postings from the open web; if
# something in that path is ever exploited, root in the container is a much
# worse starting position than an unprivileged account.
RUN groupadd --system --gid 1001 jobintel \
 && useradd --system --uid 1001 --gid jobintel jobintel

COPY --from=build --chown=jobintel:jobintel /app /app

USER jobintel

# The worker by default. It is the process that does the autonomous work, and a
# container started with no command should be the one that keeps the system
# running rather than the one that serves a page.
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]
