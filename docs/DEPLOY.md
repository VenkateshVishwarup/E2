# Deploying E2 to Vercel

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

## 1. Database — done

The Neon project `noisy-shadow-61254066` is linked, and `neon link` wrote the **pooled**
connection string into `.env` (the host ends `-pooler`; the unpooled one exhausts its
connection limit as soon as a couple of function instances are warm).

It has been migrated and seeded:

```
19,932 events · 2,000 leads · versions 3,4,5 · live v5
```

To redo either:

```bash
npm run db:migrate:remote
npm run roi
```

Both read `DATABASE_URL` from `.env`, which now points at Neon — so **local runs and the
deployment share one database**. That is deliberate: what you see locally is what is
deployed. Tests are unaffected; they use `TEST_DATABASE_URL`, still the local Docker
Postgres.

## 2. Environment variables

Set these in Vercel, for Production:

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | the **pooled** Neon string | required |
| `API_TOKEN` | a long random string | the gate, on Hobby |
| `MAX_COHORT` | `60` | Hobby kills a function at 60s; a 200-persona run does not fit |
| `OPENAI_API_KEY` | **leave unset** | see below |
| `MODEL_PROFILE` | `dev` | `terra` everywhere. `demo` only when presenting |
| `TENANT_ID` | `t1` | matches the seeded data |
| `REPORTING_CURRENCY` | `INR` | |

**`OPENAI_API_KEY` is deliberately not set on Vercel.** Production is open on Hobby, and a
public URL holding a live key is spendable by anyone who finds it. Without it the
deployment runs on the deterministic extractor and the offline copilot: every number stays
real — they are folds over the event log, not model output — and it cannot cost anything.
What is lost is conversation quality, and every screen that uses the fallback says so.

**To turn the model on for a demo**, when you are watching it:

```bash
vercel env add OPENAI_API_KEY production   # paste the key
vercel --prod                              # redeploy so the function picks it up
```

and afterwards:

```bash
vercel env rm OPENAI_API_KEY production
vercel --prod
```

`MAX_COHORT` is the one people forget. Without it, Simulate offers 200 personas, the
function is killed at 60 seconds, and the run dies half-written — events already in the
log, no summary returned. The console reads the limit from `/api/limits` and sizes runs to
fit, so setting it correctly is the whole fix.

## 3. Deploy

```bash
npx vercel link      # once, to venkatesh-vishwarup-s-projects
npx vercel --prod
```

Same origin, so the console's relative `fetch("/api/…")` calls work with no CORS and no
configuration.

### Three details in `vercel.json` that are not obvious

**The function is `api/[...path].ts`, a catch-all.** Vercel's filesystem routing maps
`api/index.ts` to `/api` only, so `/api/journeys/x/roi` would 404. Rewriting `/api/(.*)`
to `/api` runs the function but hands Fastify the literal path `/api`, so *every* route
404s — with the function running, which reads as a bug in the app rather than in the
deployment. The catch-all reaches the function with the URL intact.

**The `functions` key is `api/**/*.ts`, not the filename.** Those keys are globs, and
`[...path]` reads as a character class — the config would silently not apply and the
function would run on the default timeout rather than 60 seconds.

**`/health` is rewritten to `/api/health`,** and Fastify serves both. A host that routes
everything under `/api` to one function cannot reach a path outside that prefix.

### Verifying the build before pushing

```bash
npm run build -w @midfunnel/console                     # what Vercel runs
npx esbuild 'api/[...path].ts' --bundle --platform=node --target=node22 --format=esm --outfile=/dev/null
```

The second is the one worth running: it is how the platform bundles the function, and it
is where a TypeScript workspace import that cannot be resolved shows up. `.vercelignore`
excludes `scripts/`, so **nothing in the build may depend on it** — the first deploy failed
because the build regenerated `okf-content.ts` from a script that is not shipped. That file
is committed instead, and a test catches drift.

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
