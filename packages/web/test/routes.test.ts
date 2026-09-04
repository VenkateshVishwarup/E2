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
const V3 = V4.replace("version: 4", "version: 3");

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const LIFT = {
  n: 30,
  a: { version: 3, qualifiedRate: 0.18, projectedConversions: 3.4 },
  b: { version: 4, qualifiedRate: 0.24, projectedConversions: 4.1 },
  absoluteLift: 0.06,
  ci95: [0.02, 0.1] as [number, number],
  observedConversionByDecision: { hot: 0.31, cold: 0.02 },
  divergent: [],
};

let pool: Pool; let app: ReturnType<typeof buildServer>;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE journey_versions");
  const registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V3);
  await registry.publish(V4);
  app = buildServer({
    registry,
    store: new EventStore(pool, "t1"),
    replay: { replay: vi.fn().mockResolvedValue(LIFT) } as never,
    simulate: { run: vi.fn(), compare: vi.fn() } as never,
  });
});
afterAll(async () => { await pool.end(); });

describe("web routes", () => {
  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("lists journey versions newest first", async () => {
    const res = await app.inject({ url: "/api/journeys/mba-admissions-qualification/versions" });
    expect(res.json()).toEqual({ versions: [4, 3] });
  });

  it("returns a structural diff between two versions", async () => {
    const res = await app.inject({
      url: "/api/journeys/mba-admissions-qualification/diff?a=3&b=4",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changes.some((c: { path: string }) => c.path === "version")).toBe(true);
  });

  it("runs a replay and returns the lift", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/replay",
      payload: { journey: "mba-admissions-qualification", a: 3, b: 4, leadIds: ["L_1"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ absoluteLift: 0.06, ci95: [0.02, 0.1] });
  });

  it("rejects a replay with a malformed body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/replay", payload: { journey: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown journey rather than throwing", async () => {
    const res = await app.inject({ url: "/api/journeys/nope/diff?a=1&b=2" });
    expect(res.statusCode).toBe(404);
  });
});
