# Mid-Funnel Agent Platform

An AI agent platform for mid-funnel lead qualification and nurturing, built so that every
number it shows can be traced back to an event that actually happened.

The whole system rests on one idea: **there is a single append-only `events` table, and
everything else is a fold over it.** Replay, the A/B scoreboard, the ROI report and the
copilot all read the same log through the same predicates, so they cannot disagree with
one another. There is no separate analytics pipeline to fall out of sync.

A second idea explains a lot of the design: the log records **observable facts only**.
There is deliberately no `Converted` event, because "converted" means different things to
marketing, to sales and to finance. Each tenant declares its own named metrics as
predicates over the facts, so the platform never has to pick a definition on their behalf.

---

## Run it

Requires Node 22+ and Docker.

```bash
npm install
npm run db:up          # Postgres 16 on :5433
npm run db:migrate
```

Three commands seed three different stories. Each is self-contained and each ends showable.

```bash
npm run seed           # M1 — import a cohort, replay v3 against v4, print the lift
npm run simulate       # M2 — 500 personas, scorecards, alerts, an A/B scoreboard
npm run roi            # M3 — attribute ROI, derive findings, ask the copilot
```

Each removes only the data it owns and leaves everything else alone, so **a conversation
you have in the console survives a reseed**. They are alternatives rather than a sequence:
`npm run roi` is the one to run before a demo, because it publishes v3, v4 and v5 and
leaves every tab with something to show.

Then bring up the console:

```bash
npm start -w @midfunnel/web        # API on :3000
npm run dev -w @midfunnel/console  # console on :5173
```

**No API key is needed.** Without one the platform substitutes a deterministic keyword
extractor and an offline copilot, and says so on every screen that shows their output. The
data is real either way; the reasoning is not. Concretely, with no key:

- Replay, A/B, ROI and the copilot's *numbers* are unaffected — they are folds over the
  event log, not model output
- The Simulate tab collects around 51% of evidence rather than the ~86% a real extractor
  manages, so its quality figures are a floor, not a forecast
- The copilot routes keywords to the same tools instead of reasoning, and stamps the answer
  `offline`

Add `OPENAI_API_KEY` to `.env` for the real thing. `.env` is searched for from the working
directory upward and **overrides** the ambient environment, because a GUI app handing a
process a stale credential it never asked for is an expensive hour to lose. Leave the value
empty rather than writing a placeholder — a placeholder that looks like a key is detected
and refused, but an unrecognised one would just produce a confident 401.

---

## Try it in two minutes

1. **Journey tab** — the spec loads. Change something, press *Bump version*, press
   *Publish*. Checks run as you type; warnings never block you.
2. **Chat tab** — the version you just published is already serving. Talk to it. Watch the
   evidence contract on the right fill in as you answer, then score and route.
3. **ROI tab** — your conversation is in there, counted, with its token cost.

That loop is the product: author a contract, deploy it by publishing it, talk to it, and
see what it cost against what it earned.

---

## The demo, in eight moments

| # | Moment | Where | Kills the objection |
|---|---|---|---|
| 0 | **Author and deploy** — edit the YAML, publish, and the next conversation is served by it. Publishing *is* deployment | Journey tab | Every deployment starts from scratch |
| 1 | **The money shot** — replay a real cohort through two versions, lift with a confidence interval, drill into the divergent conversations | Replay tab | *"Will customers pay more?"* |
| 2 | **Declare, don't prompt** — change `decision_maker` from optional to required. That is the entire edit | `journeys/*.yaml`, diff endpoint | Every deployment starts from scratch |
| 3 | **Sandbox in 60 seconds** — 500 personas against a new version before one real lead sees it | Simulate tab | No way to set up a sandbox |
| 3b | **Live A/B** — start a chat with a split and the allocator assigns deterministically; a new version takes real traffic without touching the old one | Chat tab | Cannot A/B a live bot |
| 4 | **Break it on purpose** — ship a bad version; the eval harness catches the policy breach and the alert fires | Simulate tab | No quality tracking |
| 5 | **A/B scoreboard** — two versions over one paired cohort | A/B tab | No A/B on a live bot |
| 6 | **ROI, closed loop** — cost per qualified lead and per enrolment, attributed campaign → creative → journey version | ROI tab | Cannot show ROI |
| 7 | **The copilot** — *"Why is my needs_financing cohort converting worse?"* → real data → a chart → a proposed spec diff | Copilot tab | AI-enabled SaaS, not an AI product |
| 8 | **No big bang** — the same scoreboard pointed at a parallel-run cohort | A/B tab | Adoption risk |

Moment 1 is the pitch. Moments 2–7 are why it compounds. Moment 8 is why it is safe.

**On the Simulate tab, v4 reports 0% qualified. That is the product working.** The static
check above the button says why before you press it: v4's *required* evidence tops out at
65 against a threshold of 70, so it can never qualify anyone. v5 makes `decision_maker`
required and qualifies 4.5%, which is what the A/B tab then measures. A journey that cannot
do what it claims is caught by reading the spec, not by waiting for a bad quarter.

---

## What it does not do yet

Named in the product itself, on a **Roadmap** section, rather than left to be discovered.
Each entry says what is already in place, because the distinction that matters is between a
missing screen and a missing foundation — and almost all of these are the former.

| | |
|---|---|
| **Next** | WhatsApp and voice channels · more than one journey · real CRM and calendar bindings |
| **Planned** | Alert delivery · parallel run against an incumbent · multi-tenancy |
| **Later** | Cross-customer benchmarks · on-premise packaging · an agent registry screen |

Inline too, where you would reach for the thing: the channel selector in Chat lists WhatsApp
and voice as coming; the masthead says one journey today; the editor says the `tools:`
privileges are enforced but the bindings behind them are mocks.

---

## What makes the numbers defensible

These are the details that survive a hostile question, and they are the reason to prefer
this over a prompt-and-dashboard approach.

- **Observed and modelled are never mixed.** Replay reports historical conversion rates as
  fact and projected conversions as an estimate, in separate fields, rendered in different
  colours. Media spend is allocated and labelled as such; model spend is metered from real
  token usage.
- **Every comparison carries a 95% confidence interval**, and a finding whose interval
  spans zero is not shown at all. A point estimate with no interval invites exactly the
  challenge it cannot survive.
- **Replay is paired; cohort comparisons are not.** Both arms of a replay are the same
  leads through two versions, so the interval preserves the pairing. Comparing one cohort
  against the rest is two disjoint groups of different sizes, where pairing would be
  meaningless. Two different bootstraps, used deliberately.
- **Insights say what they could not run.** A detector that silently returns nothing reads
  as a clean bill of health, which is the opposite of the truth when the reason is that no
  policy event exists yet.
- **Metric definitions are versioned with the journey.** Attribution evaluates each lead
  under the definitions *it ran under*, so editing `conversion:` cannot silently rewrite
  last quarter.
- **Simulation is invisible to production.** Every simulated event is `sim`-scoped with a
  `runId`, enforced in the query builder rather than by remembering to pass a flag.
- **The agent is a principal.** Every event carries an `agent_id`, and tool privileges are
  enforced at the broker, not merely declared. An unprivileged call is denied and logged.
- **A live conversation writes exactly the events a simulated one writes.** One shared
  translation, used by both, differing only in `env` and `runId`. Two copies would have
  meant live traffic and sim traffic quietly measuring different things.
- **Nothing a person sees is improvised.** The opening disclosure is pinned and rendered
  from declared variables, never generated, and a placeholder with no value is caught by
  the linter rather than reaching a lead as raw braces.

---

## The journey spec

A journey is a typed YAML contract, not a prompt. This is what makes lift attributable to
a named change, and what makes a fleet of deployments standardisable.

```yaml
journey: mba-admissions-qualification
version: 4

agent:
  privileges:                       # enforced at the Tool Broker, not just declared
    - crm.upsert_lead:leads_owned_by_this_journey

objective:
  qualifies_when: score >= 70 AND evidence.complete(required)

evidence:                           # this block IS a JSON Schema
  budget_band:
    type: enum[under_5L, 5L_to_15L, above_15L, needs_financing]
    required: true
    sensitive: true                 # never open with it; never ask twice

routing:                            # first match wins; `otherwise` must be last
  hot:  { when: "score >= 70", target: "handoff.counsellor", sla: 5m }
  cold: { when: "otherwise",   target: "nurture.mba_longtail_90d" }

metrics:                            # named predicates over events, per tenant
  conversion: "OutcomeObserved.outcome in [enrolled, paid]"
  revenue:    "sum(OutcomeObserved.amount where outcome == paid)"
```

`npm test` includes a linter that catches journeys which cannot do what they claim — a
qualifying threshold the required evidence can never reach, a booking metric in a journey
that never hands off, a metric with a typo'd event type.

---

## API

The full surface is specified in [`docs/api/openapi.yaml`](docs/api/openapi.yaml) and
served live at `/api/openapi.json`. A test asserts that every route the server registers
appears in the document and vice versa, so the two cannot drift apart.

Authentication is off by default and enabled by setting `API_TOKEN`. The guard is real
code on a real hook either way, so enabling it is a variable rather than a project.

---

## Layout

One deployable artifact, five packages, started by role (`ROLE=web|runtime|batch|all`).

| Package | Owns |
|---|---|
| `core` | Event store, journey registry, spec format, metric predicates, bootstrap statistics |
| `runtime` | `step()`, evidence extraction, scoring, routing, tool broker, model profiles, cost metering |
| `batch` | Import, replay, simulation, eval harness, traffic allocator |
| `intelligence` | Attribution, insight engine, copilot |
| `web` + `console` | Fastify API, the live chat loop, and the React console |

Full design, decision log and roadmap:
[`docs/superpowers/specs/2026-08-31-midfunnel-agent-platform-design.md`](docs/superpowers/specs/2026-08-31-midfunnel-agent-platform-design.md).

---

## Cost

`terra` is the default for all building, debugging and A/B work — a comparison is
internally consistent at any tier, because both arms run the same model. `MODEL_PROFILE=demo`
upgrades the two roles an audience actually judges.

```bash
npm run simulate         # terra everywhere
npm run simulate:demo    # sol for the agent and judge, luna for personas
```

Reasoning effort, not prompt caching, is the cost lever: on a real call output runs roughly
25× input, so disabling caching entirely costs about 10%.

---

## Tests

```bash
npm test          # 363 tests
npm run typecheck
```

Postgres must be running; the suite uses a separate `midfunnel_test` database.
