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

/**
 * Stub asker: derives its question from the runtime's own `ask_about.field`,
 * so the conversational loop is genuinely exercised without a model call.
 */
const stubClient = () => ({
  responses: {
    create: async (body: { input: string }) => {
      const { ask_about } = JSON.parse(body.input) as { ask_about: { field: string } };
      return { output_text: `Tell me about your ${ask_about.field.replace(/_/g, " ")}?` };
    },
  },
});

const runtime = () => new AgentRuntime(new KeywordExtractor() as never, stubClient() as never);

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

  it("actually completes conversations rather than stalling them all", async () => {
    const s = await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, generatePersonas(spec, 30, 21), { runId: "run_c" });
    // If the loop could not progress, everything would land in ghosted/exhausted.
    expect(s.completed).toBeGreaterThan(0);
  });

  it("writes simulated events that a live store cannot see", async () => {
    await new SimulationRunner(sim, runtime(), new ScriptedReplier())
      .run(spec, generatePersonas(spec, 5, 12), { runId: "run_2" });

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
    for (const count of byLead.values()) {
      expect(count).toBeLessThanOrEqual(spec.policy.max_turns * 2 + 2);
    }
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
