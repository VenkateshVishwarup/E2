import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { StoredEvent } from "@midfunnel/core/events/types";
import { evaluateAll, type EvaluatedMetrics } from "@midfunnel/core/metrics/predicate";

export interface LeadFacts {
  leadId: string;
  campaignId: string;
  creativeId: string;
  journeyVersion: number;
  metrics: EvaluatedMetrics;
  mediaCost: number;
  modelCost: number;
}

export interface Totals {
  leads: number;
  /** Count of leads for which each boolean metric held. */
  counts: Record<string, number>;
  /** Sum over leads of each aggregate metric. */
  sums: Record<string, number>;
  mediaCost: number;
  modelCost: number;
  totalCost: number;
  /** Cost per lead for which a boolean metric held. Null when none did. */
  costPer: Record<string, number | null>;
  /** Aggregate value returned per unit of spend. Null when nothing was spent. */
  returnOnSpend: Record<string, number | null>;
}

export interface AttributionNode extends Totals {
  dimension: "campaign" | "creative" | "version";
  value: string;
  children: AttributionNode[];
}

export interface AttributionReport {
  journey: string;
  currency: string;
  metricKinds: { booleans: string[]; aggregates: string[] };
  total: Totals;
  tree: AttributionNode[];
  /** Assumptions a customer is entitled to see next to the numbers. */
  caveats: string[];
}

const UNATTRIBUTED = "(unattributed)";

/**
 * ROI is a fold over the same log everything else reads. There is no separate
 * attribution pipeline to fall out of sync, which is the whole point of the
 * spine: `qualified_lead` on this screen and `qualified_lead` in the A/B
 * scoreboard cannot disagree, because they are the same predicate.
 */
export class AttributionEngine {
  constructor(
    private readonly store: EventStore,
    private readonly registry: JourneyRegistry,
  ) {}

  async roll(journey: string, currency = "INR"): Promise<AttributionReport> {
    const events = await this.store.query({ journey });

    const byLead = new Map<string, StoredEvent[]>();
    for (const e of events) {
      const bucket = byLead.get(e.leadId);
      if (bucket) bucket.push(e); else byLead.set(e.leadId, [e]);
    }

    // Metric definitions are versioned with the journey, so each lead is
    // evaluated under the definitions IT ran under. Using the latest spec for
    // everything would let an edit to `conversion:` silently rewrite last
    // quarter's numbers — the one thing an append-only log exists to prevent.
    const versions = await this.registry.list(journey);
    const specs = new Map(await Promise.all(versions.map(async (v) =>
      [v, (await this.registry.get(journey, v)).metrics] as const)));

    const facts = [...byLead.values()].map((es) => {
      const version = attributedVersion(es);
      return leadFacts(es, specs.get(version) ?? {});
    });
    const kinds = metricNames(facts);

    const tree = group(facts, "campaign", (f) => f.campaignId, kinds, (campaign) =>
      group(campaign, "creative", (f) => f.creativeId, kinds, (creative) =>
        group(creative, "version", (f) => String(f.journeyVersion), kinds, () => [])));

    return {
      journey,
      currency,
      metricKinds: kinds,
      total: totals(facts, kinds),
      tree,
      caveats: [...caveatsFor(facts), ...definitionDrift(facts, specs)],
    };
  }
}

/**
 * A lead can span journey versions. Attribute it to the version that produced
 * the routing decision — the version that actually did the work — falling back
 * to the version it was ingested under.
 */
function attributedVersion(events: readonly StoredEvent[]): number {
  const routed = events.filter((e) => e.type === "Routed").at(-1);
  const ingested = events.find((e) => e.type === "LeadIngested");
  return routed?.journeyVersion ?? ingested?.journeyVersion ?? events[0]!.journeyVersion;
}

function leadFacts(events: StoredEvent[], metrics: Record<string, string>): LeadFacts {
  const ingested = events.find((e) => e.type === "LeadIngested");
  const costs = events.filter((e) => e.type === "CostObserved");

  return {
    leadId: events[0]!.leadId,
    campaignId: str(ingested?.payload.campaignId) ?? UNATTRIBUTED,
    creativeId: str(ingested?.payload.creativeId) ?? UNATTRIBUTED,
    journeyVersion: attributedVersion(events),
    metrics: evaluateAll(metrics, events),
    mediaCost: costs.filter((e) => e.payload.kind === "media")
      .reduce((s, e) => s + Number(e.payload.amount ?? 0), 0),
    modelCost: costs.filter((e) => e.payload.kind === "model")
      .reduce((s, e) => s + Number(e.payload.amount ?? 0), 0),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function metricNames(facts: readonly LeadFacts[]): { booleans: string[]; aggregates: string[] } {
  const booleans = new Set<string>(), aggregates = new Set<string>();
  for (const f of facts) {
    for (const k of Object.keys(f.metrics.booleans)) booleans.add(k);
    for (const k of Object.keys(f.metrics.aggregates)) aggregates.add(k);
  }
  return { booleans: [...booleans], aggregates: [...aggregates] };
}

function totals(
  facts: readonly LeadFacts[],
  kinds: { booleans: string[]; aggregates: string[] },
): Totals {
  const counts: Record<string, number> = {};
  const sums: Record<string, number> = {};
  for (const name of kinds.booleans) {
    counts[name] = facts.filter((f) => f.metrics.booleans[name]).length;
  }
  for (const name of kinds.aggregates) {
    sums[name] = facts.reduce((s, f) => s + (f.metrics.aggregates[name] ?? 0), 0);
  }

  const mediaCost = facts.reduce((s, f) => s + f.mediaCost, 0);
  const modelCost = facts.reduce((s, f) => s + f.modelCost, 0);
  const totalCost = mediaCost + modelCost;

  const costPer: Record<string, number | null> = {};
  for (const name of kinds.booleans) {
    // Zero conversions is not infinite cost per conversion, it is an undefined
    // ratio. Rendering Infinity in a ROI table would be a bug on a slide.
    costPer[name] = counts[name]! > 0 ? totalCost / counts[name]! : null;
  }
  const returnOnSpend: Record<string, number | null> = {};
  for (const name of kinds.aggregates) {
    returnOnSpend[name] = totalCost > 0 ? sums[name]! / totalCost : null;
  }

  return { leads: facts.length, counts, sums, mediaCost, modelCost, totalCost, costPer, returnOnSpend };
}

function group(
  facts: readonly LeadFacts[],
  dimension: AttributionNode["dimension"],
  key: (f: LeadFacts) => string,
  kinds: { booleans: string[]; aggregates: string[] },
  children: (subset: LeadFacts[]) => AttributionNode[],
): AttributionNode[] {
  const buckets = new Map<string, LeadFacts[]>();
  for (const f of facts) {
    const k = key(f);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(f); else buckets.set(k, [f]);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([value, subset]) => ({
      dimension, value, ...totals(subset, kinds), children: children(subset),
    }));
}

/**
 * A metric whose predicate changed between two versions present in the data is
 * not one column, it is two. Say so rather than summing them.
 */
function definitionDrift(
  facts: readonly LeadFacts[],
  specs: ReadonlyMap<number, Record<string, string>>,
): string[] {
  const present = new Set(facts.map((f) => f.journeyVersion));
  const names = new Set<string>();
  for (const v of present) for (const n of Object.keys(specs.get(v) ?? {})) names.add(n);

  const drifted: string[] = [];
  for (const name of names) {
    const definitions = new Set(
      [...present].map((v) => specs.get(v)?.[name]).filter((d) => d !== undefined),
    );
    if (definitions.size > 1) {
      drifted.push(`"${name}" is defined differently across versions ` +
        `${[...present].sort((a, b) => a - b).join(", ")}; the column sums two metrics`);
    }
  }
  return drifted.length === 0 ? [] : [`Metric definitions drifted: ${drifted.join("; ")}.`];
}

function caveatsFor(facts: readonly LeadFacts[]): string[] {
  const out: string[] = [];
  const unattributed = facts.filter((f) => f.campaignId === UNATTRIBUTED).length;
  const uncosted = facts.filter((f) => f.mediaCost === 0).length;

  out.push("Media spend is allocated evenly across the leads a campaign produced that day. " +
           "A weighted model is a customer decision, not a default.");
  if (unattributed > 0) {
    out.push(`${unattributed} of ${facts.length} leads carry no campaign id and are grouped ` +
             `as ${UNATTRIBUTED}. Their cost per outcome is not meaningful.`);
  }
  if (uncosted > 0) {
    out.push(`${uncosted} of ${facts.length} leads have no media cost ingested, so totals ` +
             `understate spend. Cost per outcome is a lower bound.`);
  }
  return out;
}
