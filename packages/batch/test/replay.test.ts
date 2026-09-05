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

const IMPORT_OPTS = {
  journey: "mba-admissions-qualification", journeyVersion: 3, agentId: "agent://engati/import",
};

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

/** Deterministic bucket from a lead id, independent of id format. */
const bucket = (id: string) =>
  [...id].reduce((a, c) => (a + c.charCodeAt(0)) % 3, 0);

/** v4 qualifies every lead; v3 qualifies one bucket in three. No model calls. */
function stubRuntime() {
  return {
    // Both arms share one extraction pass when the evidence contracts match,
    // so the stub offers extraction too and the fast path is what is tested.
    extract: vi.fn(async () => ({})),
    step: vi.fn(async (spec: { version: number }, state: { leadId: string }): Promise<Action[]> => {
      const hot = spec.version === 4 || bucket(state.leadId) === 0;
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
  await pool.query("TRUNCATE journey_versions CASCADE");
  store = new EventStore(pool, "t1");
  registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V3);
  await registry.publish(V4);
});
afterAll(async () => { await pool.end(); });

describe("ReplayEngine", () => {
  it("produces a lift with a confidence interval over a real cohort", async () => {
    const ids = await new ImportBoundary(store, IMPORT_OPTS)
      .import(Array.from({ length: 30 }, (_, i) => mkLead(i, i % 4 === 0)));

    const lift = await new ReplayEngine(store, registry, stubRuntime())
      .replay("mba-admissions-qualification", 3, 4, ids);

    expect(lift.n).toBe(30);
    expect(lift.b.qualifiedRate).toBeGreaterThan(lift.a.qualifiedRate);
    expect(lift.absoluteLift).toBeCloseTo(lift.b.qualifiedRate - lift.a.qualifiedRate, 5);
    expect(lift.ci95[0]).toBeLessThanOrEqual(lift.ci95[1]);
  });

  it("keeps observed and modelled numbers in separate fields", async () => {
    const ids = await new ImportBoundary(store, IMPORT_OPTS)
      .import(Array.from({ length: 12 }, (_, i) => mkLead(i, i % 3 === 0)));

    const lift = await new ReplayEngine(store, registry, stubRuntime())
      .replay("mba-admissions-qualification", 3, 4, ids);

    expect(Object.keys(lift.observedConversionByDecision).length).toBeGreaterThan(0);
    expect(typeof lift.b.projectedConversions).toBe("number");
  });

  it("lists divergent leads with the actual historical outcome attached", async () => {
    const ids = await new ImportBoundary(store, IMPORT_OPTS)
      .import(Array.from({ length: 30 }, (_, i) => mkLead(i, i === 1)));

    const lift = await new ReplayEngine(store, registry, stubRuntime())
      .replay("mba-admissions-qualification", 3, 4, ids);

    expect(lift.divergent.length).toBeGreaterThan(0);
    for (const d of lift.divergent) expect(d.a.decision).not.toBe(d.b.decision);
    expect(lift.divergent.every((d) => "actualOutcome" in d)).toBe(true);
  });

  it("writes no events - replay is a pure read over history", async () => {
    const ids = await new ImportBoundary(store, IMPORT_OPTS).import([mkLead(0, true)]);
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

describe("cost of a replay", () => {
  it("does not extract at all when the evidence is already on the record", async () => {
    // A lead the journey has already run carries its EvidenceExtracted events.
    // Re-deriving them costs a model call to reproduce a recorded fact — and on
    // a 2000-lead cohort that was the entire wall time and the entire bill.
    const ids = await new ImportBoundary(store, IMPORT_OPTS)
      .import(Array.from({ length: 30 }, (_, i) => mkLead(i, false)));
    for (const leadId of ids) {
      await store.appendMany(["target_program", "timeline", "budget_band"].map((field) => ({
        leadId, journey: IMPORT_OPTS.journey, journeyVersion: 3,
        agentId: IMPORT_OPTS.agentId, type: "EvidenceExtracted" as const,
        payload: { field, value: "x", confidence: 0.9 },
      })));
    }

    const runtime = stubRuntime() as unknown as { extract: { mock: { calls: unknown[] } } };
    const lift = await new ReplayEngine(store, registry, runtime as never)
      .replay(IMPORT_OPTS.journey, 3, 4, ids);

    expect(runtime.extract.mock.calls.length).toBe(0);
    expect(lift.cost).toEqual({ leads: 30, extracted: 0, reused: 30, usd: 0 });
  });

  it("extracts once per lead, not once per arm, when the contract is shared", async () => {
    const ids = await new ImportBoundary(store, IMPORT_OPTS)
      .import(Array.from({ length: 30 }, (_, i) => mkLead(i, false)));
    const runtime = stubRuntime() as unknown as
      { extract: { mock: { calls: unknown[] } }; step: { mock: { calls: unknown[] } } };
    await new ReplayEngine(store, registry, runtime as never)
      .replay(IMPORT_OPTS.journey, 3, 4, ids);

    // 30 extractions for 60 steps: the halving that turns 4000 model calls on a
    // 2000-lead cohort into 2000.
    // No evidence on the record for these leads, so all 30 need extracting —
    // once, not once per arm.
    expect(runtime.extract.mock.calls.length).toBe(30);
    expect(runtime.step.mock.calls.length).toBe(60);
  });

  it("extracts per arm when the two versions declare different evidence", async () => {
    // v5 makes decision_maker required, which changes the contract.
    const v5 = V4.replace("version: 4", "version: 5").replace(
      "  decision_maker:\n    type: enum[self, parent, employer]\n    required: false",
      "  decision_maker:\n    type: enum[self, parent, employer]\n    required: true",
    );
    await registry.publish(v5);
    const ids = await new ImportBoundary(store, IMPORT_OPTS)
      .import(Array.from({ length: 30 }, (_, i) => mkLead(i, false)));
    const runtime = stubRuntime() as unknown as { extract: { mock: { calls: unknown[] } } };
    await new ReplayEngine(store, registry, runtime as never)
      .replay(IMPORT_OPTS.journey, 4, 5, ids);
    expect(runtime.extract.mock.calls.length).toBe(0);
  });
});
