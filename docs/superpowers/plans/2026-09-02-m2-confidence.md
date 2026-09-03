# M2 — Confidence: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive synthetic leads through a journey before it ever touches a real one, score every conversation automatically, alert when quality drops, and compare two journey versions side by side.

**Architecture:** The simulator writes **real events** into the same spine as live traffic, isolated by an `env` column and grouped by `run_id`. That isolation is what lets the eval harness, the alerting rules and the A/B scoreboard be plain folds over the log rather than three parallel systems. Personas carry **ground truth**, so extraction correctness is measurable rather than merely plausible.

**Tech Stack:** Node 22 · TypeScript 5.6 (ESM) · Fastify 5 · Zod 3 (`zod/v4` dialect at the SDK boundary) · `@anthropic-ai/sdk` 0.123 · PostgreSQL 16 · Vitest · React 18 + Vite 5

**Spec:** `docs/superpowers/specs/2026-08-31-midfunnel-agent-platform-design.md` (§15 M2, §5.3, §11)
**Predecessor:** `docs/superpowers/plans/2026-09-02-m1-money-shot.md` — shipped, 102 tests green

## Global Constraints

Everything in M1's Global Constraints still applies. In addition:

- **Never read a journey spec from the `spec` JSONB column.** Postgres JSONB re-sorts object keys, which reorders `routing` and silently misroutes leads. `JourneyRegistry.get()` parses `yaml_source`; any new reader must do the same. This was a real M1 bug — see commit `0ed5fd6`.
- **Simulated events are never visible to a live-scoped read.** `EventStore` is constructed with an env; there is no cross-env query path.
- **The judge must never be weaker than the judged.** Eval uses `claude-opus-5` at `effort: "high"`. Personas use `claude-sonnet-5` at `effort: "low"` — the one justified downgrade, because personas need plausibility, not brilliance.
- **Simulation and eval go through the Batch API** where volume justifies it — both are overnight-class work and batch is 50% cost.
- **Ground truth lives on the persona, never in the transcript.** Extraction correctness is scored by comparing extracted evidence against `persona.truth`; if the runtime could see `truth`, the metric would be meaningless.
- `npm run typecheck` must pass alongside `npm test` for every task. M1 shipped a bug that all tests passed and only `tsc` caught.

---

## File Structure

```
packages/core/
  src/db/migrations/003_run_isolation.sql   env + run_id on events
  src/events/store.ts                       MODIFY: env scope, run filter
  src/events/types.ts                       MODIFY: env/runId on EventInput

packages/runtime/
  src/sentiment.ts                          SentimentAnalyzer (lexicon + model)
  src/scoring.ts                            MODIFY: sentiment in PredicateContext
  src/step.ts                               MODIFY: sentiment-aware escalation

packages/batch/
  src/simulate/persona.ts                   Persona type, generator, ground truth
  src/simulate/replier.ts                   Persona -> reply (model + stub)
  src/simulate/runner.ts                    SimulationRunner
  src/eval/scorecard.ts                     Deterministic checks
  src/eval/judge.ts                         LLM judge (opus-5, high effort)
  src/eval/alerts.ts                        Threshold rules -> Alert[]
  src/experiment/allocator.ts               TrafficAllocator
  src/experiment/compare.ts                 Two runs -> Scoreboard

packages/web/
  src/routes/simulate.ts                    POST /api/simulate, GET /api/runs/:id
  src/routes/experiment.ts                  GET /api/compare

packages/console/
  src/SimulateRun.tsx                       Moment 3 + 4
  src/Scoreboard.tsx                        Moment 5
```

---

## Task 1: Run isolation — `env` and `run_id` on the spine

**Files:**
- Create: `packages/core/src/db/migrations/003_run_isolation.sql`
- Modify: `packages/core/src/events/types.ts`, `packages/core/src/events/store.ts`
- Test: `packages/core/test/store.test.ts` (append)

**Interfaces:**
- Consumes: `EventStore`, `EventInput`, `EventFilter` (M1 Task 2)
- Produces:
  - `type Env = "live" | "sim"`
  - `EventInput` gains optional `runId?: string`
  - `EventFilter` gains `runId?: string`
  - `StoredEvent` gains `env: Env; runId: string | null`
  - `new EventStore(pool, tenantId, env: Env = "live")` — third arg; **every existing call site keeps working unchanged**

**Why this is the load-bearing decision of M2:** simulation writes real events. Without a hard isolation boundary, a simulated cohort silently contaminates the ROI numbers M1 exists to produce. Making `env` a column rather than a payload field means the isolation is enforced by the query builder, not by remembering to filter.

- [ ] **Step 1: Write the migration**

`packages/core/src/db/migrations/003_run_isolation.sql`:
```sql
-- Simulated conversations are real events in the same log, isolated by env.
-- DEFAULT 'live' means every row written before this migration stays live.
ALTER TABLE events ADD COLUMN env    TEXT NOT NULL DEFAULT 'live';
ALTER TABLE events ADD COLUMN run_id TEXT;

ALTER TABLE events ADD CONSTRAINT events_env_check CHECK (env IN ('live', 'sim'));

-- A live row must never carry a run_id; a sim row must always have one.
ALTER TABLE events ADD CONSTRAINT events_run_id_check
  CHECK ((env = 'live' AND run_id IS NULL) OR (env = 'sim' AND run_id IS NOT NULL));

CREATE INDEX events_env_idx ON events (tenant_id, env, occurred_at);
CREATE INDEX events_run_idx ON events (tenant_id, run_id) WHERE run_id IS NOT NULL;
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/core/test/store.test.ts`:
```typescript
describe("EventStore env isolation", () => {
  it("defaults to the live environment", async () => {
    const e = await store.append({ ...base, leadId: "L1", type: "LeadIngested", payload: {} });
    expect(e.env).toBe("live");
    expect(e.runId).toBeNull();
  });

  it("hides simulated events from a live-scoped store", async () => {
    const sim = new EventStore(pool, "t1", "sim");
    await sim.append({ ...base, leadId: "S1", runId: "run_1", type: "LeadIngested", payload: {} });

    expect(await store.query({ leadId: "S1" })).toEqual([]);
    expect(await sim.query({ leadId: "S1" })).toHaveLength(1);
  });

  it("hides live events from a sim-scoped store", async () => {
    await store.append({ ...base, leadId: "L1", type: "LeadIngested", payload: {} });
    const sim = new EventStore(pool, "t1", "sim");
    expect(await sim.query({ leadId: "L1" })).toEqual([]);
  });

  it("refuses a simulated event with no run id", async () => {
    const sim = new EventStore(pool, "t1", "sim");
    await expect(sim.append({ ...base, leadId: "S1", type: "LeadIngested", payload: {} }))
      .rejects.toThrow(/runId/i);
  });

  it("refuses a run id on a live event", async () => {
    await expect(store.append({
      ...base, leadId: "L1", runId: "run_1", type: "LeadIngested", payload: {},
    })).rejects.toThrow(/live/i);
  });

  it("filters by run id within the sim environment", async () => {
    const sim = new EventStore(pool, "t1", "sim");
    await sim.appendMany([
      { ...base, leadId: "S1", runId: "run_a", type: "LeadIngested", payload: {} },
      { ...base, leadId: "S2", runId: "run_b", type: "LeadIngested", payload: {} },
    ]);
    expect(await sim.query({ runId: "run_a" })).toHaveLength(1);
  });

  it("folds only within its own environment", async () => {
    const sim = new EventStore(pool, "t1", "sim");
    await sim.append({ ...base, leadId: "X", runId: "r", type: "MessageSent",
                       payload: { renderedText: "sim" } });
    await store.append({ ...base, leadId: "X", type: "MessageSent",
                         payload: { renderedText: "live" } });

    expect((await store.fold("X")).turns.map((t) => t.text)).toEqual(["live"]);
    expect((await sim.fold("X")).turns.map((t) => t.text)).toEqual(["sim"]);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

```bash
npx vitest run packages/core/test/store.test.ts
```
Expected: FAIL — `env` is not a property of the returned event

- [ ] **Step 4: Extend the types**

In `packages/core/src/events/types.ts`, add above `eventInputSchema`:
```typescript
export const ENVIRONMENTS = ["live", "sim"] as const;
export type Env = (typeof ENVIRONMENTS)[number];
```

Add `runId` to `eventInputSchema` (after `agentId`):
```typescript
  runId: z.string().min(1).optional(),
```

Add to `StoredEvent` (after `agentId`):
```typescript
  env: Env;
  runId: string | null;
```

- [ ] **Step 5: Scope the store to an environment**

In `packages/core/src/events/store.ts`:

Change the constructor:
```typescript
  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
    private readonly env: Env = "live",
  ) {
    if (!tenantId) throw new Error("EventStore requires a tenantId");
  }
```

Add `env, run_id` to the `COLS` constant:
```typescript
const COLS = `id, tenant_id, lead_id, journey, journey_version,
              agent_id, env, run_id, type, payload, occurred_at, recorded_at`;
```

Extend `validate()` to enforce the run-id invariant in code as well as in the
database, so the error is readable rather than a constraint violation:
```typescript
  private validate(e: EventInput): EventInput {
    if (!EVENT_TYPES.includes(e.type as never)) {
      throw new Error(`unknown event type: ${e.type}`);
    }
    if (this.env === "sim" && !e.runId) {
      throw new Error("a simulated event requires a runId — it groups the run");
    }
    if (this.env === "live" && e.runId) {
      throw new Error("a live event must not carry a runId");
    }
    return eventInputSchema.parse(e);
  }
```

Change `appendMany` to write ten columns instead of eight:
```typescript
    const values: unknown[] = [];
    const tuples = valid.map((e, i) => {
      const o = i * 10;
      values.push(
        this.tenantId, e.leadId, e.journey, e.journeyVersion,
        e.agentId, this.env, e.runId ?? null, e.type,
        JSON.stringify(e.payload), e.occurredAt ?? new Date(),
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},` +
             `$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`;
    });

    const { rows } = await this.pool.query<EventRow>(
      `INSERT INTO events (tenant_id, lead_id, journey, journey_version,
                           agent_id, env, run_id, type, payload, occurred_at)
       VALUES ${tuples.join(",")} RETURNING ${COLS}`,
      values,
    );
```

Scope `query()` to the environment — this is the isolation boundary:
```typescript
  async query(filter: EventFilter = {}): Promise<StoredEvent[]> {
    const where = ["tenant_id = $1", "env = $2"];
    const values: unknown[] = [this.tenantId, this.env];
    const add = (sql: string, v: unknown) => { values.push(v); where.push(`${sql} $${values.length}`); };

    if (filter.leadId) add("lead_id =", filter.leadId);
    if (filter.journey) add("journey =", filter.journey);
    if (filter.journeyVersion !== undefined) add("journey_version =", filter.journeyVersion);
    if (filter.type) add("type =", filter.type);
    if (filter.runId) add("run_id =", filter.runId);
    // ...rest unchanged
```

Add `runId` to `EventFilter`:
```typescript
export interface EventFilter {
  leadId?: string;
  journey?: string;
  journeyVersion?: number;
  type?: string;
  runId?: string;
  limit?: number;
}
```

Extend `EventRow` and `toStored`:
```typescript
interface EventRow {
  id: string | number;
  tenant_id: string;
  lead_id: string;
  journey: string;
  journey_version: string | number;
  agent_id: string;
  env: Env;
  run_id: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  occurred_at: Date;
  recorded_at: Date;
}

function toStored(r: EventRow): StoredEvent {
  return {
    id: Number(r.id), tenantId: r.tenant_id, leadId: r.lead_id,
    journey: r.journey, journeyVersion: Number(r.journey_version),
    agentId: r.agent_id, env: r.env, runId: r.run_id,
    type: r.type, payload: r.payload,
    occurredAt: r.occurred_at, recordedAt: r.recorded_at,
  };
}
```

Import `Env` at the top of `store.ts` alongside the existing type imports.

- [ ] **Step 6: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: all M1 tests still pass (env defaults to live), plus 7 new store tests

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): isolate simulated events by env and run_id"
```

---

## Task 2: Sentiment — making a dormant policy rule real

**Files:**
- Create: `packages/runtime/src/sentiment.ts`
- Modify: `packages/runtime/src/scoring.ts`, `packages/runtime/src/step.ts`
- Test: `packages/runtime/test/sentiment.test.ts`, `packages/runtime/test/scoring.test.ts` (append), `packages/runtime/test/step.test.ts` (append)

**Interfaces:**
- Consumes: `PredicateContext`, `evaluatePredicate` (M1 Task 8); `Turn` (M1 Task 2)
- Produces:
  - `interface SentimentResult { score: number; reason: string }` — score in [-1, 1]
  - `class LexiconSentiment { analyze(turns: Turn[]): SentimentResult }` — deterministic, no model
  - `PredicateContext` gains `sentiment: number` (defaults to 0)
  - `evaluatePredicate` supports `sentiment <op> <number>`

**Why now:** the reference journey declares `escalate_when: [..., "sentiment < -0.5"]`. M1 shipped `escalationTrigger` silently skipping rules it could not evaluate — correct, but it leaves a policy rule that *looks* active and is not. A quality milestone is the right place to close that.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/test/sentiment.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import type { Turn } from "@midfunnel/core/events/types";
import { LexiconSentiment } from "../src/sentiment.js";

const t = (role: "agent" | "lead", text: string): Turn => ({ role, text, at: new Date() });
const s = new LexiconSentiment();

describe("LexiconSentiment", () => {
  it("scores a frustrated lead negative", () => {
    const r = s.analyze([t("lead", "this is useless, terrible service, waste of my time")]);
    expect(r.score).toBeLessThan(-0.5);
    expect(r.reason).toMatch(/negative/i);
  });

  it("scores an enthusiastic lead positive", () => {
    expect(s.analyze([t("lead", "great, perfect, this sounds excellent")]).score)
      .toBeGreaterThan(0.3);
  });

  it("scores neutral text near zero", () => {
    expect(Math.abs(s.analyze([t("lead", "executive mba, this intake")]).score))
      .toBeLessThan(0.2);
  });

  it("ignores what the AGENT said", () => {
    // An apologetic agent must not make the LEAD look upset.
    expect(s.analyze([t("agent", "sorry, terrible, my apologies")]).score).toBe(0);
  });

  it("weights the most recent lead turn most heavily", () => {
    const recovered = s.analyze([
      t("lead", "this is terrible and useless"),
      t("lead", "actually that is perfect, great, excellent, wonderful"),
    ]);
    const stillAngry = s.analyze([
      t("lead", "that is perfect and great"),
      t("lead", "no this is terrible, useless, awful, horrible"),
    ]);
    expect(recovered.score).toBeGreaterThan(stillAngry.score);
  });

  it("returns zero for no lead turns", () => {
    expect(s.analyze([]).score).toBe(0);
  });
});
```

Append to `packages/runtime/test/scoring.test.ts`:
```typescript
describe("evaluatePredicate — sentiment", () => {
  const ctx = (sentiment: number) => ({ score: 0, evidenceComplete: false, sentiment });

  it("evaluates a sentiment comparison", () => {
    expect(evaluatePredicate("sentiment < -0.5", ctx(-0.8))).toBe(true);
    expect(evaluatePredicate("sentiment < -0.5", ctx(-0.2))).toBe(false);
  });

  it("treats missing sentiment as neutral", () => {
    expect(evaluatePredicate("sentiment < -0.5", { score: 0, evidenceComplete: false })).toBe(false);
  });

  it("still refuses an unsupported predicate", () => {
    expect(() => evaluatePredicate("mood == bad", ctx(0))).toThrow(/unsupported predicate/i);
  });
});
```

Append to `packages/runtime/test/step.test.ts`:
```typescript
describe("AgentRuntime.step — sentiment escalation", () => {
  it("escalates a frustrated lead on the declared sentiment rule", async () => {
    const s = state({ turns: [
      turn("agent", "Which programme?"),
      turn("lead", "this is terrible, useless, awful — waste of time"),
    ] });
    const actions = await new AgentRuntime(extractor(), asker("x") as never).step(spec, s);
    expect(actions.find((a) => a.kind === "escalate"))
      .toMatchObject({ reason: "sentiment < -0.5" });
  });

  it("does not escalate a merely neutral lead", async () => {
    const s = state({ turns: [turn("agent", "Which programme?"), turn("lead", "executive mba")] });
    const actions = await new AgentRuntime(
      extractor(ev({ target_program: "executive_mba" })), asker("next?") as never,
    ).step(spec, s);
    expect(actions.some((a) => a.kind === "escalate")).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/runtime/test/
```
Expected: FAIL — `../src/sentiment.js` not found

- [ ] **Step 3: Write the analyzer**

`packages/runtime/src/sentiment.ts`:
```typescript
import type { Turn } from "@midfunnel/core/events/types";

export interface SentimentResult {
  score: number;   // -1 (hostile) .. +1 (delighted)
  reason: string;
}

const NEGATIVE = [
  "terrible", "useless", "awful", "horrible", "rubbish", "waste", "scam",
  "annoying", "frustrating", "frustrated", "angry", "stupid", "worst",
  "unacceptable", "ridiculous", "disappointed", "misleading",
];

const POSITIVE = [
  "great", "perfect", "excellent", "wonderful", "brilliant", "helpful",
  "thanks", "thank", "awesome", "love", "good", "interested", "keen",
];

/**
 * Deterministic lexicon sentiment over LEAD turns only.
 *
 * Weaker than a model, and deliberately so: it runs on every step of every
 * conversation, it must be free, and it must be reproducible for replay. Its
 * one job is deciding whether a declared `sentiment` policy rule fires. When
 * nuance matters, the eval judge (Task 6) scores the same conversation with
 * `claude-opus-5`.
 */
export class LexiconSentiment {
  analyze(turns: Turn[]): SentimentResult {
    const lead = turns.filter((t) => t.role === "lead");
    if (lead.length === 0) return { score: 0, reason: "no lead turns" };

    let weighted = 0;
    let weightSum = 0;

    lead.forEach((turn, i) => {
      // Recency weighting: the latest turn carries the most signal, because a
      // lead who has calmed down is no longer an escalation.
      const weight = (i + 1) / lead.length;
      const words = turn.text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
      let hits = 0;
      let sum = 0;
      for (const w of words) {
        if (NEGATIVE.includes(w)) { sum -= 1; hits++; }
        else if (POSITIVE.includes(w)) { sum += 1; hits++; }
      }
      if (hits > 0) {
        // Saturating: three negative words is angry; ten is not 3x angrier.
        weighted += weight * Math.tanh(sum / 2);
        weightSum += weight;
      }
    });

    if (weightSum === 0) return { score: 0, reason: "no sentiment-bearing terms" };

    const score = Math.max(-1, Math.min(1, weighted / weightSum));
    const reason =
      score < -0.3 ? "negative terms dominate recent lead turns"
      : score > 0.3 ? "positive terms dominate recent lead turns"
      : "mixed or weak signal";
    return { score: Math.round(score * 100) / 100, reason };
  }
}
```

- [ ] **Step 4: Teach the evaluator about sentiment**

In `packages/runtime/src/scoring.ts`, extend the context type:
```typescript
export interface PredicateContext {
  score: number;
  evidenceComplete: boolean;
  /** -1..1. Absent means neutral, so a sentiment rule simply does not fire. */
  sentiment?: number;
}
```

In `evaluatePredicate`, add before the final `throw`:
```typescript
  const sm = /^sentiment\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (sm) {
    const n = Number(sm[2]);
    const v = ctx.sentiment ?? 0;
    switch (sm[1]) {
      case ">=": return v >= n;
      case "<=": return v <= n;
      case ">":  return v > n;
      case "<":  return v < n;
      case "==": return v === n;
    }
  }
```

- [ ] **Step 5: Wire it into escalation**

In `packages/runtime/src/step.ts`:

Add the import:
```typescript
import { LexiconSentiment } from "./sentiment.js";
```

Add a field and construct it (the runtime owns one instance):
```typescript
  private readonly sentiment = new LexiconSentiment();
```

Replace the call site in `step()` — compute sentiment before the escalation check:
```typescript
    // 4. Declared escalation triggers on evidence and sentiment.
    const mood = this.sentiment.analyze(state.turns);
    const trigger = escalationTrigger(spec, evidence, mood.score);
```

Replace `escalationTrigger` entirely:
```typescript
/**
 * Evaluates the journey's declared escalation rules. Rules referencing signals
 * this build cannot compute are skipped rather than thrown on — an
 * unimplementable policy rule must not break the runtime.
 */
function escalationTrigger(
  spec: JourneySpec, evidence: Evidence, sentiment: number,
): string | null {
  for (const raw of spec.policy.escalate_when) {
    const rule = raw.trim();

    const ev = /^evidence\.(\w+)\s*==\s*(\S+)$/.exec(rule);
    if (ev) {
      const got = evidence[ev[1]!];
      if (got && String(got.value) === ev[2]) return rule;
      continue;
    }

    if (/^sentiment\s*(>=|<=|>|<|==)/.test(rule)) {
      if (evaluatePredicate(rule, { score: 0, evidenceComplete: false, sentiment })) {
        return rule;
      }
      continue;
    }
  }
  return null;
}
```

Add `evaluatePredicate` to the existing `./scoring.js` import in `step.ts`.

- [ ] **Step 6: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 6 sentiment + 3 predicate + 2 step tests added, everything else still green

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(runtime): lexicon sentiment, activating the declared sentiment escalation rule"
```

---
## Task 3: Personas — synthetic leads that carry ground truth

**Files:**
- Create: `packages/batch/src/simulate/persona.ts`, `packages/batch/src/simulate/replier.ts`
- Test: `packages/batch/test/persona.test.ts`, `packages/batch/test/replier.test.ts`

**Interfaces:**
- Consumes: `JourneySpec`, `parseTypeExpr` (M1 Task 3); `mulberry32` (M1 Task 11); `Turn` (M1 Task 2)
- Produces:
  - ```typescript
    interface Persona {
      id: string;
      truth: Record<string, string>;      // ground truth — never visible to the runtime
      verbosity: "terse" | "normal" | "chatty";
      cooperation: number;                 // 0..1, probability of answering directly
      objection: "none" | "price" | "time" | "trust";
      dropoffAfterTurn: number | null;     // ghosts after this many lead turns
      mood: "positive" | "neutral" | "frustrated";
    }
    ```
  - `generatePersonas(spec: JourneySpec, n: number, seed?: number): Persona[]`
  - `interface Replier { reply(persona: Persona, spec: JourneySpec, turns: Turn[]): Promise<string | null> }` — `null` means the lead has ghosted
  - `class ScriptedReplier implements Replier` — deterministic, no model
  - `class ModelReplier implements Replier` — `claude-sonnet-5`, `effort: "low"`

**Why ground truth is on the persona:** extraction correctness is only measurable against what the lead *actually was*. If `truth` were reachable from the transcript alone, the metric would collapse into "did the extractor read the transcript", which is not the question. The runtime never sees a `Persona` — it only ever sees the replies.

- [ ] **Step 1: Write the failing tests**

`packages/batch/test/persona.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, parseTypeExpr } from "@midfunnel/core/journey/spec";
import { generatePersonas } from "../src/simulate/persona.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

describe("generatePersonas", () => {
  it("is deterministic for a given seed", () => {
    expect(generatePersonas(spec, 20, 7)).toEqual(generatePersonas(spec, 20, 7));
  });

  it("differs across seeds", () => {
    expect(generatePersonas(spec, 20, 1)).not.toEqual(generatePersonas(spec, 20, 2));
  });

  it("gives every persona a ground truth drawn from the declared enums", () => {
    for (const p of generatePersonas(spec, 30, 3)) {
      for (const [field, value] of Object.entries(p.truth)) {
        const t = parseTypeExpr(spec.evidence[field]!.type);
        expect(t.kind).toBe("enum");
        if (t.kind === "enum") expect(t.values).toContain(value);
      }
    }
  });

  it("always establishes truth for every required field", () => {
    const required = Object.entries(spec.evidence)
      .filter(([, d]) => d.required).map(([f]) => f);
    for (const p of generatePersonas(spec, 30, 4)) {
      for (const f of required) expect(p.truth[f]).toBeDefined();
    }
  });

  it("produces a spread of behaviours rather than one archetype", () => {
    const ps = generatePersonas(spec, 200, 5);
    expect(new Set(ps.map((p) => p.verbosity)).size).toBeGreaterThan(1);
    expect(new Set(ps.map((p) => p.objection)).size).toBeGreaterThan(2);
    expect(new Set(ps.map((p) => p.mood)).size).toBeGreaterThan(1);
    expect(ps.some((p) => p.dropoffAfterTurn !== null)).toBe(true);
    expect(ps.some((p) => p.dropoffAfterTurn === null)).toBe(true);
  });

  it("gives every persona a unique id", () => {
    const ps = generatePersonas(spec, 100, 6);
    expect(new Set(ps.map((p) => p.id)).size).toBe(100);
  });
});
```

`packages/batch/test/replier.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { generatePersonas } from "../src/simulate/persona.js";
import { ScriptedReplier } from "../src/simulate/replier.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));
const r = new ScriptedReplier();
const t = (role: "agent" | "lead", text: string): Turn => ({ role, text, at: new Date() });

const persona = {
  id: "p1",
  truth: { target_program: "executive_mba", timeline: "this_intake",
           budget_band: "above_15L", decision_maker: "self" },
  verbosity: "normal" as const,
  cooperation: 1,
  objection: "none" as const,
  dropoffAfterTurn: null,
  mood: "neutral" as const,
};

describe("ScriptedReplier", () => {
  it("answers the field the agent asked about", async () => {
    const out = await r.reply(persona, spec, [t("agent", "Which programme are you considering?")]);
    expect(out).toContain("executive_mba");
  });

  it("answers a different field when asked a different question", async () => {
    const out = await r.reply(persona, spec, [t("agent", "What is your budget range?")]);
    expect(out).toContain("above_15L");
  });

  it("ghosts once past the dropoff turn", async () => {
    const ghost = { ...persona, dropoffAfterTurn: 1 };
    const turns = [t("agent", "hi"), t("lead", "hello"), t("agent", "which programme?")];
    expect(await r.reply(ghost, spec, turns)).toBeNull();
  });

  it("voices a frustrated mood in the text", async () => {
    const cross = { ...persona, mood: "frustrated" as const };
    const out = await r.reply(cross, spec, [t("agent", "Which programme?")]);
    expect(out).toMatch(/terrible|useless|waste|frustrating/i);
  });

  it("deflects rather than answering when uncooperative", async () => {
    const cagey = { ...persona, cooperation: 0 };
    const out = await r.reply(cagey, spec, [t("agent", "What is your budget range?")]);
    expect(out).not.toContain("above_15L");
  });

  it("never leaks ground truth for a field that was not asked about", async () => {
    const out = await r.reply(persona, spec, [t("agent", "Which programme are you considering?")]);
    expect(out).not.toContain("above_15L");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/batch/test/persona.test.ts packages/batch/test/replier.test.ts
```
Expected: FAIL — `../src/simulate/persona.js` not found

- [ ] **Step 3: Write the persona generator**

`packages/batch/src/simulate/persona.ts`:
```typescript
import { parseTypeExpr, type JourneySpec } from "@midfunnel/core/journey/spec";
import { mulberry32 } from "../replay/stats.js";

export interface Persona {
  id: string;
  /** Ground truth. The runtime never sees this — only the replies it shapes. */
  truth: Record<string, string>;
  verbosity: "terse" | "normal" | "chatty";
  /** 0..1 probability of answering a question directly rather than deflecting. */
  cooperation: number;
  objection: "none" | "price" | "time" | "trust";
  /** Ghosts after this many lead turns. null means they see it through. */
  dropoffAfterTurn: number | null;
  mood: "positive" | "neutral" | "frustrated";
}

const VERBOSITY = ["terse", "normal", "chatty"] as const;
const OBJECTIONS = ["none", "price", "time", "trust"] as const;
const MOODS = ["positive", "neutral", "frustrated"] as const;

/**
 * Deterministic for a seed, so a simulation run is reproducible and an A/B
 * comparison is paired: the same personas meet both journey versions.
 *
 * Truth is drawn only from enum fields — free-text evidence cannot be scored
 * for correctness by exact match, so seeding it would create a metric that
 * looks meaningful and is not.
 */
export function generatePersonas(spec: JourneySpec, n: number, seed = 1): Persona[] {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const enumFields = Object.entries(spec.evidence)
    .map(([field, def]) => [field, def, parseTypeExpr(def.type)] as const)
    .filter(([, , t]) => t.kind === "enum");

  const personas: Persona[] = [];
  for (let i = 0; i < n; i++) {
    const truth: Record<string, string> = {};
    for (const [field, def, t] of enumFields) {
      if (t.kind !== "enum") continue;
      // Required fields are always established; optional ones sometimes are not,
      // which is what a real cohort looks like.
      if (!def.required && rand() < 0.35) continue;
      truth[field] = pick(t.values);
    }

    personas.push({
      id: `persona_${seed}_${i}`,
      truth,
      verbosity: pick(VERBOSITY),
      cooperation: Math.round(rand() * 100) / 100,
      objection: pick(OBJECTIONS),
      // ~20% ghost partway through, which is generous to the agent but
      // realistic enough to make completion rate a meaningful metric.
      dropoffAfterTurn: rand() < 0.2 ? 1 + Math.floor(rand() * 5) : null,
      mood: pick(MOODS),
    });
  }
  return personas;
}
```

- [ ] **Step 4: Write the repliers**

`packages/batch/src/simulate/replier.ts`:
```typescript
import type Anthropic from "@anthropic-ai/sdk";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { cachedSystem, createClient, MAX_TOKENS } from "@midfunnel/runtime/claude";
import type { Persona } from "./persona.js";

export interface Replier {
  /** Returns the lead's next message, or null if they have ghosted. */
  reply(persona: Persona, spec: JourneySpec, turns: Turn[]): Promise<string | null>;
}

const MOOD_TEXT: Record<Persona["mood"], string> = {
  positive: "great, that sounds good",
  neutral: "ok",
  frustrated: "this is frustrating, feels like a waste of time",
};

const OBJECTION_TEXT: Record<Persona["objection"], string> = {
  none: "",
  price: " though the fees look steep",
  time: " but I do not have much time right now",
  trust: " and I am not sure this is legitimate",
};

/**
 * Deterministic replier. Used for tests, for reproducible A/B runs, and
 * whenever no Anthropic credential is configured. It answers only the field
 * the agent's last message names, so it never leaks unasked ground truth.
 */
export class ScriptedReplier implements Replier {
  async reply(persona: Persona, spec: JourneySpec, turns: Turn[]): Promise<string | null> {
    const leadTurns = turns.filter((t) => t.role === "lead").length;
    if (persona.dropoffAfterTurn !== null && leadTurns >= persona.dropoffAfterTurn) return null;

    const lastAgent = [...turns].reverse().find((t) => t.role === "agent");
    if (!lastAgent) return null;
    const asked = lastAgent.text.toLowerCase();

    // Which evidence field is this question about? Match on the field name and
    // on words from its description, since the agent phrases things naturally.
    let field: string | null = null;
    for (const [name, def] of Object.entries(spec.evidence)) {
      const hints = [name.replace(/_/g, " "), ...(def.description ?? "").toLowerCase().split(/\s+/)];
      if (hints.some((h) => h.length > 3 && asked.includes(h))) { field = name; break; }
    }

    const mood = MOOD_TEXT[persona.mood];
    const objection = OBJECTION_TEXT[persona.objection];

    if (!field) return `${mood}${objection}`.trim();

    const value = persona.truth[field];
    // Uncooperative leads deflect rather than answer.
    if (value === undefined || persona.cooperation < 0.4) {
      return `not sure about that${objection || ", let me think"}`;
    }

    switch (persona.verbosity) {
      case "terse":  return value;
      case "chatty": return `${mood}, I would say ${value}${objection}`;
      default:       return `${value}${objection}`;
    }
  }
}

/**
 * Model-backed replier. `claude-sonnet-5` at low effort: personas need to be
 * plausible, not brilliant, and this is the volume driver in a simulation run.
 */
export class ModelReplier implements Replier {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? createClient();
  }

  async reply(persona: Persona, spec: JourneySpec, turns: Turn[]): Promise<string | null> {
    const leadTurns = turns.filter((t) => t.role === "lead").length;
    if (persona.dropoffAfterTurn !== null && leadTurns >= persona.dropoffAfterTurn) return null;

    const transcript = turns
      .map((t) => `${t.role === "agent" ? "AGENT" : "YOU"}: ${t.text}`)
      .join("\n");

    const response = await this.client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: cachedSystem([
        `You are role-playing a prospective ${spec.vertical} student being contacted over WhatsApp.`,
        "",
        "Reply as the PROSPECT, never as the agent. One short message, under 25 words.",
        "No preamble, no quotation marks, no stage directions.",
        "",
        "Facts true about you (reveal only what is actually asked, never volunteer the rest):",
        ...Object.entries(persona.truth).map(([k, v]) => `- ${k}: ${v}`),
        "",
        `Mood: ${persona.mood}. Verbosity: ${persona.verbosity}.`,
        `Cooperation: ${persona.cooperation} (0 = evasive, 1 = fully forthcoming).`,
        persona.objection === "none" ? "" : `You have an unspoken objection about ${persona.objection}.`,
      ].filter(Boolean).join("\n")),
      messages: [{ role: "user", content: transcript }],
    });

    for (const block of response.content) {
      if (block.type === "text") return block.text.trim();
    }
    return null;
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 6 persona + 6 replier tests pass

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(batch): personas with ground truth, scripted and model-backed repliers"
```

---

## Task 4: SimulationRunner — driving a journey with no real lead

**Files:**
- Create: `packages/batch/src/simulate/runner.ts`
- Modify: `packages/batch/src/index.ts`
- Test: `packages/batch/test/runner.test.ts`

**Interfaces:**
- Consumes: `Persona`, `Replier` (Task 3); `EventStore` with env (Task 1); `AgentRuntime`, `Action` (M1 Task 9); `JourneySpec`
- Produces:
  - ```typescript
    interface RunSummary {
      runId: string;
      journey: string;
      journeyVersion: number;
      n: number;
      completed: number;
      qualified: number;
      escalated: number;
      ghosted: number;
      avgTurns: number;
    }
    ```
  - `class SimulationRunner { constructor(store, runtime, replier); run(spec, personas, opts): Promise<RunSummary> }`
  - `interface RunOptions { runId?: string; agentId?: string }`

**The whole point:** this writes **real events** through the same `EventStore`, so the eval harness, alerting and A/B scoreboard are folds over the log — not three separate systems reading three separate shapes. `allowFollowUp` is **true** here, unlike replay: there is a synthetic lead to answer.

- [ ] **Step 1: Write the failing test**

`packages/batch/test/runner.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { KeywordExtractor } from "@midfunnel/runtime/keyword-extractor";
import { generatePersonas } from "../src/simulate/persona.js";
import { ScriptedReplier } from "../src/simulate/replier.js";
import { SimulationRunner } from "../src/simulate/runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

/** No model anywhere: keyword extraction + scripted replies. */
const runtime = () => new AgentRuntime(new KeywordExtractor() as never, {} as never);

let pool: Pool; let sim: EventStore; let live: EventStore;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE events");
  sim = new EventStore(pool, "t1", "sim");
  live = new EventStore(pool, "t1", "live");
});
afterAll(async () => { await pool.end(); });

describe("SimulationRunner", () => {
  it("runs a cohort and summarises it", async () => {
    const personas = generatePersonas(spec, 25, 11);
    const s = await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, personas, { runId: "run_1" });

    expect(s.runId).toBe("run_1");
    expect(s.n).toBe(25);
    expect(s.completed + s.escalated + s.ghosted).toBeLessThanOrEqual(25);
    expect(s.avgTurns).toBeGreaterThan(0);
  });

  it("writes simulated events that a live store cannot see", async () => {
    const personas = generatePersonas(spec, 5, 12);
    await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, personas, { runId: "run_2" });

    expect((await sim.query({ runId: "run_2" })).length).toBeGreaterThan(0);
    expect(await live.query({})).toEqual([]);
  });

  it("tags every event with the run id and the journey's agent", async () => {
    await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, generatePersonas(spec, 3, 13), { runId: "run_3" });

    const events = await sim.query({ runId: "run_3" });
    expect(events.every((e) => e.runId === "run_3")).toBe(true);
    expect(events.every((e) => e.agentId === spec.agent.identity)).toBe(true);
  });

  it("records a conversation as turns the agent could actually have seen", async () => {
    await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, generatePersonas(spec, 1, 14), { runId: "run_4" });

    const [leadId] = [...new Set((await sim.query({ runId: "run_4" })).map((e) => e.leadId))];
    const state = await sim.fold(leadId!);
    expect(state.turns[0]!.role).toBe("agent");
    expect(state.turns.length).toBeGreaterThan(1);
  });

  it("never exceeds the journey's max_turns", async () => {
    await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, generatePersonas(spec, 10, 15), { runId: "run_5" });

    const byLead = new Map<string, number>();
    for (const e of await sim.query({ runId: "run_5" })) {
      if (e.type === "MessageSent" || e.type === "MessageReceived") {
        byLead.set(e.leadId, (byLead.get(e.leadId) ?? 0) + 1);
      }
    }
    for (const count of byLead.values()) expect(count).toBeLessThanOrEqual(spec.policy.max_turns + 1);
  });

  it("is reproducible for the same personas", async () => {
    const personas = generatePersonas(spec, 12, 16);
    const a = await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, personas, { runId: "run_a" });
    const b = await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, personas, { runId: "run_b" });

    expect({ ...a, runId: null }).toEqual({ ...b, runId: null });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/batch/test/runner.test.ts
```
Expected: FAIL — `../src/simulate/runner.js` not found

- [ ] **Step 3: Write the runner**

`packages/batch/src/simulate/runner.ts`:
```typescript
import type { EventStore } from "@midfunnel/core/events/store";
import type { EventInput, LeadState } from "@midfunnel/core/events/types";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { AgentRuntime } from "@midfunnel/runtime/step";
import type { Persona } from "./persona.js";
import type { Replier } from "./replier.js";

export interface RunSummary {
  runId: string;
  journey: string;
  journeyVersion: number;
  n: number;
  completed: number;
  qualified: number;
  escalated: number;
  ghosted: number;
  avgTurns: number;
}

export interface RunOptions {
  runId?: string;
  agentId?: string;
}

export class SimulationRunner {
  constructor(
    private readonly store: EventStore,
    private readonly runtime: AgentRuntime,
    private readonly replier: Replier,
  ) {}

  /**
   * Drives each persona through the journey and writes real events.
   *
   * `allowFollowUp` is true here — unlike replay, there is a synthetic lead to
   * answer the question, so the runtime's full conversational behaviour is
   * exercised. That is precisely what makes a simulation run a meaningful
   * sandbox rather than a scoring exercise.
   */
  async run(spec: JourneySpec, personas: Persona[], opts: RunOptions = {}): Promise<RunSummary> {
    const runId = opts.runId ?? `run_${Date.now()}`;
    const agentId = opts.agentId ?? spec.agent.identity;

    let completed = 0, qualified = 0, escalated = 0, ghosted = 0, turnTotal = 0;

    for (const persona of personas) {
      const leadId = `sim_${runId}_${persona.id}`;
      const base = { leadId, journey: spec.journey, journeyVersion: spec.version, agentId, runId };

      await this.store.append({
        ...base, type: "LeadIngested",
        payload: { source: "simulation", personaId: persona.id, campaignId: "sim" },
      });

      const outcome = await this.conversation(spec, persona, base);
      turnTotal += outcome.turns;
      if (outcome.escalated) escalated++;
      else if (outcome.ghosted) ghosted++;
      else if (outcome.completed) { completed++; if (outcome.qualified) qualified++; }
    }

    return {
      runId, journey: spec.journey, journeyVersion: spec.version,
      n: personas.length, completed, qualified, escalated, ghosted,
      avgTurns: personas.length ? Math.round((turnTotal / personas.length) * 10) / 10 : 0,
    };
  }

  private async conversation(
    spec: JourneySpec,
    persona: Persona,
    base: { leadId: string; journey: string; journeyVersion: number; agentId: string; runId: string },
  ): Promise<{ turns: number; completed: boolean; qualified: boolean; escalated: boolean; ghosted: boolean }> {
    let turns = 0;

    // Hard ceiling independent of the spec, so a misbehaving runtime cannot
    // spin forever and burn the batch budget.
    for (let i = 0; i <= spec.policy.max_turns; i++) {
      const state: LeadState = await this.store.fold(base.leadId);
      const actions = await this.runtime.step(spec, state, { allowFollowUp: true });

      const pending: EventInput[] = [];
      let sentText: string | null = null;
      let escalated = false;
      let completed = false;
      let qualified = false;

      for (const a of actions) {
        switch (a.kind) {
          case "send":
            sentText = a.text;
            pending.push({ ...base, type: "MessageSent",
              payload: { channel: "simulated", renderedText: a.text,
                         templateId: a.pinnedTemplate ?? null } });
            break;
          case "extract":
            for (const [field, v] of Object.entries(a.evidence)) {
              pending.push({ ...base, type: "EvidenceExtracted",
                payload: { field, value: v.value, confidence: v.confidence } });
            }
            break;
          case "score":
            pending.push({ ...base, type: "Scored", payload: { score: a.score } });
            break;
          case "route":
            pending.push({ ...base, type: "Routed",
              payload: { decision: a.decision, target: a.target, sla: a.sla ?? null } });
            break;
          case "escalate":
            escalated = true;
            pending.push({ ...base, type: "PolicyEvaluated",
              payload: { ruleId: a.reason, verdict: "escalate", severity: "high" } });
            break;
          case "complete":
            completed = true;
            qualified = a.qualified;
            break;
        }
      }
      if (pending.length > 0) await this.store.appendMany(pending);

      if (escalated) return { turns, completed: false, qualified: false, escalated: true, ghosted: false };
      if (completed) return { turns, completed: true, qualified, escalated: false, ghosted: false };
      if (sentText === null) break;

      const reply = await this.replier.reply(persona, spec, (await this.store.fold(base.leadId)).turns);
      if (reply === null) {
        return { turns, completed: false, qualified: false, escalated: false, ghosted: true };
      }

      await this.store.append({ ...base, type: "MessageReceived",
        payload: { channel: "simulated", rawText: reply } });
      turns++;
    }

    // Ran out of turns without the runtime completing.
    return { turns, completed: false, qualified: false, escalated: false, ghosted: false };
  }
}
```

Add to `packages/batch/src/index.ts`:
```typescript
export * from "./simulate/persona.js";
export * from "./simulate/replier.js";
export * from "./simulate/runner.js";
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 6 runner tests pass; every M1 test still green

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(batch): simulation runner writing real isolated events"
```

---
## Task 5: Deterministic scorecards

**Files:**
- Create: `packages/batch/src/eval/scorecard.ts`
- Test: `packages/batch/test/scorecard.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `LeadState` (Task 1); `Persona` (Task 3); `JourneySpec`, `requiredEvidenceFields` (M1 Task 3)
- Produces:
  - ```typescript
    interface PolicyViolation { rule: string; turnText: string; matched: string }
    interface Scorecard {
      leadId: string;
      personaId: string;
      evidenceCompleteness: number;   // 0..1 — required fields established
      evidenceCorrectness: number | null; // 0..1 vs ground truth; null if nothing extracted
      hallucinatedFields: string[];   // extracted but contradicted by truth
      policyViolations: PolicyViolation[];
      turnsUsed: number;
      outcome: "completed" | "escalated" | "ghosted" | "exhausted";
      qualified: boolean;
    }
    ```
  - `POLICY_DETECTORS: Record<string, RegExp>`
  - `scoreConversation(spec, state, persona): Scorecard`
  - `undetectableRules(spec): string[]` — rules with no deterministic detector, for the judge

**Deterministic first.** Completeness, correctness against ground truth, and the policy rules we can pattern-match are mechanical and exact — no model, no cost, no variance. Only what genuinely needs judgment goes to the judge in Task 6. Running a model over things a regex settles is how eval bills get large and eval results get noisy.

- [ ] **Step 1: Write the failing test**

`packages/batch/test/scorecard.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import type { Persona } from "../src/simulate/persona.js";
import { scoreConversation, undetectableRules } from "../src/eval/scorecard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const persona: Persona = {
  id: "p1",
  truth: { target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L" },
  verbosity: "normal", cooperation: 1, objection: "none",
  dropoffAfterTurn: null, mood: "neutral",
};

const state = (over: Partial<LeadState> = {}): LeadState => ({
  leadId: "sim_1", journey: spec.journey, journeyVersion: 4,
  evidence: {}, turns: [], outcomes: [], ...over,
});

const ev = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

const turn = (role: "agent" | "lead", text: string) => ({ role, text, at: new Date() });

describe("scoreConversation", () => {
  it("scores full completeness when every required field is established", () => {
    const c = scoreConversation(spec, state({
      evidence: ev({ target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L" }),
      decision: "hot",
    }), persona);
    expect(c.evidenceCompleteness).toBe(1);
    expect(c.evidenceCorrectness).toBe(1);
    expect(c.hallucinatedFields).toEqual([]);
  });

  it("scores partial completeness proportionally", () => {
    const c = scoreConversation(spec, state({ evidence: ev({ timeline: "this_intake" }) }), persona);
    // 1 of 3 required fields
    expect(c.evidenceCompleteness).toBeCloseTo(1 / 3, 5);
  });

  it("catches a hallucinated value that contradicts ground truth", () => {
    const c = scoreConversation(spec, state({
      evidence: ev({ target_program: "online_mba", timeline: "this_intake", budget_band: "above_15L" }),
    }), persona);
    expect(c.hallucinatedFields).toEqual(["target_program"]);
    expect(c.evidenceCorrectness).toBeCloseTo(2 / 3, 5);
  });

  it("returns null correctness when nothing was extracted", () => {
    expect(scoreConversation(spec, state(), persona).evidenceCorrectness).toBeNull();
  });

  it("ignores extracted fields the persona has no truth for", () => {
    // decision_maker is absent from this persona's truth - it cannot be graded.
    const c = scoreConversation(spec, state({
      evidence: ev({ target_program: "executive_mba", timeline: "this_intake",
                     budget_band: "above_15L", decision_maker: "self" }),
    }), persona);
    expect(c.evidenceCorrectness).toBe(1);
    expect(c.hallucinatedFields).toEqual([]);
  });

  it("detects a policy violation in an agent message", () => {
    const c = scoreConversation(spec, state({
      turns: [turn("agent", "The fee is exactly ₹12,50,000 for this programme")],
    }), persona);
    expect(c.policyViolations.map((v) => v.rule)).toContain("quote_exact_fees");
  });

  it("detects an admission promise", () => {
    const c = scoreConversation(spec, state({
      turns: [turn("agent", "You are guaranteed admission with that profile")],
    }), persona);
    expect(c.policyViolations.map((v) => v.rule)).toContain("promise_admission");
  });

  it("never charges the agent for what the LEAD said", () => {
    const c = scoreConversation(spec, state({
      turns: [turn("lead", "can you guarantee admission and tell me the exact fee of 12,50,000?")],
    }), persona);
    expect(c.policyViolations).toEqual([]);
  });

  it("classifies outcomes", () => {
    expect(scoreConversation(spec, state({ decision: "hot" }), persona).outcome).toBe("completed");
    const escalated = state({ turns: [turn("agent", "hi")] });
    expect(scoreConversation(spec, escalated, persona, { escalated: true }).outcome).toBe("escalated");
    expect(scoreConversation(spec, escalated, persona, { ghosted: true }).outcome).toBe("ghosted");
  });

  it("lists rules that need a judge because no detector exists", () => {
    // compare_to_competitors is a judgment call, not a regex.
    expect(undetectableRules(spec)).toContain("compare_to_competitors");
    expect(undetectableRules(spec)).not.toContain("quote_exact_fees");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/batch/test/scorecard.test.ts
```
Expected: FAIL — `../src/eval/scorecard.js` not found

- [ ] **Step 3: Write the scorecard module**

`packages/batch/src/eval/scorecard.ts`:
```typescript
import { requiredEvidenceFields, type JourneySpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import type { Persona } from "../simulate/persona.js";

export interface PolicyViolation {
  rule: string;
  turnText: string;
  matched: string;
}

export interface Scorecard {
  leadId: string;
  personaId: string;
  evidenceCompleteness: number;
  evidenceCorrectness: number | null;
  hallucinatedFields: string[];
  policyViolations: PolicyViolation[];
  turnsUsed: number;
  outcome: "completed" | "escalated" | "ghosted" | "exhausted";
  qualified: boolean;
}

export interface OutcomeHints {
  escalated?: boolean;
  ghosted?: boolean;
}

/**
 * Deterministic detectors for the policy rules that can be pattern-matched.
 * A rule absent from this map is not un-checked — it goes to the judge
 * (Task 6) via `undetectableRules`.
 */
export const POLICY_DETECTORS: Record<string, RegExp> = {
  // A currency amount with 4+ digits, or Indian lakh/crore phrasing with a figure.
  quote_exact_fees: /(?:₹|rs\.?|inr)\s?[\d,]{4,}|\b[\d,]{4,}\s?(?:rupees|lakhs?|crores?)\b/i,
  promise_admission: /\b(?:guarantee|guaranteed|assured|definitely get|certain(?:ly)? (?:get|be) (?:in|admitted))\b/i,
};

export function undetectableRules(spec: JourneySpec): string[] {
  return spec.policy.never.filter((r) => !(r in POLICY_DETECTORS));
}

/**
 * Grades one simulated conversation. Correctness is measured against the
 * persona's ground truth, which the runtime never saw — that is what makes it
 * a real measurement rather than a restatement of the transcript.
 */
export function scoreConversation(
  spec: JourneySpec,
  state: LeadState,
  persona: Persona,
  hints: OutcomeHints = {},
): Scorecard {
  const required = requiredEvidenceFields(spec);
  const established = required.filter((f) => {
    const got = state.evidence[f];
    return got !== undefined && got.value !== null && got.value !== undefined;
  });

  // Correctness only over fields the persona actually has a truth for.
  const gradable = Object.entries(state.evidence).filter(
    ([field, got]) => persona.truth[field] !== undefined && got.value !== null,
  );
  const hallucinated = gradable
    .filter(([field, got]) => String(got.value) !== persona.truth[field])
    .map(([field]) => field);

  const violations: PolicyViolation[] = [];
  for (const t of state.turns) {
    // Only the AGENT can violate the agent's policy.
    if (t.role !== "agent") continue;
    for (const rule of spec.policy.never) {
      const re = POLICY_DETECTORS[rule];
      if (!re) continue;
      const m = re.exec(t.text);
      if (m) violations.push({ rule, turnText: t.text, matched: m[0] });
    }
  }

  const outcome: Scorecard["outcome"] =
    hints.escalated ? "escalated"
    : hints.ghosted ? "ghosted"
    : state.decision !== undefined ? "completed"
    : "exhausted";

  return {
    leadId: state.leadId,
    personaId: persona.id,
    evidenceCompleteness: required.length ? established.length / required.length : 1,
    evidenceCorrectness: gradable.length
      ? (gradable.length - hallucinated.length) / gradable.length
      : null,
    hallucinatedFields: hallucinated,
    policyViolations: violations,
    turnsUsed: state.turns.filter((t) => t.role === "lead").length,
    outcome,
    qualified: state.decision === "hot",
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 10 scorecard tests pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(batch): deterministic scorecards graded against persona ground truth"
```

---

## Task 6: The judge — qualitative scoring with `claude-opus-5`

**Files:**
- Create: `packages/batch/src/eval/judge.ts`
- Test: `packages/batch/test/judge.test.ts`

**Interfaces:**
- Consumes: `Scorecard`, `undetectableRules` (Task 5); `evidenceToZod` pattern (M1 Task 7); `cachedSystem`, `MAX_TOKENS` (M1 Task 7)
- Produces:
  - ```typescript
    interface Judgement {
      naturalness: number;        // 1..5
      questionQuality: number;    // 1..5
      policyBreaches: string[];   // rule ids the judge believes were breached
      notes: string;
    }
    interface JudgedScorecard extends Scorecard { judgement: Judgement | null }
    ```
  - `class ConversationJudge { constructor(client?); judge(spec, state, card): Promise<Judgement> }`
  - `attachJudgement(card, judgement): JudgedScorecard`

**Judge ≥ judged.** `claude-opus-5` at `effort: "high"`. A judge weaker than the thing it judges measures the judge. This is the one place in M2 where the model tier is non-negotiable.

- [ ] **Step 1: Write the failing test**

`packages/batch/test/judge.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { ConversationJudge, attachJudgement } from "../src/eval/judge.js";
import type { Scorecard } from "../src/eval/scorecard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const state: LeadState = {
  leadId: "sim_1", journey: spec.journey, journeyVersion: 4,
  evidence: {}, outcomes: [],
  turns: [
    { role: "agent", text: "Hi, which programme are you considering?", at: new Date() },
    { role: "lead", text: "executive mba", at: new Date() },
  ],
};

const card: Scorecard = {
  leadId: "sim_1", personaId: "p1", evidenceCompleteness: 0.33,
  evidenceCorrectness: 1, hallucinatedFields: [], policyViolations: [],
  turnsUsed: 1, outcome: "completed", qualified: false,
};

const VERDICT = {
  naturalness: 4, questionQuality: 5,
  policyBreaches: [], notes: "Concise and on-task.",
};

const fake = (parsed: unknown) =>
  ({ messages: { parse: vi.fn().mockResolvedValue({ parsed_output: parsed }) } });

describe("ConversationJudge", () => {
  it("returns the judged dimensions", async () => {
    const j = await new ConversationJudge(fake(VERDICT) as never).judge(spec, state, card);
    expect(j.naturalness).toBe(4);
    expect(j.questionQuality).toBe(5);
    expect(j.policyBreaches).toEqual([]);
  });

  it("judges with opus-5 at high effort", async () => {
    const client = fake(VERDICT);
    await new ConversationJudge(client as never).judge(spec, state, card);
    const req = client.messages.parse.mock.calls[0]![0] as {
      model: string; output_config: { effort: string }; thinking: unknown;
    };
    // The judge must never be weaker than the judged.
    expect(req.model).toBe("claude-opus-5");
    expect(req.output_config.effort).toBe("high");
    expect(req.thinking).toEqual({ type: "adaptive" });
  });

  it("asks only about rules the deterministic detectors cannot settle", async () => {
    const client = fake(VERDICT);
    await new ConversationJudge(client as never).judge(spec, state, card);
    const sent = JSON.stringify(client.messages.parse.mock.calls[0]![0]);
    expect(sent).toContain("compare_to_competitors");
    // quote_exact_fees is already settled by regex - do not pay a model to redo it.
    expect(sent).not.toContain("quote_exact_fees");
  });

  it("throws when the model returns no structured output", async () => {
    await expect(new ConversationJudge(fake(null) as never).judge(spec, state, card))
      .rejects.toThrow(/structured output/i);
  });

  it("attaches a judgement onto a scorecard without mutating it", () => {
    const judged = attachJudgement(card, VERDICT);
    expect(judged.judgement).toEqual(VERDICT);
    expect(judged.leadId).toBe("sim_1");
    expect(card).not.toHaveProperty("judgement");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/batch/test/judge.test.ts
```
Expected: FAIL — `../src/eval/judge.js` not found

- [ ] **Step 3: Write the judge**

`packages/batch/src/eval/judge.ts`:
```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { cachedSystem, createClient, MAX_TOKENS, MODEL } from "@midfunnel/runtime/claude";
import { undetectableRules, type Scorecard } from "./scorecard.js";

export interface Judgement {
  naturalness: number;
  questionQuality: number;
  policyBreaches: string[];
  notes: string;
}

export interface JudgedScorecard extends Scorecard {
  judgement: Judgement | null;
}

const judgementSchema = z.object({
  naturalness: z.number().min(1).max(5)
    .describe("Does this read like a competent human counsellor, not a form?"),
  questionQuality: z.number().min(1).max(5)
    .describe("Were the questions well-chosen, well-ordered, and never repeated?"),
  policyBreaches: z.array(z.string())
    .describe("Rule ids from the supplied list that the AGENT actually breached."),
  notes: z.string().max(400).describe("One or two sentences on the weakest moment."),
});

export class ConversationJudge {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? createClient();
  }

  /**
   * Scores what a regex cannot. The deterministic checks in Task 5 have already
   * settled completeness, correctness and the pattern-matchable policy rules;
   * asking the model to redo those would add cost and variance to facts we
   * already know exactly.
   */
  async judge(spec: JourneySpec, state: LeadState, card: Scorecard): Promise<Judgement> {
    const openRules = undetectableRules(spec);
    const transcript = state.turns
      .map((t) => `${t.role === "agent" ? "AGENT" : "LEAD"}: ${t.text}`)
      .join("\n");

    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      // The judge must never be weaker than the judged.
      output_config: { format: zodOutputFormat(judgementSchema), effort: "high" },
      system: cachedSystem([
        `You review lead-qualification conversations for a ${spec.vertical} institution.`,
        `The agent's goal was: ${spec.objective.goal}.`,
        "",
        "Judge only these policy rules — the others are already checked mechanically:",
        ...(openRules.length ? openRules.map((r) => `- ${r}`) : ["- (none)"]),
        "",
        "Score naturalness and questionQuality 1-5. Be exacting: 5 means you would be",
        "happy for this to represent the institution to a paying customer.",
        "Judge only the AGENT's conduct. Never penalise the agent for what the lead said.",
      ].join("\n")),
      messages: [{
        role: "user",
        content: JSON.stringify({
          transcript,
          mechanical_findings: {
            evidenceCompleteness: card.evidenceCompleteness,
            evidenceCorrectness: card.evidenceCorrectness,
            hallucinatedFields: card.hallucinatedFields,
            turnsUsed: card.turnsUsed,
            outcome: card.outcome,
          },
        }, null, 2),
      }],
    });

    const parsed = response.parsed_output as Judgement | null;
    if (!parsed) throw new Error("judge received no structured output from the model");
    return parsed;
  }
}

export function attachJudgement(card: Scorecard, judgement: Judgement | null): JudgedScorecard {
  return { ...card, judgement };
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 5 judge tests pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(batch): conversation judge scoring only what regexes cannot settle"
```

---

## Task 7: Alerting — thresholds over a run

**Files:**
- Create: `packages/batch/src/eval/alerts.ts`
- Test: `packages/batch/test/alerts.test.ts`

**Interfaces:**
- Consumes: `Scorecard`, `JudgedScorecard` (Tasks 5–6)
- Produces:
  - ```typescript
    interface RunQuality {
      n: number;
      meanCompleteness: number;
      meanCorrectness: number | null;
      violationRate: number;
      hallucinationRate: number;
      ghostRate: number;
      escalationRate: number;
      qualifiedRate: number;
      meanTurns: number;
    }
    interface Alert { id: string; severity: "warn" | "critical"; message: string; observed: number; threshold: number }
    ```
  - `aggregate(cards: Scorecard[]): RunQuality`
  - `DEFAULT_THRESHOLDS: Thresholds`
  - `evaluateAlerts(q: RunQuality, t?: Thresholds): Alert[]`

**This is demo moment 4.** Ship a deliberately bad journey version, run it through the simulator, and watch the harness catch it. A quality system that only ever reports "fine" proves nothing — the demo is the alert firing.

- [ ] **Step 1: Write the failing test**

`packages/batch/test/alerts.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { aggregate, evaluateAlerts, DEFAULT_THRESHOLDS } from "../src/eval/alerts.js";
import type { Scorecard } from "../src/eval/scorecard.js";

const card = (over: Partial<Scorecard> = {}): Scorecard => ({
  leadId: "l", personaId: "p", evidenceCompleteness: 1, evidenceCorrectness: 1,
  hallucinatedFields: [], policyViolations: [], turnsUsed: 4,
  outcome: "completed", qualified: true, ...over,
});

describe("aggregate", () => {
  it("summarises a healthy run", () => {
    const q = aggregate([card(), card(), card()]);
    expect(q.n).toBe(3);
    expect(q.meanCompleteness).toBe(1);
    expect(q.violationRate).toBe(0);
    expect(q.qualifiedRate).toBe(1);
  });

  it("computes rates over the whole cohort", () => {
    const q = aggregate([
      card(),
      card({ outcome: "ghosted", qualified: false }),
      card({ policyViolations: [{ rule: "promise_admission", turnText: "x", matched: "guaranteed" }] }),
      card({ outcome: "escalated", qualified: false }),
    ]);
    expect(q.ghostRate).toBe(0.25);
    expect(q.escalationRate).toBe(0.25);
    expect(q.violationRate).toBe(0.25);
    expect(q.qualifiedRate).toBe(0.5);
  });

  it("ignores ungradable conversations in mean correctness", () => {
    const q = aggregate([card({ evidenceCorrectness: null }), card({ evidenceCorrectness: 0.5 })]);
    expect(q.meanCorrectness).toBe(0.5);
  });

  it("reports null correctness when nothing was gradable", () => {
    expect(aggregate([card({ evidenceCorrectness: null })]).meanCorrectness).toBeNull();
  });

  it("handles an empty run without dividing by zero", () => {
    const q = aggregate([]);
    expect(q.n).toBe(0);
    expect(q.meanCompleteness).toBe(0);
    expect(q.meanCorrectness).toBeNull();
  });
});

describe("evaluateAlerts", () => {
  it("stays silent on a healthy run", () => {
    expect(evaluateAlerts(aggregate([card(), card(), card()]))).toEqual([]);
  });

  it("raises a critical alert on any policy violation", () => {
    const q = aggregate([card({
      policyViolations: [{ rule: "promise_admission", turnText: "x", matched: "guaranteed" }],
    })]);
    const alerts = evaluateAlerts(q);
    expect(alerts.find((a) => a.id === "policy_violations")?.severity).toBe("critical");
  });

  it("raises an alert when evidence collection collapses", () => {
    const q = aggregate(Array.from({ length: 10 }, () => card({ evidenceCompleteness: 0.2 })));
    expect(evaluateAlerts(q).map((a) => a.id)).toContain("evidence_completeness");
  });

  it("raises a critical alert on hallucinated evidence", () => {
    const q = aggregate(Array.from({ length: 10 }, () => card({
      evidenceCorrectness: 0.4, hallucinatedFields: ["target_program"],
    })));
    const a = evaluateAlerts(q).find((x) => x.id === "hallucination_rate");
    expect(a?.severity).toBe("critical");
  });

  it("raises an alert when leads ghost too often", () => {
    const q = aggregate(Array.from({ length: 10 }, (_, i) =>
      card(i < 7 ? { outcome: "ghosted", qualified: false } : {})));
    expect(evaluateAlerts(q).map((a) => a.id)).toContain("ghost_rate");
  });

  it("reports the observed value and the threshold it breached", () => {
    const q = aggregate(Array.from({ length: 10 }, () => card({ evidenceCompleteness: 0.2 })));
    const a = evaluateAlerts(q).find((x) => x.id === "evidence_completeness")!;
    expect(a.observed).toBeCloseTo(0.2, 5);
    expect(a.threshold).toBe(DEFAULT_THRESHOLDS.minEvidenceCompleteness);
  });

  it("accepts caller-supplied thresholds", () => {
    const q = aggregate([card({ evidenceCompleteness: 0.9 })]);
    expect(evaluateAlerts(q, { ...DEFAULT_THRESHOLDS, minEvidenceCompleteness: 0.95 }))
      .toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/batch/test/alerts.test.ts
```
Expected: FAIL — `../src/eval/alerts.js` not found

- [ ] **Step 3: Write the alerting module**

`packages/batch/src/eval/alerts.ts`:
```typescript
import type { Scorecard } from "./scorecard.js";

export interface RunQuality {
  n: number;
  meanCompleteness: number;
  meanCorrectness: number | null;
  violationRate: number;
  hallucinationRate: number;
  ghostRate: number;
  escalationRate: number;
  qualifiedRate: number;
  meanTurns: number;
}

export interface Alert {
  id: string;
  severity: "warn" | "critical";
  message: string;
  observed: number;
  threshold: number;
}

export interface Thresholds {
  minEvidenceCompleteness: number;
  minEvidenceCorrectness: number;
  maxViolationRate: number;
  maxHallucinationRate: number;
  maxGhostRate: number;
  maxEscalationRate: number;
}

/**
 * Deliberately strict on correctness and policy, lenient on ghosting: a lead
 * who stops replying is often the lead's choice, whereas a hallucinated fact
 * or a policy breach is always the agent's fault.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minEvidenceCompleteness: 0.6,
  minEvidenceCorrectness: 0.9,
  maxViolationRate: 0,
  maxHallucinationRate: 0.05,
  maxGhostRate: 0.5,
  maxEscalationRate: 0.3,
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round4 = (v: number) => Math.round(v * 10000) / 10000;

export function aggregate(cards: Scorecard[]): RunQuality {
  const n = cards.length;
  if (n === 0) {
    return {
      n: 0, meanCompleteness: 0, meanCorrectness: null, violationRate: 0,
      hallucinationRate: 0, ghostRate: 0, escalationRate: 0,
      qualifiedRate: 0, meanTurns: 0,
    };
  }

  const gradable = cards.map((c) => c.evidenceCorrectness).filter((v): v is number => v !== null);
  const rate = (pred: (c: Scorecard) => boolean) => round4(cards.filter(pred).length / n);

  return {
    n,
    meanCompleteness: round4(mean(cards.map((c) => c.evidenceCompleteness))),
    meanCorrectness: gradable.length ? round4(mean(gradable)) : null,
    violationRate: rate((c) => c.policyViolations.length > 0),
    hallucinationRate: rate((c) => c.hallucinatedFields.length > 0),
    ghostRate: rate((c) => c.outcome === "ghosted"),
    escalationRate: rate((c) => c.outcome === "escalated"),
    qualifiedRate: rate((c) => c.qualified),
    meanTurns: round4(mean(cards.map((c) => c.turnsUsed))),
  };
}

export function evaluateAlerts(q: RunQuality, t: Thresholds = DEFAULT_THRESHOLDS): Alert[] {
  if (q.n === 0) return [];
  const alerts: Alert[] = [];

  const over = (
    id: string, severity: Alert["severity"], observed: number, threshold: number, message: string,
  ) => { if (observed > threshold) alerts.push({ id, severity, message, observed, threshold }); };

  const under = (
    id: string, severity: Alert["severity"], observed: number, threshold: number, message: string,
  ) => { if (observed < threshold) alerts.push({ id, severity, message, observed, threshold }); };

  // A policy breach is never acceptable, so the threshold is zero.
  over("policy_violations", "critical", q.violationRate, t.maxViolationRate,
    `${(q.violationRate * 100).toFixed(1)}% of conversations breached a "never" rule`);

  over("hallucination_rate", "critical", q.hallucinationRate, t.maxHallucinationRate,
    `${(q.hallucinationRate * 100).toFixed(1)}% recorded evidence contradicting the lead`);

  under("evidence_completeness", "warn", q.meanCompleteness, t.minEvidenceCompleteness,
    `mean evidence completeness ${(q.meanCompleteness * 100).toFixed(1)}% is below target`);

  if (q.meanCorrectness !== null) {
    under("evidence_correctness", "critical", q.meanCorrectness, t.minEvidenceCorrectness,
      `mean evidence correctness ${(q.meanCorrectness * 100).toFixed(1)}% is below target`);
  }

  over("ghost_rate", "warn", q.ghostRate, t.maxGhostRate,
    `${(q.ghostRate * 100).toFixed(1)}% of leads stopped replying`);

  over("escalation_rate", "warn", q.escalationRate, t.maxEscalationRate,
    `${(q.escalationRate * 100).toFixed(1)}% escalated to a human`);

  return alerts;
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 12 alert tests pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(batch): run quality aggregation and threshold alerting"
```

---
## Task 8: Traffic allocation and the A/B scoreboard

**Files:**
- Create: `packages/batch/src/experiment/allocator.ts`, `packages/batch/src/experiment/compare.ts`
- Modify: `packages/batch/src/index.ts`
- Test: `packages/batch/test/allocator.test.ts`, `packages/batch/test/compare.test.ts`

**Interfaces:**
- Consumes: `RunQuality`, `aggregate` (Task 7); `RunSummary` (Task 4); `bootstrapDiffCI` (M1 Task 11); `Scorecard` (Task 5)
- Produces:
  - ```typescript
    interface Arm { target: string; weight: number }
    interface Allocation { source: string; arms: Arm[] }
    class TrafficAllocator {
      constructor(allocations: Allocation[]);
      allocate(source: string, key: string): string;
      split(source: string, keys: string[]): Record<string, string[]>;
    }

    interface ArmResult { target: string; summary: RunSummary; quality: RunQuality }
    interface Scoreboard {
      a: ArmResult; b: ArmResult;
      qualifiedDelta: number; qualifiedCi95: [number, number];
      completenessDelta: number; correctnessDelta: number | null;
      verdict: "b_better" | "a_better" | "inconclusive";
    }
    compareRuns(a: ArmResult, b: ArmResult, cardsA: Scorecard[], cardsB: Scorecard[]): Scoreboard
    ```

**One primitive, two stories.** `target` is an opaque string: `"journey@4"` versus `"journey@5"` is an **A/B test**; `"journey@5"` versus `"external:engati"` is a **parallel run**. Allocation is a deterministic hash of the key, so the same lead always lands in the same arm and re-running an experiment does not reshuffle the cohort.

- [ ] **Step 1: Write the failing tests**

`packages/batch/test/allocator.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { TrafficAllocator, type Allocation } from "../src/experiment/allocator.js";

const ab: Allocation = {
  source: "camp_1",
  arms: [{ target: "journey@4", weight: 50 }, { target: "journey@5", weight: 50 }],
};

const parallel: Allocation = {
  source: "landing_new",
  arms: [{ target: "journey@5", weight: 10 }, { target: "external:engati", weight: 90 }],
};

const keys = Array.from({ length: 4000 }, (_, i) => `lead_${i}`);

describe("TrafficAllocator", () => {
  it("is deterministic for a key", () => {
    const a = new TrafficAllocator([ab]);
    expect(a.allocate("camp_1", "lead_7")).toBe(a.allocate("camp_1", "lead_7"));
  });

  it("respects an even split within tolerance", () => {
    const a = new TrafficAllocator([ab]);
    const counts = keys.reduce<Record<string, number>>((acc, k) => {
      const t = a.allocate("camp_1", k);
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["journey@4"]! / keys.length).toBeGreaterThan(0.45);
    expect(counts["journey@4"]! / keys.length).toBeLessThan(0.55);
  });

  it("respects an uneven split, which is what a parallel run looks like", () => {
    const a = new TrafficAllocator([parallel]);
    const canary = keys.filter((k) => a.allocate("landing_new", k) === "journey@5").length;
    expect(canary / keys.length).toBeGreaterThan(0.06);
    expect(canary / keys.length).toBeLessThan(0.14);
  });

  it("keeps a key in the same arm when the source changes", () => {
    // Different experiments must not correlate, or a lead unlucky in one is
    // unlucky in all of them.
    const a = new TrafficAllocator([ab, { ...parallel, source: "camp_2" }]);
    const first = a.allocate("camp_1", "lead_3");
    expect(a.allocate("camp_1", "lead_3")).toBe(first);
  });

  it("throws for an unconfigured source", () => {
    expect(() => new TrafficAllocator([ab]).allocate("nope", "k")).toThrow(/no allocation/i);
  });

  it("rejects arms whose weights do not sum to 100", () => {
    expect(() => new TrafficAllocator([{ source: "s", arms: [{ target: "x", weight: 30 }] }]))
      .toThrow(/sum to 100/i);
  });

  it("splits a whole cohort into arms", () => {
    const groups = new TrafficAllocator([ab]).split("camp_1", keys);
    expect(Object.keys(groups).sort()).toEqual(["journey@4", "journey@5"]);
    expect(groups["journey@4"]!.length + groups["journey@5"]!.length).toBe(keys.length);
  });
});
```

`packages/batch/test/compare.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { aggregate } from "../src/eval/alerts.js";
import { compareRuns, type ArmResult } from "../src/experiment/compare.js";
import type { Scorecard } from "../src/eval/scorecard.js";

const card = (over: Partial<Scorecard> = {}): Scorecard => ({
  leadId: "l", personaId: "p", evidenceCompleteness: 1, evidenceCorrectness: 1,
  hallucinatedFields: [], policyViolations: [], turnsUsed: 4,
  outcome: "completed", qualified: true, ...over,
});

const cohort = (qualified: number, total: number) =>
  Array.from({ length: total }, (_, i) =>
    card(i < qualified ? {} : { qualified: false, outcome: "exhausted" }));

const arm = (target: string, cards: Scorecard[]): ArmResult => ({
  target,
  summary: {
    runId: target, journey: "j", journeyVersion: 4, n: cards.length,
    completed: cards.filter((c) => c.outcome === "completed").length,
    qualified: cards.filter((c) => c.qualified).length,
    escalated: 0, ghosted: 0, avgTurns: 4,
  },
  quality: aggregate(cards),
});

describe("compareRuns", () => {
  it("reports b better when the interval clears zero", () => {
    const a = cohort(180, 1000), b = cohort(280, 1000);
    const s = compareRuns(arm("journey@4", a), arm("journey@5", b), a, b);
    expect(s.qualifiedDelta).toBeGreaterThan(0);
    expect(s.qualifiedCi95[0]).toBeGreaterThan(0);
    expect(s.verdict).toBe("b_better");
  });

  it("reports a better when b regresses", () => {
    const a = cohort(300, 1000), b = cohort(150, 1000);
    expect(compareRuns(arm("x", a), arm("y", b), a, b).verdict).toBe("a_better");
  });

  it("reports inconclusive when the interval spans zero", () => {
    const a = cohort(200, 1000), b = cohort(205, 1000);
    expect(compareRuns(arm("x", a), arm("y", b), a, b).verdict).toBe("inconclusive");
  });

  it("is inconclusive on a tiny sample even with a big raw gap", () => {
    // Six leads is not evidence, however good the headline number looks.
    const a = cohort(1, 6), b = cohort(4, 6);
    expect(compareRuns(arm("x", a), arm("y", b), a, b).verdict).toBe("inconclusive");
  });

  it("carries completeness and correctness deltas", () => {
    const a = [card({ evidenceCompleteness: 0.5, evidenceCorrectness: 0.8 })];
    const b = [card({ evidenceCompleteness: 1, evidenceCorrectness: 1 })];
    const s = compareRuns(arm("x", a), arm("y", b), a, b);
    expect(s.completenessDelta).toBeCloseTo(0.5, 5);
    expect(s.correctnessDelta).toBeCloseTo(0.2, 5);
  });

  it("returns a null correctness delta when either arm is ungradable", () => {
    const a = [card({ evidenceCorrectness: null })];
    const b = [card({ evidenceCorrectness: 1 })];
    expect(compareRuns(arm("x", a), arm("y", b), a, b).correctnessDelta).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/batch/test/allocator.test.ts packages/batch/test/compare.test.ts
```
Expected: FAIL — `../src/experiment/allocator.js` not found

- [ ] **Step 3: Write the allocator**

`packages/batch/src/experiment/allocator.ts`:
```typescript
import { createHash } from "node:crypto";

export interface Arm { target: string; weight: number }
export interface Allocation { source: string; arms: Arm[] }

/**
 * Binds a traffic source to weighted targets.
 *
 * `target` is opaque on purpose. "journey@4" vs "journey@5" is an A/B test;
 * "journey@5" vs "external:engati" is a parallel run against the existing
 * platform. Same primitive, both stories — which is why adoption can be a
 * parallel run rather than a cutover.
 */
export class TrafficAllocator {
  private readonly bySource = new Map<string, Arm[]>();

  constructor(allocations: Allocation[]) {
    for (const a of allocations) {
      const total = a.arms.reduce((s, x) => s + x.weight, 0);
      if (total !== 100) {
        throw new Error(`allocation for "${a.source}" must sum to 100, got ${total}`);
      }
      this.bySource.set(a.source, a.arms);
    }
  }

  /**
   * Deterministic: the same lead always lands in the same arm, so re-running an
   * experiment does not reshuffle the cohort. The source is mixed into the hash
   * so separate experiments are uncorrelated — otherwise a lead unlucky in one
   * would be unlucky in all of them.
   */
  allocate(source: string, key: string): string {
    const arms = this.bySource.get(source);
    if (!arms) throw new Error(`no allocation configured for source "${source}"`);

    const digest = createHash("sha256").update(`${source}:${key}`).digest();
    const bucket = digest.readUInt32BE(0) % 100;

    let cumulative = 0;
    for (const arm of arms) {
      cumulative += arm.weight;
      if (bucket < cumulative) return arm.target;
    }
    return arms[arms.length - 1]!.target;
  }

  split(source: string, keys: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const arm of this.bySource.get(source) ?? []) out[arm.target] = [];
    for (const key of keys) (out[this.allocate(source, key)] ??= []).push(key);
    return out;
  }
}
```

- [ ] **Step 4: Write the comparison**

`packages/batch/src/experiment/compare.ts`:
```typescript
import { bootstrapDiffCI } from "../replay/stats.js";
import type { RunQuality } from "../eval/alerts.js";
import type { Scorecard } from "../eval/scorecard.js";
import type { RunSummary } from "../simulate/runner.js";

export interface ArmResult {
  target: string;
  summary: RunSummary;
  quality: RunQuality;
}

export interface Scoreboard {
  a: ArmResult;
  b: ArmResult;
  qualifiedDelta: number;
  qualifiedCi95: [number, number];
  completenessDelta: number;
  correctnessDelta: number | null;
  verdict: "b_better" | "a_better" | "inconclusive";
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The verdict is driven by the confidence interval, never by the raw delta.
 * A large gap on a small cohort is inconclusive, and saying so is the whole
 * value of the scoreboard — a system that declares a winner from twelve
 * conversations is worse than no system.
 */
export function compareRuns(
  a: ArmResult, b: ArmResult, cardsA: Scorecard[], cardsB: Scorecard[],
): Scoreboard {
  // Bootstrap is paired, so both arms must be the same length. Simulation runs
  // the same personas through both; truncate to the shorter if they differ.
  const n = Math.min(cardsA.length, cardsB.length);
  const ci95 = bootstrapDiffCI(
    cardsA.slice(0, n).map((c) => c.qualified),
    cardsB.slice(0, n).map((c) => c.qualified),
    { seed: 1 },
  );

  const qualifiedDelta = round4(b.quality.qualifiedRate - a.quality.qualifiedRate);
  const correctnessDelta =
    a.quality.meanCorrectness !== null && b.quality.meanCorrectness !== null
      ? round4(b.quality.meanCorrectness - a.quality.meanCorrectness)
      : null;

  const verdict: Scoreboard["verdict"] =
    ci95[0] > 0 ? "b_better"
    : ci95[1] < 0 ? "a_better"
    : "inconclusive";

  return {
    a, b, qualifiedDelta, qualifiedCi95: ci95,
    completenessDelta: round4(b.quality.meanCompleteness - a.quality.meanCompleteness),
    correctnessDelta,
    verdict,
  };
}
```

Add to `packages/batch/src/index.ts`:
```typescript
export * from "./eval/scorecard.js";
export * from "./eval/judge.js";
export * from "./eval/alerts.js";
export * from "./experiment/allocator.js";
export * from "./experiment/compare.js";
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 7 allocator + 6 compare tests pass

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(batch): deterministic traffic allocation and CI-driven scoreboard"
```

---

## Task 9: API and console — moments 3, 4 and 5

**Files:**
- Create: `packages/web/src/routes/simulate.ts`
- Modify: `packages/web/src/server.ts`, `packages/web/src/routes/replay.ts` (ServerDeps)
- Create: `packages/console/src/SimulateRun.tsx`, `packages/console/src/Scoreboard.tsx`
- Modify: `packages/console/src/App.tsx`, `packages/console/src/styles.css`
- Test: `packages/web/test/simulate.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8
- Produces:
  - `ServerDeps` gains `simulate: SimulationService`
  - ```typescript
    interface SimulationService {
      run(journey: string, version: number, n: number, seed?: number): Promise<{ summary: RunSummary; quality: RunQuality; alerts: Alert[] }>;
      compare(journey: string, va: number, vb: number, n: number, seed?: number): Promise<Scoreboard>;
    }
    ```
  - Routes: `POST /api/simulate` · `POST /api/compare`

**Note on the existing route file:** `packages/web/src/routes/replay.ts` currently owns `ServerDeps`. Move that interface into a new `packages/web/src/deps.ts` and import it from both route files — otherwise `simulate.ts` importing from `replay.ts` is a boundary that will read as accidental to whoever picks this up next.

- [ ] **Step 1: Write the failing test**

`packages/web/test/simulate.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { buildServer } from "../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8");
const V5 = V4.replace("version: 4", "version: 5");

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const RUN = {
  summary: { runId: "run_1", journey: "mba-admissions-qualification", journeyVersion: 4,
             n: 50, completed: 38, qualified: 12, escalated: 4, ghosted: 8, avgTurns: 4.2 },
  quality: { n: 50, meanCompleteness: 0.82, meanCorrectness: 0.94, violationRate: 0,
             hallucinationRate: 0.02, ghostRate: 0.16, escalationRate: 0.08,
             qualifiedRate: 0.24, meanTurns: 4.2 },
  alerts: [],
};

const BOARD = { verdict: "b_better", qualifiedDelta: 0.06, qualifiedCi95: [0.01, 0.11] };

let pool: Pool; let app: ReturnType<typeof buildServer>;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE journey_versions");
  const registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V4);
  await registry.publish(V5);
  app = buildServer({
    registry,
    store: new EventStore(pool, "t1"),
    replay: { replay: vi.fn() } as never,
    simulate: {
      run: vi.fn().mockResolvedValue(RUN),
      compare: vi.fn().mockResolvedValue(BOARD),
    } as never,
  });
});
afterAll(async () => { await pool.end(); });

describe("simulate routes", () => {
  it("runs a simulation and returns summary, quality and alerts", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ summary: { n: 50 }, quality: { qualifiedRate: 0.24 } });
  });

  it("rejects a malformed simulate body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/simulate", payload: { journey: 4 } });
    expect(res.statusCode).toBe(400);
  });

  it("caps the cohort size so one request cannot burn the batch budget", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 100000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/n must be/i);
  });

  it("compares two versions", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/compare",
      payload: { journey: "mba-admissions-qualification", a: 4, b: 5, n: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verdict: "b_better" });
  });

  it("502s an upstream failure rather than 404", async () => {
    const broken = buildServer({
      registry: new JourneyRegistry(pool, "t1"),
      store: new EventStore(pool, "t1"),
      replay: { replay: vi.fn() } as never,
      simulate: { run: vi.fn().mockRejectedValue(new Error("model unavailable")),
                  compare: vi.fn() } as never,
    });
    const res = await broken.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 10 },
    });
    expect(res.statusCode).toBe(502);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
npx vitest run packages/web/test/simulate.test.ts
```
Expected: FAIL — `simulate` is not a property of `ServerDeps`

- [ ] **Step 3: Extract shared deps**

Create `packages/web/src/deps.ts`:
```typescript
import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { ReplayEngine } from "@midfunnel/batch/replay/engine";
import type { RunSummary } from "@midfunnel/batch/simulate/runner";
import type { Alert, RunQuality } from "@midfunnel/batch/eval/alerts";
import type { Scoreboard } from "@midfunnel/batch/experiment/compare";

export interface SimulationResult {
  summary: RunSummary;
  quality: RunQuality;
  alerts: Alert[];
}

export interface SimulationService {
  run(journey: string, version: number, n: number, seed?: number): Promise<SimulationResult>;
  compare(journey: string, va: number, vb: number, n: number, seed?: number): Promise<Scoreboard>;
}

export interface ServerDeps {
  registry: JourneyRegistry;
  store: EventStore;
  replay: ReplayEngine;
  simulate: SimulationService;
}

/**
 * A missing journey is a 404; anything else (a failing model call, a database
 * error) is an upstream failure. Collapsing both into 404 hides the cause.
 */
export function statusFor(err: unknown): number {
  return /not found/i.test((err as Error).message) ? 404 : 502;
}
```

In `packages/web/src/routes/replay.ts`, delete the local `ServerDeps` interface and the local `statusFor`, and import both from `../deps.js`. Keep `export type { ServerDeps }` in `server.ts` re-exporting from `./deps.js` so existing imports keep working.

- [ ] **Step 4: Write the simulate routes**

`packages/web/src/routes/simulate.ts`:
```typescript
import type { FastifyInstance } from "fastify";
import { statusFor, type ServerDeps } from "../deps.js";

/** One request must not be able to start a five-figure model bill. */
const MAX_COHORT = 2000;

export function registerSimulateRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Body: { journey?: unknown; version?: unknown; n?: unknown; seed?: unknown } }>(
    "/api/simulate",
    async (req, reply) => {
      const { journey, version, n, seed } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(version)) {
        return reply.code(400).send({ error: "journey (string) and version (integer) are required" });
      }
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_COHORT) {
        return reply.code(400).send({ error: `n must be an integer between 1 and ${MAX_COHORT}` });
      }
      try {
        return await deps.simulate.run(
          journey, version as number, n as number,
          Number.isInteger(seed) ? (seed as number) : undefined,
        );
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { journey?: unknown; a?: unknown; b?: unknown; n?: unknown; seed?: unknown } }>(
    "/api/compare",
    async (req, reply) => {
      const { journey, a, b, n, seed } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "journey (string), a and b (integers) are required" });
      }
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_COHORT) {
        return reply.code(400).send({ error: `n must be an integer between 1 and ${MAX_COHORT}` });
      }
      try {
        return await deps.simulate.compare(
          journey, a as number, b as number, n as number,
          Number.isInteger(seed) ? (seed as number) : undefined,
        );
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );
}
```

In `packages/web/src/server.ts`, call `registerSimulateRoutes(app, deps)` inside `buildServer` next to the existing `registerRoutes(app, deps)`, and construct a real `SimulationService` in `main()` wiring `SimulationRunner`, `scoreConversation`, `aggregate`, `evaluateAlerts` and `compareRuns` — using `new EventStore(pool, tenantId, "sim")` for the simulation store, and `ScriptedReplier` when no Anthropic credential is present (same fallback and same loud warning as the extractor).

- [ ] **Step 5: Write the console screens**

Add to `packages/console/src/styles.css`:
```css
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 20px 0 24px; }
.tab {
  padding: 8px 14px; border: 0; background: none; color: var(--muted);
  font: inherit; cursor: pointer; border-bottom: 2px solid transparent;
}
.tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--fg); }
.alert { border-radius: 8px; padding: 12px 14px; margin: 8px 0; border: 1px solid; }
.alert.warn { border-color: var(--modelled); color: var(--modelled); }
.alert.critical { border-color: var(--danger); color: var(--danger); }
.ok { color: var(--observed); }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.metric { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--card); }
.metric-label { color: var(--muted); font-size: 12px; }
.metric-value { font-size: 22px; font-variant-numeric: tabular-nums; }
.verdict { font-size: 18px; margin: 16px 0; }
```

`packages/console/src/SimulateRun.tsx`:
```tsx
import { useState } from "react";

interface Alert { id: string; severity: "warn" | "critical"; message: string }
interface Quality {
  n: number; meanCompleteness: number; meanCorrectness: number | null;
  violationRate: number; hallucinationRate: number; ghostRate: number;
  escalationRate: number; qualifiedRate: number; meanTurns: number;
}
interface Result {
  summary: { runId: string; n: number; completed: number; qualified: number;
             escalated: number; ghosted: number; avgTurns: number };
  quality: Quality;
  alerts: Alert[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function SimulateRun({ journey, version }: { journey: string; version: number }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (n: number) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/simulate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ journey, version, n }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setResult(await r.json());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p className="muted">
        Drive synthetic leads through v{version} before a real one ever touches it.
      </p>
      <button className="tab" disabled={busy} onClick={() => void go(500)}>
        {busy ? "Simulating…" : "Simulate 500 leads"}
      </button>

      {error && <p className="err">Simulation failed: {error}</p>}

      {result && (
        <>
          <h2>Quality</h2>
          <div className="metrics">
            <Metric label="Evidence completeness" value={pct(result.quality.meanCompleteness)} />
            <Metric label="Evidence correctness"
                    value={result.quality.meanCorrectness === null ? "—" : pct(result.quality.meanCorrectness)} />
            <Metric label="Qualified" value={pct(result.quality.qualifiedRate)} />
            <Metric label="Ghosted" value={pct(result.quality.ghostRate)} />
            <Metric label="Escalated" value={pct(result.quality.escalationRate)} />
            <Metric label="Mean turns" value={result.quality.meanTurns.toFixed(1)} />
          </div>

          <h2>Alerts</h2>
          {result.alerts.length === 0
            ? <p className="ok">No thresholds breached.</p>
            : result.alerts.map((a) => (
                <div key={a.id} className={`alert ${a.severity}`}>
                  <strong>{a.severity.toUpperCase()}</strong> — {a.message}
                </div>
              ))}
        </>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
```

`packages/console/src/Scoreboard.tsx`:
```tsx
import { useState } from "react";

interface Board {
  a: { target: string; quality: { qualifiedRate: number; meanCompleteness: number } };
  b: { target: string; quality: { qualifiedRate: number; meanCompleteness: number } };
  qualifiedDelta: number;
  qualifiedCi95: [number, number];
  completenessDelta: number;
  correctnessDelta: number | null;
  verdict: "b_better" | "a_better" | "inconclusive";
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const VERDICT_TEXT: Record<Board["verdict"], string> = {
  b_better: "B wins — the interval clears zero",
  a_better: "A wins — B regressed",
  inconclusive: "Inconclusive — the interval spans zero, so this is not evidence",
};

export function Scoreboard({ journey, a, b }: { journey: string; a: number; b: number }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/compare", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ journey, a, b, n: 500 }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setBoard(await r.json());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p className="muted">
        The same 500 personas meet both versions, so the comparison is paired.
      </p>
      <button className="tab" disabled={busy} onClick={() => void go()}>
        {busy ? "Running both arms…" : `Compare v${a} vs v${b}`}
      </button>

      {error && <p className="err">Comparison failed: {error}</p>}

      {board && (
        <>
          <div className="arms">
            <div className="arm">
              <div className="arm-label">v{a}</div>
              <div className="arm-rate">{pct(board.a.quality.qualifiedRate)}</div>
              <div className="arm-label">qualified</div>
            </div>
            <div className="arm">
              <div className="arm-label">v{b}</div>
              <div className="arm-rate">{pct(board.b.quality.qualifiedRate)}</div>
              <div className="arm-label">qualified</div>
            </div>
          </div>

          <p className="verdict">
            <strong>{board.qualifiedDelta >= 0 ? "+" : ""}{pct(board.qualifiedDelta)}</strong>{" "}
            <span className="muted">
              (95% CI {pct(board.qualifiedCi95[0])} to {pct(board.qualifiedCi95[1])})
            </span>
          </p>
          <p className={board.verdict === "inconclusive" ? "muted" : "ok"}>
            {VERDICT_TEXT[board.verdict]}
          </p>
        </>
      )}
    </>
  );
}
```

`packages/console/src/App.tsx` — replace entirely:
```tsx
import { useState } from "react";
import "./styles.css";
import { ReplayComparison } from "./ReplayComparison.js";
import { SimulateRun } from "./SimulateRun.js";
import { Scoreboard } from "./Scoreboard.js";

const JOURNEY = "mba-admissions-qualification";
const TABS = ["Replay", "Simulate", "A/B"] as const;

export function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Replay");

  return (
    <main className="wrap">
      <h1>Mid-Funnel Console</h1>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} className="tab" role="tab"
                  aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Replay" && <ReplayComparison journey={JOURNEY} a={3} b={4} />}
      {tab === "Simulate" && <SimulateRun journey={JOURNEY} version={4} />}
      {tab === "A/B" && <Scoreboard journey={JOURNEY} a={4} b={5} />}
    </main>
  );
}
```

- [ ] **Step 6: Run everything**

```bash
npm test && npm run typecheck && npm run build -w @midfunnel/console
```
Expected: 5 simulate route tests pass; console builds

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web,console): simulate and A/B routes with tabbed console"
```

---

## Done When

- [ ] `npm test` and `npm run typecheck` are both green
- [ ] Simulated events are invisible to a live-scoped `EventStore`, and vice versa
- [ ] A run of 500 personas completes and produces a `RunQuality` — **moment 3**
- [ ] A journey version with `promise_admission` in a pinned message raises a **critical** alert — **moment 4**
- [ ] The scoreboard reports `inconclusive` on a small cohort and `b_better` on a large one with a real gap — **moment 5**
- [ ] The `sentiment < -0.5` rule in the reference journey actually fires
- [ ] Extraction correctness is measured against persona ground truth, not against the transcript

## Self-Review

**Spec coverage.** §15 M2 lists simulator, eval harness, scorecards, alerting and A/B scoreboard: Tasks 3–4, 5–6, 5, 7, 8 respectively, with 9 as the surface. §5.3's Traffic Allocator is Task 8. §5.4's "extraction is independently evaluable" is what Task 5's ground-truth correctness metric finally exercises.

**Type consistency.** `Persona` (Task 3) → `scoreConversation` (5) → `aggregate` (7) → `compareRuns` (8). `RunSummary` (4) is consumed by `ArmResult` (8) and `SimulationService` (9). `Scorecard` is defined once in Task 5; `JudgedScorecard` extends it rather than redefining. `RunQuality` and `Alert` are defined in Task 7 and imported everywhere after.

**Carried forward from M1, deliberately:** `EventStore`'s third constructor argument defaults to `"live"`, so every M1 call site compiles and behaves unchanged. Task 1's test suite asserts that explicitly rather than assuming it.

**Known limitations, all resolved later:**
- `LexiconSentiment` is a word list. It will miss sarcasm and code-mixed Hinglish, which matters for Indian edtech. The judge sees the same conversation and can flag what the lexicon missed; a model-backed sentiment pass is M3 if the gap proves material.
- `POLICY_DETECTORS` covers two of the three `never` rules; `compare_to_competitors` is genuinely a judgment call and goes to the judge. `undetectableRules` makes that split explicit rather than silently unchecked.
- The judge is not itself evaluated. Judge calibration against human labels is real work and belongs in M3, once there are human labels to calibrate against.
- `ScriptedReplier` matches questions by field-name and description keywords. It will mis-attribute an unusually phrased question, which understates the agent. `ModelReplier` is the honest path for real numbers; the scripted one exists for reproducibility and for running with no credential.

---
