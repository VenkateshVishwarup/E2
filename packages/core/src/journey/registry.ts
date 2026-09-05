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
    // The first version of a journey goes live on publish: there is nothing to
    // choose between, and a journey with no live version serves nobody. Every
    // version after it has to be promoted deliberately.
    await this.pool.query(
      `INSERT INTO journey_live (tenant_id, journey, version)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, journey) DO NOTHING`,
      [this.tenantId, spec.journey, spec.version],
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

  /**
   * Publish, tolerating an identical republish.
   *
   * Versions stay immutable — republishing CHANGED yaml under a version that
   * already exists is still refused. But re-running a seed script, or starting
   * a server that ensures its default journey exists, is not a violation of
   * immutability and should not have to be expressed as "delete everything
   * first". That framing is what made the seed scripts destructive, which in
   * turn would have deleted every real conversation the moment anyone reseeded.
   */
  async ensurePublished(yamlText: string): Promise<{ spec: JourneySpec; created: boolean }> {
    const spec = parseSpec(yamlText);
    const { rows } = await this.pool.query<{ yaml_source: string }>(
      `SELECT yaml_source FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 AND version = $3`,
      [this.tenantId, spec.journey, spec.version],
    );
    const existing = rows[0]?.yaml_source;
    if (existing === undefined) return { spec: await this.publish(yamlText), created: true };
    if (existing !== yamlText) {
      throw new Error(
        `${spec.journey} v${spec.version} is already published with different content; ` +
        `versions are immutable — publish a new version instead`,
      );
    }
    return { spec, created: false };
  }

  /**
   * Removes a published version. **For fixtures and development only.**
   *
   * Immutability is what lets lift be attributed to a named change, so nothing
   * in the product calls this. Seed scripts do, because they own the fixture
   * versions they publish and a fixture that cannot be edited without wiping
   * the database is a fixture nobody edits.
   */
  async deleteVersion(journey: string, version: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 AND version = $3`,
      [this.tenantId, journey, version],
    );
    return (rowCount ?? 0) > 0;
  }

  /** The authored YAML, byte for byte. Key order in the source is load-bearing. */
  async getSource(journey: string, version: number): Promise<string> {
    const { rows } = await this.pool.query<{ yaml_source: string }>(
      `SELECT yaml_source FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 AND version = $3`,
      [this.tenantId, journey, version],
    );
    if (rows.length === 0) throw new Error(`journey not found: ${journey} v${version}`);
    return rows[0]!.yaml_source;
  }

  async list(journey: string): Promise<number[]> {
    const { rows } = await this.pool.query(
      `SELECT version FROM journey_versions
       WHERE tenant_id = $1 AND journey = $2 ORDER BY version DESC`,
      [this.tenantId, journey],
    );
    return rows.map((r) => Number(r.version));
  }

  async latest(journey: string): Promise<JourneySpec> {
    const versions = await this.list(journey);
    if (versions.length === 0) throw new Error(`journey not found: ${journey}`);
    return this.get(journey, versions[0]!);
  }

  /**
   * The version that answers by default.
   *
   * Distinct from the newest one, and that distinction is the point: publishing
   * makes a version exist so it can be tried, promoting makes it the one real
   * traffic meets. Collapsing the two left no way to test a change before it
   * was already serving.
   */
  async liveVersion(journey: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ version: number }>(
      `SELECT version FROM journey_live WHERE tenant_id = $1 AND journey = $2`,
      [this.tenantId, journey],
    );
    return rows[0] ? Number(rows[0].version) : null;
  }

  async live(journey: string): Promise<JourneySpec> {
    const version = await this.liveVersion(journey);
    if (version === null) throw new Error(`journey not found: ${journey}`);
    return this.get(journey, version);
  }

  /** Point default traffic at a published version. Reversible by promoting back. */
  async promote(journey: string, version: number): Promise<void> {
    // Fails loudly rather than pointing live at something that does not exist.
    await this.get(journey, version);
    await this.pool.query(
      `INSERT INTO journey_live (tenant_id, journey, version)
       VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, journey)
       DO UPDATE SET version = EXCLUDED.version, promoted_at = now()`,
      [this.tenantId, journey, version],
    );
  }

  /**
   * A characterisable diff. This is what makes A/B meaningful — you can
   * attribute lift to "added decision_maker to required", which is impossible
   * when a journey is a prose prompt.
   */
  async diff(journey: string, va: number, vb: number): Promise<SpecChange[]> {
    const [a, b] = await Promise.all([this.get(journey, va), this.get(journey, vb)]);
    return diffSpecs(a, b);
  }
}

/**
 * The pure half of `diff`, so a spec that has not been published yet — a
 * copilot proposal, say — can still be characterised before anyone commits to it.
 */
export function diffSpecs(a: JourneySpec, b: JourneySpec): SpecChange[] {
  const changes: SpecChange[] = [];
  walk(a as unknown as Json, b as unknown as Json, "", changes);
  return changes;
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
