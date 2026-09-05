import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { buildServer } from "../src/server.js";

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";
const TOKEN = "tok_live_9f2c4a7b1e";

let pool: Pool;
const deps = (store: EventStore) => ({
  registry: { list: vi.fn().mockResolvedValue([4]), get: vi.fn(), diff: vi.fn() } as never,
  store,
  replay: { replay: vi.fn() } as never,
  simulate: { run: vi.fn(), compare: vi.fn() } as never,
  attribution: { roll: vi.fn() } as never,
  insights: { insights: vi.fn() } as never,
  copilot: { ask: vi.fn() },
  chat: { start: vi.fn(), send: vi.fn(), state: vi.fn() },
  offline: true,
});

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
afterAll(async () => { await pool.end(); });

const guarded = () => buildServer(deps(new EventStore(pool, "t1")), TOKEN);
const open = () => buildServer(deps(new EventStore(pool, "t1")), null);

describe("bearer guard", () => {
  const path = "/api/journeys/mba-admissions-qualification/versions";

  it("is not installed when no token is configured", async () => {
    expect((await open().inject({ url: path })).statusCode).toBe(200);
  });

  it("accepts the configured token", async () => {
    const res = await guarded().inject({ url: path, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a missing, malformed, wrong or truncated token identically", async () => {
    const app = guarded();
    const headers = [
      undefined,
      { authorization: TOKEN },                      // no scheme
      { authorization: `Basic ${TOKEN}` },           // wrong scheme
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },   // truncated
      { authorization: `Bearer ${TOKEN}x` },               // extended
    ];
    for (const h of headers) {
      const res = await app.inject({ url: path, ...(h ? { headers: h } : {}) });
      expect(res.statusCode).toBe(401);
      // The same answer to every failure: no hint about which half was wrong.
      expect(res.json().error).toBe("a valid Bearer token is required");
    }
  });

  it("leaves health and spec discovery open, since a client needs them first", async () => {
    const app = guarded();
    for (const url of ["/health", "/api/openapi.json", "/api/openapi.yaml"]) {
      expect((await app.inject({ url })).statusCode, url).toBe(200);
    }
  });

  it("guards a path with a query string too", async () => {
    const res = await guarded().inject({ url: "/api/journeys/x/roi?currency=INR" });
    expect(res.statusCode).toBe(401);
  });
});
