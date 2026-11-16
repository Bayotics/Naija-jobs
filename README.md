# Naija Jobs

**Why refresh Jobberman at 2am when a bot can do it and have the good ones
waiting for you, ranked?**

This thing works the Nigerian job boards while you sleep. It reads the
listings, throws out everything that isn't your field, scores what's left
against your real profile, and puts the good ones at the top of your dashboard
with a reason attached.

You wake up. You open the dashboard. The best jobs are already at the top.
That's the product.

**No email.** Not "email off by default" — there is no email in this system at
all. No provider, no key, no address, nothing to configure and nothing that
can land in your inbox at 3am. The ranked list *is* the delivery.

It's free. It stays free. I'm not selling this, there's no waitlist, there's no
"pro tier". I built it because job hunting in Nigeria is a full-time job on its
own, and I'd rather write code than refresh six tabs.

If it lands you an interview, **give it a star**. That's the whole ask.

---

## What it looks for

Seven fields, and nothing outside them:

- Administration / Secretarial / PA / Clerical / Office Assistant
- Advertising / Branding / PR
- Customer Service / Call Centre / Front Desk / Receptionist
- Graduate Trainee / Fresh Graduate / Graduate Internship
- Marketing / Sales / Business Development / Merchandiser / Financial Adviser
- Research / Survey / Data Entry
- Remote / Freelance / Work-from-home

**Nigeria only.** Remote, hybrid, on-site — all fine, as long as it's here. No
more "exciting opportunity in Munich" for someone sitting in Lagos.

Salary isn't a gate. A job without a stated salary still reaches you, because
half of them don't state one and you'd rather see it than not.

---

## What it actually does

- Checks the boards **every hour**, no tabs, no clicking
- Bins anything outside your fields *before* it touches the database — you're
  applying for admin roles, you'll never see "Senior DevOps Engineer"
- Scores each job on your real profile: titles, experience, location, work
  arrangement
- Flags the scams. "Pay ₦5,000 registration fee" is not a job offer, and it
  knows that
- Shows you *why* each one ranks where it does, not just a percentage
- **Never applies for you.** No auto-submit, no bot messaging recruiters. It
  prepares, you decide. Your name stays yours

---

## Where the jobs come from

**Jobberman** is the backbone — six category feeds, one per field, each on its
own schedule so a broken one doesn't take the rest down. Every listing carries
proper structured data: company, location, salary, date posted.

**MyJobMag** runs alongside it for coverage Jobberman misses.

**Indeed is in the code, switched off, with the reason written down.** It
answers any honest crawler with a 403. Getting in would mean pretending to be
Chrome or renting residential proxies, and this project doesn't do that. It's
registered so the gap is visible instead of looking like something I forgot.

**Hot Nigerian Jobs** is off too, for a duller reason: it timed out on every
single run in testing. It's there, ready, waiting for someone to work out why
it's so slow.

Adding a source is a connector and a seed row. PRs very welcome.

---

## The money

Full transparency, because "free and open source" usually still costs
something somewhere:

| What | Cost |
|---|---|
| Claude + OpenAI API keys | **~$10** total, and that lasts a good while |
| Neon Postgres | Free tier. Maybe **$5/month** after the trial |
| Render worker (optional) | **$7/month** — only if you want it running without your laptop on |
| Vercel dashboard | Free tier |
| Everything else | $0 |

So **about $10 to try it on your own machine**, around $12/month if you deploy
it properly and leave it running.

Use it properly — real profile, real preferences, actually apply to what it
sends you — and you should have something inside a month. That's genuinely
what I'm hoping happens for you. I'm rooting for you. Go and get it.

---

## Getting it running

You need **Node 22+** and **pnpm 10+**. That's it.

### 1. Clone and install

```bash
git clone https://github.com/Bayotics/Naija-jobs.git
cd Naija-jobs
pnpm install
```

### 2. Set up your environment

```bash
cp .env.example .env
```

Open `.env` and fill in:

- `DATABASE_URL` — free Postgres from [neon.tech](https://neon.tech), two minutes
- `ANTHROPIC_API_KEY` and `AI_EMBEDDING_API_KEY` — the brains

That's the lot. There is no email configuration because there is no email.

### 3. Set up the database

```bash
pnpm db:migrate && pnpm db:seed && pnpm bootstrap:search
```

Migration takes a couple of minutes against Neon. It hasn't hung, it's building
indexes.

That last command turns your profile into a search profile, so the system knows
what to look for on day one.

### 4. Run it

Two terminals:

```bash
pnpm dev:worker
```

```bash
pnpm dev:web
```

The worker is the one that matters. The dashboard, at **localhost:3000**, is so
you can watch it work.

### 5. Fill in your profile

**localhost:3000 → Candidate Profile.** Your real experience, your real
preferences, the fields you actually want.

Don't skip this. The seed data is a made-up person and the system will happily
find jobs for *them*.

### 6. Let it run

That's it. The worker checks the boards hourly and keeps the dashboard sorted.
Open **Recommendations** whenever you feel like looking; nothing will chase
you.

---

## Making it run without your laptop on

A worker on your laptop stops working when you shut your laptop. Rude, but
fair. And it's the whole point: jobs get posted while you're asleep.

It goes out in two halves, because the two halves are different animals:

- **The worker → [Render](https://render.com).** A process that never stops,
  crawling on a schedule. ~$7/month, and it's the bit worth paying for.
- **The dashboard → [Vercel](https://vercel.com).** A normal web app that's
  idle most of the day. Free tier is plenty.

Both read the same Neon database. `render.yaml` and `vercel.json` are in the
repo, so each platform is a few clicks.

**Full walkthrough, including the three settings that will bite you:
[DEPLOYING.md](DEPLOYING.md).**

Short version of those three: use `DATABASE_DRIVER=neon` on Vercel (`pg` leaks
connections from serverless functions), use Neon's **pooled** connection
string, and give Vercel the *same* `AUTH_SECRET` Render generated — mismatched
secrets look exactly like a login bug and aren't one.

Any $5 VPS works for the worker too; there's a `Dockerfile`. What won't work is
the worker on Vercel: no always-on process, nothing to run.

---

## About the database

I put this on **Neon** because it's Postgres, it's free to start, and it took
two minutes. Nothing more principled than that.

And honestly? **I'm not a big SQL guy.** I use it because it works and because
pgvector makes the semantic search easy, not because I enjoy writing joins.

So if you'd rather rip it out, do it. Genuinely. The database sits behind a
repository layer, so it's a contained swap and not a rewrite:

```
packages/db/src/repositories/*
```

Everything above that layer talks to repositories, not to SQL. MongoDB?
DynamoDB? Supabase? Firebase? Rewrite the repositories and leave the rest
alone. The matching engine neither knows nor cares where the rows came from.

One catch if you go NoSQL: the semantic search uses **pgvector**, so you'll
want a vector store of some kind — Pinecone, Qdrant, Mongo Atlas Vector Search,
whatever. Or drop it and run deterministic matching only. Still works, just
with less magic.

Fork it, break it, make it yours. That's what it's here for.

---

## Handy commands

```bash
pnpm discover      # go and find jobs right now
pnpm match         # score everything against your profile
pnpm recommend     # rank them
pnpm probe         # check every source is still reachable
pnpm prune:jobs    # delete stored jobs that don't match your profile
pnpm test          # 1,494 tests
```

You shouldn't need these — the worker does all of it on a schedule. They're for
when you're curious, or when something looks off.

---

## When it goes quiet

**No jobs?** Check the worker terminal, then **Sources** in the dashboard.
Anything restricted says so, with the reason.

**Jobs but nothing in Recommendations?** Your match threshold is probably
higher than anything you've actually matched. Look at **Matches**, see what
your top score really is, and set the threshold below it.

**Getting jobs you can't take?** Check your location settings. Nigeria should
be the only country listed.

---

## Contributing

Yes please. Especially:

- More Nigerian sources (`packages/connectors`) — Jooble, Careerjet, the
  smaller boards
- Better matching for non-technical roles
- NoSQL adapters, if you build one

Fork, branch, PR. `pnpm test` before you push.

---

## The honest bit

This is a personal project I built and then cleaned up enough to share. It's
not enterprise software. Job boards change their HTML and break connectors.
Some postings are strange. Some recruiters are stranger.

But it does the actual job: it works the boards while you sleep, and the list
waiting for you in the morning is real.

MIT licensed. Free forever. Not commercialising it, ever.

**Now go and get that job. 🚀**

⭐ *and star the repo if it helps*
