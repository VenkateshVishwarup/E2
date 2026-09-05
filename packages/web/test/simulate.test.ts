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
const V5 = V4.replace("version: 4", "version: 5");

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const RUN = {
  summary: { runId: "run_1", journey: "mba-admissions-qualification", journeyVersion: 4,
             n: 50, completed: 38, qualified: 12, escalated: 4, ghosted: 8,
             avgTurns: 4.2, results: [] },
  quality: { n: 50, meanCompleteness: 0.82, meanCorrectness: 0.94, violationRate: 0,
             hallucinationRate: 0.02, ghostRate: 0.16, escalationRate: 0.08,
             qualifiedRate: 0.24, meanTurns: 4.2 },
  alerts: [],
};

const BOARD = { verdict: "b_better", qualifiedDelta: 0.06, qualifiedCi95: [0.01, 0.11] };

const deps = (over: Record<string, unknown> = {}) => ({
  registry: new JourneyRegistry(pool, "t1"),
  store: new EventStore(pool, "t1"),
  replay: { replay: vi.fn() } as never,
  simulate: {
    run: vi.fn().mockResolvedValue(RUN),
    compare: vi.fn().mockResolvedValue(BOARD),
  } as never,
  ...over,
});

let pool: Pool; let app: ReturnType<typeof buildServer>;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE journey_versions CASCADE");
  const registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V4);
  await registry.publish(V5);
  app = buildServer(deps({ registry }) as never);
});
afterAll(async () => { await pool.end(); });

describe("simulate routes", () => {
  it("runs a simulation and returns summary, quality and alerts", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ summary: { n: 50 }, quality: { qualifiedRate: 0.24 } });
  });

  it("rejects a malformed simulate body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/simulate", payload: { journey: 4 } });
    expect(res.statusCode).toBe(400);
  });

  it("caps the cohort size so one request cannot burn the batch budget", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 100000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/n must be/i);
  });

  it("compares two versions", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/compare",
      payload: { journey: "mba-admissions-qualification", a: 4, b: 5, n: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verdict: "b_better" });
  });

  it("502s an upstream failure rather than 404", async () => {
    const broken = buildServer(deps({
      simulate: { run: vi.fn().mockRejectedValue(new Error("model unavailable")), compare: vi.fn() },
    }) as never);
    const res = await broken.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 10 },
    });
    expect(res.statusCode).toBe(502);
  });

  it("404s a genuinely missing journey", async () => {
    const missing = buildServer(deps({
      simulate: { run: vi.fn().mockRejectedValue(new Error("journey not found: nope v1")), compare: vi.fn() },
    }) as never);
    const res = await missing.inject({
      method: "POST", url: "/api/simulate", payload: { journey: "nope", version: 1, n: 10 },
    });
    expect(res.statusCode).toBe(404);
  });
});
