import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { costOf } from "@midfunnel/runtime/provider";
import { CostIngestor, recordModelCost } from "../src/attribution/cost.js";
import { AttributionEngine } from "../src/attribution/engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8");
const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const JOURNEY = "mba-admissions-qualification";
const AGENT = "agent://engati/mba-admissions";
const INR = { currency: "INR", perUsd: 8300 };

let pool: Pool;
let store: EventStore;
let registry: JourneyRegistry;

/** Three leads on one campaign: one converts, one qualifies only, one neither. */
async function seed() {
  const base = { journey: JOURNEY, journeyVersion: 4, agentId: AGENT };
  const day = "2026-06-01T10:00:00Z";
  const lead = (id: string, creative: string) => ({
    ...base, leadId: id, type: "LeadIngested" as const, occurredAt: new Date(day),
    payload: { source: "meta_lead_ads", campaignId: "camp_0", creativeId: creative },
  });

  await store.appendMany([
    lead("L1", "cr_a"), lead("L2", "cr_a"), lead("L3", "cr_b"),
    { ...base, leadId: "L1", type: "Scored", payload: { score: 75 }, occurredAt: new Date(day) },
    { ...base, leadId: "L1", type: "Routed", payload: { decision: "hot", target: "handoff.counsellor" }, occurredAt: new Date(day) },
    { ...base, leadId: "L1", type: "HandoffCreated", payload: {}, occurredAt: new Date(day) },
    { ...base, leadId: "L1", type: "OutcomeObserved", payload: { outcome: "paid", amount: 45000000 }, occurredAt: new Date(day) },
    { ...base, leadId: "L2", type: "Routed", payload: { decision: "hot", target: "handoff.counsellor" }, occurredAt: new Date(day) },
    { ...base, leadId: "L3", type: "Routed", payload: { decision: "cold", target: "nurture.x" }, occurredAt: new Date(day) },
  ]);
}

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE events");
  await pool.query("TRUNCATE journey_versions CASCADE");
  store = new EventStore(pool, "t1");
  registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V4);
});
afterAll(async () => { await pool.end(); });

describe("CostIngestor", () => {
  it("allocates campaign spend evenly and loses no minor units to rounding", async () => {
    await seed();
    // 1000 paise across 3 leads does not divide evenly.
    const res = await new CostIngestor(store).ingestMedia([
      { campaignId: "camp_0", day: "2026-06-01", amount: 1000, currency: "INR" },
    ]);
    expect(res.leadsCharged).toBe(3);

    const charged = (await store.query({ type: "CostObserved" }))
      .map((e) => Number(e.payload.amount));
    expect(charged.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(charged.sort()).toEqual([333, 333, 334]);
  });

  it("records the allocation method alongside the amount", async () => {
    await seed();
    await new CostIngestor(store).ingestMedia([
      { campaignId: "camp_0", day: "2026-06-01", amount: 900, currency: "INR" },
    ]);
    const [first] = await store.query({ leadId: "L1", type: "CostObserved" });
    expect(first!.payload).toMatchObject({ allocation: "even", cohortSize: 3, kind: "media" });
  });

  it("is idempotent, so re-importing a platform export does not double-charge", async () => {
    await seed();
    const rows = [{ campaignId: "camp_0", day: "2026-06-01", amount: 900, currency: "INR" }];
    await new CostIngestor(store).ingestMedia(rows);
    const again = await new CostIngestor(store).ingestMedia(rows);
    expect(again.leadsCharged).toBe(0);
    expect(again.skipped).toBe(1);
    expect((await store.query({ type: "CostObserved" })).length).toBe(3);
  });

  it("can narrow allocation to a single creative", async () => {
    await seed();
    await new CostIngestor(store).ingestMedia([
      { campaignId: "camp_0", creativeId: "cr_b", day: "2026-06-01", amount: 500, currency: "INR" },
    ]);
    const charged = await store.query({ type: "CostObserved" });
    expect(charged.length).toBe(1);
    expect(charged[0]!.leadId).toBe("L3");
  });

  it("skips a spend row that matches no leads instead of charging nobody", async () => {
    await seed();
    const res = await new CostIngestor(store).ingestMedia([
      { campaignId: "camp_missing", day: "2026-06-01", amount: 500, currency: "INR" },
    ]);
    expect(res).toEqual({ leadsCharged: 0, allocated: 0, skipped: 1 });
  });
});

describe("recordModelCost", () => {
  it("converts USD to the reporting currency at write time and records the rate", async () => {
    await seed();
    const call = costOf("gpt-5.6-terra", {
      input_tokens: 1000, output_tokens: 2000,
      input_tokens_details: { cached_tokens: 500 },
      output_tokens_details: { reasoning_tokens: 1500 },
    });
    // (500 * $2 + 500 * $0.20 + 2000 * $12) / 1e6
    expect(call.usd).toBeCloseTo(0.025100, 6);

    await recordModelCost(store, {
      leadId: "L1", journey: JOURNEY, journeyVersion: 4, agentId: AGENT,
    }, [call], INR);

    const [ev] = await store.query({ leadId: "L1", type: "CostObserved" });
    expect(ev!.payload).toMatchObject({
      kind: "model", currency: "INR", fxPerUsd: 8300, reasoningTokens: 1500,
    });
    expect(ev!.payload.amount).toBe(Math.round(0.0251 * 8300));
  });

  it("writes nothing when no call carried a published price", async () => {
    await seed();
    await recordModelCost(store, {
      leadId: "L1", journey: JOURNEY, journeyVersion: 4, agentId: AGENT,
    }, [costOf("some-unpriced-model", { input_tokens: 100 })], INR);
    expect((await store.query({ leadId: "L1", type: "CostObserved" })).length).toBe(0);
  });
});

describe("AttributionEngine", () => {
  it("folds declared metrics into counts, sums and cost per outcome", async () => {
    await seed();
    await new CostIngestor(store).ingestMedia([
      { campaignId: "camp_0", day: "2026-06-01", amount: 3000, currency: "INR" },
    ]);

    const report = await new AttributionEngine(store, registry).roll(JOURNEY);
    expect(report.total.leads).toBe(3);
    // Two routed hot; only L1 booked and paid.
    expect(report.total.counts).toMatchObject({ qualified_lead: 2, booked: 1, conversion: 1 });
    expect(report.total.sums.revenue).toBe(45000000);
    expect(report.total.mediaCost).toBe(3000);
    expect(report.total.costPer.qualified_lead).toBe(1500);
    expect(report.total.costPer.conversion).toBe(3000);
    expect(report.total.returnOnSpend.revenue).toBe(15000);
  });

  it("reports an undefined ratio rather than Infinity when nothing converted", async () => {
    const base = { journey: JOURNEY, journeyVersion: 4, agentId: AGENT };
    await store.appendMany([
      { ...base, leadId: "L9", type: "LeadIngested", payload: { campaignId: "camp_1", creativeId: "cr_z" } },
      { ...base, leadId: "L9", type: "Routed", payload: { decision: "cold", target: "nurture.x" } },
    ]);
    const report = await new AttributionEngine(store, registry).roll(JOURNEY);
    expect(report.total.counts.conversion).toBe(0);
    expect(report.total.costPer.conversion).toBeNull();
  });

  it("nests campaign then creative then journey version", async () => {
    await seed();
    const { tree } = await new AttributionEngine(store, registry).roll(JOURNEY);
    expect(tree.map((n) => [n.dimension, n.value, n.leads]))
      .toEqual([["campaign", "camp_0", 3]]);
    expect(tree[0]!.children.map((n) => [n.value, n.leads]))
      .toEqual([["cr_a", 2], ["cr_b", 1]]);
    expect(tree[0]!.children[0]!.children.map((n) => [n.dimension, n.value]))
      .toEqual([["version", "4"]]);
  });

  it("attributes a lead to the version that routed it, not the one that ingested it", async () => {
    await registry.publish(V4.replace("version: 4", "version: 5"));
    const base = { journey: JOURNEY, agentId: AGENT };
    await store.appendMany([
      { ...base, journeyVersion: 4, leadId: "LX", type: "LeadIngested", payload: { campaignId: "c", creativeId: "cr" } },
      { ...base, journeyVersion: 5, leadId: "LX", type: "Routed", payload: { decision: "hot", target: "handoff.counsellor" } },
    ]);
    const { tree } = await new AttributionEngine(store, registry).roll(JOURNEY);
    expect(tree[0]!.children[0]!.children.map((n) => n.value)).toEqual(["5"]);
  });

  it("warns when a metric predicate changed between versions present in the data", async () => {
    // v5 redefines conversion to count `applied` too. Summing the two columns
    // is comparing different questions, so the report must say so.
    await registry.publish(V4
      .replace("version: 4", "version: 5")
      .replace("outcome in [enrolled, paid]", "outcome in [applied, enrolled, paid]"));
    const base = { journey: JOURNEY, agentId: AGENT, payload: { campaignId: "c", creativeId: "cr" } };
    await store.appendMany([
      { ...base, journeyVersion: 4, leadId: "LA", type: "LeadIngested" },
      { ...base, journeyVersion: 5, leadId: "LB", type: "LeadIngested" },
    ]);
    const { caveats } = await new AttributionEngine(store, registry).roll(JOURNEY);
    expect(caveats.join(" ")).toMatch(/"conversion" is defined differently across versions 4, 5/);
  });

  it("states the allocation assumption and flags leads with no cost ingested", async () => {
    await seed();
    const { caveats } = await new AttributionEngine(store, registry).roll(JOURNEY);
    expect(caveats.join(" ")).toMatch(/allocated evenly/);
    expect(caveats.join(" ")).toMatch(/3 of 3 leads have no media cost/);
  });
});
