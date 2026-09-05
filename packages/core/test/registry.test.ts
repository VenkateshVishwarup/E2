import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { JourneyRegistry } from "../src/journey/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "fixtures/mba-v4.yaml"), "utf8");
const V3 = V4.replace("version: 4", "version: 3");

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

let pool: Pool;
let reg: JourneyRegistry;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => { await pool.query("TRUNCATE journey_versions CASCADE"); reg = new JourneyRegistry(pool, "t1"); });
afterAll(async () => { await pool.end(); });

describe("JourneyRegistry", () => {
  it("publishes and reads back a version", async () => {
    await reg.publish(V4);
    const s = await reg.get("mba-admissions-qualification", 4);
    expect(s.version).toBe(4);
    expect(s.agent.privileges).toHaveLength(3);
  });

  it("rejects republishing the same version", async () => {
    await reg.publish(V4);
    await expect(reg.publish(V4)).rejects.toThrow(/already published/i);
  });

  it("rejects an invalid spec before it reaches the database", async () => {
    await expect(reg.publish("journey: broken\nversion: 1")).rejects.toThrow();
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM journey_versions");
    expect(rows[0].n).toBe(0);
  });

  it("lists versions newest first", async () => {
    await reg.publish(V3);
    await reg.publish(V4);
    expect(await reg.list("mba-admissions-qualification")).toEqual([4, 3]);
  });

  it("produces a characterisable diff between two versions", async () => {
    await reg.publish(V3);
    await reg.publish(V4);
    const changes = await reg.diff("mba-admissions-qualification", 3, 4);
    const paths = changes.map((c) => c.path);
    expect(paths).toContain("version");
    expect(changes.find((c) => c.path === "version"))
      .toMatchObject({ kind: "changed", before: 3, after: 4 });
  });

  it("preserves routing declaration order across a database round-trip", async () => {
    // Regression: JSONB re-sorts object keys by length then bytewise, which
    // reorders routing to {hot, cold, warm}. Since routing is first-match-wins
    // and `cold` is `otherwise`, every warm lead would silently route cold.
    await reg.publish(V4);
    const s = await reg.get("mba-admissions-qualification", 4);
    expect(Object.keys(s.routing)).toEqual(["hot", "warm", "cold"]);
    expect(Object.keys(s.evidence)[0]).toBe("target_program");
  });

  it("never reads another tenant's journeys", async () => {
    await reg.publish(V4);
    const other = new JourneyRegistry(pool, "t2");
    await expect(other.get("mba-admissions-qualification", 4)).rejects.toThrow(/not found/i);
  });
});

describe("ensurePublished", () => {
  it("publishes when the version is new", async () => {
    const { spec, created } = await reg.ensurePublished(V4);
    expect(created).toBe(true);
    expect(spec.version).toBe(4);
  });

  it("is a no-op for an identical republish, so reseeding is not a violation", async () => {
    await reg.ensurePublished(V4);
    const again = await reg.ensurePublished(V4);
    expect(again.created).toBe(false);
    expect(await reg.list("mba-admissions-qualification")).toEqual([4]);
  });

  it("still refuses changed content under a version that exists", async () => {
    await reg.ensurePublished(V4);
    const tampered = V4.replace("max_turns: 14", "max_turns: 20");
    await expect(reg.ensurePublished(tampered))
      .rejects.toThrow(/already published with different content/);
  });
});

describe("publishing versus going live", () => {
  it("makes the first version live, because a journey with none serves nobody", async () => {
    await reg.publish(V4);
    expect(await reg.liveVersion("mba-admissions-qualification")).toBe(4);
  });

  it("does not make a later version live on publish", async () => {
    // The whole point: a version you published in order to try it is not a
    // version you have chosen to ship.
    await reg.publish(V4);
    await reg.publish(V4.replace("version: 4", "version: 5"));
    expect(await reg.liveVersion("mba-admissions-qualification")).toBe(4);
  });

  it("promotes, and promotes back", async () => {
    await reg.publish(V4);
    await reg.publish(V4.replace("version: 4", "version: 5"));
    await reg.promote("mba-admissions-qualification", 5);
    expect((await reg.live("mba-admissions-qualification")).version).toBe(5);
    await reg.promote("mba-admissions-qualification", 4);
    expect((await reg.live("mba-admissions-qualification")).version).toBe(4);
  });

  it("refuses to point live at a version that does not exist", async () => {
    await reg.publish(V4);
    await expect(reg.promote("mba-admissions-qualification", 9)).rejects.toThrow(/not found/);
    expect(await reg.liveVersion("mba-admissions-qualification")).toBe(4);
  });

  it("reports no live version for a journey that has none", async () => {
    expect(await reg.liveVersion("no-such-journey")).toBeNull();
  });
});
