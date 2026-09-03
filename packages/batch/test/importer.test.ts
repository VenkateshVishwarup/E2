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
