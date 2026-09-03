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
