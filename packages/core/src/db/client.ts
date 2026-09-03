import pg from "pg";

// Money is BIGINT minor units. node-pg returns int8 as string by default;
// parse to number, which is exact below 2^53 (~90 trillion paise).
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Pool = pg.Pool;

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString });
}
