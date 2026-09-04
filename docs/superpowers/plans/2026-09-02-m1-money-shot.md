# M1 — The Money Shot: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay a real historical lead cohort through two journey versions and produce a lift figure with a confidence interval, on an event spine where every event carries an enforced agent identity.

**Architecture:** A TypeScript monorepo shaped as a modulith. One append-only `events` table in Postgres is the integration point — components never call each other synchronously, they append to and fold over the log. A journey is a declarative YAML spec (objective + typed evidence schema + policy + agent identity); the Agent Runtime plans conversation to satisfy it. Attribution and replay are folds over the log, not a separate pipeline.

**Tech Stack:** Node 22 LTS · TypeScript 5.6 (ESM) · Fastify 5 · Zod 3 · `@anthropic-ai/sdk` · PostgreSQL 16 · Vitest · React 18 + Vite 5

**Spec:** `docs/superpowers/specs/2026-08-31-midfunnel-agent-platform-design.md`

> **Superseded in part (2026-09-04):** this plan was executed against the Anthropic
> SDK. The model provider has since moved to OpenAI — `provider.ts` replaces
> `claude.ts`, `responses.parse` replaces `messages.parse`, and the models are
> `gpt-5.6-sol` / `gpt-5.6-terra`. The shipped code is the source of truth; see
> spec §7.3 and decision-log rows 20–21. Everything else here still holds.

## Global Constraints

- **Node 22 LTS**, ESM only (`"type": "module"` in every package). `__dirname`/`__filename` are undefined — derive from `import.meta.url` when a script-relative path is needed.
- **Model IDs are exact strings, never date-suffixed:** `claude-opus-5` for runtime, extractor, replay, eval, insight, copilot. `claude-sonnet-5` for persona simulation (M2 only).
- **Thinking:** `thinking: { type: "adaptive" }`. `budget_tokens` is **rejected with a 400** on Opus 5 — never use it.
- **Effort:** `output_config: { effort: "low" | "high" | "xhigh" }`. Lives inside `output_config`, not top-level.
- **`max_tokens: 16000`** for non-streaming calls.
- **No assistant prefill** — returns 400 on Opus 5. Use structured outputs to constrain format.
- **Every event row carries `agent_id`.** There is no code path that appends an event without a principal.
- **Every `events` query filters on `tenant_id`.** No exceptions, including in tests.
- **The event log contains no `Converted` event.** Only observable facts. Metrics are declared predicates.
- **Money is `BIGINT` minor units (paise) + an ISO-4217 currency string.** Never floats.
- Test DB is `midfunnel_test`, reset between test files. Never point tests at `midfunnel_dev`.

---

## File Structure

```
package.json                      npm workspaces root
tsconfig.base.json                shared compiler options
docker-compose.yml                postgres:16
vitest.config.ts                  workspace test config
.env.example                      DATABASE_URL, ANTHROPIC_API_KEY

packages/core/                    shared by every role — no I/O beyond Postgres
  src/db/client.ts                pg Pool, tenant-scoped query helper
  src/db/migrate.ts               forward-only migration runner
  src/db/migrations/001_events.sql
  src/db/migrations/002_registries.sql
  src/events/types.ts             event union + Zod schemas + EventEnvelope
  src/events/store.ts             EventStore: append, appendMany, fold, query
  src/journey/spec.ts             JourneySpec Zod schema + type-expression parser
  src/journey/registry.ts         JourneyRegistry: publish, get, list, diff
  src/agent/registry.ts           AgentRegistry: get, authorize
  src/index.ts                    public surface

packages/runtime/                 live conversation stepping
  src/claude.ts                   Anthropic client + cached-prefix helper
  src/extractor.ts                EvidenceExtractor (structured outputs)
  src/broker.ts                   ToolBroker (privilege-enforcing)
  src/scoring.ts                  score() + route()
  src/step.ts                     AgentRuntime.step()

packages/batch/                   bursty, non-latency-sensitive work
  src/import/pii.ts               scrubbing rules
  src/import/importer.ts          ImportBoundary
  src/replay/stats.ts             bootstrap confidence interval
  src/replay/engine.ts            ReplayEngine

packages/web/
  src/server.ts                   Fastify app + role dispatch
  src/routes/replay.ts

packages/console/                 React + Vite
  src/App.tsx
  src/ReplayComparison.tsx
```

**Boundary rule:** `core` never imports from `runtime`, `batch`, or `web`. Dependencies point inward only.

---

## Task 1: Monorepo scaffold, Postgres, migration runner

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/core/src/db/client.ts`, `packages/core/src/db/migrate.ts`
- Create: `packages/core/src/db/migrations/001_events.sql`
- Test: `packages/core/test/migrate.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `pool: Pool`, `withTenant(tenantId, fn)`, `migrate(pool): Promise<string[]>` returning applied migration names

- [ ] **Step 1: Create the workspace root**

`package.json`:
```json
{
  "name": "midfunnel",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22" },
  "scripts": {
    "db:up": "docker compose up -d && sleep 3",
    "db:migrate": "tsx packages/core/src/db/migrate.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "dependencies": {
    "pg": "^8.13.0",
    "@types/pg": "^8.11.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true
  }
}
```

`docker-compose.yml`:
```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: midfunnel
      POSTGRES_PASSWORD: midfunnel
      POSTGRES_DB: midfunnel_dev
    ports: ["5433:5432"]
```

`.env.example`:
```
DATABASE_URL=postgres://midfunnel:midfunnel@localhost:5433/midfunnel_dev
TEST_DATABASE_URL=postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test
ANTHROPIC_API_KEY=
```

`.gitignore`:
```
node_modules/
dist/
.env
*.log
```

`vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
```

`packages/core/package.json`:
```json
{
  "name": "@midfunnel/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/migrate.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

let pool: Pool;

beforeAll(async () => {
  const admin = new Pool({
    connectionString: URL.replace(/\/[^/]+$/, "/postgres"),
  });
  await admin.query("DROP DATABASE IF EXISTS midfunnel_test");
  await admin.query("CREATE DATABASE midfunnel_test");
  await admin.end();
  pool = new Pool({ connectionString: URL });
});

afterAll(async () => { await pool.end(); });

describe("migrate", () => {
  it("applies 001_events and creates the events table with agent_id", async () => {
    const applied = await migrate(pool);
    expect(applied).toContain("001_events.sql");

    const { rows } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'events' ORDER BY ordinal_position`
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual([
      "id", "tenant_id", "lead_id", "journey", "journey_version",
      "agent_id", "type", "payload", "occurred_at", "recorded_at",
    ]);
  });

  it("is idempotent - a second run applies nothing", async () => {
    const applied = await migrate(pool);
    expect(applied).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npm install && npm run db:up && npx vitest run packages/core/test/migrate.test.ts
```
Expected: FAIL — `Cannot find module '../src/db/migrate.js'`

- [ ] **Step 4: Write the migration SQL**

`packages/core/src/db/migrations/001_events.sql`:
```sql
CREATE TABLE events (
  id              BIGSERIAL   PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  lead_id         TEXT        NOT NULL,
  journey         TEXT        NOT NULL,
  journey_version INT         NOT NULL,
  agent_id        TEXT        NOT NULL,
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_lead_idx    ON events (tenant_id, lead_id, occurred_at);
CREATE INDEX events_journey_idx ON events (tenant_id, journey, journey_version, type);
CREATE INDEX events_agent_idx   ON events (tenant_id, agent_id, occurred_at);
CREATE INDEX events_payload_idx ON events USING GIN (payload);
```

- [ ] **Step 5: Write the client and migration runner**

`packages/core/src/db/client.ts`:
```typescript
import pg from "pg";

// Money is BIGINT minor units. node-pg returns int8 as string by default;
// parse to number, which is exact below 2^53 (~90 trillion paise).
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Pool = pg.Pool;

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString });
}
```

`packages/core/src/db/migrate.ts`:
```typescript
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "migrations");

/** Forward-only. Returns the names applied by THIS call. */
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  const done = new Set(rows.map((r) => r.name));
  const pending = readdirSync(DIR).filter((f) => f.endsWith(".sql") && !done.has(f)).sort();

  const applied: string[] = [];
  for (const name of pending) {
    const sql = readFileSync(join(DIR, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npx vitest run packages/core/test/migrate.test.ts
```
Expected: PASS — 2 tests

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: monorepo scaffold, postgres, forward-only migration runner"
```

---
## Task 2: Event types and the EventStore

**Files:**
- Create: `packages/core/src/events/types.ts`, `packages/core/src/events/store.ts`
- Modify: `packages/core/package.json` (add `zod`, `uuid`)
- Test: `packages/core/test/store.test.ts`

**Interfaces:**
- Consumes: `createPool`, `migrate` (Task 1)
- Produces:
  - `EVENT_TYPES: readonly string[]`, `type EventType`
  - `interface EventInput { leadId; journey; journeyVersion; agentId; type; payload; occurredAt? }`
  - `interface StoredEvent extends EventInput { id: number; tenantId: string; occurredAt: Date; recordedAt: Date }`
  - `class EventStore { constructor(pool, tenantId); append(e): Promise<StoredEvent>; appendMany(es): Promise<StoredEvent[]>; fold(leadId): Promise<LeadState>; query(filter): Promise<StoredEvent[]> }`
  - `interface LeadState { leadId; journey; journeyVersion; evidence: Record<string,{value,confidence}>; turns: Turn[]; score?: number; decision?: string; outcomes: OutcomePayload[] }`
  - `interface Turn { role: "agent" | "lead"; text: string; at: Date }`

- [ ] **Step 1: Add dependencies**

```bash
npm install zod@^3.23.0 uuid@^10.0.0 -w @midfunnel/core
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/store.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createPool, type Pool } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { EventStore } from "../src/events/store.js";

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

let pool: Pool;
let store: EventStore;

const base = {
  journey: "mba-admissions-qualification",
  journeyVersion: 4,
  agentId: "agent://engati/mba-admissions",
};

beforeAll(async () => {
  pool = createPool(URL);
  await migrate(pool);
});
beforeEach(async () => { await pool.query("TRUNCATE events"); store = new EventStore(pool, "t1"); });
afterAll(async () => { await pool.end(); });

describe("EventStore", () => {
  it("round-trips an event with its agent principal", async () => {
    const saved = await store.append({
      ...base, leadId: "L1", type: "LeadIngested",
      payload: { source: "meta_lead_ads", campaignId: "c1" },
    });
    expect(saved.id).toBeGreaterThan(0);
    expect(saved.agentId).toBe(base.agentId);
    expect(saved.tenantId).toBe("t1");
  });

  it("refuses an event with no agent principal", async () => {
    await expect(store.append({
      ...base, agentId: "", leadId: "L1", type: "LeadIngested", payload: {},
    })).rejects.toThrow(/agentId/);
  });

  it("refuses an unknown event type", async () => {
    await expect(store.append({
      ...base, leadId: "L1", type: "Converted" as never, payload: {},
    })).rejects.toThrow(/unknown event type/i);
  });

  it("never returns another tenant's events", async () => {
    await store.append({ ...base, leadId: "L1", type: "LeadIngested", payload: {} });
    const other = new EventStore(pool, "t2");
    expect(await other.query({ leadId: "L1" })).toEqual([]);
  });

  it("folds a lead into evidence, turns, score and decision", async () => {
    await store.appendMany([
      { ...base, leadId: "L1", type: "LeadIngested", payload: { source: "meta_lead_ads" } },
      { ...base, leadId: "L1", type: "MessageSent", payload: { renderedText: "Hi there" } },
      { ...base, leadId: "L1", type: "MessageReceived", payload: { rawText: "exec mba please" } },
      { ...base, leadId: "L1", type: "EvidenceExtracted",
        payload: { field: "target_program", value: "executive_mba", confidence: 0.91 } },
      { ...base, leadId: "L1", type: "EvidenceExtracted",
        payload: { field: "target_program", value: "online_mba", confidence: 0.95 } },
      { ...base, leadId: "L1", type: "Scored", payload: { score: 72 } },
      { ...base, leadId: "L1", type: "Routed", payload: { decision: "hot", target: "handoff.counsellor" } },
      { ...base, leadId: "L1", type: "OutcomeObserved",
        payload: { outcome: "enrolled", amount: 45000000, currency: "INR" } },
    ]);

    const s = await store.fold("L1");
    // Later extraction of the same field wins.
    expect(s.evidence.target_program).toEqual({ value: "online_mba", confidence: 0.95 });
    expect(s.turns.map((t) => t.role)).toEqual(["agent", "lead"]);
    expect(s.score).toBe(72);
    expect(s.decision).toBe("hot");
    expect(s.outcomes[0]).toMatchObject({ outcome: "enrolled", amount: 45000000 });
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx vitest run packages/core/test/store.test.ts
```
Expected: FAIL — `Cannot find module '../src/events/store.js'`

- [ ] **Step 4: Write the event types**

`packages/core/src/events/types.ts`:
```typescript
import { z } from "zod";

/**
 * Observable facts only. There is deliberately NO `Converted` event —
 * "converted" means different things to different teams, so it is a declared
 * predicate over these facts (see JourneySpec.metrics), never a stored fact.
 */
export const EVENT_TYPES = [
  "LeadIngested", "MessageSent", "MessageReceived", "EvidenceExtracted",
  "PolicyEvaluated", "ToolInvoked", "AuthorizationDenied", "Scored", "Routed",
  "HandoffCreated", "NurtureScheduled", "OutcomeObserved", "CostObserved",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const eventInputSchema = z.object({
  leadId: z.string().min(1),
  journey: z.string().min(1),
  journeyVersion: z.number().int().positive(),
  agentId: z.string().min(1, "agentId is required — every event needs a principal"),
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.unknown()),
  occurredAt: z.date().optional(),
});

export type EventInput = z.infer<typeof eventInputSchema>;

export interface StoredEvent {
  id: number;
  tenantId: string;
  leadId: string;
  journey: string;
  journeyVersion: number;
  agentId: string;
  type: EventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
  recordedAt: Date;
}

export interface Turn { role: "agent" | "lead"; text: string; at: Date }

export interface OutcomePayload {
  outcome: "attended" | "applied" | "enrolled" | "paid";
  amount?: number;
  currency?: string;
}

export interface LeadState {
  leadId: string;
  journey: string;
  journeyVersion: number;
  evidence: Record<string, { value: unknown; confidence: number }>;
  turns: Turn[];
  score?: number;
  decision?: string;
  outcomes: OutcomePayload[];
}
```

- [ ] **Step 5: Write the EventStore**

`packages/core/src/events/store.ts`:
```typescript
import type { Pool } from "../db/client.js";
import {
  EVENT_TYPES, eventInputSchema,
  type EventInput, type LeadState, type OutcomePayload, type StoredEvent, type Turn,
} from "./types.js";

const COLS = `id, tenant_id, lead_id, journey, journey_version,
              agent_id, type, payload, occurred_at, recorded_at`;

export interface EventFilter {
  leadId?: string;
  journey?: string;
  journeyVersion?: number;
  type?: string;
  limit?: number;
}

export class EventStore {
  constructor(private readonly pool: Pool, private readonly tenantId: string) {
    if (!tenantId) throw new Error("EventStore requires a tenantId");
  }

  private validate(e: EventInput): EventInput {
    if (!EVENT_TYPES.includes(e.type as never)) {
      throw new Error(`unknown event type: ${e.type}`);
    }
    return eventInputSchema.parse(e);
  }

  async append(e: EventInput): Promise<StoredEvent> {
    const [row] = await this.appendMany([e]);
    return row!;
  }

  async appendMany(events: EventInput[]): Promise<StoredEvent[]> {
    if (events.length === 0) return [];
    const valid = events.map((e) => this.validate(e));

    const values: unknown[] = [];
    const tuples = valid.map((e, i) => {
      const o = i * 8;
      values.push(
        this.tenantId, e.leadId, e.journey, e.journeyVersion,
        e.agentId, e.type, JSON.stringify(e.payload), e.occurredAt ?? new Date(),
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
    });

    const { rows } = await this.pool.query(
      `INSERT INTO events (tenant_id, lead_id, journey, journey_version,
                           agent_id, type, payload, occurred_at)
       VALUES ${tuples.join(",")} RETURNING ${COLS}`,
      values,
    );
    return rows.map(toStored);
  }

  /** Always tenant-scoped. There is no unscoped read path. */
  async query(filter: EventFilter = {}): Promise<StoredEvent[]> {
    const where = ["tenant_id = $1"];
    const values: unknown[] = [this.tenantId];
    const add = (sql: string, v: unknown) => { values.push(v); where.push(`${sql} $${values.length}`); };

    if (filter.leadId) add("lead_id =", filter.leadId);
    if (filter.journey) add("journey =", filter.journey);
    if (filter.journeyVersion !== undefined) add("journey_version =", filter.journeyVersion);
    if (filter.type) add("type =", filter.type);

    const limit = filter.limit ? ` LIMIT ${Number(filter.limit)}` : "";
    const { rows } = await this.pool.query(
      `SELECT ${COLS} FROM events WHERE ${where.join(" AND ")}
       ORDER BY occurred_at ASC, id ASC${limit}`,
      values,
    );
    return rows.map(toStored);
  }

  /** Reconstruct everything known about a lead. This is the only read model. */
  async fold(leadId: string): Promise<LeadState> {
    const events = await this.query({ leadId });
    const state: LeadState = {
      leadId,
      journey: events[0]?.journey ?? "",
      journeyVersion: events[0]?.journeyVersion ?? 0,
      evidence: {}, turns: [], outcomes: [],
    };

    for (const e of events) {
      const p = e.payload as Record<string, never>;
      switch (e.type) {
        case "MessageSent":
          state.turns.push({ role: "agent", text: String(p.renderedText ?? ""), at: e.occurredAt } satisfies Turn);
          break;
        case "MessageReceived":
          state.turns.push({ role: "lead", text: String(p.rawText ?? ""), at: e.occurredAt } satisfies Turn);
          break;
        case "EvidenceExtracted":
          // Last write wins: a later extraction supersedes an earlier one.
          state.evidence[String(p.field)] = { value: p.value, confidence: Number(p.confidence) };
          break;
        case "Scored":   state.score = Number(p.score); break;
        case "Routed":   state.decision = String(p.decision); break;
        case "OutcomeObserved": state.outcomes.push(e.payload as unknown as OutcomePayload); break;
        default: break;
      }
    }
    return state;
  }
}

function toStored(r: Record<string, never>): StoredEvent {
  return {
    id: Number(r.id), tenantId: r.tenant_id, leadId: r.lead_id,
    journey: r.journey, journeyVersion: Number(r.journey_version),
    agentId: r.agent_id, type: r.type, payload: r.payload,
    occurredAt: r.occurred_at, recordedAt: r.recorded_at,
  };
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npx vitest run packages/core/test/store.test.ts
```
Expected: PASS — 5 tests

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): event types and tenant-scoped EventStore with fold"
```

---
## Task 3: Journey spec schema, type-expression parser, JSON Schema compiler

**Files:**
- Create: `packages/core/src/journey/spec.ts`
- Create: `packages/core/test/fixtures/mba-v4.yaml` (verbatim from the design spec §6)
- Modify: `packages/core/package.json` (add `yaml`)
- Test: `packages/core/test/spec.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `journeySpecSchema: ZodSchema<JourneySpec>`
  - `type JourneySpec` with `.journey .version .vertical .owner .agent .objective .evidence .policy .pinned .scoring .routing .tools .metrics`
  - `type AgentBlock { persona; identity; privileges: string[]; dataScope: { read: string[]; deny: string[] } }`
  - `parseSpec(yamlText: string): JourneySpec` — throws with a readable path on failure
  - `parseTypeExpr(expr: string): { kind: "enum"; values: string[] } | { kind: "string" | "number" | "boolean" }`
  - `evidenceToJsonSchema(spec: JourneySpec): Record<string, unknown>` — the object passed to `output_config.format` in Task 7
  - `requiredEvidenceFields(spec): string[]`

- [ ] **Step 1: Add the YAML dependency and the fixture**

```bash
npm install yaml@^2.5.0 -w @midfunnel/core
```

Copy the complete `mba-admissions-qualification` spec from
`docs/superpowers/specs/2026-08-31-midfunnel-agent-platform-design.md` §6 into
`packages/core/test/fixtures/mba-v4.yaml`, verbatim including comments.

- [ ] **Step 2: Write the failing test**

`packages/core/test/spec.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, parseTypeExpr, evidenceToJsonSchema, requiredEvidenceFields }
  from "../src/journey/spec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const yaml = readFileSync(join(HERE, "fixtures/mba-v4.yaml"), "utf8");

describe("parseTypeExpr", () => {
  it("parses an enum expression", () => {
    expect(parseTypeExpr("enum[executive_mba, full_time_mba, online_mba]"))
      .toEqual({ kind: "enum", values: ["executive_mba", "full_time_mba", "online_mba"] });
  });
  it("parses scalars", () => {
    expect(parseTypeExpr("string")).toEqual({ kind: "string" });
    expect(parseTypeExpr("number")).toEqual({ kind: "number" });
  });
  it("rejects nonsense", () => {
    expect(() => parseTypeExpr("enum[")).toThrow(/type expression/i);
  });
});

describe("parseSpec", () => {
  it("parses the reference MBA journey", () => {
    const s = parseSpec(yaml);
    expect(s.journey).toBe("mba-admissions-qualification");
    expect(s.version).toBe(4);
    expect(s.agent.identity).toBe("agent://engati/mba-admissions");
    expect(s.agent.privileges).toHaveLength(3);
    expect(s.objective.goal).toBe("book_counselling_call");
    expect(Object.keys(s.evidence)).toContain("budget_band");
    expect(s.evidence.budget_band?.sensitive).toBe(true);
    expect(s.policy.never).toContain("promise_admission");
    expect(s.metrics.conversion).toMatch(/OutcomeObserved/);
    expect(s.tools.map((t) => t.capability)).toContain("crm.upsert_lead");
  });

  it("rejects a spec with no agent identity", () => {
    const bad = yaml.replace("identity: agent://engati/mba-admissions", "identity: ''");
    expect(() => parseSpec(bad)).toThrow(/identity/);
  });

  it("rejects a spec declaring a tool it has no privilege for", () => {
    const bad = yaml.replace("  - capability: crm.upsert_lead",
                             "  - capability: payment.charge_card");
    expect(() => parseSpec(bad)).toThrow(/payment\.charge_card.*privilege/i);
  });

  it("lists required evidence fields only", () => {
    expect(requiredEvidenceFields(parseSpec(yaml)).sort())
      .toEqual(["budget_band", "target_program", "timeline"]);
  });
});

describe("evidenceToJsonSchema", () => {
  it("compiles the evidence block into a strict JSON Schema", () => {
    const js = evidenceToJsonSchema(parseSpec(yaml)) as never as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type?: string; enum?: string[]; maxLength?: number }>;
    };
    expect(js.type).toBe("object");
    expect(js.additionalProperties).toBe(false);
    // Every field is required in the schema; optionality is expressed by a
    // nullable value, so the model must explicitly say "not established".
    expect(js.required.sort()).toEqual([
      "budget_band", "decision_maker", "prior_qualification", "target_program", "timeline",
    ]);
    expect(js.properties.target_program?.enum)
      .toEqual(["executive_mba", "full_time_mba", "online_mba"]);
    expect(js.properties.prior_qualification?.maxLength).toBe(120);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx vitest run packages/core/test/spec.test.ts
```
Expected: FAIL — `Cannot find module '../src/journey/spec.js'`

- [ ] **Step 4: Write the spec module**

`packages/core/src/journey/spec.ts`:
```typescript
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type TypeExpr =
  | { kind: "enum"; values: string[] }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" };

/** Parses the mini type syntax used in `evidence:` — `enum[a, b]`, `string`, ... */
export function parseTypeExpr(expr: string): TypeExpr {
  const t = expr.trim();
  if (t === "string" || t === "number" || t === "boolean") return { kind: t };
  const m = /^enum\[([^\]]*)\]$/.exec(t);
  if (!m) throw new Error(`invalid type expression: ${expr}`);
  const values = m[1]!.split(",").map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`invalid type expression: ${expr}`);
  return { kind: "enum", values };
}

const agentBlock = z.object({
  persona: z.string().min(1),
  identity: z.string().min(1, "agent.identity is required — an agent must be a principal"),
  privileges: z.array(z.string().min(1)).min(1),
  data_scope: z.object({
    read: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default({ read: [], deny: [] }),
});

const evidenceField = z.object({
  type: z.string(),
  required: z.boolean().default(false),
  confidence_min: z.number().min(0).max(1).default(0.7),
  sensitive: z.boolean().default(false),
  description: z.string().optional(),
  example: z.unknown().optional(),
  maxLength: z.number().int().positive().optional(),
});

const routeRule = z.object({
  when: z.string(),
  target: z.string(),
  sla: z.string().optional(),
});

const rawSpec = z.object({
  journey: z.string().min(1),
  version: z.number().int().positive(),
  vertical: z.string().min(1),
  owner: z.string().min(1),
  agent: agentBlock,
  objective: z.object({ goal: z.string().min(1), qualifies_when: z.string().min(1) }),
  evidence: z.record(evidenceField),
  policy: z.object({
    never: z.array(z.string()).default([]),
    must_disclose: z.string().optional(),
    escalate_when: z.array(z.string()).default([]),
    max_turns: z.number().int().positive().default(20),
    quiet_hours: z.object({ start: z.string(), end: z.string(), tz: z.string() }).optional(),
  }),
  pinned: z.record(z.string()).default({}),
  scoring: z.object({ weights: z.record(z.number()) }),
  routing: z.record(routeRule),
  tools: z.array(z.object({ capability: z.string().min(1), binding: z.string().min(1) })),
  metrics: z.record(z.string()).default({}),
});

export interface JourneySpec extends z.infer<typeof rawSpec> {
  agent: z.infer<typeof agentBlock> & { dataScope: { read: string[]; deny: string[] } };
}

export function parseSpec(yamlText: string): JourneySpec {
  const parsed = rawSpec.parse(parseYaml(yamlText));

  // Every evidence type expression must be well-formed.
  for (const [field, def] of Object.entries(parsed.evidence)) parseTypeExpr(def.type);

  // A journey may not declare a tool its agent has no privilege for.
  // Privileges are `capability:scope`; match on the capability half.
  const granted = new Set(parsed.agent.privileges.map((p) => p.split(":")[0]));
  for (const t of parsed.tools) {
    if (!granted.has(t.capability)) {
      throw new Error(
        `tool "${t.capability}" is declared but the agent holds no privilege for it`,
      );
    }
  }

  return { ...parsed, agent: { ...parsed.agent, dataScope: parsed.agent.data_scope } };
}

export function requiredEvidenceFields(spec: JourneySpec): string[] {
  return Object.entries(spec.evidence).filter(([, d]) => d.required).map(([f]) => f);
}

/**
 * The evidence block IS a JSON Schema. This is why Approach B works and a
 * prompt-based approach cannot: the API guarantees conformance.
 *
 * Every field is `required` with a nullable value rather than optional, so the
 * model must explicitly report "not established" instead of silently omitting.
 */
export function evidenceToJsonSchema(spec: JourneySpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const [field, def] of Object.entries(spec.evidence)) {
    const t = parseTypeExpr(def.type);
    const value =
      t.kind === "enum"
        ? { type: ["string", "null"], enum: [...t.values, null] }
        : t.kind === "string"
          ? { type: ["string", "null"], ...(def.maxLength ? { maxLength: def.maxLength } : {}) }
          : { type: [t.kind, "null"] };

    properties[field] = {
      type: "object",
      additionalProperties: false,
      required: ["value", "confidence"],
      description: def.description ?? `Evidence field ${field}`,
      properties: {
        value,
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(spec.evidence),
    properties,
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npx vitest run packages/core/test/spec.test.ts
```
Expected: PASS — 8 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): journey spec schema, type parser, evidence-to-JSON-Schema compiler"
```

---

## Task 4: Journey Registry — publish, get, list, diff

**Files:**
- Create: `packages/core/src/journey/registry.ts`
- Create: `packages/core/src/db/migrations/002_registries.sql`
- Test: `packages/core/test/registry.test.ts`

**Interfaces:**
- Consumes: `parseSpec`, `JourneySpec` (Task 3); `Pool`, `migrate` (Task 1)
- Produces:
  - `interface SpecChange { path: string; kind: "added" | "removed" | "changed"; before?: unknown; after?: unknown }`
  - `class JourneyRegistry { constructor(pool, tenantId); publish(yamlText): Promise<JourneySpec>; get(journey, version): Promise<JourneySpec>; list(journey): Promise<number[]>; diff(journey, va, vb): Promise<SpecChange[]> }`

- [ ] **Step 1: Write the migration**

`packages/core/src/db/migrations/002_registries.sql`:
```sql
CREATE TABLE journey_versions (
  tenant_id    TEXT        NOT NULL,
  journey      TEXT        NOT NULL,
  version      INT         NOT NULL,
  yaml_source  TEXT        NOT NULL,
  spec         JSONB       NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, journey, version)
);
```

- [ ] **Step 2: Write the failing test**

`packages/core/test/registry.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { JourneyRegistry } from "../src/journey/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "fixtures/mba-v4.yaml"), "utf8");
// v3 is v4 with decision_maker optional and no scholarship weighting.
const V3 = V4.replace("version: 4", "version: 3")
             .replace(/  decision_maker:\n    type: enum\[self, parent, employer\]\n    required: false\n    example: employer\n/,
                      "  decision_maker:\n    type: enum[self, parent, employer]\n    required: false\n");

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

let pool: Pool;
let reg: JourneyRegistry;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE journey_versions"); reg = new JourneyRegistry(pool, "t1"); });
afterAll(async () => { await pool.end(); });

describe("JourneyRegistry", () => {
  it("publishes and reads back a version", async () => {
    await reg.publish(V4);
    const s = await reg.get("mba-admissions-qualification", 4);
    expect(s.version).toBe(4);
    expect(s.agent.privileges).toHaveLength(3);
  });

  it("rejects republishing the same version", async () => {
    await reg.publish(V4);
    await expect(reg.publish(V4)).rejects.toThrow(/already published/i);
  });

  it("rejects an invalid spec before it reaches the database", async () => {
    await expect(reg.publish("journey: broken\nversion: 1")).rejects.toThrow();
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM journey_versions");
    expect(rows[0].n).toBe(0);
  });

  it("lists versions newest first", async () => {
    await reg.publish(V3);
    await reg.publish(V4);
    expect(await reg.list("mba-admissions-qualification")).toEqual([4, 3]);
  });

  it("produces a characterisable diff between two versions", async () => {
    await reg.publish(V3);
    await reg.publish(V4);
    const changes = await reg.diff("mba-admissions-qualification", 3, 4);
    const paths = changes.map((c) => c.path);
    expect(paths).toContain("version");
    expect(changes.find((c) => c.path === "version"))
      .toMatchObject({ kind: "changed", before: 3, after: 4 });
  });

  it("never reads another tenant's journeys", async () => {
    await reg.publish(V4);
    const other = new JourneyRegistry(pool, "t2");
    await expect(other.get("mba-admissions-qualification", 4)).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx vitest run packages/core/test/registry.test.ts
```
Expected: FAIL — `Cannot find module '../src/journey/registry.js'`

- [ ] **Step 4: Write the registry**

`packages/core/src/journey/registry.ts`:
```typescript
import type { Pool } from "../db/client.js";
import { parseSpec, type JourneySpec } from "./spec.js";

export interface SpecChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export class JourneyRegistry {
  constructor(private readonly pool: Pool, private readonly tenantId: string) {
    if (!tenantId) throw new Error("JourneyRegistry requires a tenantId");
  }

  /** Validates before writing — an invalid spec never reaches the database. */
  async publish(yamlText: string): Promise<JourneySpec> {
    const spec = parseSpec(yamlText);
    const existing = await this.pool.query(
      `SELECT 1 FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 AND version = $3`,
      [this.tenantId, spec.journey, spec.version],
    );
    if (existing.rowCount) {
      throw new Error(`${spec.journey} v${spec.version} is already published; versions are immutable`);
    }
    await this.pool.query(
      `INSERT INTO journey_versions (tenant_id, journey, version, yaml_source, spec)
       VALUES ($1,$2,$3,$4,$5)`,
      [this.tenantId, spec.journey, spec.version, yamlText, JSON.stringify(spec)],
    );
    return spec;
  }

  async get(journey: string, version: number): Promise<JourneySpec> {
    const { rows } = await this.pool.query(
      `SELECT spec FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 AND version = $3`,
      [this.tenantId, journey, version],
    );
    if (rows.length === 0) throw new Error(`journey not found: ${journey} v${version}`);
    return rows[0].spec as JourneySpec;
  }

  async list(journey: string): Promise<number[]> {
    const { rows } = await this.pool.query(
      `SELECT version FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 ORDER BY version DESC`,
      [this.tenantId, journey],
    );
    return rows.map((r) => Number(r.version));
  }

  /**
   * A characterisable diff. This is what makes A/B meaningful — you can
   * attribute lift to "added decision_maker to required", which is impossible
   * when a journey is a prose prompt.
   */
  async diff(journey: string, va: number, vb: number): Promise<SpecChange[]> {
    const [a, b] = await Promise.all([this.get(journey, va), this.get(journey, vb)]);
    const changes: SpecChange[] = [];
    walk(a as unknown as Json, b as unknown as Json, "", changes);
    return changes;
  }
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(a: Json, b: Json, path: string, out: SpecChange[]): void {
  if (isObj(a) && isObj(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = path ? `${path}.${key}` : key;
      if (!(key in a)) out.push({ path: p, kind: "added", after: b[key] });
      else if (!(key in b)) out.push({ path: p, kind: "removed", before: a[key] });
      else walk(a[key] as Json, b[key] as Json, p, out);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path, kind: "changed", before: a, after: b });
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npx vitest run packages/core/test/registry.test.ts
```
Expected: PASS — 6 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): journey registry with immutable versions and structural diff"
```

---
## Task 5: Agent Registry and privilege authorization

**Files:**
- Create: `packages/core/src/agent/registry.ts`
- Test: `packages/core/test/agent.test.ts`

**Interfaces:**
- Consumes: `JourneySpec`, `parseSpec` (Task 3)
- Produces:
  - `interface AgentPrincipal { identity: string; persona: string; privileges: string[]; dataScope: { read: string[]; deny: string[] } }`
  - `interface AuthzResult { allowed: boolean; scope?: string; reason?: string }`
  - `class AgentRegistry { static fromSpec(spec): AgentRegistry; get(identity): AgentPrincipal; authorize(principal, capability): AuthzResult; canRead(principal, resource): boolean }`

**Why this exists:** an agent is a *principal*, not a configuration blob. Privileges are enforced at the Tool Broker (Task 6), never merely declared. Privilege strings are `capability:scope` — the capability half gates the call, the scope half is carried into the binding.

- [ ] **Step 1: Write the failing test**

`packages/core/test/agent.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "../src/journey/spec.js";
import { AgentRegistry } from "../src/agent/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "fixtures/mba-v4.yaml"), "utf8"));
const reg = AgentRegistry.fromSpec(spec);
const principal = reg.get("agent://engati/mba-admissions");

describe("AgentRegistry", () => {
  it("resolves the principal declared by the journey", () => {
    expect(principal.persona).toBe("admissions_counsellor_v2");
    expect(principal.privileges).toContain("crm.upsert_lead:leads_owned_by_this_journey");
  });

  it("throws for an unknown identity", () => {
    expect(() => reg.get("agent://engati/nope")).toThrow(/unknown agent/i);
  });

  it("allows a granted capability and returns its scope", () => {
    expect(reg.authorize(principal, "crm.upsert_lead"))
      .toEqual({ allowed: true, scope: "leads_owned_by_this_journey" });
  });

  it("denies a capability that was never granted", () => {
    const r = reg.authorize(principal, "payment.charge_card");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no privilege/i);
  });

  it("does not treat a capability prefix as a grant", () => {
    // "crm.upsert_lead" granted must NOT imply "crm.upsert_lead_bulk".
    expect(reg.authorize(principal, "crm.upsert_lead_bulk").allowed).toBe(false);
  });

  it("enforces data scope, with deny beating read", () => {
    expect(reg.canRead(principal, "lead.self")).toBe(true);
    expect(reg.canRead(principal, "catalog.programs")).toBe(true);
    expect(reg.canRead(principal, "lead.other_journeys")).toBe(false);
    expect(reg.canRead(principal, "payment.instruments")).toBe(false);
    expect(reg.canRead(principal, "anything.unlisted")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run packages/core/test/agent.test.ts
```
Expected: FAIL — `Cannot find module '../src/agent/registry.js'`

- [ ] **Step 3: Write the registry**

`packages/core/src/agent/registry.ts`:
```typescript
import type { JourneySpec } from "../journey/spec.js";

export interface AgentPrincipal {
  identity: string;
  persona: string;
  privileges: string[];
  dataScope: { read: string[]; deny: string[] };
}

export interface AuthzResult {
  allowed: boolean;
  scope?: string;
  reason?: string;
}

/**
 * MVP: agents are declared inline in the journey spec. When a shared agent
 * registry arrives this becomes a lookup by identity — the journey format and
 * every call site here stay unchanged.
 */
export class AgentRegistry {
  private constructor(private readonly agents: Map<string, AgentPrincipal>) {}

  static fromSpec(spec: JourneySpec): AgentRegistry {
    const p: AgentPrincipal = {
      identity: spec.agent.identity,
      persona: spec.agent.persona,
      privileges: spec.agent.privileges,
      dataScope: spec.agent.dataScope,
    };
    return new AgentRegistry(new Map([[p.identity, p]]));
  }

  get(identity: string): AgentPrincipal {
    const a = this.agents.get(identity);
    if (!a) throw new Error(`unknown agent: ${identity}`);
    return a;
  }

  /** Exact capability match. A prefix is never a grant. */
  authorize(principal: AgentPrincipal, capability: string): AuthzResult {
    for (const priv of principal.privileges) {
      const idx = priv.indexOf(":");
      const cap = idx === -1 ? priv : priv.slice(0, idx);
      if (cap === capability) {
        return idx === -1
          ? { allowed: true }
          : { allowed: true, scope: priv.slice(idx + 1) };
      }
    }
    return {
      allowed: false,
      reason: `agent ${principal.identity} holds no privilege for ${capability}`,
    };
  }

  /** Deny wins; unlisted resources are denied (allow-list, not deny-list). */
  canRead(principal: AgentPrincipal, resource: string): boolean {
    if (principal.dataScope.deny.includes(resource)) return false;
    return principal.dataScope.read.includes(resource);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run packages/core/test/agent.test.ts
```
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): agent registry with exact-match privilege authorization"
```

---

## Task 6: Tool Broker with enforced privileges

**Files:**
- Create: `packages/runtime/package.json`, `packages/runtime/tsconfig.json`
- Create: `packages/runtime/src/broker.ts`
- Test: `packages/runtime/test/broker.test.ts`

**Interfaces:**
- Consumes: `AgentRegistry`, `AgentPrincipal` (Task 5); `EventStore` (Task 2)
- Produces:
  - `interface InvocationContext { leadId: string; journey: string; journeyVersion: number }`
  - `type Binding = (args: Record<string, unknown>, scope?: string) => Promise<unknown>`
  - `interface ToolResult { ok: boolean; value?: unknown; error?: string }`
  - `class ToolBroker { constructor(registry, store, bindings: Record<string, Binding>); invoke(ctx, principal, capability, args): Promise<ToolResult> }`
  - `mockBindings: Record<string, Binding>` — deterministic stand-ins for HubSpot/Calendly/catalog

**Why this exists:** the Tool Broker is the single egress point. It is where privilege is enforced, where `ToolInvoked` and `AuthorizationDenied` are written, and later where data-residency lives. Bindings are vendors; capabilities are the contract. `binding: mcp://...` slots in here as just another binding type.

- [ ] **Step 1: Create the runtime package**

`packages/runtime/package.json`:
```json
{
  "name": "@midfunnel/runtime",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
  "dependencies": { "@midfunnel/core": "*" }
}
```

`packages/runtime/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
npm install
```

- [ ] **Step 2: Write the failing test**

`packages/runtime/test/broker.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { AgentRegistry } from "@midfunnel/core/agent/registry";
import { ToolBroker, mockBindings } from "../src/broker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));
const registry = AgentRegistry.fromSpec(spec);
const principal = registry.get("agent://engati/mba-admissions");
const ctx = { leadId: "L1", journey: spec.journey, journeyVersion: spec.version };

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

let pool: Pool; let store: EventStore; let broker: ToolBroker;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE events");
  store = new EventStore(pool, "t1");
  broker = new ToolBroker(registry, store, mockBindings);
});
afterAll(async () => { await pool.end(); });

describe("ToolBroker", () => {
  it("invokes a granted capability and records ToolInvoked", async () => {
    const r = await broker.invoke(ctx, principal, "crm.upsert_lead", { email: "a@b.com" });
    expect(r.ok).toBe(true);

    const events = await store.query({ leadId: "L1", type: "ToolInvoked" });
    expect(events).toHaveLength(1);
    expect(events[0]!.agentId).toBe(principal.identity);
    expect(events[0]!.payload).toMatchObject({
      capability: "crm.upsert_lead", binding: "mock-crm", resultStatus: "ok",
    });
  });

  it("denies an ungranted capability and records AuthorizationDenied", async () => {
    const r = await broker.invoke(ctx, principal, "payment.charge_card", { amount: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no privilege/i);

    const denied = await store.query({ leadId: "L1", type: "AuthorizationDenied" });
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({
      capability: "payment.charge_card", principal: principal.identity,
    });
    // A denied call must not reach the binding.
    expect(await store.query({ leadId: "L1", type: "ToolInvoked" })).toEqual([]);
  });

  it("passes the privilege scope through to the binding", async () => {
    const seen: Array<string | undefined> = [];
    const b = new ToolBroker(registry, store, {
      "crm.upsert_lead": async (_a, scope) => { seen.push(scope); return { id: "x" }; },
    });
    await b.invoke(ctx, principal, "crm.upsert_lead", {});
    expect(seen).toEqual(["leads_owned_by_this_journey"]);
  });

  it("records a failing binding as an error without throwing", async () => {
    const b = new ToolBroker(registry, store, {
      "crm.upsert_lead": async () => { throw new Error("hubspot 503"); },
    });
    const r = await b.invoke(ctx, principal, "crm.upsert_lead", {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hubspot 503/);

    const events = await store.query({ leadId: "L1", type: "ToolInvoked" });
    expect(events[0]!.payload).toMatchObject({ resultStatus: "error" });
  });

  it("never writes raw arguments to the event log", async () => {
    await broker.invoke(ctx, principal, "crm.upsert_lead", { email: "secret@person.com" });
    const [e] = await store.query({ leadId: "L1", type: "ToolInvoked" });
    expect(JSON.stringify(e!.payload)).not.toContain("secret@person.com");
    expect(e!.payload).toHaveProperty("argsHash");
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx vitest run packages/runtime/test/broker.test.ts
```
Expected: FAIL — `Cannot find module '../src/broker.js'`

- [ ] **Step 4: Write the broker**

`packages/runtime/src/broker.ts`:
```typescript
import { createHash } from "node:crypto";
import type { EventStore } from "@midfunnel/core/events/store";
import type { AgentPrincipal, AgentRegistry } from "@midfunnel/core/agent/registry";

export interface InvocationContext {
  leadId: string;
  journey: string;
  journeyVersion: number;
}

export type Binding = (
  args: Record<string, unknown>,
  scope?: string,
) => Promise<unknown>;

export interface ToolResult { ok: boolean; value?: unknown; error?: string }

/** Deterministic stand-ins. Real vendor bindings arrive post-MVP. */
export const mockBindings: Record<string, Binding> = {
  "crm.upsert_lead": async (args) => ({ id: `crm_${hash(args).slice(0, 8)}`, binding: "mock-crm" }),
  "calendar.book_slot": async () => ({ bookingId: "bk_1", startsAt: "2026-09-10T10:00:00Z" }),
  "catalog.lookup_program": async (args) => ({ program: args.program ?? "executive_mba", feesBand: "5L_to_15L" }),
};

const BINDING_NAMES: Record<string, string> = {
  "crm.upsert_lead": "mock-crm",
  "calendar.book_slot": "mock-calendar",
  "catalog.lookup_program": "mock-catalog",
};

export class ToolBroker {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly store: EventStore,
    private readonly bindings: Record<string, Binding>,
  ) {}

  /**
   * The single egress point. Privilege is enforced here, not suggested by the
   * spec. Arguments are hashed rather than logged — the event log must stay
   * clean of PII.
   */
  async invoke(
    ctx: InvocationContext,
    principal: AgentPrincipal,
    capability: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const base = { ...ctx, agentId: principal.identity };

    const authz = this.registry.authorize(principal, capability);
    if (!authz.allowed) {
      await this.store.append({
        ...base, type: "AuthorizationDenied",
        payload: {
          capability, principal: principal.identity,
          reason: authz.reason, attemptedAt: new Date().toISOString(),
        },
      });
      return { ok: false, error: authz.reason };
    }

    const binding = this.bindings[capability];
    if (!binding) return { ok: false, error: `no binding configured for ${capability}` };

    const startedAt = Date.now();
    let value: unknown;
    let error: string | undefined;
    try {
      value = await binding(args, authz.scope);
    } catch (err) {
      error = (err as Error).message;
    }

    await this.store.append({
      ...base, type: "ToolInvoked",
      payload: {
        capability,
        binding: BINDING_NAMES[capability] ?? "custom",
        argsHash: hash(args),
        resultStatus: error ? "error" : "ok",
        latencyMs: Date.now() - startedAt,
      },
    });

    return error ? { ok: false, error } : { ok: true, value };
  }
}

function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npx vitest run packages/runtime/test/broker.test.ts
```
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(runtime): privilege-enforcing tool broker with PII-free audit events"
```

---
## Task 7: Evidence Extractor (Claude structured outputs)

**Files:**
- Modify: `packages/core/src/journey/spec.ts` (add `evidenceToZod`)
- Create: `packages/runtime/src/claude.ts`, `packages/runtime/src/extractor.ts`
- Modify: `packages/runtime/package.json` (add `@anthropic-ai/sdk`, `zod`)
- Test: `packages/core/test/spec.test.ts` (append), `packages/runtime/test/extractor.test.ts`

**Interfaces:**
- Consumes: `JourneySpec`, `parseTypeExpr` (Task 3); `Turn` (Task 2)
- Produces:
  - `evidenceToZod(spec): z.ZodObject<never>` — dynamic Zod mirror of the evidence block
  - `createClient(): Anthropic`, `MODEL`, `cachedSystem(text): Anthropic.TextBlockParam[]`
  - `interface ExtractedField { value: unknown; confidence: number }`
  - `class EvidenceExtractor { constructor(client?); extract(spec, turns): Promise<Record<string, ExtractedField>> }` — fields below `confidence_min`, or with a null value, are **omitted** from the result

**Why separate from the runtime:** extraction is independently evaluable against ground truth and independently improvable. Splitting them lets you measure *"did it ask well"* apart from *"did it understand"* — two different failures with two different fixes.

- [ ] **Step 1: Add dependencies**

```bash
npm install @anthropic-ai/sdk@^0.70.0 zod@^3.23.0 -w @midfunnel/runtime
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/core/test/spec.test.ts`:
```typescript
import { evidenceToZod } from "../src/journey/spec.js";

describe("evidenceToZod", () => {
  it("mirrors the JSON Schema contract exactly", () => {
    const spec = parseSpec(yaml);
    const shape = evidenceToZod(spec).shape as Record<string, unknown>;
    const js = evidenceToJsonSchema(spec) as { required: string[] };
    // One contract, two renderings — they must never drift.
    expect(Object.keys(shape).sort()).toEqual([...js.required].sort());
  });

  it("accepts a null value for an unestablished field", () => {
    const parsed = evidenceToZod(parseSpec(yaml)).parse({
      target_program: { value: "executive_mba", confidence: 0.9 },
      timeline: { value: null, confidence: 0 },
      budget_band: { value: null, confidence: 0 },
      decision_maker: { value: null, confidence: 0 },
      prior_qualification: { value: null, confidence: 0 },
    });
    expect(parsed.timeline.value).toBeNull();
  });

  it("rejects a value outside the declared enum", () => {
    expect(() => evidenceToZod(parseSpec(yaml)).parse({
      target_program: { value: "phd", confidence: 0.9 },
      timeline: { value: null, confidence: 0 },
      budget_band: { value: null, confidence: 0 },
      decision_maker: { value: null, confidence: 0 },
      prior_qualification: { value: null, confidence: 0 },
    })).toThrow();
  });
});
```

`packages/runtime/test/extractor.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { EvidenceExtractor } from "../src/extractor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const turns: Turn[] = [
  { role: "agent", text: "Hi Ravi, which programme are you considering?", at: new Date() },
  { role: "lead", text: "the executive mba, want to start this intake", at: new Date() },
];

function fakeClient(parsed: unknown) {
  return { messages: { parse: vi.fn().mockResolvedValue({ parsed_output: parsed }) } };
}

describe("EvidenceExtractor", () => {
  it("keeps fields at or above their confidence floor", async () => {
    const client = fakeClient({
      target_program: { value: "executive_mba", confidence: 0.93 },
      timeline: { value: "this_intake", confidence: 0.88 },
      budget_band: { value: null, confidence: 0 },
      decision_maker: { value: null, confidence: 0 },
      prior_qualification: { value: null, confidence: 0 },
    });
    const out = await new EvidenceExtractor(client as never).extract(spec, turns);
    expect(out).toEqual({
      target_program: { value: "executive_mba", confidence: 0.93 },
      timeline: { value: "this_intake", confidence: 0.88 },
    });
  });

  it("drops a field below its declared confidence_min", async () => {
    // target_program requires 0.8; 0.55 is not good enough to record as fact.
    const client = fakeClient({
      target_program: { value: "online_mba", confidence: 0.55 },
      timeline: { value: null, confidence: 0 },
      budget_band: { value: null, confidence: 0 },
      decision_maker: { value: null, confidence: 0 },
      prior_qualification: { value: null, confidence: 0 },
    });
    const out = await new EvidenceExtractor(client as never).extract(spec, turns);
    expect(out).not.toHaveProperty("target_program");
  });

  it("sends the journey spec as a cached system prefix", async () => {
    const client = fakeClient({
      target_program: { value: null, confidence: 0 }, timeline: { value: null, confidence: 0 },
      budget_band: { value: null, confidence: 0 }, decision_maker: { value: null, confidence: 0 },
      prior_qualification: { value: null, confidence: 0 },
    });
    await new EvidenceExtractor(client as never).extract(spec, turns);
    const req = client.messages.parse.mock.calls[0][0];
    expect(req.model).toBe("claude-opus-5");
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.output_config.effort).toBe("low");
    expect(req.thinking).toEqual({ type: "adaptive" });
  });

  it("throws when the model returns no parsed output", async () => {
    await expect(new EvidenceExtractor(fakeClient(null) as never).extract(spec, turns))
      .rejects.toThrow(/structured output/i);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

```bash
npx vitest run packages/runtime/test/extractor.test.ts packages/core/test/spec.test.ts
```
Expected: FAIL — `evidenceToZod` is not exported; `../src/extractor.js` not found

- [ ] **Step 4: Add `evidenceToZod` to the spec module**

Append to `packages/core/src/journey/spec.ts`:
```typescript
/**
 * The Zod mirror of `evidenceToJsonSchema`. Passed to the API via
 * `zodOutputFormat`, so conformance is guaranteed rather than post-validated.
 *
 * Every field is present with a nullable value: the model must say "not
 * established" explicitly rather than silently omitting a field.
 */
export function evidenceToZod(spec: JourneySpec): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};

  for (const [field, def] of Object.entries(spec.evidence)) {
    const t = parseTypeExpr(def.type);
    let value: z.ZodTypeAny;
    switch (t.kind) {
      case "enum":
        value = z.enum(t.values as [string, ...string[]]).nullable();
        break;
      case "string":
        value = (def.maxLength ? z.string().max(def.maxLength) : z.string()).nullable();
        break;
      case "number":  value = z.number().nullable(); break;
      case "boolean": value = z.boolean().nullable(); break;
    }
    shape[field] = z.object({
      value,
      confidence: z.number().min(0).max(1),
    }).describe(def.description ?? `Evidence field ${field}`);
  }

  return z.object(shape);
}
```

- [ ] **Step 5: Write the Claude client helper**

`packages/runtime/src/claude.ts`:
```typescript
import Anthropic from "@anthropic-ai/sdk";

/** Exact model id. Never append a date suffix. */
export const MODEL = "claude-opus-5" as const;

/** Non-streaming ceiling — keeps requests inside the SDK HTTP timeout. */
export const MAX_TOKENS = 16000;

export function createClient(): Anthropic {
  // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
  // profile. Never hardcode a key.
  return new Anthropic();
}

/**
 * The journey spec is byte-identical across every conversation in a run, and
 * render order is tools -> system -> messages. Putting the spec in a cached
 * system block puts the breakpoint exactly where the stable prefix ends.
 */
export function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}
```

- [ ] **Step 6: Write the extractor**

`packages/runtime/src/extractor.ts`:
```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { evidenceToZod, type JourneySpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { cachedSystem, createClient, MAX_TOKENS, MODEL } from "./claude.js";

export interface ExtractedField { value: unknown; confidence: number }

export class EvidenceExtractor {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? createClient();
  }

  /**
   * Returns only fields that are established: non-null, and at or above the
   * field's declared `confidence_min`. Everything else is simply absent — the
   * runtime treats absence as "still to be collected".
   */
  async extract(spec: JourneySpec, turns: Turn[]): Promise<Record<string, ExtractedField>> {
    const schema = evidenceToZod(spec);

    const transcript = turns
      .map((t) => `${t.role === "agent" ? "AGENT" : "LEAD"}: ${t.text}`)
      .join("\n");

    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: cachedSystem(systemPrompt(spec)),
      output_config: {
        format: zodOutputFormat(schema),
        // Schema-constrained work: the schema does the heavy lifting, so low
        // effort is sufficient and this runs on every turn.
        effort: "low",
      },
      messages: [{ role: "user", content: `TRANSCRIPT\n\n${transcript}` }],
    });

    const parsed = response.parsed_output as Record<string, ExtractedField> | null;
    if (!parsed) throw new Error("extractor received no structured output from the model");

    const out: Record<string, ExtractedField> = {};
    for (const [field, def] of Object.entries(spec.evidence)) {
      const got = parsed[field];
      if (!got || got.value === null || got.value === undefined) continue;
      if (got.confidence < def.confidence_min) continue;
      out[field] = { value: got.value, confidence: got.confidence };
    }
    return out;
  }
}

function systemPrompt(spec: JourneySpec): string {
  const fields = Object.entries(spec.evidence)
    .map(([f, d]) => `- ${f} (${d.type})${d.required ? " [required]" : ""}: ${d.description ?? ""}`)
    .join("\n");

  return [
    `You extract structured evidence from a ${spec.vertical} lead-qualification conversation.`,
    `Journey: ${spec.journey} v${spec.version}. Goal: ${spec.objective.goal}.`,
    "",
    "Fields to establish:",
    fields,
    "",
    "Rules:",
    "- Report only what the LEAD actually said or clearly implied. Never infer from the agent's questions.",
    "- If a field was not established, set value to null and confidence to 0.",
    "- confidence is your calibrated probability that the value is correct.",
  ].join("\n");
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

```bash
npx vitest run packages/runtime/test/extractor.test.ts packages/core/test/spec.test.ts
```
Expected: PASS — 4 extractor tests, 11 spec tests

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(runtime): evidence extractor via structured outputs with cached spec prefix"
```

---

## Task 8: Scoring and routing

**Files:**
- Create: `packages/runtime/src/scoring.ts`
- Test: `packages/runtime/test/scoring.test.ts`

**Interfaces:**
- Consumes: `JourneySpec`, `requiredEvidenceFields` (Task 3)
- Produces:
  - `score(spec, evidence): number` — 0..100
  - `evaluatePredicate(expr, ctx): boolean` where `ctx = { score: number; evidenceComplete: boolean }`
  - `route(spec, score): { decision: string; target: string; sla?: string }`
  - `qualifies(spec, score, evidence): boolean`

**Why an explicit evaluator and not `eval`:** journey specs are authored by FDEs and will eventually be customer-editable. Evaluating them as JavaScript would be a remote code execution path straight into the runtime.

- [ ] **Step 1: Write the failing test**

`packages/runtime/test/scoring.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { score, route, qualifies, evaluatePredicate } from "../src/scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const ev = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

describe("score", () => {
  it("sums the weights that match field.value", () => {
    // timeline.this_intake 30 + budget_band.above_15L 25 + decision_maker.self 15
    // + target_program.* 10 = 80
    expect(score(spec, ev({
      timeline: "this_intake", budget_band: "above_15L",
      decision_maker: "self", target_program: "executive_mba",
    }))).toBe(80);
  });

  it("honours a wildcard weight for any value of the field", () => {
    expect(score(spec, ev({ target_program: "online_mba" }))).toBe(10);
  });

  it("scores an empty evidence set as zero", () => {
    expect(score(spec, {})).toBe(0);
  });

  it("caps at 100", () => {
    const inflated = { ...spec, scoring: { weights: { "timeline.this_intake": 500 } } };
    expect(score(inflated, ev({ timeline: "this_intake" }))).toBe(100);
  });
});

describe("evaluatePredicate", () => {
  it("evaluates a score comparison", () => {
    expect(evaluatePredicate("score >= 70", { score: 72, evidenceComplete: true })).toBe(true);
    expect(evaluatePredicate("score >= 70", { score: 69, evidenceComplete: true })).toBe(false);
  });
  it("evaluates evidence completeness", () => {
    expect(evaluatePredicate("evidence.complete(required)", { score: 0, evidenceComplete: true })).toBe(true);
  });
  it("evaluates a conjunction", () => {
    expect(evaluatePredicate("score >= 70 AND evidence.complete(required)",
      { score: 80, evidenceComplete: false })).toBe(false);
  });
  it("always satisfies `otherwise`", () => {
    expect(evaluatePredicate("otherwise", { score: 0, evidenceComplete: false })).toBe(true);
  });
  it("refuses an expression it does not understand rather than guessing", () => {
    expect(() => evaluatePredicate("process.exit(1)", { score: 0, evidenceComplete: false }))
      .toThrow(/unsupported predicate/i);
  });
});

describe("route", () => {
  it("routes hot at or above 70", () => {
    expect(route(spec, 72)).toEqual({ decision: "hot", target: "handoff.counsellor", sla: "5m" });
  });
  it("routes warm between 40 and 69", () => {
    expect(route(spec, 45)).toMatchObject({ decision: "warm", target: "nurture.mba_warm_14d" });
  });
  it("falls through to cold", () => {
    expect(route(spec, 10)).toMatchObject({ decision: "cold", target: "nurture.mba_longtail_90d" });
  });
  it("takes the first matching rule in declaration order", () => {
    expect(route(spec, 100).decision).toBe("hot");
  });
});

describe("qualifies", () => {
  it("requires both a passing score and complete required evidence", () => {
    const full = ev({ target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L" });
    expect(qualifies(spec, 80, full)).toBe(true);
    expect(qualifies(spec, 80, ev({ timeline: "this_intake" }))).toBe(false);
    expect(qualifies(spec, 20, full)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run packages/runtime/test/scoring.test.ts
```
Expected: FAIL — `Cannot find module '../src/scoring.js'`

- [ ] **Step 3: Write the scoring module**

`packages/runtime/src/scoring.ts`:
```typescript
import { requiredEvidenceFields, type JourneySpec } from "@midfunnel/core/journey/spec";

export interface Evidence { [field: string]: { value: unknown; confidence: number } }

export interface RouteResult { decision: string; target: string; sla?: string }

export interface PredicateContext { score: number; evidenceComplete: boolean }

/** Weight keys are `field.value`, or `field.*` for any established value. */
export function score(spec: JourneySpec, evidence: Evidence): number {
  let total = 0;
  for (const [key, weight] of Object.entries(spec.scoring.weights)) {
    const dot = key.lastIndexOf(".");
    if (dot === -1) continue;
    const field = key.slice(0, dot);
    const want = key.slice(dot + 1);
    const got = evidence[field];
    if (!got || got.value === null || got.value === undefined) continue;
    if (want === "*" || String(got.value) === want) total += weight;
  }
  return Math.min(100, Math.round(total));
}

/**
 * A deliberately tiny evaluator. Specs are authored data, not code — running
 * them through `eval` would put remote code execution in the runtime.
 * Supported atoms: `score <op> <number>`, `evidence.complete(required)`,
 * `otherwise`. Joined with AND / OR.
 */
export function evaluatePredicate(expr: string, ctx: PredicateContext): boolean {
  const trimmed = expr.trim();
  if (trimmed.toLowerCase() === "otherwise") return true;

  if (/\sOR\s/.test(trimmed)) {
    return trimmed.split(/\sOR\s/).some((part) => evaluatePredicate(part, ctx));
  }
  if (/\sAND\s/.test(trimmed)) {
    return trimmed.split(/\sAND\s/).every((part) => evaluatePredicate(part, ctx));
  }

  if (trimmed === "evidence.complete(required)") return ctx.evidenceComplete;

  const m = /^score\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (m) {
    const n = Number(m[2]);
    switch (m[1]) {
      case ">=": return ctx.score >= n;
      case "<=": return ctx.score <= n;
      case ">":  return ctx.score > n;
      case "<":  return ctx.score < n;
      case "==": return ctx.score === n;
    }
  }

  throw new Error(`unsupported predicate: ${expr}`);
}

/** First rule in declaration order wins. */
export function route(spec: JourneySpec, s: number): RouteResult {
  for (const [decision, rule] of Object.entries(spec.routing)) {
    if (evaluatePredicate(rule.when, { score: s, evidenceComplete: true })) {
      return { decision, target: rule.target, ...(rule.sla ? { sla: rule.sla } : {}) };
    }
  }
  throw new Error(`no routing rule matched score ${s} — every journey needs an "otherwise" rule`);
}

export function evidenceComplete(spec: JourneySpec, evidence: Evidence): boolean {
  return requiredEvidenceFields(spec).every((f) => {
    const got = evidence[f];
    return got !== undefined && got.value !== null && got.value !== undefined;
  });
}

export function qualifies(spec: JourneySpec, s: number, evidence: Evidence): boolean {
  return evaluatePredicate(spec.objective.qualifies_when, {
    score: s,
    evidenceComplete: evidenceComplete(spec, evidence),
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run packages/runtime/test/scoring.test.ts
```
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(runtime): scoring, safe predicate evaluator, and routing"
```

---
## Task 9: Agent Runtime — `step()`

**Files:**
- Create: `packages/runtime/src/step.ts`, `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/step.test.ts`

**Interfaces:**
- Consumes: `EvidenceExtractor` (Task 7); `score`, `route`, `qualifies`, `evidenceComplete` (Task 8); `LeadState`, `Turn` (Task 2); `JourneySpec` (Task 3)
- Produces:
  - ```typescript
    type Action =
      | { kind: "send"; text: string; pinnedTemplate?: string }
      | { kind: "extract"; evidence: Record<string, { value: unknown; confidence: number }> }
      | { kind: "score"; score: number }
      | { kind: "route"; decision: string; target: string; sla?: string }
      | { kind: "escalate"; reason: string }
      | { kind: "complete"; qualified: boolean };
    ```
  - `class AgentRuntime { constructor(extractor?, client?); step(spec, state): Promise<Action[]> }`

**The entire contract is `step()`.** Everything above it — replay, simulation, A/B, attribution — depends on this signature and nothing else. That is what makes the runtime replaceable, and what lets the same interface later wrap the existing Engati bot.

- [ ] **Step 1: Write the failing test**

`packages/runtime/test/step.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { AgentRuntime } from "../src/step.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const state = (over: Partial<LeadState> = {}): LeadState => ({
  leadId: "L1", journey: spec.journey, journeyVersion: spec.version,
  evidence: {}, turns: [], outcomes: [], ...over,
});

const turn = (role: "agent" | "lead", text: string) => ({ role, text, at: new Date() });
const ev = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

/** Extractor stub — step() must never call the model for deterministic paths. */
const extractor = (evidence: Record<string, { value: unknown; confidence: number }> = {}) =>
  ({ extract: vi.fn().mockResolvedValue(evidence) }) as never;

const asker = (text: string) =>
  ({ messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }] }) } }) as never;

describe("AgentRuntime.step", () => {
  it("opens with the pinned template and the AI disclosure", async () => {
    const actions = await new AgentRuntime(extractor(), asker("unused")).step(spec, state());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "send", pinnedTemplate: "templates/wa_mba_optin_v4" });
    expect((actions[0] as { text: string }).text).toContain("AI assistant");
  });

  it("does not call the model on first contact", async () => {
    const a = asker("should not be used");
    await new AgentRuntime(extractor(), a).step(spec, state());
    expect((a as never as { messages: { create: { mock: { calls: unknown[] } } } })
      .messages.create.mock.calls).toHaveLength(0);
  });

  it("escalates when the lead asks for a human", async () => {
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "can I speak to a human please")] });
    const actions = await new AgentRuntime(extractor(), asker("x")).step(spec, s);
    expect(actions.some((a) => a.kind === "escalate")).toBe(true);
  });

  it("escalates when declared evidence triggers it", async () => {
    // policy.escalate_when includes evidence.budget_band == needs_financing
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "need a loan")] });
    const rt = new AgentRuntime(extractor(ev({ budget_band: "needs_financing" })), asker("x"));
    const actions = await rt.step(spec, s);
    expect(actions.find((a) => a.kind === "escalate"))
      .toMatchObject({ reason: expect.stringContaining("budget_band") });
  });

  it("completes as unqualified once max_turns is exhausted", async () => {
    const turns = Array.from({ length: 14 }, (_, i) =>
      turn(i % 2 === 0 ? "agent" : "lead", `t${i}`));
    const actions = await new AgentRuntime(extractor(), asker("x")).step(spec, state({ turns }));
    expect(actions.at(-1)).toEqual({ kind: "complete", qualified: false });
  });

  it("scores, routes and completes once required evidence is established", async () => {
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "exec mba, this intake, 20L budget")] });
    const rt = new AgentRuntime(
      extractor(ev({ target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L" })),
      asker("x"),
    );
    const actions = await rt.step(spec, s);
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toEqual(["extract", "score", "route", "complete"]);
    expect(actions.find((a) => a.kind === "route")).toMatchObject({ decision: "hot" });
    expect(actions.at(-1)).toEqual({ kind: "complete", qualified: true });
  });

  it("asks for the next missing field, and never re-asks an established one", async () => {
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "exec mba")] });
    const a = asker("Are you looking at this intake or the next one?");
    const rt = new AgentRuntime(extractor(ev({ target_program: "executive_mba" })), a);
    const actions = await rt.step(spec, s);

    expect(actions.map((x) => x.kind)).toEqual(["extract", "send"]);
    const prompt = JSON.stringify(
      (a as never as { messages: { create: { mock: { calls: unknown[][] } } } }).messages.create.mock.calls[0]![0],
    );
    expect(prompt).toContain("timeline");
    expect(prompt).not.toContain("\"target_program\"");
  });

  it("defers sensitive fields until something else is established", async () => {
    // budget_band is sensitive: never the opening question.
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "hello")] });
    const a = asker("Which programme are you considering?");
    await new AgentRuntime(extractor(), a).step(spec, s);
    const prompt = JSON.stringify(
      (a as never as { messages: { create: { mock: { calls: unknown[][] } } } }).messages.create.mock.calls[0]![0],
    );
    expect(prompt).toContain("target_program");
    expect(prompt).not.toContain("budget_band");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run packages/runtime/test/step.test.ts
```
Expected: FAIL — `Cannot find module '../src/step.js'`

- [ ] **Step 3: Write the runtime**

`packages/runtime/src/step.ts`:
```typescript
import type Anthropic from "@anthropic-ai/sdk";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { EvidenceExtractor, type ExtractedField } from "./extractor.js";
import { cachedSystem, createClient, MAX_TOKENS, MODEL } from "./claude.js";
import { evidenceComplete, qualifies, route, score, type Evidence } from "./scoring.js";

export type Action =
  | { kind: "send"; text: string; pinnedTemplate?: string }
  | { kind: "extract"; evidence: Record<string, ExtractedField> }
  | { kind: "score"; score: number }
  | { kind: "route"; decision: string; target: string; sla?: string }
  | { kind: "escalate"; reason: string }
  | { kind: "complete"; qualified: boolean };

const HUMAN_REQUEST = /\b(human|agent|person|representative|talk to someone|real person)\b/i;

export class AgentRuntime {
  private readonly extractor: EvidenceExtractor;
  private readonly client: Anthropic;

  constructor(extractor?: EvidenceExtractor, client?: Anthropic) {
    this.client = client ?? createClient();
    this.extractor = extractor ?? new EvidenceExtractor(this.client);
  }

  /**
   * The whole contract. Pure with respect to the event log: it reads a folded
   * LeadState and returns intended actions. The caller persists them, which is
   * what lets replay, simulation and live traffic share one runtime.
   */
  async step(spec: JourneySpec, state: LeadState): Promise<Action[]> {
    // 1. First contact — deterministic, pinned, and never a model call.
    if (state.turns.length === 0) {
      const disclosure = spec.pinned.disclosure ?? "";
      return [{
        kind: "send",
        text: disclosure || "Hello.",
        ...(spec.pinned.opening ? { pinnedTemplate: spec.pinned.opening } : {}),
      }];
    }

    const actions: Action[] = [];

    // 2. Explicit human request short-circuits everything.
    const lastLead = [...state.turns].reverse().find((t) => t.role === "lead");
    if (lastLead && HUMAN_REQUEST.test(lastLead.text)) {
      return [{ kind: "escalate", reason: "asks_for_human" }];
    }

    // 3. Extract, then merge over what is already known.
    const fresh = await this.extractor.extract(spec, state.turns);
    if (Object.keys(fresh).length > 0) actions.push({ kind: "extract", evidence: fresh });
    const evidence: Evidence = { ...state.evidence, ...fresh };

    // 4. Declared escalation triggers on evidence.
    const trigger = escalationTrigger(spec, evidence);
    if (trigger) {
      actions.push({ kind: "escalate", reason: trigger });
      return actions;
    }

    // 5. Turn budget exhausted.
    const leadTurns = state.turns.filter((t) => t.role === "lead").length;
    if (state.turns.length >= spec.policy.max_turns || leadTurns >= spec.policy.max_turns) {
      actions.push({ kind: "complete", qualified: false });
      return actions;
    }

    // 6. Required evidence complete — score, route, finish.
    if (evidenceComplete(spec, evidence)) {
      const s = score(spec, evidence);
      const r = route(spec, s);
      actions.push({ kind: "score", score: s });
      actions.push({ kind: "route", ...r });
      actions.push({ kind: "complete", qualified: qualifies(spec, s, evidence) });
      return actions;
    }

    // 7. Otherwise ask for the next missing field.
    const target = nextField(spec, evidence);
    actions.push({ kind: "send", text: await this.ask(spec, state, evidence, target) });
    return actions;
  }

  private async ask(
    spec: JourneySpec, state: LeadState, evidence: Evidence, field: string,
  ): Promise<string> {
    const def = spec.evidence[field]!;
    const transcript = state.turns.map((t) =>
      `${t.role === "agent" ? "AGENT" : "LEAD"}: ${t.text}`).join("\n");

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: cachedSystem([
        `You are ${spec.agent.persona}, qualifying a ${spec.vertical} lead over chat.`,
        `Goal: ${spec.objective.goal}.`,
        "",
        "You must NEVER:",
        ...spec.policy.never.map((r) => `- ${r}`),
        "",
        "Write ONE short, natural message. No preamble, no sign-off, no emoji.",
        "Under 30 words. Ask about exactly one thing.",
      ].join("\n")),
      output_config: { effort: "high" },
      messages: [{
        role: "user",
        content: JSON.stringify({
          transcript,
          established: Object.fromEntries(
            Object.entries(evidence).map(([k, v]) => [k, v.value]),
          ),
          ask_about: { field, type: def.type, description: def.description ?? null },
        }, null, 2),
      }],
    });

    for (const block of response.content) {
      if (block.type === "text") return block.text.trim();
    }
    throw new Error("runtime received no text content from the model");
  }
}

/**
 * Ordering rule: required before optional, and a `sensitive` field is never
 * asked while nothing at all is established — you do not open with money.
 */
function nextField(spec: JourneySpec, evidence: Evidence): string {
  const missing = Object.entries(spec.evidence).filter(([f]) => {
    const got = evidence[f];
    return got === undefined || got.value === null || got.value === undefined;
  });
  const nothingEstablished = Object.keys(evidence).length === 0;

  const eligible = missing.filter(([, d]) => !(d.sensitive && nothingEstablished));
  const pool = eligible.length > 0 ? eligible : missing;

  const required = pool.find(([, d]) => d.required);
  return (required ?? pool[0]!)[0];
}

function escalationTrigger(spec: JourneySpec, evidence: Evidence): string | null {
  for (const rule of spec.policy.escalate_when) {
    const m = /^evidence\.(\w+)\s*==\s*(\S+)$/.exec(rule.trim());
    if (!m) continue;
    const got = evidence[m[1]!];
    if (got && String(got.value) === m[2]) return rule.trim();
  }
  return null;
}
```

`packages/runtime/src/index.ts`:
```typescript
export * from "./broker.js";
export * from "./claude.js";
export * from "./extractor.js";
export * from "./scoring.js";
export * from "./step.js";
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run packages/runtime/test/step.test.ts
```
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(runtime): agent runtime step() with policy, escalation and question ordering"
```

---

## Task 10: Import Boundary with PII scrubbing

**Files:**
- Create: `packages/batch/package.json`, `packages/batch/tsconfig.json`
- Create: `packages/batch/src/import/pii.ts`, `packages/batch/src/import/importer.ts`
- Test: `packages/batch/test/pii.test.ts`, `packages/batch/test/importer.test.ts`

**Interfaces:**
- Consumes: `EventStore` (Task 2)
- Produces:
  - `scrub(text: string): string`
  - `PII_PATTERNS: Array<{ name: string; re: RegExp; token: string }>`
  - ```typescript
    interface HistoricalLead {
      externalId: string; source: string;
      campaignId?: string; creativeId?: string; consentScope?: string;
      turns: Array<{ role: "agent" | "lead"; text: string; at: string }>;
      outcome?: { outcome: "attended" | "applied" | "enrolled" | "paid";
                  amount?: number; currency?: string; observedAt: string };
    }
    ```
  - `class ImportBoundary { constructor(store, opts: { journey; journeyVersion; agentId }); import(leads): Promise<string[]> }`

**Scrubbing happens before anything is persisted**, so the event log is never dirty. There is no later cleanup pass, because there is nothing to clean up.

- [ ] **Step 1: Create the batch package**

`packages/batch/package.json`:
```json
{
  "name": "@midfunnel/batch",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
  "dependencies": { "@midfunnel/core": "*", "@midfunnel/runtime": "*" }
}
```

`packages/batch/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
npm install
```

- [ ] **Step 2: Write the failing tests**

`packages/batch/test/pii.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scrub } from "../src/import/pii.js";

describe("scrub", () => {
  it("redacts email addresses", () => {
    expect(scrub("write to ravi.kumar@example.co.in please"))
      .toBe("write to [EMAIL] please");
  });

  it("redacts Indian mobile numbers in common formats", () => {
    expect(scrub("call +91 98765 43210")).toBe("call [PHONE]");
    expect(scrub("call 9876543210")).toBe("call [PHONE]");
    expect(scrub("call +919876543210")).toBe("call [PHONE]");
  });

  it("redacts Aadhaar-shaped and PAN-shaped identifiers", () => {
    expect(scrub("aadhaar 1234 5678 9012")).toBe("aadhaar [GOVID]");
    expect(scrub("pan ABCDE1234F")).toBe("pan [GOVID]");
  });

  it("redacts card numbers", () => {
    expect(scrub("card 4111 1111 1111 1111")).toBe("card [CARD]");
  });

  it("leaves qualification-relevant text intact", () => {
    const s = "I want the executive MBA, budget around 12 lakhs, starting this intake";
    expect(scrub(s)).toBe(s);
  });

  it("does not redact a plain year or a small number", () => {
    expect(scrub("graduated in 2019 with 4 years experience"))
      .toBe("graduated in 2019 with 4 years experience");
  });
});
```

`packages/batch/test/importer.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { ImportBoundary, type HistoricalLead } from "../src/import/importer.js";

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const OPTS = {
  journey: "mba-admissions-qualification",
  journeyVersion: 3,
  agentId: "agent://engati/import",
};

const lead = (over: Partial<HistoricalLead> = {}): HistoricalLead => ({
  externalId: "ext-1", source: "meta_lead_ads", campaignId: "c1", creativeId: "cr1",
  consentScope: "marketing",
  turns: [
    { role: "agent", text: "Hi, which programme?", at: "2026-06-01T10:00:00Z" },
    { role: "lead", text: "exec mba, reach me at ravi@example.com", at: "2026-06-01T10:02:00Z" },
  ],
  outcome: { outcome: "enrolled", amount: 45000000, currency: "INR", observedAt: "2026-07-01T00:00:00Z" },
  ...over,
});

let pool: Pool; let store: EventStore; let boundary: ImportBoundary;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE events");
  store = new EventStore(pool, "t1");
  boundary = new ImportBoundary(store, OPTS);
});
afterAll(async () => { await pool.end(); });

describe("ImportBoundary", () => {
  it("writes ingestion, both turns and the outcome", async () => {
    const [leadId] = await boundary.import([lead()]);
    const s = await store.fold(leadId!);
    expect(s.turns).toHaveLength(2);
    expect(s.outcomes[0]).toMatchObject({ outcome: "enrolled", amount: 45000000 });
  });

  it("scrubs PII before it reaches the database", async () => {
    const [leadId] = await boundary.import([lead()]);
    const events = await store.query({ leadId: leadId! });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain("ravi@example.com");
    expect(dump).toContain("[EMAIL]");
  });

  it("stamps every imported event with the importing principal", async () => {
    const [leadId] = await boundary.import([lead()]);
    const events = await store.query({ leadId: leadId! });
    expect(events.every((e) => e.agentId === OPTS.agentId)).toBe(true);
  });

  it("is idempotent on externalId", async () => {
    const a = await boundary.import([lead()]);
    const b = await boundary.import([lead()]);
    expect(a).toEqual(b);
    expect(await store.query({ leadId: a[0]! })).toHaveLength(4);
  });

  it("carries campaign attribution onto LeadIngested", async () => {
    const [leadId] = await boundary.import([lead()]);
    const [ingested] = await store.query({ leadId: leadId!, type: "LeadIngested" });
    expect(ingested!.payload).toMatchObject({
      source: "meta_lead_ads", campaignId: "c1", creativeId: "cr1", consentScope: "marketing",
    });
  });

  it("imports a lead with no outcome", async () => {
    const [leadId] = await boundary.import([lead({ outcome: undefined })]);
    expect((await store.fold(leadId!)).outcomes).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

```bash
npx vitest run packages/batch/test/
```
Expected: FAIL — `Cannot find module '../src/import/pii.js'`

- [ ] **Step 4: Write the scrubber**

`packages/batch/src/import/pii.ts`:
```typescript
/**
 * Order matters: card and Aadhaar patterns are checked before the bare
 * 10-digit phone rule, so a 16-digit card is never partially matched as a
 * phone number.
 */
export const PII_PATTERNS: Array<{ name: string; re: RegExp; token: string }> = [
  { name: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, token: "[EMAIL]" },
  { name: "card", re: /\b(?:\d[ -]?){15,18}\d\b/g, token: "[CARD]" },
  { name: "aadhaar", re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, token: "[GOVID]" },
  { name: "pan", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, token: "[GOVID]" },
  { name: "phone", re: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g, token: "[PHONE]" },
];

/** Applied before persistence. The event log is never written dirty. */
export function scrub(text: string): string {
  let out = text;
  for (const { re, token } of PII_PATTERNS) out = out.replace(re, token);
  return out;
}
```

- [ ] **Step 5: Write the import boundary**

`packages/batch/src/import/importer.ts`:
```typescript
import { createHash } from "node:crypto";
import type { EventStore } from "@midfunnel/core/events/store";
import type { EventInput } from "@midfunnel/core/events/types";
import { scrub } from "./pii.js";

export interface HistoricalLead {
  externalId: string;
  source: string;
  campaignId?: string;
  creativeId?: string;
  consentScope?: string;
  turns: Array<{ role: "agent" | "lead"; text: string; at: string }>;
  outcome?: {
    outcome: "attended" | "applied" | "enrolled" | "paid";
    amount?: number;
    currency?: string;
    observedAt: string;
  };
}

export interface ImportOptions {
  journey: string;
  journeyVersion: number;
  agentId: string;
}

export class ImportBoundary {
  constructor(
    private readonly store: EventStore,
    private readonly opts: ImportOptions,
  ) {}

  /**
   * Deterministic lead ids from externalId make imports idempotent without a
   * dedupe table. Re-importing the same export is a no-op.
   */
  async import(leads: HistoricalLead[]): Promise<string[]> {
    const ids: string[] = [];

    for (const lead of leads) {
      const leadId = deriveLeadId(lead.externalId);
      ids.push(leadId);

      const existing = await this.store.query({ leadId, limit: 1 });
      if (existing.length > 0) continue;

      const base = {
        leadId,
        journey: this.opts.journey,
        journeyVersion: this.opts.journeyVersion,
        agentId: this.opts.agentId,
      };
      const first = lead.turns[0]?.at ?? new Date().toISOString();

      const events: EventInput[] = [{
        ...base, type: "LeadIngested", occurredAt: new Date(first),
        payload: {
          externalId: lead.externalId, source: lead.source,
          campaignId: lead.campaignId ?? null, creativeId: lead.creativeId ?? null,
          consentScope: lead.consentScope ?? null,
        },
      }];

      for (const t of lead.turns) {
        events.push(t.role === "agent"
          ? { ...base, type: "MessageSent", occurredAt: new Date(t.at),
              payload: { channel: "whatsapp", renderedText: scrub(t.text) } }
          : { ...base, type: "MessageReceived", occurredAt: new Date(t.at),
              payload: { channel: "whatsapp", rawText: scrub(t.text) } });
      }

      if (lead.outcome) {
        events.push({
          ...base, type: "OutcomeObserved", occurredAt: new Date(lead.outcome.observedAt),
          payload: {
            outcome: lead.outcome.outcome,
            amount: lead.outcome.amount ?? null,
            currency: lead.outcome.currency ?? null,
            source: "import",
          },
        });
      }

      await this.store.appendMany(events);
    }

    return ids;
  }
}

function deriveLeadId(externalId: string): string {
  return `L_${createHash("sha256").update(externalId).digest("hex").slice(0, 16)}`;
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npx vitest run packages/batch/test/
```
Expected: PASS — 6 pii tests, 6 importer tests

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(batch): import boundary with pre-persistence PII scrubbing"
```

---
## Task 11: Replay Engine and bootstrap confidence interval

**Files:**
- Create: `packages/batch/src/replay/stats.ts`, `packages/batch/src/replay/engine.ts`, `packages/batch/src/index.ts`
- Test: `packages/batch/test/stats.test.ts`, `packages/batch/test/replay.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `LeadState` (Task 2); `JourneyRegistry` (Task 4); `AgentRuntime`, `Action` (Task 9)
- Produces:
  - `mulberry32(seed: number): () => number`
  - `bootstrapDiffCI(a: boolean[], b: boolean[], opts?): [number, number]`
  - `interface ReplayOutcome { leadId; decision: string; qualified: boolean; turns: number }`
  - `interface Divergence { leadId; a: ReplayOutcome; b: ReplayOutcome; actualOutcome: string | null }`
  - ```typescript
    interface Lift {
      n: number;
      a: { version: number; qualifiedRate: number; projectedConversions: number };
      b: { version: number; qualifiedRate: number; projectedConversions: number };
      absoluteLift: number;
      ci95: [number, number];
      observedConversionByDecision: Record<string, number>;
      divergent: Divergence[];
    }
    ```
  - `class ReplayEngine { constructor(store, registry, runtime); replay(journey, va, vb, leadIds): Promise<Lift> }`

**The honesty requirement:** `observedConversionByDecision` is measured from history; `projectedConversions` is modelled from it. `Lift` keeps them in separate fields precisely so the console can render them differently. Blurring observed and modelled numbers is what would get the pitch caught.

- [ ] **Step 1: Write the failing stats test**

`packages/batch/test/stats.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { bootstrapDiffCI, mulberry32 } from "../src/replay/stats.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42); const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("stays inside [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 500; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe("bootstrapDiffCI", () => {
  const rep = (trues: number, total: number) =>
    Array.from({ length: total }, (_, i) => i < trues);

  it("brackets a real difference without spanning zero", () => {
    const [lo, hi] = bootstrapDiffCI(rep(180, 1000), rep(260, 1000), { seed: 1 });
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(0.2);
    expect(lo).toBeLessThan(hi);
  });

  it("spans zero when the two arms are identical", () => {
    const [lo, hi] = bootstrapDiffCI(rep(200, 1000), rep(200, 1000), { seed: 1 });
    expect(lo).toBeLessThanOrEqual(0);
    expect(hi).toBeGreaterThanOrEqual(0);
  });

  it("is wider on a small sample than a large one", () => {
    const small = bootstrapDiffCI(rep(18, 100), rep(26, 100), { seed: 3 });
    const large = bootstrapDiffCI(rep(180, 1000), rep(260, 1000), { seed: 3 });
    expect(small[1] - small[0]).toBeGreaterThan(large[1] - large[0]);
  });

  it("is reproducible for a fixed seed", () => {
    expect(bootstrapDiffCI(rep(180, 1000), rep(260, 1000), { seed: 9 }))
      .toEqual(bootstrapDiffCI(rep(180, 1000), rep(260, 1000), { seed: 9 }));
  });

  it("refuses mismatched arms", () => {
    expect(() => bootstrapDiffCI(rep(1, 10), rep(1, 11))).toThrow(/same length/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run packages/batch/test/stats.test.ts
```
Expected: FAIL — `Cannot find module '../src/replay/stats.js'`

- [ ] **Step 3: Write the stats module**

`packages/batch/src/replay/stats.ts`:
```typescript
/** Small deterministic PRNG — replay numbers must be reproducible on stage. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapOptions {
  iterations?: number;
  alpha?: number;
  seed?: number;
}

/**
 * Paired bootstrap on the difference in proportions (b - a). Paired because
 * both arms are the same leads replayed through two journey versions — an
 * unpaired interval would overstate the uncertainty.
 */
export function bootstrapDiffCI(
  a: boolean[], b: boolean[], opts: BootstrapOptions = {},
): [number, number] {
  if (a.length !== b.length) throw new Error("arms must be the same length (replay is paired)");
  if (a.length === 0) return [0, 0];

  const { iterations = 2000, alpha = 0.05, seed = 1 } = opts;
  const rand = mulberry32(seed);
  const n = a.length;
  const diffs: number[] = [];

  for (let i = 0; i < iterations; i++) {
    let sa = 0, sb = 0;
    for (let j = 0; j < n; j++) {
      const k = Math.floor(rand() * n);
      if (a[k]) sa++;
      if (b[k]) sb++;
    }
    diffs.push(sb / n - sa / n);
  }

  diffs.sort((x, y) => x - y);
  const lo = diffs[Math.floor((alpha / 2) * iterations)]!;
  const hi = diffs[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))]!;
  return [round4(lo), round4(hi)];
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
```

- [ ] **Step 4: Write the failing replay test**

`packages/batch/test/replay.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { Action } from "@midfunnel/runtime/step";
import { ImportBoundary, type HistoricalLead } from "../src/import/importer.js";
import { ReplayEngine } from "../src/replay/engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8");
const V3 = V4.replace("version: 4", "version: 3");

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const mkLead = (i: number, enrolled: boolean): HistoricalLead => ({
  externalId: `ext-${i}`, source: "meta_lead_ads", campaignId: "c1",
  turns: [
    { role: "agent", text: "Which programme?", at: "2026-06-01T10:00:00Z" },
    { role: "lead", text: "exec mba this intake", at: "2026-06-01T10:01:00Z" },
  ],
  ...(enrolled
    ? { outcome: { outcome: "enrolled" as const, amount: 45000000, currency: "INR",
                   observedAt: "2026-07-01T00:00:00Z" } }
    : {}),
});

/** v4 qualifies every lead; v3 qualifies every third. Deterministic, no model calls. */
function stubRuntime() {
  return {
    step: vi.fn(async (spec: { version: number }, state: { leadId: string }): Promise<Action[]> => {
      const idx = Number(state.leadId.slice(-1).replace(/\D/g, "") || 0);
      const hot = spec.version === 4 || idx % 3 === 0;
      return [
        { kind: "score", score: hot ? 80 : 20 },
        { kind: "route", decision: hot ? "hot" : "cold", target: hot ? "handoff.counsellor" : "nurture.x" },
        { kind: "complete", qualified: hot },
      ];
    }),
  } as never;
}

let pool: Pool; let store: EventStore; let registry: JourneyRegistry;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE events");
  await pool.query("TRUNCATE journey_versions");
  store = new EventStore(pool, "t1");
  registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V3);
  await registry.publish(V4);
});
afterAll(async () => { await pool.end(); });

describe("ReplayEngine", () => {
  it("produces a lift with a confidence interval over a real cohort", async () => {
    const leads = Array.from({ length: 30 }, (_, i) => mkLead(i, i % 4 === 0));
    const ids = await new ImportBoundary(store, {
      journey: "mba-admissions-qualification", journeyVersion: 3, agentId: "agent://engati/import",
    }).import(leads);

    const lift = await new ReplayEngine(store, registry, stubRuntime())
      .replay("mba-admissions-qualification", 3, 4, ids);

    expect(lift.n).toBe(30);
    expect(lift.b.qualifiedRate).toBeGreaterThan(lift.a.qualifiedRate);
    expect(lift.absoluteLift).toBeCloseTo(lift.b.qualifiedRate - lift.a.qualifiedRate, 5);
    expect(lift.ci95[0]).toBeLessThanOrEqual(lift.ci95[1]);
  });

  it("keeps observed and modelled numbers in separate fields", async () => {
    const leads = Array.from({ length: 12 }, (_, i) => mkLead(i, i % 3 === 0));
    const ids = await new ImportBoundary(store, {
      journey: "mba-admissions-qualification", journeyVersion: 3, agentId: "agent://engati/import",
    }).import(leads);

    const lift = await new ReplayEngine(store, registry, stubRuntime())
      .replay("mba-admissions-qualification", 3, 4, ids);

    // Observed: measured from history. Modelled: derived from it.
    expect(Object.keys(lift.observedConversionByDecision).length).toBeGreaterThan(0);
    expect(typeof lift.b.projectedConversions).toBe("number");
  });

  it("lists divergent leads with the actual historical outcome attached", async () => {
    const leads = Array.from({ length: 9 }, (_, i) => mkLead(i, i === 1));
    const ids = await new ImportBoundary(store, {
      journey: "mba-admissions-qualification", journeyVersion: 3, agentId: "agent://engati/import",
    }).import(leads);

    const lift = await new ReplayEngine(store, registry, stubRuntime())
      .replay("mba-admissions-qualification", 3, 4, ids);

    expect(lift.divergent.length).toBeGreaterThan(0);
    for (const d of lift.divergent) expect(d.a.decision).not.toBe(d.b.decision);
    expect(lift.divergent.every((d) => "actualOutcome" in d)).toBe(true);
  });

  it("writes no events — replay is a pure read over history", async () => {
    const ids = await new ImportBoundary(store, {
      journey: "mba-admissions-qualification", journeyVersion: 3, agentId: "agent://engati/import",
    }).import([mkLead(0, true)]);
    const before = (await store.query({ leadId: ids[0]! })).length;

    await new ReplayEngine(store, registry, stubRuntime())
      .replay("mba-admissions-qualification", 3, 4, ids);

    expect((await store.query({ leadId: ids[0]! })).length).toBe(before);
  });

  it("returns a zero-width interval for an empty cohort", async () => {
    const lift = await new ReplayEngine(store, registry, stubRuntime())
      .replay("mba-admissions-qualification", 3, 4, []);
    expect(lift.n).toBe(0);
    expect(lift.ci95).toEqual([0, 0]);
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

```bash
npx vitest run packages/batch/test/replay.test.ts
```
Expected: FAIL — `Cannot find module '../src/replay/engine.js'`

- [ ] **Step 6: Write the replay engine**

`packages/batch/src/replay/engine.ts`:
```typescript
import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { LeadState } from "@midfunnel/core/events/types";
import type { AgentRuntime } from "@midfunnel/runtime/step";
import { bootstrapDiffCI } from "./stats.js";

export interface ReplayOutcome {
  leadId: string;
  decision: string;
  qualified: boolean;
  turns: number;
}

export interface Divergence {
  leadId: string;
  a: ReplayOutcome;
  b: ReplayOutcome;
  actualOutcome: string | null;
}

export interface Lift {
  n: number;
  a: { version: number; qualifiedRate: number; projectedConversions: number };
  b: { version: number; qualifiedRate: number; projectedConversions: number };
  absoluteLift: number;
  ci95: [number, number];
  /** OBSERVED — measured from history, never modelled. */
  observedConversionByDecision: Record<string, number>;
  divergent: Divergence[];
}

const CONVERTED = new Set(["enrolled", "paid"]);

export class ReplayEngine {
  constructor(
    private readonly store: EventStore,
    private readonly registry: JourneyRegistry,
    private readonly runtime: AgentRuntime,
  ) {}

  /**
   * Replays a historical cohort through two journey versions.
   *
   * The runtime used here must be identical in model and effort to the
   * production runtime — otherwise the counterfactual estimates a different
   * system and the lift figure is meaningless.
   *
   * Writes nothing: replay is a pure read over history.
   */
  async replay(
    journey: string, va: number, vb: number, leadIds: string[],
  ): Promise<Lift> {
    const [specA, specB] = await Promise.all([
      this.registry.get(journey, va),
      this.registry.get(journey, vb),
    ]);

    const states = await Promise.all(leadIds.map((id) => this.store.fold(id)));

    const outA: ReplayOutcome[] = [];
    const outB: ReplayOutcome[] = [];
    for (const state of states) {
      outA.push(await this.run(specA, state));
      outB.push(await this.run(specB, state));
    }

    // OBSERVED: what actually happened, bucketed by the decision v_a reached.
    const observed = observedConversion(states, outA);

    const rate = (o: ReplayOutcome[]) => (o.length ? o.filter((x) => x.qualified).length / o.length : 0);
    const rateA = rate(outA);
    const rateB = rate(outB);

    // MODELLED: apply the observed per-decision conversion rate to each arm.
    const project = (o: ReplayOutcome[]) =>
      round2(o.reduce((sum, x) => sum + (observed[x.decision] ?? 0), 0));

    const divergent: Divergence[] = [];
    states.forEach((s, i) => {
      const a = outA[i]!; const b = outB[i]!;
      if (a.decision !== b.decision) {
        divergent.push({
          leadId: s.leadId, a, b,
          actualOutcome: s.outcomes.at(-1)?.outcome ?? null,
        });
      }
    });

    return {
      n: states.length,
      a: { version: va, qualifiedRate: round4(rateA), projectedConversions: project(outA) },
      b: { version: vb, qualifiedRate: round4(rateB), projectedConversions: project(outB) },
      absoluteLift: round4(rateB - rateA),
      ci95: bootstrapDiffCI(outA.map((o) => o.qualified), outB.map((o) => o.qualified), { seed: 1 }),
      observedConversionByDecision: observed,
      divergent,
    };
  }

  private async run(spec: Awaited<ReturnType<JourneyRegistry["get"]>>, state: LeadState): Promise<ReplayOutcome> {
    const actions = await this.runtime.step(spec, state);
    let decision = "cold";
    let qualified = false;
    for (const a of actions) {
      if (a.kind === "route") decision = a.decision;
      if (a.kind === "complete") qualified = a.qualified;
      if (a.kind === "escalate") decision = "escalated";
    }
    return { leadId: state.leadId, decision, qualified, turns: state.turns.length };
  }
}

/** Historical conversion rate per decision bucket. Pure measurement. */
function observedConversion(
  states: LeadState[], outcomes: ReplayOutcome[],
): Record<string, number> {
  const tally: Record<string, { converted: number; total: number }> = {};
  states.forEach((s, i) => {
    const decision = outcomes[i]!.decision;
    const bucket = (tally[decision] ??= { converted: 0, total: 0 });
    bucket.total++;
    if (s.outcomes.some((o) => CONVERTED.has(o.outcome))) bucket.converted++;
  });
  return Object.fromEntries(
    Object.entries(tally).map(([k, v]) => [k, round4(v.converted / v.total)]),
  );
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const round2 = (v: number) => Math.round(v * 100) / 100;
```

`packages/batch/src/index.ts`:
```typescript
export * from "./import/pii.js";
export * from "./import/importer.js";
export * from "./replay/stats.js";
export * from "./replay/engine.js";
```

- [ ] **Step 7: Run the tests and confirm they pass**

```bash
npx vitest run packages/batch/test/
```
Expected: PASS — 6 pii, 6 importer, 5 stats, 5 replay

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(batch): replay engine with paired bootstrap CI and observed/modelled separation"
```

---
## Task 12: Web API and the replay comparison screen

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`
- Create: `packages/web/src/server.ts`, `packages/web/src/routes/replay.ts`
- Create: `packages/console/package.json`, `packages/console/vite.config.ts`, `packages/console/index.html`
- Create: `packages/console/src/main.tsx`, `packages/console/src/App.tsx`, `packages/console/src/ReplayComparison.tsx`
- Test: `packages/web/test/routes.test.ts`

**Interfaces:**
- Consumes: `JourneyRegistry` (Task 4); `ReplayEngine`, `Lift` (Task 11); `EventStore` (Task 2); `AgentRuntime` (Task 9)
- Produces:
  - `buildServer(deps: ServerDeps): FastifyInstance`
  - `interface ServerDeps { registry; store; replay }`
  - Routes: `GET /health` · `GET /api/journeys/:journey/versions` · `GET /api/journeys/:journey/diff?a&b` · `POST /api/replay`

**Role dispatch:** `ROLE=web|runtime|batch|all` selects the entrypoint. Same image, different startup — that is the modulith. M1 only needs `web`, but the switch exists from the start so nothing has to be restructured to add the others.

- [ ] **Step 1: Create the web package**

`packages/web/package.json`:
```json
{
  "name": "@midfunnel/web",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/server.ts",
  "scripts": { "dev": "tsx watch src/server.ts" },
  "dependencies": {
    "@midfunnel/core": "*",
    "@midfunnel/runtime": "*",
    "@midfunnel/batch": "*",
    "fastify": "^5.0.0"
  }
}
```

`packages/web/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```bash
npm install
```

- [ ] **Step 2: Write the failing test**

`packages/web/test/routes.test.ts`:
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
const V3 = V4.replace("version: 4", "version: 3");

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const LIFT = {
  n: 30,
  a: { version: 3, qualifiedRate: 0.18, projectedConversions: 3.4 },
  b: { version: 4, qualifiedRate: 0.24, projectedConversions: 4.1 },
  absoluteLift: 0.06,
  ci95: [0.02, 0.1] as [number, number],
  observedConversionByDecision: { hot: 0.31, cold: 0.02 },
  divergent: [],
};

let pool: Pool; let app: ReturnType<typeof buildServer>;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE journey_versions");
  const registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V3);
  await registry.publish(V4);
  app = buildServer({
    registry,
    store: new EventStore(pool, "t1"),
    replay: { replay: vi.fn().mockResolvedValue(LIFT) } as never,
  });
});
afterAll(async () => { await pool.end(); });

describe("web routes", () => {
  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("lists journey versions newest first", async () => {
    const res = await app.inject({ url: "/api/journeys/mba-admissions-qualification/versions" });
    expect(res.json()).toEqual({ versions: [4, 3] });
  });

  it("returns a structural diff between two versions", async () => {
    const res = await app.inject({
      url: "/api/journeys/mba-admissions-qualification/diff?a=3&b=4",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changes.some((c: { path: string }) => c.path === "version")).toBe(true);
  });

  it("runs a replay and returns the lift", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/replay",
      payload: { journey: "mba-admissions-qualification", a: 3, b: 4, leadIds: ["L_1"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ absoluteLift: 0.06, ci95: [0.02, 0.1] });
  });

  it("rejects a replay with a malformed body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/replay", payload: { journey: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown journey rather than throwing", async () => {
    const res = await app.inject({ url: "/api/journeys/nope/diff?a=1&b=2" });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx vitest run packages/web/test/routes.test.ts
```
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 4: Write the routes and server**

`packages/web/src/routes/replay.ts`:
```typescript
import type { FastifyInstance } from "fastify";
import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { ReplayEngine } from "@midfunnel/batch/replay/engine";

export interface ServerDeps {
  registry: JourneyRegistry;
  store: EventStore;
  replay: ReplayEngine;
}

export function registerRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { journey: string } }>(
    "/api/journeys/:journey/versions",
    async (req) => ({ versions: await deps.registry.list(req.params.journey) }),
  );

  app.get<{ Params: { journey: string }; Querystring: { a?: string; b?: string } }>(
    "/api/journeys/:journey/diff",
    async (req, reply) => {
      const a = Number(req.query.a);
      const b = Number(req.query.b);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "a and b must be integer versions" });
      }
      try {
        return { changes: await deps.registry.diff(req.params.journey, a, b) };
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { journey?: unknown; a?: unknown; b?: unknown; leadIds?: unknown } }>(
    "/api/replay",
    async (req, reply) => {
      const { journey, a, b, leadIds } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "journey (string), a and b (integers) are required" });
      }
      const ids = Array.isArray(leadIds)
        ? (leadIds as string[])
        : (await deps.store.query({ journey, type: "LeadIngested" })).map((e) => e.leadId);

      try {
        return await deps.replay.replay(journey, a as number, b as number, ids);
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );
}
```

`packages/web/src/server.ts`:
```typescript
import Fastify, { type FastifyInstance } from "fastify";
import { createPool } from "@midfunnel/core/db/client";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { ReplayEngine } from "@midfunnel/batch/replay/engine";
import { registerRoutes, type ServerDeps } from "./routes/replay.js";

export type { ServerDeps };

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
  });
  registerRoutes(app, deps);
  return app;
}

/**
 * Role dispatch. One artifact, three startup modes — `web` serves the console
 * API, `runtime` steps live conversations, `batch` runs replay and simulation.
 * M1 exercises `web`; the switch exists now so adding the others is a flag.
 */
async function main(): Promise<void> {
  const role = process.env.ROLE ?? "all";
  const tenantId = process.env.TENANT_ID ?? "t1";
  const pool = createPool();

  const store = new JourneyRegistry(pool, tenantId);
  const events = new EventStore(pool, tenantId);
  const runtime = new AgentRuntime();
  const replay = new ReplayEngine(events, store, runtime);

  if (role === "web" || role === "all") {
    const app = buildServer({ registry: store, store: events, replay });
    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`[${role}] listening on :${port}`);
  }
  if (role === "runtime") console.log("[runtime] role is a no-op in M1 — live stepping lands in M2");
  if (role === "batch") console.log("[batch] role is invoked per job in M1 — see scripts/replay.ts");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npx vitest run packages/web/test/routes.test.ts
```
Expected: PASS — 6 tests

- [ ] **Step 6: Build the console**

`packages/console/package.json`:
```json
{
  "name": "@midfunnel/console",
  "version": "0.1.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0"
  }
}
```

`packages/console/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
```

`packages/console/index.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Mid-Funnel Console</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`packages/console/src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(<App />);
```

`packages/console/src/App.tsx`:
```tsx
import { ReplayComparison } from "./ReplayComparison.js";

export function App() {
  return (
    <main style={{ font: "14px system-ui", maxWidth: 900, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>Replay — v3 vs v4</h1>
      <ReplayComparison journey="mba-admissions-qualification" a={3} b={4} />
    </main>
  );
}
```

- [ ] **Step 7: Write the replay screen**

`packages/console/src/ReplayComparison.tsx`:
```tsx
import { useEffect, useState } from "react";

interface Lift {
  n: number;
  a: { version: number; qualifiedRate: number; projectedConversions: number };
  b: { version: number; qualifiedRate: number; projectedConversions: number };
  absoluteLift: number;
  ci95: [number, number];
  observedConversionByDecision: Record<string, number>;
  divergent: Array<{ leadId: string; a: { decision: string }; b: { decision: string }; actualOutcome: string | null }>;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function ReplayComparison({ journey, a, b }: { journey: string; a: number; b: number }) {
  const [lift, setLift] = useState<Lift | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journey, a, b }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setLift)
      .catch((e: Error) => setError(e.message));
  }, [journey, a, b]);

  if (error) return <p style={{ color: "#b00" }}>Replay failed: {error}</p>;
  if (!lift) return <p>Replaying…</p>;

  return (
    <>
      <p style={{ color: "#555" }}>{lift.n.toLocaleString()} historical leads</p>

      <div style={{ display: "flex", gap: 24, margin: "24px 0" }}>
        <Arm label={`v${lift.a.version} (current)`} rate={lift.a.qualifiedRate} />
        <Arm label={`v${lift.b.version} (candidate)`} rate={lift.b.qualifiedRate} />
      </div>

      <p style={{ fontSize: 18 }}>
        <strong>{lift.absoluteLift >= 0 ? "+" : ""}{pct(lift.absoluteLift)}</strong>{" "}
        qualification rate
        <span style={{ color: "#555" }}>
          {" "}(95% CI {pct(lift.ci95[0])} to {pct(lift.ci95[1])})
        </span>
      </p>

      {/* Observed and modelled are rendered differently on purpose. Blurring
          the two is the fastest way to lose a room. */}
      <Section title="Observed — measured from history" tone="#0a0">
        <ul>
          {Object.entries(lift.observedConversionByDecision).map(([d, r]) => (
            <li key={d}>{d}: {pct(r)} converted</li>
          ))}
        </ul>
      </Section>

      <Section title="Modelled — projected from observed rates" tone="#a60">
        <p>
          v{lift.a.version}: {lift.a.projectedConversions.toFixed(1)} conversions ·{" "}
          v{lift.b.version}: {lift.b.projectedConversions.toFixed(1)} conversions
        </p>
      </Section>

      <h2 style={{ fontSize: 15 }}>Diverged on {lift.divergent.length} leads</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th>Lead</th><th>v{lift.a.version}</th><th>v{lift.b.version}</th><th>Actually</th>
          </tr>
        </thead>
        <tbody>
          {lift.divergent.slice(0, 60).map((d) => (
            <tr key={d.leadId} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td><code>{d.leadId}</code></td>
              <td>{d.a.decision}</td>
              <td>{d.b.decision}</td>
              <td>{d.actualOutcome ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Arm({ label, rate }: { label: string; rate: number }) {
  return (
    <div style={{ flex: 1, border: "1px solid #ddd", borderRadius: 8, padding: 16 }}>
      <div style={{ color: "#555", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 28 }}>{pct(rate)}</div>
      <div style={{ color: "#555", fontSize: 12 }}>qualified</div>
    </div>
  );
}

function Section({ title, tone, children }: { title: string; tone: string; children: React.ReactNode }) {
  return (
    <section style={{ borderLeft: `3px solid ${tone}`, paddingLeft: 12, margin: "20px 0" }}>
      <h3 style={{ fontSize: 13, color: tone, margin: "0 0 4px" }}>{title}</h3>
      {children}
    </section>
  );
}
```

- [ ] **Step 8: Verify the console builds and the full suite is green**

```bash
npm install && npm run build -w @midfunnel/console && npm test
```
Expected: vite build succeeds; all suites pass

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web,console): replay API and comparison screen with observed/modelled separation"
```

---

## Done When

M1 is complete when all of the following hold:

- [ ] `npm test` is green across `core`, `runtime`, `batch`, `web`
- [ ] A real historical cohort imports with PII scrubbed **before** persistence
- [ ] Replaying that cohort through two journey versions yields a lift figure with a 95% confidence interval
- [ ] Observed and modelled numbers are visually distinct on screen
- [ ] Every event row carries `agent_id`
- [ ] An unprivileged capability call is denied, and `AuthorizationDenied` is in the log
- [ ] Changing `decision_maker` to `required` and publishing v5 produces a readable diff — **demo moment 2**
- [ ] The replay screen renders divergent conversations — **demo moment 1**

---

## Self-Review

**Spec coverage.** Every M1 component in spec §12.3 maps to a task: Event Store → 2 · Import Boundary → 10 · Agent Registry → 5 · Journey Registry → 4 · Agent Runtime → 9 · Evidence Extractor → 7 · Tool Broker → 6 · Replay Engine → 11 · replay screen → 12. Scoring and routing (spec §5.3) were implicit in "Agent Runtime" and are broken out as Task 8. Simulator, Eval Harness, Attribution, Insight Engine and Copilot are M2/M3 and correctly absent.

**Type consistency.** `Turn`, `LeadState`, `EventInput` are defined once in Task 2 and imported thereafter. `Evidence` (Task 8) and `Record<string, ExtractedField>` (Task 7) are structurally identical — `{ value: unknown; confidence: number }` — and used interchangeably by design. `Action` is defined in Task 9 and consumed by Task 11. `JourneySpec` flows from Task 3 into 4, 5, 7, 8, 9, 11.

**One contract, two renderings.** `evidenceToJsonSchema` (Task 3) and `evidenceToZod` (Task 7) both express the evidence block. Task 7 adds a test asserting they agree on field names, so they cannot drift.

**Deliberate M1 limitations, all resolved later:**
- `AgentRegistry.fromSpec` reads a single inline agent. Multi-agent lookup arrives with the shared registry; the interface does not change.
- `evaluatePredicate` supports `score <op> n`, `evidence.complete(required)` and `otherwise`. The `sentiment < -0.5` escalation rule in the fixture parses but never fires until M2 adds sentiment. **This is why `escalationTrigger` silently skips rules it cannot evaluate rather than throwing** — an unimplementable rule must not break the runtime.
- `metrics:` is parsed and stored but not yet evaluated. The metric evaluator is M3, where attribution needs it.
- Replay assumes one `step()` per lead against the full historical transcript, rather than turn-by-turn re-simulation. This measures *decision* divergence, not *conversational* divergence — the honest and much cheaper thing for M1. Turn-by-turn replay is an M2 upgrade once the simulator exists.

---
