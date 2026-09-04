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
    expect(s.evidence.target_program).toEqual({ value: "online_mba", confidence: 0.95 });
    expect(s.turns.map((t) => t.role)).toEqual(["agent", "lead"]);
    expect(s.score).toBe(72);
    expect(s.decision).toBe("hot");
    expect(s.outcomes[0]).toMatchObject({ outcome: "enrolled", amount: 45000000 });
  });
});

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

describe("EventStore.appendMany at scale", () => {
  it("writes a batch larger than the wire protocol's parameter limit", async () => {
    // 5000 events x 10 bind parameters is 50000, well past the Int16 ceiling of
    // 32767. Before chunking, this failed with a parameter-count mismatch that
    // named neither the cause nor the limit.
    const events = Array.from({ length: 5000 }, (_, i) => ({
      ...base, leadId: `L${i}`, type: "LeadIngested" as const,
      payload: { source: "bulk", n: i },
    }));
    const saved = await store.appendMany(events);
    expect(saved.length).toBe(5000);
    expect((await pool.query("SELECT count(*)::int n FROM events")).rows[0].n).toBe(5000);
  });

  it("commits a large batch all or nothing", async () => {
    const events = Array.from({ length: 2000 }, (_, i) => ({
      ...base, leadId: `L${i}`, type: "LeadIngested" as const, payload: {},
    }));
    // An invalid event in the last chunk must leave the first chunks unwritten.
    events.push({ ...base, leadId: "", type: "LeadIngested", payload: {} });
    await expect(store.appendMany(events)).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int n FROM events")).rows[0].n).toBe(0);
  });
});
