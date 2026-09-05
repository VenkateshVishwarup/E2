/**
 * Run migrations against a hosted database.
 *
 * Vercel builds are ephemeral and run once per deploy, so migrating there would
 * either race between concurrent deploys or silently not run at all. Migration
 * is an explicit act against a named database:
 *
 *   DATABASE_URL="postgres://…-pooler…/neondb?sslmode=require" npm run db:migrate:remote
 */
import { createPool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { loadEnvFile } from "@midfunnel/runtime/provider";

loadEnvFile();
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
if (/localhost|127\.0\.0\.1/.test(url)) {
  console.error("DATABASE_URL points at localhost. Use `npm run db:migrate` for the local database.");
  process.exit(1);
}

const host = new URL(url.replace(/^postgres(ql)?:/, "http:")).host;
console.log(`migrating ${host} …`);
const pool = createPool(url, { max: 1 });
await migrate(pool);
const { rows } = await pool.query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' ORDER BY table_name`);
console.log(`done. tables: ${rows.map((r) => r.table_name).join(", ")}`);
await pool.end();
