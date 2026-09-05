import pg from "pg";

// Money is BIGINT minor units. node-pg returns int8 as string by default;
// parse to number, which is exact below 2^53 (~90 trillion paise).
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Pool = pg.Pool;

export interface PoolOptions {
  /**
   * Maximum connections. The default of 10 is right for one long-lived server
   * and wrong for serverless, where dozens of instances each want a pool and
   * the database's connection limit is the shared resource.
   */
  max?: number;
  idleTimeoutMillis?: number;
}

export function createPool(
  connectionString = process.env.DATABASE_URL, opts: PoolOptions = {},
): Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  // Managed Postgres requires TLS; local Docker does not offer it.
  const ssl = /\bsslmode=require\b/.test(connectionString) || /neon\.tech|supabase/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
  return new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}), ...opts });
}
