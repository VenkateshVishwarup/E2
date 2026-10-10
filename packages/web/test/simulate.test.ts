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

  it("repeats a run over the same cohort when asked", async () => {
    const run = vi.fn().mockResolvedValue(RUN);
    const repeating = buildServer(deps({ simulate: { run, compare: vi.fn() } }) as never);
    const res = await repeating.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 50, repeats: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith("mba-admissions-qualification", 4, 50, undefined, 3);
  });

  it("runs once when repeats is not given", async () => {
    const run = vi.fn().mockResolvedValue(RUN);
    const once = buildServer(deps({ simulate: { run, compare: vi.fn() } }) as never);
    await once.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 50 },
    });
    expect(run).toHaveBeenCalledWith("mba-admissions-qualification", 4, 50, undefined, 1);
  });

  it("rejects a repeat count outside what a range over repeats can honestly mean", async () => {
    for (const repeats of [0, 6, 2.5, "3"]) {
      const res = await app.inject({
        method: "POST", url: "/api/simulate",
        payload: { journey: "mba-admissions-qualification", version: 4, n: 10, repeats },
      });
      expect(res.statusCode, String(repeats)).toBe(400);
      expect(res.json().error).toMatch(/repeats must be/i);
    }
  });

  it("caps the cohort times its repeats, since every repeat is billed", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/simulate",
      payload: { journey: "mba-admissions-qualification", version: 4, n: 1000, repeats: 3 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/n × repeats/);
  });

  it("advertises the repeat ceiling beside the cohort ceiling", async () => {
    const res = await app.inject({ url: "/api/limits" });
    expect(res.json()).toMatchObject({ maxRepeats: 5 });
    expect(res.json().maxCohort).toBeGreaterThan(0);
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

describe("compare — range against range", () => {
  /** A server whose simulate service is the one the test wants to watch. */
  const serverWith = (simulate: Record<string, unknown>) =>
    buildServer(deps({
      registry: new JourneyRegistry(pool, "t1"),
      simulate: { run: vi.fn(), ...simulate },
    }) as never);

  it("passes repeats through to the service", async () => {
    const compare = vi.fn().mockResolvedValue({ verdict: "inconclusive" });
    const app = serverWith({ compare });
    await app.inject({
      method: "POST", url: "/api/compare",
      payload: { journey: "j", a: 4, b: 5, n: 10, seed: 2, repeats: 3 },
    });
    expect(compare).toHaveBeenCalledWith("j", 4, 5, 10, 2, 3);
  });

  it("defaults to one run each, as it always did", async () => {
    const compare = vi.fn().mockResolvedValue({ verdict: "inconclusive" });
    await serverWith({ compare }).inject({
      method: "POST", url: "/api/compare", payload: { journey: "j", a: 4, b: 5, n: 10 },
    });
    expect(compare).toHaveBeenCalledWith("j", 4, 5, 10, undefined, 1);
  });

  it("refuses more repeats than the limit advertises", async () => {
    const res = await serverWith({ compare: vi.fn() }).inject({
      method: "POST", url: "/api/compare", payload: { journey: "j", a: 4, b: 5, n: 10, repeats: 9 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/repeats must be an integer between 1 and 5/);
  });

  it("counts both arms against the cohort cap, because both are billed", async () => {
    const res = await serverWith({ compare: vi.fn() }).inject({
      method: "POST", url: "/api/compare",
      payload: { journey: "j", a: 4, b: 5, n: 2000, repeats: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/n × repeats × 2 arms/);
  });
});
