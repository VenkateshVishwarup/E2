# Mid-Funnel Agent Platform — Design

**Date:** 2026-08-31
**Revised:** 2026-09-02 — reconciled against the 2026-09-02 platform orchestration call
(agent identity, metric definitions, platform seams, conversational rendering)
**Revised:** 2026-09-04 — model provider switched from Anthropic to OpenAI (§7.3, §17 row 20)
**Revised:** 2026-09-04 — per-role model profiles: `dev` (terra) for building, `demo` (sol/luna) for the pitch (§8.2, §17 row 22)
**Status:** Approved for implementation planning
**Author:** Venkatesh Vishwarup (with Claude)

---

## 1. Context

Engati today is an AI-enabled CX SaaS: a no-code bot builder spanning ~14 channels,
with GenAI assistants, CRM/ticketing/payment connectors, and a large services layer
delivered by an FDE (Forward Deployed Engineering) team.

The implementation footprint, as of 2026-08-31, spans roughly 150 repositories across
three workspaces:

| Workspace | Repos | Character |
|---|---:|---|
| `engati platform` | 99 | SaaS core. Carries v1 *and* v2 of portal and bot; four separate auth services; four separate analytics/funnel engines |
| `engati-intelligence` | 38 | NLP layer. Solr plugins, Rasa, Dialogflow smalltalk, Duckling, hand-rolled spellchecker/tokenizer/NER, Chroma — with a newer `gen-ai-*` set bolted alongside |
| `project-prism` | 10 | Current agent stack: orchestrator, router, adapter, telephony, analytics, llama-stack |

`agent-orchestrator-service` alone carries 123 configuration properties spanning Redis,
Vault, Kafka, RabbitMQ and the Meta Graph API. Three generations of the same idea run
side by side.

This document specifies a replacement built from a clean base, and an MVP that
demonstrates it.

---

## 2. Problem Statement

### 2.1 Stated problems

| # | Problem | Root cause |
|---|---|---|
| 1 | Every deployment starts from scratch; an FDE writes a prompt and wires integrations by hand | The unit of authoring is **prose**. Prose has no schema, so it cannot be standardised, validated, diffed, or compared |
| 1a | No standardisation — output quality tracks the individual's prompt-writing skill | As above |
| 1b | No common way to add integrations | Connectors are bound to vendors, not to capabilities |
| 2 | No way to quickly set up a sandbox | No source of realistic traffic that does not involve real humans |
| 3 | No way to A/B test a live bot | You cannot meaningfully diff two prompts, so you cannot attribute a lift to a change |
| 4 | Agent quality is not tracked; no alerting when responses degrade | No ground truth to score against, and no structured record of what the agent did |
| 5 | Accumulated baggage from repeated pivots | ~150 repos, three overlapping generations |
| 6 | Old tooling — Solr, Rasa, Dialogflow, Duckling | Predates the current model era |
| 7 | Cannot show ROI to the customer | The runtime never records **what it did** in a form analytics can fold. Four analytics services compute four versions of the truth, all downstream of a runtime that told them nothing |
| 8 | AI-enabled SaaS, not an AI product | The human does the work and AI assists, rather than the system doing the work under human direction |

### 2.2 Added goals

- **9.** Use captured data to suggest journey improvements to the marketer
- **10.** Make data the defensible moat, and be explicit about how
- **11.** Build an agent for the marketer and the FDE that helps them improve the platform by discussing problems with them

### 2.3 Non-functional intent (product, not MVP)

Newer technology · strong security posture for enterprise clients · straightforward path
to on-premise · easy to scale · small infrastructure footprint · a harness capable of
running many agents.

---

## 3. Product Thesis

> **The only mid-funnel system that can prove what it earned you — and then tell you how to earn more.**

Two claims, in a deliberate order.

**Claim one — the unit of authoring changes.** Today an FDE writes a prompt, so quality
is a function of that person's skill on that day. In this product the FDE declares an
**objective, the evidence the agent must collect, and the constraints it must respect**.
The agent plans the conversation itself.

Standardisation then stops being a style guide nobody follows and becomes structural:
journeys are typed, versioned, diffable artifacts. And crucially, everything downstream
becomes possible for the first time — you cannot diff two prompts, but you can diff two
objective specs, and therefore you can A/B them, evaluate them, and attribute revenue
to them.

**Claim two — the loop is the product.** The agent is the *instrument*. What compounds is
the closed loop: every conversation produces structured evidence, every outcome is
observed and attributed back to campaign, creative and *agent version*, and that record
both proves ROI and drives the next improvement. That loop is the moat, because it
cannot be copied by a competitor without the accumulated data.

**Consequence for build order:** we build **backwards from outcome**. Every upstream
decision — event schema, journey versioning, message identity — exists so the outcome
layer can be truthful. Bolting analytics on at the end is how you arrive at four
analytics services and no answer to "which agent version earned this rupee."

**Consequence for problems 1 and 2:** standardisation and sandboxing are *internal cost*
problems, not customer-value problems. They do not lead the pitch; they are the margin
story beneath it — *we can do this per-account profitably because deployment is
templated*. They are still built, but they serve the commercial claim rather than
competing with it.

---

## 4. The Mid-Funnel, Decomposed

The product owns stages 1–8. Stage 8 feeds back into the customer's top-of-funnel.

| # | Stage | What happens | Why it matters |
|---|---|---|---|
| 1 | **Ingest** | Lead arrives from ToFu — Meta/Google lead ads, landing page, webinar, CRM webhook, offline list. Identity resolution, dedupe, consent capture | The consent scope captured here governs every later channel decision |
| 2 | **Contextualise** | Attach campaign, creative, keyword, geo, page intent, prior history. *Which programme* the ad was about | This is the difference between a generic opener and a relevant one |
| 3 | **Reach** | Speed-to-lead. Channel, timing, opening message, and a retry ladder on no-answer | Response rate decays sharply with time-to-first-touch |
| 4 | **Qualify** | The conversation. Elicit the domain evidence needed to decide | The core loop. Evidence, not vibes |
| 5 | **Decide** | Score and route: hot → human now; warm → nurture; unfit → close politely | Must be auditable. A score with no attributable evidence is not a decision |
| 6 | **Nurture** | Multi-day, trigger-based re-engagement — new batch, slot opened, fee deadline | Most leads live here. Usually where the most value leaks |
| 7 | **Convert & hand off** | Book the counselling call, warm transfer, CRM push, payment link. Then: *did they show up?* | The show-up signal is the one most platforms never instrument |
| 8 | **Learn** | Show-up rate, conversion, revenue attributed to campaign → creative → conversation path → **agent version** | The whole game. ROI proof, improvement suggestions, and the moat all live here |

### 4.1 Edtech instantiation (the MVP vertical)

Edtech was chosen because **the money event is observable**: lead → counselling call →
application → fee paid is a fully digital chain, so revenue can be honestly attributed
without reaching into an offline system of record. The cycle is weeks rather than months,
so a *closed* loop can be demonstrated rather than promised. Lead volume is high enough
that A/B results are statistically meaningful rather than decorative.

Healthcare remains the higher-ticket, more defensible vertical — compliance becomes a moat
rather than a tax — but conversion happens offline when a patient walks into a clinic, so
attribution requires an HIS/appointment-system integration and the show-up signal may not
exist digitally at all. It is deferred, not abandoned; the architecture is vertical-neutral.

---

## 5. Architecture

### 5.1 The event spine

**There is no separate analytics pipeline. Attribution is a fold over the event log.**

This is the single decision every other property depends on. Every fact the system knows
arrives as an immutable event:

```sql
CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID        NOT NULL,
  lead_id         UUID        NOT NULL,
  conversation_id UUID,
  journey         TEXT        NOT NULL,
  journey_version INT         NOT NULL,
  agent_id        TEXT        NOT NULL,   -- the principal the action was taken as
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON events (tenant_id, lead_id, occurred_at);
CREATE INDEX ON events (tenant_id, journey, journey_version, type);
CREATE INDEX ON events (tenant_id, agent_id, occurred_at);
CREATE INDEX ON events USING GIN (payload);
```

**Event types:**

| Type | Payload carries |
|---|---|
| `LeadIngested` | source, campaign_id, creative_id, utm, consent_scope, raw_attributes |
| `MessageSent` | channel, template_id, content_hash, rendered_text, latency_ms |
| `MessageReceived` | channel, raw_text, detected_language, received_at |
| `EvidenceExtracted` | field, value, confidence, source_turn_id, extractor_version |
| `PolicyEvaluated` | rule_id, verdict, severity, triggering_turn_id |
| `ToolInvoked` | capability, binding, args_hash, result_status, latency_ms |
| `AuthorizationDenied` | capability, principal, reason, attempted_at |
| `Scored` | score, contributing_evidence[], scorer_version |
| `Routed` | decision (hot/warm/cold), target, sla_seconds |
| `HandoffCreated` | counsellor_id, accepted_at, first_response_at |
| `NurtureScheduled` | sequence_id, next_touch_at |
| `OutcomeObserved` | outcome (attended/applied/enrolled/paid), amount, currency, observed_at, source |
| `CostObserved` | campaign_id, spend, currency, period |

**Properties this buys, none of which are separately built:**

- **ROI is a `GROUP BY`.** Revenue by campaign, creative, or journey version is one query
  over one table, so it cannot drift from what the runtime actually did
- **Replay is possible.** The full history of a lead is reconstructable
- **Evaluation has ground truth.** `EvidenceExtracted` compared against `OutcomeObserved`
  tells you whether the agent understood correctly, not just whether it sounded fluent
- **The audit trail is free.** Append-only *is* what enterprise compliance asks for
- **A/B is exact.** `journey_version` is on every row

### 5.2 Four layers

Each layer depends only on those beneath it. Everything reads the spine.

```
┌─ INTELLIGENCE ──────────────────────────────────────────┐
│  Attribution Engine · Insight Engine · Copilot           │
├─ CONFIDENCE ────────────────────────────────────────────┤
│  Simulator · Replay Engine · Eval Harness · Allocator    │
├─ EXECUTION ─────────────────────────────────────────────┤
│  Agent Registry · Journey Registry · Agent Runtime       │
│  Evidence Extractor · Tool Broker · Channel Adapters     │
├─ SPINE ─────────────────────────────────────────────────┤
│  Event Store · Import Boundary · Outcome Ingestor        │
└──────────────────────────────────────────────────────────┘
```

### 5.3 Component contracts

| Component | Single responsibility | Interface |
|---|---|---|
| **Event Store** | Append-only truth | `append(event)` · `fold(leadId)` · `query(filter)` |
| **Import Boundary** | Absorb foreign history; scrub PII; resolve identity | `import(source, records) -> leadId[]` |
| **Outcome Ingestor** | Pull the money event from the system of record | `observe(externalId, outcome)` |
| **Agent Registry** | Persona, identity and privilege set an agent runs as | `get(agentId)` · `authorize(principal, capability) -> bool` |
| **Journey Registry** | Store, validate, version and diff specs | `publish(spec)` · `get(j, v)` · `diff(v1, v2)` · `validate(spec)` |
| **Agent Runtime** | Decide the next action given spec + state | `step(spec, state, inbound) -> Action[]` |
| **Evidence Extractor** | Conversation → typed evidence + confidence | `extract(turns, schema) -> Evidence` |
| **Tool Broker** | Typed capability → vendor binding; enforces privilege | `invoke(principal, capability, args) -> Result` |
| **Channel Adapter** | Action → transport | `send(action)` · `receive() -> Inbound` |
| **Simulator** | Personas that behave like real leads | `run(journeyVersion, n, personaMix) -> Conversation[]` |
| **Replay Engine** | Counterfactual lift on historical leads | `replay(leads, vA, vB) -> Lift` |
| **Eval Harness** | Score conversations; emit alerts | `score(conversation) -> Scorecard` |
| **Traffic Allocator** | Bind source → target, with a split | `allocate(source) -> Target` |
| **Attribution Engine** | Fold events into funnel and ROI | `funnel(filter)` · `roi(filter)` |
| **Insight Engine** | Find patterns worth telling a marketer | `insights(scope) -> Finding[]` |
| **Copilot** | Converse over all of it; propose spec diffs; render views | `ask(question) -> Answer + ProposedDiff? + View?` |

### 5.4 Four properties worth protecting

**The Agent Runtime is replaceable.** `step()` is the entire contract. A different runtime —
or the *existing* Engati bot behind an adapter — plugs in without anything above it
noticing. This is what makes incremental migration possible rather than a big-bang rewrite.

**Evidence extraction is separate from the runtime.** These are usually fused, and that is a
mistake: extraction is independently evaluable against ground truth and independently
improvable. Splitting them lets you measure *"did it ask well"* separately from
*"did it understand"* — two different failures with two different fixes.

**The Tool Broker binds capabilities, not vendors.** `crm.upsert_lead` is the contract;
HubSpot versus Salesforce is configuration. This is the entirety of problem 1b, and it is
why on-prem later is a binding swap rather than a fork.

*This also settles the MCP question.* MCP is **a binding type, not an architecture** —
`binding: mcp://vendor/server` sits alongside `binding: hubspot` in the same capability
contract. Whether MCP matures, stalls, or coexists with direct API integrations becomes a
configuration decision rather than a bet the architecture has to take.

**The agent is a principal, and privileges are enforced rather than declared.** An agent
runs *as* an identity with a scoped privilege set; the Tool Broker checks every invocation
against it and emits `AuthorizationDenied` when it fails. Because `agent_id` is on every
event, the log answers *"what did this agent do, and what was it allowed to do"* without a
separate audit system. This is what makes many agents on one platform safe rather than
merely possible.

### 5.5 The Traffic Allocator unifies A/B and migration

One primitive, two stories:

- Target = journey `v3` vs `v4` → **A/B test**
- Target = new platform vs existing Engati bot → **parallel run**

A customer points a separate landing page, or a slice of campaign traffic, at the new
agent and runs both side by side reporting into the same dashboard. Adoption is a
parallel run, never a cutover.

### 5.6 Memory

Two distinct kinds, deliberately separated because they have different owners, retention
rules and privacy exposure.

| | **Lead memory** | **Operator memory** |
|---|---|---|
| Subject | The prospective student | The marketer or FDE |
| Store | The event log — `fold(leadId)` reconstructs everything known | Separate, small, explicitly listed |
| Content | Evidence collected, prior conversations, consent scope, outcomes | Preferred report formats, recurring questions, prior accepted suggestions |
| Retention | Tenant policy; deletion cascades by `lead_id` | Operator-controlled, individually erasable |
| Already built? | **Yes** — it is the spine | **No** — roadmap |

The ownership question — *what is stored, where, and who controls it* — has a structural
answer here rather than a policy one: **everything is in one tenant-scoped append-only log
in one database the customer can host themselves.** There is no second copy, no derived
store that has to be separately deleted, and no analytics warehouse holding a divergent
shadow of the same facts.

---

## 6. The Journey Spec

The core artifact. A journey is a **typed declaration of an outcome**, not a script.

```yaml
journey: mba-admissions-qualification
version: 4
vertical: edtech
owner: fde@engati.com

# ─── Who this journey runs as. Privileges are ENFORCED, not declared. ───
agent:
  persona: admissions_counsellor_v2      # tone and register; from the agent registry
  identity: agent://engati/mba-admissions
  privileges:
    - crm.upsert_lead:leads_owned_by_this_journey
    - calendar.book_slot:counsellor_pool_mba
    - catalog.lookup_program:read
  data_scope:
    read:  [lead.self, catalog.programs]
    deny:  [lead.other_journeys, payment.instruments]

objective:
  goal: book_counselling_call
  qualifies_when: score >= 70 AND evidence.complete(required)

# ─── The contract. THIS is the standardisation. ───
evidence:
  target_program:
    type: enum[executive_mba, full_time_mba, online_mba]
    required: true
    confidence_min: 0.8
    description: Which programme the lead is actually considering
    example: executive_mba
  timeline:
    type: enum[this_intake, next_intake, just_exploring]
    required: true
    confidence_min: 0.7
    example: this_intake
  budget_band:
    type: enum[under_5L, 5L_to_15L, above_15L, needs_financing]
    required: true
    sensitive: true          # never open with it; never ask twice
    example: 5L_to_15L
  decision_maker:
    type: enum[self, parent, employer]
    required: false
    example: employer
  prior_qualification:
    type: string
    maxLength: 120
    required: false
    example: B.Tech, 4 years work experience

policy:
  never:
    - quote_exact_fees
    - promise_admission
    - compare_to_competitors
  must_disclose: ai_agent_on_first_contact
  escalate_when:
    - asks_for_human
    - sentiment < -0.5
    - evidence.budget_band == needs_financing
  max_turns: 14
  quiet_hours: { start: "21:00", end: "09:00", tz: Asia/Kolkata }

# ─── Determinism exactly where it matters ───
pinned:
  opening: templates/wa_mba_optin_v4
  disclosure: "Hi {{name}}, I'm an AI assistant from {{institute}}."
  handoff: templates/wa_counsellor_intro_v2

scoring:
  weights:
    timeline.this_intake: 30
    budget_band.above_15L: 25
    budget_band.5L_to_15L: 20
    decision_maker.self: 15
    target_program.*: 10

routing:
  hot:  { when: "score >= 70", target: "handoff.counsellor", sla: 5m }
  warm: { when: "score >= 40", target: "nurture.mba_warm_14d" }
  cold: { when: "otherwise",   target: "nurture.mba_longtail_90d" }

tools:
  - capability: crm.upsert_lead
    binding: hubspot
  - capability: calendar.book_slot
    binding: calendly
  - capability: catalog.lookup_program
    binding: internal

# ─── Named metrics as predicates over events. No global "converted". ───
metrics:
  qualified_lead: "Routed.decision == hot"
  booked:         "HandoffCreated exists"
  conversion:     "OutcomeObserved.outcome in [enrolled, paid]"
  revenue:        "sum(OutcomeObserved.amount where outcome == paid)"
```

### 6.1 Why this shape

| Property | Mechanism |
|---|---|
| **Standardisation** | The evidence schema is a contract. Two FDEs produce comparable journeys because the artifact is typed, not prose |
| **Versioning** | The spec is a file. `version` is on every event |
| **Diffing** | `git diff v3 v4` is a characterisable change — *"added `decision_maker` to required"* — so a measured lift can be attributed to it |
| **Evaluability** | Did it collect the required evidence? Was the evidence correct against the observed outcome? Did it violate `policy.never`? All mechanical |
| **Safety** | `pinned` and `policy` are enforced by the runtime, not suggested to the model |
| **Portability** | YAML. No language leaks into the durable artifact |

### 6.2 The schema is the API contract

`evidence:` compiles directly to JSON Schema and is passed as `output_config.format`, so
conformance is **guaranteed by the API** rather than hoped for and post-validated. This is
the technical reason Approach B works and a prompt-based approach cannot: prose has no
schema to enforce.

### 6.3 Agent and journey — reconciling two decompositions

The platform discussion defines an agent as **persona · skills · goals · identity and
privileges**. This spec is journey-centric. Both are right about different things, and they
reconcile without either giving anything up:

> **An agent is a persona + identity + privilege set. A journey is a goal assigned to an
> agent.**

| Platform element | Where it lives here |
|---|---|
| Persona | `agent.persona` — reference into the agent registry |
| Identity and privileges | `agent.identity`, `agent.privileges`, `agent.data_scope` |
| Skills | `tools` (capabilities) + `evidence` (what it must establish) |
| Goals | `objective` |

**The journey stays the versioning unit**, and that is deliberate: the thing you A/B, diff
and attribute revenue to must be the journey. You cannot cleanly A/B "an agent," because an
agent pursuing two different goals is two different experiments. One agent may run many
journeys; a journey always names the agent it runs as.

For the MVP the `agent:` block is inline. Once a shared agent registry exists, it becomes a
reference — no change to the journey format, and no migration.

### 6.4 Why metrics are declared, not assumed

*"Converted"* means different things to marketing, sales and support, and a platform that
picks one definition globally will be wrong for most of its users.

The event log deliberately contains **no `Converted` event** — only observable facts
(`attended`, `applied`, `enrolled`, `paid`). `metrics:` then defines named metrics as
**predicates over those facts**, so each tenant, and each team within a tenant, can hold its
own definition without anyone editing the data.

The principle, stated once so it is not eroded later:

> **Record observable facts. Let each consumer define its own predicate.**

Two consequences worth having: metric definitions are versioned alongside the journey, so a
changed definition cannot silently rewrite history; and the Copilot can answer *"what do you
mean by converted?"* with the actual predicate rather than a guess.

---

## 7. Technology

### 7.1 Stack

| Layer | Choice |
|---|---|
| Runtime | **Node 22 LTS + TypeScript** |
| HTTP | **Fastify** (JSON-Schema-native route validation) |
| Schema | **Zod** (`zod/v4` dialect) — journey spec → Zod → JSON Schema → `text.format` |
| Datastore | **PostgreSQL**, single instance. Event log, registry, outcomes, scorecards. `pgvector` if the Insight Engine needs semantic search |
| Model | **OpenAI GPT-5.6** via `openai` (Responses API) |
| Console | **React + Vite** |
| Deliberately absent | Kafka · RabbitMQ · Redis · vector DB · Solr · queue |

**Two build artifacts: one backend image and one static bundle. One database.**
Against roughly 150 repositories running Kafka *and* RabbitMQ *and* Redis *and* Vault
*and* Solr *and* Chroma. This contrast is the demonstration for problems 5 and 6 and for
the small-footprint goal.

### 7.2 Why TypeScript — recorded so it is not relitigated

The workload was assessed first. **There is no CPU-bound work anywhere in this system.**
The runtime is I/O-bound (every step waits on a 0.5–5s model call); aggregation happens
in Postgres; replay is rate-limited by the model API, not by the runtime. So raw
compute throughput — the usual reason to choose Go or the JVM — is close to irrelevant.

Two criteria decided it.

**The decisive one: this product's central abstraction is a runtime-loaded, user-authored
schema.** The journey spec is YAML, authored by a human, loaded at runtime, compiled to
JSON Schema, and used to drive extraction, validation, scoring, evaluation and diffing.

- **Go is weak at this.** Runtime-known schemas mean `map[string]any` throughout, which
  forfeits exactly the static typing Go is chosen for
- **Java is weaker still** — records plus Jackson plus hand-built schema, and reflection-heavy
- **TypeScript is exceptional at it.** Zod schemas are *values*: composable at runtime,
  natively serialisable to JSON Schema, first-class in the provider SDK (`zodTextFormat`)

**The second: a React console ships regardless**, so "one language everywhere" was never
available — it is TypeScript plus *something* in every scenario. Choosing TypeScript for
the backend makes journey-spec types, event types and scorecard types a **single definition**
shared by runtime, batch workers, API and console. In any other language that is a
hand-maintained duplicate across the wire, and it drifts.

**Go is the honest runner-up.** The condition under which to switch, stated explicitly:
*if the evidence schema were fixed and compiled in rather than user-authored at runtime.*
Then Go's static typing costs nothing and its ~20MB static binary wins. But a fixed schema
means abandoning the declarative approach — so choosing Go is choosing a different product.

**On Python:** rejected. The scale concern raised against it would not in fact have bitten
(the GIL barely touches an I/O-bound workload), but a Java-heavy organisation watching a
Python demo and asking *"will this scale?"* deserves a simple answer, and the honest one is
nuanced. That is a hole in a pitch, and pitch holes cost more than build days.

**If Java were ever revisited:** Quarkus *only* with GraalVM native compilation
(~50MB binary, ~30MB RSS, sub-100ms startup — roughly 10× better than a Spring Boot fat jar
on a JVM). The catch is specific to this product: GraalVM native fights reflection, and the
dynamic-schema work is reflection-heavy, which erodes the reason to choose Quarkus at all.
In JVM mode Quarkus's advantage evaporates and Spring Boot's ecosystem wins.
**Quarkus if native, Spring Boot if JVM. "Quarkus on the JVM" is never the right answer.**

### 7.3 Where the API shape and the product design coincide

Not planned — the declarative approach turns out to be what the API is built for.

1. **The evidence schema is a JSON Schema.** It compiles into `text: {format: zodTextFormat(...)}`
   and the API guarantees conformance; `responses.parse()` validates it into `output_parsed`
2. **The journey spec is the cache prefix.** Spec, policy and tool definitions are
   byte-identical across every conversation in a run; only turns differ. They go in
   `instructions`, the transcript goes in `input`, and `prompt_cache_key` is set per
   journey version. **See the caveat below** — this is weaker than it was
3. **Replay and simulation are textbook Batch API workloads** — neither is latency-sensitive,
   and batch runs at **50% cost**
4. **Effort is a per-component dial** — `reasoning: {effort: ...}`, from `minimal` to `max`

**Caveat on caching, recorded because it weakened.** Under the previous Anthropic design an
explicit `cache_control` breakpoint was placed exactly where the spec ended, which made the
prefix hit a *guarantee*. OpenAI caches automatically on prefix match; `prompt_cache_key`
only steers requests toward the same cache. The ordering discipline therefore carries the
entire burden, and cache hit rate is now something to **measure** (`usage.cached_tokens`)
rather than something to assert. Mitigating factor: cached input on `gpt-5.6-sol` is
**$0.40/1M against $4.00 uncached**, a 10× discount, so the ordering is worth protecting.

---

## 8. Model Selection

Two principles, both load-bearing:

> **The judge must never be weaker than the judged.** An eval run by a lesser model measures
> the judge, not the agent.
>
> **The replay agent must be identical in model and effort to the production runtime.**
> Otherwise the counterfactual estimates a different system and the lift figure is invalid.

| Component | Model | Effort | Reasoning |
|---|---|---|---|
Models are resolved per role from `MODEL_PROFILE`, not hardcoded (`modelFor(role)`
in `provider.ts`).

| Role | `dev` (default) | `demo` | Effort | Reasoning |
|---|---|---|---|---|
| Agent Runtime | `terra` | **`sol`** | `high` | This is the product. Quality here is what an audience judges |
| Evidence Extractor | `terra` | `terra` | `low` | Schema-constrained, so low effort suffices — but extraction errors corrupt the event log and every downstream ROI number, so never `luna` |
| Replay Engine | *inherits runtime* | *inherits runtime* | `high` | Must match the runtime exactly or the counterfactual estimates a different system |
| Eval / judge | `terra` | **`sol`** | `high` | Judge ≥ judged, enforced by `judgeWeakerThanJudged()` at startup |
| Insight Engine | `terra` | `sol` | `high` | Reasoning quality is the output |
| Copilot | `terra` | `sol` | `xhigh` | Marketer-facing reasoning; proposes spec diffs |
| Persona Simulator | `terra` | **`luna`** | `low` | The volume driver — a third of all simulation calls. Personas need *plausibility*, not brilliance |

**Why `dev` is uniform.** An A/B comparison is internally consistent at any
tier, because both arms run the same model. Building and debugging at `terra`
costs roughly 40% of `sol` and changes nothing about whether v4 beats v5.

Prices per 1M tokens (input / cached input / output): `gpt-5.6-sol` **$4 / $0.40 / $20** ·
`gpt-5.6-terra` **$2 / $0.20 / $12** · `gpt-5.6-luna` **$0.20 / $0.02 / $1.20** ·
`gpt-6-astra` **$10 / $1.00 / $50**. Astra is the stronger flagship and is deliberately not
the default: the judge only has to be at least as strong as the judged, and if both are
`sol` that holds at 2.5× less cost.

**Pricing reference (per 1M tokens, as of 2026-08-31):** Opus 5 — $5 in / $25 out ·
Sonnet 5 — $2 / $10 · Haiku 4.5 — $1 / $5.

### 8.1 Cost levers — structural, not compromises

- **Batch API for replay and simulation — 50% off.** Neither is latency-sensitive; both run
  as overnight jobs
- **Prompt caching on the journey-spec prefix.** Most of the input cost across a run
- **Reasoning effort is the real lever, not caching.** Measured on the reference journey:
  one extraction call costs ~$0.0003 in cached input against ~$0.007 in output. Output is
  ~25× the input, so turning prefix caching off entirely raises a 500-persona run by only
  **10%**. Halving `reasoning.effort` roughly halves the bill. Cache ordering is still worth
  keeping — it is just not where the money is
- **Measured costs** (batch, 500 personas): `sol` ~$32 · `terra` ~$19 · `luna` ~$1.90.
  A 10,000-lead replay: `sol` ~$38 · `terra` ~$23. The `demo` profile mix lands a
  500-persona run around $8–12. **Reasoning-token volume is assumed, not measured** —
  the band is ±2× until a real run reports `usage`
- **Next lever if simulation volume dominates:** `gpt-5.6-luna` for personas, at $0.20/$1.20
  — a 10× cut on the volume driver. Noted rather
  than pre-applied, to avoid degrading persona realism before it is a measured problem

### 8.2 Budget note

A full 10,000-lead replay is a real expense — roughly ten turns each across two journey
versions, so on the order of 100k+ model calls. Batching halves it and caching cuts the
input side hard, but it remains material.

**Practice: develop against a 1,000-lead sample; run the full 10k once as a batch job before
the meeting. Budget for two or three full runs, not twenty.**

### 8.3 API notes

Model ids and API shapes drift faster than a spec does. Read the current reference — or the
installed SDK's own type definitions, which is what was actually done here — before writing
client code, rather than working from recall.

Verified against `openai` **7.10.0** on 2026-09-04:
`client.responses.parse(...)` returns the validated object on **`output_parsed`**;
the schema goes in **`text: { format: zodTextFormat(schema, name) }`** (helper from
`openai/helpers/zod`, which requires the **`zod/v4`** dialect); reasoning depth is
**`reasoning: { effort }`** with `none | minimal | low | medium | high | xhigh | max`;
the generation ceiling is **`max_output_tokens`**; the stable prefix goes in
**`instructions`** with **`prompt_cache_key`** as a routing hint; free text comes back on
**`response.output_text`**. There is no adaptive-thinking switch — `effort` is the only dial.

---

## 9. Deployment Shape

### 9.1 One codebase, one image, three runtime roles

Not a microservice fleet, and not a monolith that cannot be scaled apart.

| Role | Runs | Scaling profile |
|---|---|---|
| `web` | Console API, channel webhooks, copilot | Request-driven; scale on traffic |
| `runtime` | Live conversation stepping | Long-lived, thousands concurrent; scale on active leads |
| `batch` | Replay, simulation, eval, attribution folds | Bursty and heavy; scale on demand, zero at rest |

Same artifact, different entrypoint. `ROLE=all` for the MVP and small on-prem deployments;
`ROLE=runtime` × N when a customer has volume.

**Why this works:** components integrate through the **event store**, never through calls to
each other. Nothing performs a synchronous hop to a sibling. So splitting processes is a
deployment flag, not a refactor, because there is no in-process call graph to unpick.

**The mistake being avoided:** `agent-orchestrator-service` → `agent-router-service` →
`agent-adapter-service` → `intelli-conversation-service` is a synchronous chain across four
deployables. Every hop is a failure mode, a version skew, and a place where analytics
diverges from truth. This design gets the same separation of concerns from module boundaries
and pays for it once.

### 9.2 Layout

```
packages/
  core/        journey spec · event schema · types      ← shared by everything
  runtime/     agent runtime · extractor · tool broker
  batch/       simulator · replay · eval · attribution
  web/         Fastify API · webhooks · copilot
  console/     React app
```

### 9.3 When to genuinely split later

Conditions named now, so nothing is split on instinct:

- **Channel adapters** → extract once there are 3+ channels with materially different SLAs
  and BSP-specific dependencies
- **Tool Broker** → extract when a customer contractually requires egress isolation

That is the complete list. Everything else stays in the modulith permanently.

### 9.4 Platform seams

The wider platform discussion identified shared foundational layers — tenant management,
partner management, IAM/RBAC, channel layer, branding and console rendering, products and
subscriptions — and explicitly recorded that **shared-infrastructure versus product-separation
is unresolved**.

This spec does not resolve it, and should not. Instead these are treated as **ports**: each
can be provided by us or consumed from shared infrastructure, with **no change above the
seam**. That is what makes the unresolved debate survivable rather than blocking.

| Seam | Port | MVP provides | Platform would provide |
|---|---|---|---|
| **Identity / RBAC** | `AgentRegistry.authorize(principal, capability)` | Inline privilege list in the spec | Central IAM, unified-but-flexible roles |
| **Tenancy** | `tenant_id` on every row + row-level security | Single tenant, column present | Tenant management service |
| **Channel** | `ChannelAdapter.send / receive` | Simulated + web chat | Shared channel layer (WhatsApp, Instagram, Meta/Google Ads) |
| **Billing** | `metrics:` + `OutcomeObserved` | Metric definitions only | Products, subscriptions, usage- and outcome-based billing |
| **Rendering** | Console reads Attribution; Copilot returns `View` | Fixed screens + copilot views | Embedded UI or meta-business agent surface |

**RBAC is the one to watch.** The discussion noted that role structures differ per product
and need to be unified but flexible. Our privilege model is capability-scoped rather than
role-scoped (`crm.upsert_lead:leads_owned_by_this_journey`), which composes into a role
system without assuming one. If a central IAM arrives, `authorize()` delegates to it; if it
does not, the inline list keeps working.

---

## 10. Security, Multi-Tenancy and On-Premise

Not in the MVP. The architecture must not preclude them, and several fall out for free.

| Concern | Mechanism |
|---|---|
| **PII** | Scrubbed at the **Import Boundary**, before anything is persisted, so the event log is never dirty |
| **Audit** | The event log is append-only. This *is* the audit trail enterprises ask for — a consequence of the spine, not a feature |
| **Egress control** | The **Tool Broker** is the only egress point, so data residency and consent enforcement have exactly one place to live |
| **Consent** | `consent_scope` is captured on `LeadIngested` and enforced at the Channel Adapter. A channel the lead did not consent to is unreachable by construction |
| **Tenancy** | `tenant_id` on every event row; row-level security in Postgres. Not MVP, but the column exists from day one so no migration is needed |
| **On-premise** | The runtime talks to one model client. Bedrock, Vertex, Foundry or a self-hosted model are constructor changes. Combined with one Postgres and no queue, the on-prem story is credible rather than aspirational |
| **Secrets** | Tool bindings hold credential references, never values. Vault or equivalent at the Broker boundary |

---

## 11. The Full Product: Nine Subsystems

The complete vision. The MVP is carved out of this in §12; the remainder is the roadmap.

| # | Subsystem | Owns | Solves |
|---|---|---|---|
| 1 | **Authoring** | Journey spec format, registry, versioning, diff, validation, template library per vertical | 1, 1a, 8 |
| 2 | **Runtime** | Agent stepping, evidence extraction, policy enforcement, scoring, routing | 8 |
| 3 | **Integrations** | Tool Broker, capability catalogue, vendor bindings (incl. MCP), credential management, **privilege enforcement** | 1b |
| 4 | **Environments** | Sandbox, simulator, persona library, seeded tenants, promotion between environments | 2 |
| 5 | **Experimentation** | Traffic Allocator, A/B assignment, statistical significance, rollout and rollback | 3 |
| 6 | **Quality** | Eval harness, scorecards, drift detection, alerting, adversarial suites | 4 |
| 7 | **ROI & Attribution** | Cost ingestion, funnel folds, revenue attribution, ToFu feedback | 7 |
| 8 | **Intelligence** | Insight Engine, suggestion generation, cohort analysis, benchmark corpus | 9, 10 |
| 9 | **Copilot** | Marketer agent and FDE agent over the whole system; proposes spec diffs | 11 |

### 11.1 How the moat compounds (subsystem 8)

Stated explicitly, because "data is the moat" is otherwise a slogan.

Each conversation contributes a tuple of **(journey version, evidence collected,
conversational path, observed outcome)**. Three things accumulate from that, and none can be
replicated without the data:

1. **Within a tenant** — which evidence fields actually predict enrolment for *this*
   institute, which openers work for *this* programme, which cohorts behave differently
2. **Across tenants in a vertical** — benchmark distributions. *"Your `timeline` collection
   rate is 41%; the edtech median is 68%."* No competitor can say this without a comparable
   corpus
3. **Across verticals** — which journey *structures* transfer. This is what makes a new
   deployment start from a strong template instead of a blank prompt, which closes the loop
   back to problem 1

### 11.2 Insight Engine finding types

Concrete, so this is buildable rather than aspirational:

| Finding | Shape |
|---|---|
| **Evidence bottleneck** | Field *X* has the lowest collection rate; conversations missing it convert *Y*% worse |
| **Segment divergence** | Cohort *A* converts materially differently on the same journey version |
| **Drop-off point** | Turn *N* is where abandonment concentrates |
| **Routing miscalibration** | Leads routed `cold` that later converted anyway — the score is wrong |
| **Timing** | Response rate by hour, day, and time-to-first-touch |
| **Policy friction** | Conversations where a policy rule fired and the lead then disengaged |
| **Version regression** | Version *v* underperforms *v−1* on a specific segment |

### 11.3 What the spine unlocks commercially: outcome-based pricing

A consequence rather than a feature, and a significant one given that the objection this
product must answer is commercial.

**If revenue is attributable to a journey version, the product can be priced on outcomes.**
`metrics:` already defines what an outcome *is* per tenant; `OutcomeObserved` already records
when one happened; the attribution fold already ties it to a campaign, a creative and an
agent version. Usage- and outcome-based billing is therefore a *read* over infrastructure
that exists for other reasons — not a billing system to be built.

This changes the shape of the commercial answer:

> Not *"will customers pay more?"* but *"customers don't have to pay more — they can pay
> per enrolment."*

A platform that cannot attribute revenue to a specific agent version cannot offer this, and
cannot verify it if a customer demands it. It is a pricing model the architecture earns.

---

## 12. MVP Scope

### 12.1 Framing

The MVP is a **leadership pitch with a real spine**. The objection it must kill is
commercial — *"can we sell it, will customers pay more?"* — so depth concentrates in
stages 7–8 and in the replay engine.

**Nothing is mocked.** Every screen reads from the real event stream. A screen fed by
hand-authored JSON dies in the Q&A.

### 12.2 The scope insight that makes it small

**Most demo moments need no live WhatsApp integration at all.** Replay runs offline against
real transcripts. Simulation runs against synthetic personas. Both drive the *real* runtime,
and neither requires Meta approval, a BSP contract, or template review — weeks of calendar
time spent on plumbing nobody watches.

So: **build the runtime for real, drive it from replay and simulation, and put a
WhatsApp-faithful chat surface on top for the live moment.**

Precisely what that is and is not, because it will be asked: the agent, evidence extraction,
scoring, routing, policy enforcement, eval and data are all **real**. Only the *transport* is
simulated — and because the channel layer is abstract, the runtime cannot tell the
difference. The WhatsApp adapter is then a thin, well-understood addition. That is a straight
answer, not a dodge.

### 12.3 Build classification

| | Component | MVP treatment |
|---|---|---|
| **Real** | Event Store, Import Boundary, Journey Registry, Agent Runtime, Evidence Extractor, Simulator, Replay Engine, Eval Harness, Copilot | Fully built |
| **Real but narrow** | Agent Registry, Outcome Ingestor, Tool Broker, Attribution Engine, Insight Engine, Traffic Allocator | Inline agent identity with enforced privileges; one binding, one fold, fixed finding set, simulated cohorts |
| **Plan only** | WhatsApp/voice adapters, multi-tenancy, on-prem packaging, security model, integration marketplace | Documented, not built |

---

## 13. Counterfactual Replay — Methodology

The centrepiece of the demo, and the most technically attackable claim in it. It is
specified rigorously here so it survives scrutiny.

### 13.1 The claim

> *"These are your last 10,000 leads. Your current journey qualified 18% and enrolled 340.
> Through the new journey the model estimates 24% qualified and ~410 enrolled — ₹X more
> revenue on the same ad spend. Here are the 60 conversations where the two diverged,
> and why."*

This answers *"will customers pay more?"* **using the customer's own data, before they buy
anything.** It is also a genuine sales instrument afterwards, not only a demo device.

### 13.2 Procedure

1. **Import** historical leads with transcripts and observed outcomes through the Import
   Boundary. PII scrubbed; identity resolved
2. **Seed a persona** per historical lead from that lead's *known attributes and observed
   behaviour* — not from imagination. The persona is constrained to what the real lead
   actually revealed
3. **Re-run** the conversation against the candidate journey version, using the identical
   model and effort as production
4. **Compare** on three axes: evidence collected, routing decision, and predicted outcome
5. **Predict the outcome** with a model fitted on the historical mapping
   (evidence + route → outcome), then applied to the counterfactual evidence
6. **Report** the lift with a confidence interval, and list the divergent conversations

### 13.3 Stated limitations

Presenting these strengthens the claim rather than weakening it, and pre-empts the hostile
version of the question.

- **Divergence compounds.** The persona simulates the real lead; the further a counterfactual
  conversation drifts from the original, the weaker the grounding. *Mitigation:* report
  short-horizon divergence separately from long-horizon, and cap turns
- **Outcome prediction is a model, not an observation.** The 410 figure is an estimate;
  the 340 is a fact. **The UI must distinguish observed from modelled numbers visually.**
  Blurring the two is fatal to a commercial pitch if noticed
- **Selection effects.** Historical leads were reached by the old journey's channel and
  timing choices. A new journey that would have reached *different* leads cannot be
  evaluated this way
- **Confidence intervals are reported, always.** A point estimate with no interval invites
  exactly the challenge it cannot survive

---

## 14. Demo Script

Sequenced as the pitch itself. Each moment is the acceptance criterion for the components
beneath it.

| # | Moment | On screen | Kills |
|---|---|---|---|
| 1 | **The money shot** | Replay 10k real leads → current vs new journey → projected lift with CI → drill into the 60 divergent conversations | *"Will customers pay more?"* |
| 2 | **Declare, don't prompt** | Open the spec. Change `decision_maker` from optional to required. Save. That is the entire edit | 1, 1a |
| 3 | **Sandbox in 60 seconds** | Press *Simulate*. 500 personas run the new version. Evidence-collection rates, outcome distribution, policy violations — before one real lead | 2 |
| 4 | **Break it on purpose** | Ship a deliberately bad version. The eval harness catches the policy violation and the evidence-collection drop. Alert fires | 4 |
| 5 | **A/B scoreboard** | v3 vs v4 over a split cohort, qualification and booking rates side by side | 3 |
| 6 | **ROI, closed loop** | Cost per qualified lead and per enrolment, attributed campaign → creative → **journey version** | 7 |
| 7 | **The copilot** | *"Why is my Bangalore cohort converting worse?"* → queries real data → **renders the cohort chart inline** → *"`needs_financing` is 3× higher there and your journey routes those cold. Add a scholarship branch?"* → proposes the spec diff | 9, 11 |
| 8 | **No big bang** | The same dashboard pointed at a parallel-run cohort. Adoption is a separate landing page, never a cutover | 5, *"why rebuild?"* |

Moment 1 is the pitch. Moments 2–7 are why it compounds. Moment 8 is why it is safe.

**A/B (moment 5) runs in simulation**, not on live traffic — same scoreboard, same
mechanism, no BSP contract. The Traffic Allocator that later powers parallel-run is the same
component pointed at simulated cohorts.

**Moment 7 takes a position in the console debate.** The wider discussion questioned whether
fixed console interfaces survive at all, against conversational real-time rendering. The
demo keeps fixed screens — a ROI dashboard answered conversationally looks evasive — but the
Copilot returning a rendered `View` demonstrates the conversational-rendering thesis *inside*
the architecture rather than arguing about it. Both surfaces read the same event store, so
this is a presentation choice rather than a bet.

---

## 15. Milestones

Approximately 11–12 working days. **Every milestone ends showable** — if the meeting moves up,
there is always a coherent artifact.

### M1 — The money shot (~5 days)

**Builds:** Event Store · Import Boundary with PII scrub · **Agent Registry with enforced
privileges** · Journey Registry with validation and diff · Agent Runtime (`step`) · Evidence
Extractor · Tool Broker with `authorize()` · Replay Engine · replay comparison screen

**Unlocks:** moments 1 and 2
**Done when:** a real historical cohort replays through two journey versions and produces a
lift figure with a confidence interval, with observed and modelled values visually distinct —
and every event carries `agent_id`, with an unprivileged capability call denied and logged

**Why identity lands in M1 rather than later:** retrofitting a principal after the event
schema is in use is a migration, not an edit. `agent_id` has to be on the first event ever
written.

### M2 — Confidence (~3 days)

**Builds:** Simulator with persona library · Eval Harness and scorecards · alerting
thresholds · Traffic Allocator over simulated cohorts · simulate, scorecard, A/B and
parallel-run screens

**Unlocks:** moments 3, 4, 5 and 8
**Done when:** 500 personas run a journey version end to end, a deliberately broken version
is caught automatically, two versions can be compared side by side, and the same scoreboard
can be pointed at a parallel-run cohort (moment 8 is the Allocator with a different target,
not additional machinery)

### M3 — The loop (~4 days)

**Builds:** Attribution Engine folds over declared `metrics:` · ROI screen · Insight Engine
with the fixed finding set · Copilot over event store and registry, able to propose spec
diffs **and return rendered views**

**Unlocks:** moments 6 and 7
**Done when:** ROI is attributable to journey version through tenant-declared metric
predicates, and the copilot answers a cohort question from real data, renders it, and
proposes a valid spec diff

---

## 16. Workstreams for a Team

The layering makes these parallelisable once `core/` lands. Interfaces are the contracts in
§5.3; each stream can be developed against them independently.

| Stream | Owns | Depends on | Parallel after |
|---|---|---|---|
| **A — Spine** | Event store, import, PII scrub, outcome ingestion | — | Day 0 |
| **B — Authoring** | Spec format, journey + agent registries, validation, diff, console editor | `core/` types | Day 1 |
| **C — Runtime** | Agent stepping, extraction, policy, scoring, routing, Tool Broker privilege checks | `core/`, Spine, Agent Registry `authorize()` | Day 1 |
| **D — Confidence** | Simulator, replay, eval, allocator | Runtime interface | Day 2 (against a stub `step`) |
| **E — Intelligence** | Attribution, insights, copilot | Spine, event schema | Day 2 (against seeded events) |
| **F — Console** | React app, all screens | `core/` types | Day 1 |

**The critical path is A → C.** Streams D, E and F can begin against stubs and seeded data
because the interfaces are defined before the implementations, which is the concrete payoff
of specifying contracts up front.

---

## 17. Decision Log

Every significant decision with its reasoning, recorded so none of it is relitigated in
month three.

| # | Decision | Reasoning | Alternatives rejected |
|---|---|---|---|
| 1 | Leadership pitch with a real spine | Breadth of surface over one real vertical; nothing mocked | Design-partner pilot; engineering reference implementation |
| 2 | Target the **commercial** objection | *"Can we sell it?"* is the pushback expected in the room, so depth goes to stages 7–8 | *"Why rebuild?"*; *"is the AI good enough?"*; *"what does it cost?"* |
| 3 | **Edtech** first | The money event is digitally observable end to end; cycle short enough to demo a closed loop; volume makes A/B meaningful | Healthcare — higher ticket and more defensible, but conversion happens offline so attribution needs an HIS integration |
| 4 | **WhatsApp deep, voice thin** | Abstract channel layer; cross-channel pursuit story without two production runtimes | WhatsApp-only (nothing looks new); voice-first (would consume the whole budget) |
| 5 | **Approach B** — declarative outcome contracts | Standardisation, diffing, A/B and eval are all *structurally* impossible with prose | A: modern flow builder with LLM nodes — AI-enabled SaaS with new paint. C alone: measurement layer only — a feature, not a product |
| 6 | Steal C's **pluggable runtime** | `step()` as the sole contract means the existing bot can be wrapped. Migration story without a big-bang rewrite | Full rebuild with no migration path |
| 7 | **Event spine**, attribution as a fold | The only way *"which agent version earned this rupee"* is answerable. A schema decision, not infrastructure — one table | Separate analytics pipeline — how four divergent analytics services happened |
| 8 | Split **extraction** from **runtime** | Independently evaluable and improvable. *"Did it ask well"* and *"did it understand"* are different failures with different fixes | Fusing them, as is conventional |
| 9 | **TypeScript** | The central abstraction is a runtime-loaded user-authored schema; Zod is exceptional at it and Go/Java are not. A React console ships regardless, so shared types are free | Go (weak on dynamic schema); Java (weakest, slowest to build); Python (scale objection is a hole in the pitch even though technically it would not bite) |
| 10 | **Modulith**, three roles | Components integrate through the event store, so splitting is a deployment flag. Avoids repeating the four-deployable synchronous chain | Microservices from day one; an unsplittable monolith |
| 11 | **Opus 5**, Sonnet 5 for personas | Judge ≥ judged; replay must match production exactly. Personas are the volume driver and need plausibility, not brilliance | Cheaper models throughout — would invalidate eval and replay |
| 12 | **Simulator is a product component**, not a demo prop | One component serves sandbox, A/B pre-test, eval corpus and demo data | Building demo data by hand |
| 13 | Adoption is **parallel run**, not cutover | Customer points a separate landing page at the new agent; both report into one dashboard. Same primitive as A/B | Migration-first — riskier and harder to sell |
| 14 | Simulated transport, real everything else | Replay and simulation need no BSP contract; weeks of calendar time saved on plumbing nobody watches | Full WhatsApp integration in the MVP |
| 15 | **Agent is a principal**; privileges enforced at the Tool Broker | Closes a real security gap for an enterprise product, and reconciles the platform's agent anatomy. Cheap now; a schema migration later | Leaving `tools:` unauthorised, as originally specified |
| 16 | **Journey stays the versioning unit**, agent is referenced | You cannot cleanly A/B "an agent" — one agent pursuing two goals is two experiments | Agent-centric decomposition, as framed in the platform call |
| 17 | **Metrics are declared predicates**; no global `Converted` event | *"Converted"* means different things per team; a global definition is wrong for most users. Record facts, let consumers define predicates | A canonical conversion definition in the platform |
| 18 | **Platform layers treated as ports**, not decided | Shared-vs-separate is explicitly unresolved upstream; ports make that survivable instead of blocking | Picking a side and rebuilding when the platform decides differently |
| 19 | Eval harness **is** the data-quality validator | Validating against observed outcomes is ground truth; a second LLM with no ground truth measures correlation, not correctness | The proposed secondary-LLM validator pattern |
| 20 | **OpenAI `gpt-5.6-sol`** as the model provider | Owner's decision (2026-09-04). Slightly cheaper than the Anthropic tier it replaces ($4/$20 vs $5/$25) with a 10× cached-input discount. The `step()` and `extract()` contracts did not change, so the swap touched one module — the first real test of the replaceable-runtime property in §5.4 | Anthropic Claude, as originally specified |
| 22 | **`dev` profile (terra) for all building, debugging and A/B; `demo` (sol + luna) only for the pitch** | Owner's decision (2026-09-04). A comparison is internally consistent at any tier, so iterating at 40% of the cost changes no conclusion. Upgrading only the agent and the judge puts spend where an audience actually looks | One model everywhere, chosen once |
| 21 | Accept weaker cache **guarantees** for automatic caching | No explicit breakpoint exists on the Responses API. Prefix ordering now carries the whole burden, and hit rate becomes a measured number rather than an asserted one. Judged an acceptable trade for the price difference — but it is a real loss, recorded in §7.3 | Keeping explicit `cache_control` breakpoints (would have meant staying on Anthropic) |

---

## 18. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Historical data does not arrive, or arrives without outcomes** | **Critical** — moment 1 depends on it | Import Boundary treats calibration as a swappable input. Fall back to simulator-only, and lead with the architecture of the loop rather than results |
| Replay lift is challenged as unrigorous | High | §13.3 limitations stated openly; confidence intervals always; observed and modelled values visually distinct |
| Persona realism is circular — the simulator flatters the agent | High | Personas calibrated against real transcript shapes, never invented. Report simulated and replayed results separately |
| Cost of full replay runs | Medium | Batch API (50%), spec-prefix caching, 1k sample during development, 2–3 full runs total |
| Prefix cache does not hit as assumed | Medium | Caching is automatic and unguaranteed (§7.3). Measure `usage.cached_tokens` on the first real run rather than assuming the discount; if it misses, the prompt ordering is the thing to fix |
| The 11–12 day estimate slips | Medium | Milestones are independently showable; M1 alone kills the commercial objection |
| "Simulated transport" reads as faking it | Medium | Answer prepared and rehearsed: everything except transport is real, and the channel layer is abstract by design |
| Declarative authoring is unfamiliar to FDEs | Medium (post-MVP) | The copilot is partly how that adoption cost is paid down |
| Scope creep into the nine subsystems | Medium | §12.3 classification is the contract. Anything outside it goes in the roadmap |
| **Moat conflicts with "the customer owns the intelligence"** | **High (strategic)** | Cross-tenant benchmarking (§11.1) needs data held *across* customers; on-prem and customer-owned intelligence fragment exactly that corpus. Mitigation: federated aggregates rather than raw data, opt-in benchmark participation, differential privacy on shared statistics. **Unresolved — raise it before someone else does** |
| Shared platform layers arrive with different contracts than our ports assume | Medium | §9.4 seams are narrow and behavioural (`authorize`, `send`, `receive`), so adaptation is an adapter rather than a redesign |

---

## 19. Open Questions

1. **Which edtech account** supplies the historical transcripts and outcomes, and what is the
   legal path to exporting them?
2. **What is the observable money event** for that specific account — enrolment, fee payment,
   or counselling-call attendance? This determines the Outcome Ingestor's binding
3. **Does a campaign-spend source exist** for cost-per-outcome, or is spend entered manually
   for the MVP?
4. **Migration remains an open pointer.** Large-customer historical data migration is expected
   later; the Import Boundary is designed for it, but the scope is not settled
5. **Which CRM binding** does the demo account use — HubSpot, Salesforce, Zoho?
6. **Which foundational layers are shared platform infrastructure** versus product-specific?
   §9.4 makes this non-blocking, but the answer determines how much of identity, tenancy,
   channel and billing we ever build ourselves
7. **How is cross-tenant benchmarking reconciled with customer-owned intelligence?**
   The moat argument depends on it and the platform position currently contradicts it
   (see §18)

---

## 20. Explicitly Out of Scope for the MVP

Live WhatsApp and voice adapters · multi-tenancy enforcement · on-prem packaging ·
the full security model · integration marketplace · healthcare vertical · nurture sequence
execution over real calendar time · human counsellor handoff UI.

All are specified in §11 as roadmap, and none is precluded by the MVP architecture.
