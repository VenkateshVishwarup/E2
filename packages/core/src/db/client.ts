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
  // TLS is left to the connection string's own `sslmode`, which managed hosts
  // already set. An earlier version forced `rejectUnauthorized: false` for
  // known hosts — which disabled certificate verification on exactly the
  // connections that cross a network, to solve a problem those hosts do not
  // have. Their certificates are valid.
  return new pg.Pool({ connectionString, ...opts });
}
