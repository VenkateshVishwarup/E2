import type { Alert, RunQuality } from "./alerts.js";

/** One run of a version over a cohort, as the variance report reads it. */
export interface RepeatRun {
  runId: string;
  quality: RunQuality;
  alerts: Alert[];
}

export interface MetricRange { min: number; max: number; mean: number }

/** The quality figures a range is reported for — every rate a run produces. */
export const RANGED_METRICS = [
  "qualifiedRate", "meanCompleteness", "meanCorrectness", "escalationRate",
  "ghostRate", "violationRate", "hallucinationRate", "meanTurns",
] as const;

export type RangedMetric = (typeof RANGED_METRICS)[number];

export interface VarianceReport {
  repeats: number;
  /**
   * Every repeat produced the same figures and fired the same alerts. True for
   * anything with no model in the loop, which is the honest result rather than
   * a band of width zero that looks like a measurement.
   */
  identical: boolean;
  /** Null only for correctness, when no repeat had ground truth to grade against. */
  ranges: Record<RangedMetric, MetricRange | null>;
  /** How many repeats each alert fired in. */
  alertFrequency: Record<string, number>;
  runs: RepeatRun[];
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The spread of a version's results over repeated runs of ONE cohort.
 *
 * A single figure for an agent that may diverge is a point estimate of a
 * distribution. Holding the personas fixed and repeating the run isolates the
 * variance the model contributes — the planner, the extractor and, when a
 * model plays them, the personas — from the sampling variance of a different
 * cohort, which is what changing the seed would measure instead.
 *
 * This is a range over a handful of repeats, not a confidence interval, and
 * it is named accordingly.
 */
export function varianceAcross(runs: RepeatRun[]): VarianceReport {
  if (runs.length === 0) throw new Error("variance needs at least one run");

  const ranges = {} as Record<RangedMetric, MetricRange | null>;
  for (const metric of RANGED_METRICS) {
    const values = runs.map((r) => r.quality[metric]).filter((v): v is number => v !== null);
    ranges[metric] = values.length === 0 ? null : {
      min: Math.min(...values),
      max: Math.max(...values),
      mean: round4(values.reduce((a, b) => a + b, 0) / values.length),
    };
  }

  const alertFrequency: Record<string, number> = {};
  for (const r of runs) {
    for (const id of new Set(r.alerts.map((a) => a.id))) {
      alertFrequency[id] = (alertFrequency[id] ?? 0) + 1;
    }
  }

  const sameFigures = RANGED_METRICS.every((m) =>
    runs.every((r) => r.quality[m] === runs[0]!.quality[m]));
  const sameAlerts = Object.values(alertFrequency).every((count) => count === runs.length);

  return {
    repeats: runs.length,
    identical: sameFigures && sameAlerts,
    ranges,
    alertFrequency,
    runs,
  };
}
