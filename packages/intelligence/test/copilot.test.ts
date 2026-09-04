import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { route, score } from "@midfunnel/runtime/scoring";
import type { EventInput } from "@midfunnel/core/events/types";
import { CopilotTools } from "../src/copilot/tools.js";
import { OfflineCopilot, addBranch } from "../src/copilot/offline.js";

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
 * 160 leads. Leads whose budget_band is `needs_financing` convert far worse and
 * are routed cold — exactly the shape of demo moment 7.
 */
async function seed() {
  const events: EventInput[] = [];
  for (let i = 0; i < 160; i++) {
    const financing = i % 2 === 0;
    const converts = financing ? i % 20 === 0 : i % 5 !== 0;
    const base = { leadId: `L${i}`, journey: JOURNEY, journeyVersion: 4, agentId: AGENT };
    const at = new Date("2026-06-01T05:30:00Z");

    events.push({ ...base, type: "LeadIngested", occurredAt: at,
      payload: { campaignId: `camp_${i % 2}`, creativeId: "cr_0" } });
    events.push({ ...base, type: "EvidenceExtracted", occurredAt: at,
      payload: { field: "budget_band", value: financing ? "needs_financing" : "above_15L", confidence: 0.9 } });
    events.push({ ...base, type: "Routed", occurredAt: at,
      payload: financing
        ? { decision: "cold", target: "nurture.mba_longtail_90d" }
        : { decision: "hot", target: "handoff.counsellor" } });
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
  await pool.query("TRUNCATE journey_versions");
  store = new EventStore(pool, "t1");
  registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V4);
});
afterAll(async () => { await pool.end(); });

describe("addBranch", () => {
  it("inserts the branch first, because routing is first-match-wins", () => {
    const spec = parseSpec(addBranch(V4, "budget_band", "needs_financing"));
    expect(Object.keys(spec.routing)[0]).toBe("needs_financing_branch");
    expect(Object.keys(spec.routing).at(-1)).toBe("cold");
    expect(spec.version).toBe(5);
  });

  it("produces a branch the routing evaluator actually honours", () => {
    const spec = parseSpec(addBranch(V4, "budget_band", "needs_financing"));
    const financing = { budget_band: { value: "needs_financing", confidence: 0.9 } };
    const rich = { budget_band: { value: "above_15L", confidence: 0.9 },
                   timeline: { value: "this_intake", confidence: 0.9 },
                   decision_maker: { value: "self", confidence: 0.9 },
                   target_program: { value: "executive_mba", confidence: 0.9 } };

    // A financing lead is captured by the branch even at a score that would
    // otherwise route it hot; everyone else routes exactly as before.
    expect(route(spec, 100, financing).decision).toBe("needs_financing_branch");
    expect(score(spec, rich)).toBe(80);
    expect(route(spec, score(spec, rich), rich).decision).toBe("hot");
  });
});

describe("CopilotTools", () => {
  it("breaks conversion down by an evidence dimension", async () => {
    await seed();
    const b = await new CopilotTools(store, registry).cohort(JOURNEY, "evidence.budget_band");
    const financing = b.rows.find((r) => r.value === "needs_financing")!;
    const rich = b.rows.find((r) => r.value === "above_15L")!;
    expect(financing.leads).toBe(80);
    expect(financing.rate).toBeLessThan(rich.rate);
  });

  it("rejects a dimension it cannot compute rather than returning an empty chart", async () => {
    await seed();
    await expect(new CopilotTools(store, registry).cohort(JOURNEY, "phase_of_moon"))
      .rejects.toThrow(/unknown dimension/);
  });

  it("returns the authored YAML byte for byte, since key order is load-bearing", async () => {
    await seed();
    const { version, yaml } = await new CopilotTools(store, registry).readSpec(JOURNEY);
    expect(version).toBe(4);
    expect(yaml).toBe(V4);
  });
});

describe("proposeDiff — the validation gate", () => {
  const tools = () => new CopilotTools(store, registry);

  it("accepts a valid proposal and returns its diff and lint warnings", async () => {
    await seed();
    const d = await tools().proposeDiff(
      JOURNEY, addBranch(V4, "budget_band", "needs_financing"), "give financing its own path");
    expect(d.fromVersion).toBe(4);
    expect(d.toVersion).toBe(5);
    expect(d.changes.some((c) => c.path.startsWith("routing."))).toBe(true);
    expect(Array.isArray(d.warnings)).toBe(true);
  });

  it("refuses a proposal that does not parse", async () => {
    await seed();
    await expect(tools().proposeDiff(JOURNEY, "journey: broken\nversion: 5", "nope"))
      .rejects.toThrow(/does not parse/);
  });

  it("refuses a proposal that breaks a rule the parser enforces", async () => {
    await seed();
    // Two `otherwise` rules: the first would shadow everything after it.
    const bad = V4.replace("version: 4", "version: 5")
      .replace('warm: { when: "score >= 40"', 'warm: { when: "otherwise"');
    await expect(tools().proposeDiff(JOURNEY, bad, "nope"))
      .rejects.toThrow(/exactly one "otherwise"/);
  });

  it("refuses a proposal that does not bump the version", async () => {
    await seed();
    await expect(tools().proposeDiff(JOURNEY, V4, "no bump"))
      .rejects.toThrow(/must be greater than the current v4/);
  });

  it("refuses a proposal that renames the journey out from under the caller", async () => {
    await seed();
    const renamed = V4.replace("version: 4", "version: 5")
      .replace(`journey: ${JOURNEY}`, "journey: someone-elses-journey");
    await expect(tools().proposeDiff(JOURNEY, renamed, "nope"))
      .rejects.toThrow(/propose a new version of/);
  });

  it("refuses a proposal that changes nothing", async () => {
    await seed();
    await expect(tools().proposeDiff(JOURNEY, V4.replace("version: 4", "version: 5"), "no-op"))
      .rejects.toThrow(/only bumps the version/);
  });
});

describe("OfflineCopilot", () => {
  it("answers the cohort question from real data, renders it, and proposes a valid diff", async () => {
    await seed();
    const answer = await new OfflineCopilot(store, registry)
      .ask(JOURNEY, "Why is my needs_financing cohort converting worse?");

    expect(answer.offline).toBe(true);
    expect(answer.text).toMatch(/needs_financing/);
    expect(answer.usedTools).toEqual(["insights", "cohort", "read_spec", "propose_diff"]);

    expect(answer.view!.kind).toBe("bar");
    expect(answer.view!.title).toMatch(/budget_band/);

    // The gate held: the proposal parses, so it is publishable as it stands.
    const proposed = parseSpec(answer.diff!.yaml);
    expect(proposed.version).toBe(5);
    expect(Object.keys(proposed.routing)[0]).toBe("needs_financing_branch");
    await expect(registry.publish(answer.diff!.yaml)).resolves.toBeDefined();
  });

  it("answers a cost question from the attribution fold", async () => {
    await seed();
    const answer = await new OfflineCopilot(store, registry).ask(JOURNEY, "What is my cost per conversion?");
    expect(answer.usedTools).toEqual(["roi"]);
    expect(answer.view!.kind).toBe("table");
    expect(answer.text).toMatch(/leads cost/);
  });

  it("says it found nothing rather than inventing a finding", async () => {
    const answer = await new OfflineCopilot(store, registry).ask(JOURNEY, "Why is conversion worse?");
    expect(answer.text).toMatch(/Nothing in 0 leads clears the significance bar|Detectors skipped/);
    expect(answer.diff).toBeUndefined();
  });
});
