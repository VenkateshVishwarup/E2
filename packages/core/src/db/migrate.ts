import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "migrations");

/** Forward-only. Returns the names applied by THIS call. */
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  const done = new Set(rows.map((r) => r.name));
  const pending = readdirSync(DIR).filter((f) => f.endsWith(".sql") && !done.has(f)).sort();

  const applied: string[] = [];
  for (const name of pending) {
    const sql = readFileSync(join(DIR, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
