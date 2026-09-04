import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate.js";

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

let pool: Pool;

beforeAll(async () => {
  const admin = new Pool({
    connectionString: URL.replace(/\/[^/]+$/, "/postgres"),
  });
  await admin.query("DROP DATABASE IF EXISTS midfunnel_test");
  await admin.query("CREATE DATABASE midfunnel_test");
  await admin.end();
  pool = new Pool({ connectionString: URL });
});

afterAll(async () => { await pool.end(); });

describe("migrate", () => {
  it("applies every migration and shapes the events table", async () => {
    const applied = await migrate(pool);
    expect(applied).toContain("001_events.sql");
    expect(applied).toContain("003_run_isolation.sql");

    const { rows } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'events' ORDER BY ordinal_position`
    );
    const cols = rows.map((r) => r.column_name);
    // agent_id: every event carries a principal (M1).
    // env / run_id: simulated conversations are isolated from live (M2).
    expect(cols).toEqual([
      "id", "tenant_id", "lead_id", "journey", "journey_version",
      "agent_id", "type", "payload", "occurred_at", "recorded_at",
      "env", "run_id",
    ]);
  });

  it("defaults pre-existing rows to the live environment", async () => {
    // 003 adds env with DEFAULT 'live', so nothing written before it silently
    // becomes simulated data.
    const { rows } = await pool.query(
      `SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'events' AND column_name = 'env'`
    );
    expect(rows[0].column_default).toContain("live");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("is idempotent - a second run applies nothing", async () => {
    const applied = await migrate(pool);
    expect(applied).toEqual([]);
  });
});
