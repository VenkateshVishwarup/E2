import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import { DETECTORS, type DetectorContext } from "./detectors.js";
import { FINDING_CODES, type Finding, type FindingCode, type InsightReport } from "./types.js";
import { buildViews, type LeadView, type MetricNames } from "./view.js";

export interface InsightOptions {
  /** Which declared metric means "converted" for this question. */
  conversion?: string;
  /** Which declared metric means "qualified". */
  qualified?: string;
  only?: FindingCode[];
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Findings are derived, never stored. The moat is the event log; a findings
 * table would be a cache of it that goes stale the moment a metric definition
 * changes, and would then have to be invalidated by hand.
 */
export class InsightEngine {
  constructor(
    private readonly store: EventStore,
    private readonly registry: JourneyRegistry,
  ) {}

  async insights(journey: string, opts: InsightOptions = {}): Promise<InsightReport> {
    const events = await this.store.query({ journey });
    const versions = await this.registry.list(journey);
    const specs = new Map<number, JourneySpec>(
      await Promise.all(versions.map(async (v) => [v, await this.registry.get(journey, v)] as const)),
    );

    const names: MetricNames = {
      conversion: opts.conversion ?? "conversion",
      qualified: opts.qualified ?? "qualified_lead",
    };
    const views = buildViews(events, specs, names);
    const ctx: DetectorContext = { specs, tz: timezoneOf(specs) };

    const findings: Finding[] = [];
    const skipped: InsightReport["skipped"] = [];
    const missing = undeclaredMetrics(specs, names);
    for (const note of missing) skipped.push(note);

    const codes = opts.only ?? FINDING_CODES;
    for (const code of codes) {
      if (missing.some((m) => m.code === code)) continue;
      const result = DETECTORS[code](views, ctx);
      findings.push(...result.findings);
      if (result.skipped) skipped.push({ code, reason: result.skipped });
    }

    return {
      journey,
      leadsAnalysed: views.length,
      findings: rank(findings),
      skipped,
    };
  }
}

/** Severity first, then effect size. A big low-severity number is still low. */
function rank(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.effect - a.effect);
}

/**
 * Every detector reads conversion from a DECLARED metric. If the tenant never
 * declared one, the honest answer is to say which detectors could not run —
 * not to substitute a guess at what "converted" means, which is the exact
 * mistake the no-`Converted`-event rule exists to prevent.
 */
function undeclaredMetrics(
  specs: ReadonlyMap<number, JourneySpec>,
  names: MetricNames,
): Array<{ code: FindingCode; reason: string }> {
  const declared = new Set([...specs.values()].flatMap((s) => Object.keys(s.metrics)));
  if (declared.has(names.conversion)) return [];

  const reason = `no metric named "${names.conversion}" is declared on this journey, ` +
                 `so there is no tenant-defined answer to "converted". ` +
                 `Declared: ${[...declared].join(", ") || "none"}`;
  return FINDING_CODES.map((code) => ({ code, reason }));
}

function timezoneOf(specs: ReadonlyMap<number, JourneySpec>): string {
  for (const spec of specs.values()) {
    const tz = spec.policy.quiet_hours?.tz;
    if (tz) return tz;
  }
  return "UTC";
}

export type { LeadView };
