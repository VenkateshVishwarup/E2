# Deploying Elevate to Vercel

The console is a static bundle; the API is one serverless function wrapping the same
Fastify app that runs locally. Nothing is forked for production — `api/index.ts` builds the
identical `ServerDeps` that `npm start` does.

---

## Before anything: one correction

You chose **Hobby** and **Vercel password protection**. Those do not go together —
**Password Protection is a Pro feature**. On Hobby you get *Vercel Authentication*, which
gates preview deployments behind a Vercel account login but leaves **production open**.

So on Hobby the real gate is `API_TOKEN`, which is now built in: any 401 puts the whole
console behind a token prompt, and the token is stored in that browser only. It is a gate
against strangers finding the URL, not a security model — the token reaches the browser, so
anyone you give it to has it for good.

**If this URL will be public and holds your OpenAI key, do one of:**

| | |
|---|---|
| Upgrade to Pro | Turn on Password Protection. Strongest, and the API token stays as a second layer |
| Stay on Hobby | Set `API_TOKEN` to something long and random, and treat the URL as semi-public |
| Stay on Hobby, spend nothing | Leave `OPENAI_API_KEY` unset. Everything still runs on the deterministic extractor and offline copilot, every number stays real, and the deployment cannot cost you anything |

The third option is a genuinely good demo. The only thing it loses is conversation quality,
and every screen says so.

---

## 1. Database

Create a Neon project and take the **pooled** connection string — the host ends in
`-pooler`. The unpooled one will exhaust its connection limit as soon as more than a couple
of function instances are warm.

```
postgres://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
```

Migrate it, and seed it if you want the demo cohort:

```bash
DATABASE_URL="postgres://…-pooler…?sslmode=require" npm run db:migrate:remote
DATABASE_URL="postgres://…-pooler…?sslmode=require" npm run roi
```

`npm run roi` writes ~20,000 events and publishes v3, v4 and v5. It is well inside Neon's
free tier.

## 2. Environment variables

Set these in Vercel, for Production:

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | the **pooled** Neon string | required |
| `API_TOKEN` | a long random string | the gate, on Hobby |
| `MAX_COHORT` | `60` | Hobby kills a function at 60s; a 200-persona run does not fit |
| `OPENAI_API_KEY` | your key, **or leave unset** | unset ⇒ the deployment cannot spend |
| `MODEL_PROFILE` | `dev` | `terra` everywhere. `demo` only when presenting |
| `TENANT_ID` | `t1` | matches the seeded data |
| `REPORTING_CURRENCY` | `INR` | |

`MAX_COHORT` is the one people forget. Without it, Simulate offers 200 personas, the
function is killed at 60 seconds, and the run dies half-written — events already in the
log, no summary returned. The console reads the limit from `/api/limits` and sizes runs to
fit, so setting it correctly is the whole fix.

## 3. Deploy

```bash
npx vercel --prod
```

`vercel.json` already routes `/api/*` and `/health` to the function and everything else to
the console bundle. Same origin, so the console's relative `fetch("/api/…")` calls work
with no CORS and no configuration.

---

## What behaves differently in production

**Replay and Simulate are bounded by the function timeout, not by cost.** Locally a
200-lead replay takes 19s and a 200-persona simulation about 40s. On Hobby's 60s ceiling,
replay at 200 is comfortable and simulation is not — hence `MAX_COHORT=60`. On Pro, raise
`maxDuration` in `vercel.json` to 300 and `MAX_COHORT` back to 2000.

**Cold starts add three to five seconds** to the first request after idle, because the pool
and the Fastify instance are built once per warm container. Subsequent requests reuse both.

**Nothing writes on a schedule.** There is no cron, no queue and no background worker: every
event is written by a request. That is why one function and one database is the entire
production topology.

---

## What this deployment is not

It is a demo of a working product, not a production deployment of one. Specifically:

- **One tenant.** `TENANT_ID` is fixed per process. Every row already carries a tenant id
  and no read path is unscoped, so this is a request-resolution gap rather than a data one
- **One journey.** The console is pinned to `mba-admissions-qualification`
- **Mock tool bindings.** Privileges are enforced — an unprivileged call is denied and
  logged — but nothing reaches a real CRM or calendar
- **No alert delivery.** Thresholds fire and appear on screen; nothing is sent anywhere

All four are named in the product's own Roadmap section, so a visitor finds them there
rather than by being surprised.
