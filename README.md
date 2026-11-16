# Job Intelligence

**Why scroll job boards when a bot can do it and email you the good ones?**

This thing wakes up while you're asleep, goes out and reads job boards, throws
away everything that isn't you, scores what's left against your actual profile,
and drops the winners in your inbox with a reason attached.

You wake up. You check your email. There are jobs there. That's the product.

It's free. It'll stay free. I'm not selling this, I'm not building a startup on
it, there's no waitlist and there's no "pro tier". I built it because job
hunting is miserable and I'd rather write code than refresh LinkedIn.

If it lands you an interview, **give it a star**. That's the whole ask.

---

## What it actually does

- Pulls jobs from multiple boards on a schedule, no clicking, no tabs
- Bins anything outside your field *before* it hits the database. You're a
  backend dev, you'll never see "IGCSE Teacher — Chemistry"
- Scores every job against your real profile: skills, seniority, salary,
  location, visa, remote policy
- Knows you can't take an on-site role in Munich if you're in Lagos, and won't
  waste your time pretending otherwise
- Emails you a digest with *why* each job matched, not just a percentage
- **Never applies for you.** No auto-submit, no bot messaging recruiters. It
  prepares, you decide. Your name stays yours.

---

## The money

Full transparency, because "free and open source" usually still costs something
somewhere:

| What | Cost |
|---|---|
| Claude + OpenAI API keys | **~$10** total, and that's lasted me a while |
| Neon Postgres | Free tier. Maybe **$5/month** after the trial |
| Everything else | $0 |

So **around $10 to start**, maybe $15 if you keep it running past the first
month. (You most likely would not need to if you set your profile efficiently)

Use it properly — real profile, real preferences, actually apply to what it
sends you, and you should have your next job inside a month. That's genuinely
what I'm hoping happens for you. I'm rooting for you. Go get it.

---

## Getting it running

You need **Node 22+** and **pnpm 10+**. That's it.

### 1. Clone and install

```bash
git clone https://github.com/Bayotics/Fully-automated-Job-Discovery-Platform.git
cd Fully-automated-Job-Discovery-Platform
pnpm install
```

### 2. Set up your environment

```bash
cp .env.example .env
```

Open `.env` and fill in the required bits. The short version:

- `DATABASE_URL` — free Postgres from [neon.tech](https://neon.tech), takes two minutes
- `ANTHROPIC_API_KEY` and `AI_EMBEDDING_API_KEY` — the AI brains
- `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL`, `NOTIFICATION_TO_EMAIL` — the email bit

Leave `NOTIFICATION_DRY_RUN=true` for now. Nothing will send while it's true,
which is what you want until you've seen what it picks.

### 3. Set up the database

```bash
pnpm db:migrate
pnpm db:seed
pnpm bootstrap:search
```

That last one builds your first search profile from your candidate profile so
the system has something to look for on day one.

### 4. Run it

Two terminals:

```bash
pnpm dev:worker    # the engine — finds, scores, emails
```

```bash
pnpm dev:web       # the dashboard — localhost:3000
```

The worker is the one that matters. The dashboard is just so you can watch.

### 5. Fill in your profile

Open **localhost:3000** → **Candidate Profile**. Put in your real skills, real
years, real preferences.

Do not skip this. The seed data is a fake person and the system will score jobs
against that fake person and you'll wonder why the matches are mid.

### 6. Turn on email

Once you're happy with what's showing up in **Matches**, set
`NOTIFICATION_DRY_RUN=false` and restart the worker.

Check **Notification Settings** and set your timezone, unless you enjoy your
morning digest arriving at 3pm.

---

## Making it run without your laptop on

A worker on your laptop stops working when you close your laptop. Rude, but
fair.

Cheapest fix is [Railway](https://railway.app) — about $5/month:

1. Push to GitHub
2. Railway → New Project → Deploy from GitHub repo
3. Start command: `node --import tsx apps/worker/src/index.ts`
4. Paste your `.env`, then change:
   - `NODE_ENV=production`
   - `NOTIFICATION_DRY_RUN=false`
   - add `AUTH_SECRET` and `OPS_PASSWORD` (production insists — generate with
     `openssl rand -base64 32`)

Fly.io or any $5 VPS works too. There's a `Dockerfile` in the repo. Avoid
Vercel for the worker — it has no always-on process, so there's nothing to run.

---

## About the database

I put this on **Neon** because it's Postgres, it's free to start, and it took
two minutes. Nothing more principled than that.

And honestly? **I'm not a big SQL guy.** I use it because it works and because
pgvector makes the semantic search easy, not because I love writing joins.

So if you'd rather rip it out, do it. Genuinely. The database sits behind a
repository layer, so the swap is contained rather than a rewrite:

```
packages/db/src/repositories/*
```

Everything above that layer talks to repositories, not to SQL. Want MongoDB?
DynamoDB? Supabase? Firebase? Rewrite the repositories, leave the rest alone.
The matching engine doesn't know or care where the rows came from.

One thing to know if you go NoSQL: the semantic search uses **pgvector**, so
you'll need a vector store of some kind — Pinecone, Qdrant, Mongo Atlas Vector
Search, whatever. Or drop it and run deterministic matching only. It still
works, just with less magic.

Fork it, break it, make it yours. That's what it's here for.

---

## Handy commands

```bash
pnpm discover      # go find jobs right now
pnpm enrich        # parse and clean what was found
pnpm match         # score everything against your profile
pnpm recommend     # rank them
pnpm notify        # run the email decision (respects dry run)
pnpm probe         # check every source is reachable
pnpm prune:jobs    # delete stored jobs that don't match your profile
pnpm test          # 1,494 tests
```

You shouldn't need these. The worker runs it all on a schedule. They're for
when you're curious or something looks off.

---

## When it goes quiet

**No jobs showing up?** Check the worker terminal. Then **Sources**, some need
credentials and will say so.

**Jobs but no email?** Almost always one of three things: `NOTIFICATION_DRY_RUN`
is still `true`, no email set in Notification Settings, or your match thresholds
are higher than anything you've actually matched. That last one is sneaky. 
check **Matches**, see what your top score really is, and set the threshold
below it.

**Getting jobs you can't take?** Your work authorisation is probably empty.
Set it in your profile and it'll stop showing you on-site roles on other
continents.

---

## Contributing

Yes please. Especially:

- More job sources (`packages/connectors`)
- Better matching
- NoSQL adapters, if you build one
- Non-English job boards, the relevance filter speaks English and German so
  far, and that's a real gap

Fork, branch, PR. `pnpm test` before you push.

---

## The honest bit

This is a personal project I built for myself and then cleaned up enough to
share. It's not enterprise software. There are rough edges. Some job boards
change their HTML and break a connector. Some postings are weird.

But it does the actual job: it finds work while you sleep, and the email that
shows up in the morning is real.

MIT licensed. Free forever. Not commercialising it, ever.

**Now go get that job. 🚀**

⭐ *and star the repo if it helps*
