import type { Pool } from "../db/client.js";
import { parseSpec, type JourneySpec } from "./spec.js";

export interface SpecChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export class JourneyRegistry {
  constructor(private readonly pool: Pool, private readonly tenantId: string) {
    if (!tenantId) throw new Error("JourneyRegistry requires a tenantId");
  }

  /** Validates before writing — an invalid spec never reaches the database. */
  async publish(yamlText: string): Promise<JourneySpec> {
    const spec = parseSpec(yamlText);
    const existing = await this.pool.query(
      `SELECT 1 FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 AND version = $3`,
      [this.tenantId, spec.journey, spec.version],
    );
    if (existing.rowCount) {
      throw new Error(`${spec.journey} v${spec.version} is already published; versions are immutable`);
    }
    await this.pool.query(
      `INSERT INTO journey_versions (tenant_id, journey, version, yaml_source, spec)
       VALUES ($1,$2,$3,$4,$5)`,
      [this.tenantId, spec.journey, spec.version, yamlText, JSON.stringify(spec)],
    );
    return spec;
  }

  /**
   * Reads back from `yaml_source`, NOT from the `spec` JSONB column.
   *
   * This is load-bearing: Postgres JSONB does not preserve object key order —
   * it re-sorts keys by length then bytewise. Routing is evaluated in
   * declaration order with first-match-wins, so a spec round-tripped through
   * JSONB comes back with `otherwise` potentially ahead of `warm`, silently
   * misrouting every mid-scoring lead. The JSONB column exists for querying;
   * the YAML is the source of truth.
   */
  async get(journey: string, version: number): Promise<JourneySpec> {
    const { rows } = await this.pool.query<{ yaml_source: string }>(
      `SELECT yaml_source FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 AND version = $3`,
      [this.tenantId, journey, version],
    );
    if (rows.length === 0) throw new Error(`journey not found: ${journey} v${version}`);
    return parseSpec(rows[0]!.yaml_source);
  }

  async list(journey: string): Promise<number[]> {
    const { rows } = await this.pool.query(
      `SELECT version FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 ORDER BY version DESC`,
      [this.tenantId, journey],
    );
    return rows.map((r) => Number(r.version));
  }

  /**
   * A characterisable diff. This is what makes A/B meaningful — you can
   * attribute lift to "added decision_maker to required", which is impossible
   * when a journey is a prose prompt.
   */
  async diff(journey: string, va: number, vb: number): Promise<SpecChange[]> {
    const [a, b] = await Promise.all([this.get(journey, va), this.get(journey, vb)]);
    const changes: SpecChange[] = [];
    walk(a as unknown as Json, b as unknown as Json, "", changes);
    return changes;
  }
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(a: Json, b: Json, path: string, out: SpecChange[]): void {
  if (isObj(a) && isObj(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = path ? `${path}.${key}` : key;
      if (!(key in a)) out.push({ path: p, kind: "added", after: b[key] });
      else if (!(key in b)) out.push({ path: p, kind: "removed", before: a[key] });
      else walk(a[key] as Json, b[key] as Json, p, out);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path, kind: "changed", before: a, after: b });
  }
}
