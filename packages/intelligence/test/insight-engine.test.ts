import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { EventInput } from "@midfunnel/core/events/types";
import { InsightEngine } from "../src/insights/engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8");
const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const JOURNEY = "mba-admissions-qualification";
const AGENT = "agent://engati/mba-admissions";

let pool: Pool;
let store: EventStore;
let registry: JourneyRegistry;

/**
 * 160 leads split evenly into four quadrants of 40 by campaign and by whether
 * budget_band was ever established:
 *
 *   good campaign + budget   80% convert      bad campaign + budget   30%
 *   good campaign + none     30%              bad campaign + none      5%
 *
 * Two independent signals planted on purpose, each quadrant above MIN_SUPPORT,
 * so the assertions test detection rather than luck.
 */
const CONVERSION: Record<number, number> = { 0: 12, 1: 32, 2: 2, 3: 12 };

async function seed() {
  const events: EventInput[] = [];
  for (let i = 0; i < 160; i++) {
    const quadrant = i % 4;                       // 0 bad+budget, 1 good+budget,
    const bad = quadrant % 2 === 0;               // 2 bad+none,   3 good+none
    const hasBudget = quadrant < 2;
    const converts = Math.floor(i / 4) < CONVERSION[quadrant]!;
    const base = {
      leadId: `L${i}`, journey: JOURNEY, journeyVersion: 4, agentId: AGENT,
    };
    const at = new Date(`2026-06-01T0${(i % 5) + 3}:30:00Z`);

    events.push({ ...base, type: "LeadIngested", occurredAt: at,
      payload: { campaignId: bad ? "camp_bad" : "camp_good", creativeId: `cr_${i % 3}` } });
    events.push({ ...base, type: "MessageSent", occurredAt: at,
      payload: { renderedText: "Which programme are you considering?" } });
    events.push({ ...base, type: "MessageReceived", occurredAt: at,
      payload: { rawText: "executive mba, this intake" } });
    events.push({ ...base, type: "EvidenceExtracted", occurredAt: at,
      payload: { field: "timeline", value: "this_intake", confidence: 0.9 } });
    if (hasBudget) {
      events.push({ ...base, type: "EvidenceExtracted", occurredAt: at,
        payload: { field: "budget_band", value: "above_15L", confidence: 0.9 } });
    }
    events.push({ ...base, type: "Scored", occurredAt: at, payload: { score: hasBudget ? 75 : 40 } });
    events.push({ ...base, type: "Routed", occurredAt: at,
      payload: hasBudget
        ? { decision: "hot", target: "handoff.counsellor" }
        : { decision: "warm", target: "nurture.mba_warm_14d" } });
    if (converts) {
      events.push({ ...base, type: "OutcomeObserved", occurredAt: at,
        payload: { outcome: "enrolled", amount: 45000000 } });
    }
  }
  await store.appendMany(events);
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

describe("InsightEngine", () => {
  it("finds the planted campaign divergence and evidence bottleneck", async () => {
    await seed();
    const report = await new InsightEngine(store, registry).insights(JOURNEY);
    expect(report.leadsAnalysed).toBe(160);

    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("segment_divergence");
    expect(codes).toContain("evidence_bottleneck");

    const seg = report.findings.find((f) => f.code === "segment_divergence")!;
    expect(seg.claim).toMatch(/camp_bad/);
    expect(seg.ci95).toBeDefined();
  });

  it("carries support and an interval on every comparison finding", async () => {
    await seed();
    const { findings } = await new InsightEngine(store, registry).insights(JOURNEY);
    // drop_off and timing are distributional, not comparisons. Routing is the
    // one finding entitled to report an interval spanning zero, because "the
    // score carries no signal" is precisely what such an interval means.
    const comparisons = findings.filter((f) =>
      !["drop_off", "timing", "routing_miscalibration"].includes(f.code));
    expect(comparisons.length).toBeGreaterThan(0);
    for (const f of comparisons) {
      expect(f.n).toBeGreaterThanOrEqual(30);
      expect(f.ci95).toBeDefined();
      // Anywhere else, an interval that spans zero is a finding that should not exist.
      expect(f.ci95![0] <= 0 && f.ci95![1] >= 0).toBe(false);
    }
  });

  it("ranks by severity first, so a large low-severity effect never leads", async () => {
    await seed();
    const { findings } = await new InsightEngine(store, registry).insights(JOURNEY);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < findings.length; i++) {
      expect(rank[findings[i - 1]!.severity]).toBeLessThanOrEqual(rank[findings[i]!.severity]);
    }
  });

  it("names the detectors that could not run instead of implying a clean bill", async () => {
    await seed();
    const { skipped } = await new InsightEngine(store, registry).insights(JOURNEY);
    expect(skipped.find((s) => s.code === "policy_friction")!.reason)
      .toMatch(/no PolicyEvaluated events/);
    expect(skipped.find((s) => s.code === "version_regression")!.reason)
      .toMatch(/only one journey version/);
  });

  it("refuses to guess at 'converted' when the tenant declared no such metric", async () => {
    await seed();
    const report = await new InsightEngine(store, registry)
      .insights(JOURNEY, { conversion: "enrolment" });
    expect(report.findings).toEqual([]);
    expect(report.skipped[0]!.reason).toMatch(/no metric named "enrolment" is declared/);
    expect(report.skipped[0]!.reason).toMatch(/Declared: qualified_lead, booked, conversion, revenue/);
  });

  it("honours a tenant's own definition of conversion", async () => {
    // `booked` means HandoffCreated, which nothing in this cohort emits, so a
    // journey measured on bookings has nothing to explain.
    await seed();
    const report = await new InsightEngine(store, registry)
      .insights(JOURNEY, { conversion: "booked", only: ["segment_divergence"] });
    expect(report.findings).toEqual([]);
  });
});
