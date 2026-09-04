import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { lintSpec, parseSpec } from "@midfunnel/core/journey/spec";
import { diffSpecs } from "@midfunnel/core/journey/registry";
import { AttributionEngine, type AttributionReport } from "../attribution/engine.js";
import { InsightEngine } from "../insights/engine.js";
import { buildViews, type LeadView } from "../insights/view.js";
import type { InsightReport } from "../insights/types.js";
import type { ProposedDiff } from "./types.js";

export interface CohortRow { value: string; leads: number; converted: number; rate: number }
export interface CohortBreakdown { dimension: string; rows: CohortRow[]; baseline: number }

/**
 * The copilot's entire reach. Deliberately NOT raw SQL: SQL from a model is
 * both an injection surface and a hallucination surface, and these are the same
 * folds the console screens use — so the copilot and the screens cannot
 * disagree about a number.
 */
export class CopilotTools {
  private readonly attribution: AttributionEngine;
  private readonly insightEngine: InsightEngine;

  constructor(
    private readonly store: EventStore,
    private readonly registry: JourneyRegistry,
  ) {
    this.attribution = new AttributionEngine(store, registry);
    this.insightEngine = new InsightEngine(store, registry);
  }

  async roi(journey: string): Promise<AttributionReport> {
    return this.attribution.roll(journey);
  }

  async insights(journey: string): Promise<InsightReport> {
    return this.insightEngine.insights(journey);
  }

  /**
   * Conversion broken down by one dimension: `campaign`, `creative`, `version`,
   * or `evidence.<field>`.
   */
  async cohort(journey: string, dimension: string): Promise<CohortBreakdown> {
    const views = await this.views(journey);
    const key = keyFor(dimension);
    if (!key) throw new Error(`unknown dimension: ${dimension}`);

    const groups = new Map<string, LeadView[]>();
    for (const v of views) {
      const k = key(v);
      if (k === null) continue;
      const g = groups.get(k);
      if (g) g.push(v); else groups.set(k, [v]);
    }

    const rows = [...groups.entries()]
      .map(([value, vs]) => {
        const converted = vs.filter((v) => v.converted).length;
        return { value, leads: vs.length, converted, rate: converted / vs.length };
      })
      .sort((a, b) => b.leads - a.leads);

    const total = views.filter((v) => v.converted).length;
    return { dimension, rows, baseline: views.length === 0 ? 0 : total / views.length };
  }

  async readSpec(journey: string, version?: number): Promise<{ version: number; yaml: string }> {
    const versions = await this.registry.list(journey);
    if (versions.length === 0) throw new Error(`journey not found: ${journey}`);
    const v = version ?? versions[0]!;
    return { version: v, yaml: await this.registry.getSource(journey, v) };
  }

  /**
   * The gate that matters. A proposal is parsed, linted and diffed BEFORE it
   * can be returned, so the copilot cannot hand anyone a journey that would not
   * publish. A failure comes back as an error for the model to correct, never
   * as a suggestion for a human to discover is broken.
   */
  async proposeDiff(journey: string, yaml: string, rationale: string): Promise<ProposedDiff> {
    const versions = await this.registry.list(journey);
    if (versions.length === 0) throw new Error(`journey not found: ${journey}`);
    const from = versions[0]!;
    const base = await this.registry.get(journey, from);

    let proposed;
    try {
      proposed = parseSpec(yaml);
    } catch (err) {
      throw new Error(`the proposed spec does not parse: ${(err as Error).message}`);
    }

    if (proposed.journey !== journey) {
      throw new Error(`the proposal renames the journey to "${proposed.journey}"; ` +
                      `propose a new version of "${journey}" instead`);
    }
    if (proposed.version <= from) {
      throw new Error(`version must be greater than the current v${from}, got v${proposed.version}`);
    }

    const changes = diffSpecs(base, proposed);
    // The version bump is mandatory, so it is always in the diff and can never
    // be the substance of one. A proposal that only bumps changes nothing.
    if (changes.every((c) => c.path === "version")) {
      throw new Error("the proposal only bumps the version — propose a real change");
    }

    return {
      journey, fromVersion: from, toVersion: proposed.version, rationale, yaml,
      changes, warnings: lintSpec(proposed),
    };
  }

  private async views(journey: string): Promise<LeadView[]> {
    const [events, versions] = await Promise.all([
      this.store.query({ journey }),
      this.registry.list(journey),
    ]);
    const specs = new Map(await Promise.all(
      versions.map(async (v) => [v, await this.registry.get(journey, v)] as const),
    ));
    return buildViews(events, specs, { conversion: "conversion", qualified: "qualified_lead" });
  }
}

function keyFor(dimension: string): ((v: LeadView) => string | null) | null {
  if (dimension === "campaign") return (v) => v.campaignId;
  if (dimension === "creative") return (v) => v.creativeId;
  if (dimension === "version") return (v) => `v${v.journeyVersion}`;
  if (dimension === "decision") return (v) => v.decision;
  const field = /^evidence\.(.+)$/.exec(dimension)?.[1];
  if (field) return (v) => (v.evidence[field] == null ? null : String(v.evidence[field]));
  return null;
}
