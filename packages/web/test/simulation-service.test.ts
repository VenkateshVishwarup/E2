import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { mulberry32 } from "@midfunnel/core/stats/bootstrap";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { KeywordExtractor } from "@midfunnel/runtime/keyword-extractor";
import { offlineClient } from "@midfunnel/runtime/offline-client";
import { OfflinePlanner } from "@midfunnel/runtime/planner";
import { ScriptedReplier, type Replier } from "@midfunnel/batch/simulate/replier";
import type { Persona } from "@midfunnel/batch/simulate/persona";
import { LiveSimulationService } from "../src/simulation-service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8");
const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";
const JOURNEY = "mba-admissions-qualification";

/**
 * A lead whose patience is not a property of the persona: on any given turn
 * they may stop replying. The draw continues across runs, so the same cohort
 * meets a different outcome each time — which is what a model-played persona
 * does, made reproducible for a test.
 */
class FickleReplier implements Replier {
  private readonly rand = mulberry32(7);
  private readonly inner = new ScriptedReplier();
  async reply(persona: Persona, spec: JourneySpec, turns: Turn[]): Promise<string | null> {
    return this.rand() < 0.3 ? null : this.inner.reply(persona, spec, turns);
  }
}

let pool: Pool;
let registry: JourneyRegistry;

const service = (replier: Replier = new ScriptedReplier()) => new LiveSimulationService(
  pool, "t1", registry,
  new AgentRuntime(new KeywordExtractor() as never, offlineClient(), new OfflinePlanner()),
  replier,
);

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE events");
  await pool.query("TRUNCATE journey_versions CASCADE");
  registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V4);
});
afterAll(async () => { await pool.end(); });

describe("repeating a simulation over one cohort", () => {
  it("reports no variance section for a single run, so the response is unchanged", async () => {
    const result = await service().run(JOURNEY, 4, 5);
    expect(result.variance).toBeUndefined();
  });

  it("says outright that a configuration with no model in it does not vary", async () => {
    const result = await service().run(JOURNEY, 4, 5, 1, 3);
    expect(result.variance?.repeats).toBe(3);
    expect(result.variance?.identical).toBe(true);
  });

  it("writes each repeat under its own run, so none overwrites another", async () => {
    const result = await service().run(JOURNEY, 4, 5, 1, 3);
    const ids = result.variance!.runs.map((r) => r.runId);
    expect(new Set(ids).size).toBe(3);
    const { rows } = await pool.query(
      "SELECT count(DISTINCT run_id)::int AS runs, count(DISTINCT lead_id)::int AS leads FROM events WHERE env = 'sim'");
    expect(rows[0]).toEqual({ runs: 3, leads: 15 });
  });

  it("reports a range when the same cohort meets a different outcome each time", async () => {
    const result = await service(new FickleReplier()).run(JOURNEY, 4, 20, 1, 3);
    const v = result.variance!;
    expect(v.identical).toBe(false);
    const ghost = v.ranges.ghostRate!;
    expect(ghost.max).toBeGreaterThan(ghost.min);
    // The headline figures are the first repeat's, so a caller that ignores
    // `variance` reads exactly what a single run would have told it.
    expect(result.quality).toEqual(v.runs[0]!.quality);
  });
});
