# Deploying

Two halves, two platforms, and the split is not arbitrary.

The **worker** is a process that must never stop: it crawls on a schedule,
holds a queue lease, and keeps a database connection open between passes. That
is the one thing a serverless platform cannot host. The **dashboard** is a
request/response app that sits idle most of the day, which is the one thing
serverless is good at.

So: worker on Render, dashboard on Vercel. Both read the same Neon database.

---

## 1. The worker — Render

1. [Render](https://dashboard.render.com) → **New** → **Blueprint** → pick this repo
2. It reads `render.yaml` and prompts once per secret
3. Deploy

It costs about **$7/month**. Render has no free worker tier, and the free *web*
tier sleeps — a sleeping worker finds you nothing, which is the whole failure
this deployment exists to avoid.

Generate the two shared secrets first and keep them somewhere you can paste
from twice; both platforms need the identical values.

```bash
node -e "const c=require('crypto');console.log('AUTH_SECRET  =',c.randomBytes(32).toString('base64'));console.log('OPS_PASSWORD =',c.randomBytes(24).toString('base64'))"
```

---

## 2. The dashboard — Vercel

1. [Vercel](https://vercel.com/new) → **Add New** → **Project** → import this repo
2. Leave **Root Directory** as the repository root. `vercel.json` already says
   where the app is, which command builds it, and where the output lands —
   setting the root to `apps/web` makes Vercel look for that file in the wrong
   place and the workspace packages resolve from nowhere.
3. Add the environment variables below
4. Deploy

### Environment variables

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | your Neon **pooled** string (`...-pooler...`) | see below |
| `DATABASE_DRIVER` | `neon` | see below |
| `AUTH_SECRET` | **the same value Render generated** | see below |
| `OPS_PASSWORD` | the same value Render generated | signs into the ops console |
| `APP_URL` | `https://your-project.vercel.app` | used in absolute links |
| `ANTHROPIC_API_KEY` | your key | AI explanations on job pages |
| `AI_EMBEDDING_PROVIDER` | `openai` | |
| `AI_EMBEDDING_API_KEY` | your key | semantic search |

`NODE_ENV` is set to `production` by Vercel; don't add it yourself. There is no
email configuration because there is no email.

### Three things that will bite you if you skip them

**`DATABASE_DRIVER=neon`, not `pg`.** The worker uses `pg`, and it is right to:
it is one long-lived process that opens a connection pool once and keeps it.
A Vercel function is the opposite — it may be frozen between requests and
exists in dozens of copies — so a TCP pool there either leaks connections until
Neon refuses new ones, or is thrown away on every request. The `neon` driver
speaks the same Postgres over HTTP/WebSocket and is built for exactly this. The
same database either way.

**Use the pooled connection string.** Neon gives you two; the one with
`-pooler` in the host goes through PgBouncer. Serverless means many short-lived
clients, which is what the pooler is for.

**`AUTH_SECRET` must match the worker's.** It signs sessions. Two independently
generated secrets produce a dashboard that accepts a login and then rejects
every request after it — which reads as a login bug and is not one.

---

## Checking it worked

- Vercel: open the deployment URL. **Your jobs** should load, with whatever is
  currently ranked.
- Render: the worker log should show `Configuration resolved` on boot, then a
  discovery pass within the hour.
- Both: `/api/v1/health` on the Vercel URL reports database connectivity.

If the dashboard loads but shows zeros while Render is discovering, the two are
pointed at different databases — check that both `DATABASE_URL`s name
`naija_jobs` and not `neondb`.
