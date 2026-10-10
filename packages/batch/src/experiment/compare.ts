import { bootstrapDiffCI } from "@midfunnel/core/stats/bootstrap";
import type { RunQuality } from "../eval/alerts.js";
import type { Scorecard } from "../eval/scorecard.js";
import type { RunSummary } from "../simulate/runner.js";
import type { MetricRange, VarianceReport } from "../eval/variance.js";

export interface ArmResult {
  target: string;
  summary: RunSummary;
  quality: RunQuality;
}

export type Verdict = "b_better" | "a_better" | "inconclusive";

/**
 * The same comparison made on ranges instead of on one run each.
 *
 * A version that may not take the same path twice does not have a qualified
 * rate; it has a distribution, and one run is one draw from it. Judging two of
 * those against each other on a single draw apiece is how a difference that is
 * really noise gets shipped — so when both arms are repeated, the verdict is
 * made on whether their ranges overlap at all.
 *
 * Deliberately conservative: separation here means the WORSE run of the winner
 * still beat the BEST run of the loser. That is a strong claim from a handful
 * of repeats, and a weaker one would not be worth making.
 */
export interface RangeComparison {
  repeats: number;
  a: MetricRange;
  b: MetricRange;
  verdict: Verdict;
  /**
   * Whether the one-run verdict survived repetition. False is the interesting
   * case and the reason this exists: a single run picked a winner that the
   * ranges say was a draw.
   */
  agreesWithSingleRun: boolean;
  /**
   * Both arms produced identical figures on every repeat, so there is no range
   * to compare and the single-run verdict stands unchallenged. True for
   * anything with no model in the loop.
   */
  identical: boolean;
}

export interface Scoreboard {
  a: ArmResult;
  b: ArmResult;
  qualifiedDelta: number;
  qualifiedCi95: [number, number];
  completenessDelta: number;
  correctnessDelta: number | null;
  verdict: Verdict;
  /** Present only when both arms were repeated. */
  variance?: {
    a: VarianceReport;
    b: VarianceReport;
    qualified: RangeComparison;
  };
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The verdict is driven by the confidence interval, never by the raw delta.
 * A large gap on a small cohort is inconclusive, and saying so is the whole
 * value of the scoreboard — a system that declares a winner from twelve
 * conversations is worse than no system.
 */
export function compareRuns(
  a: ArmResult, b: ArmResult, cardsA: Scorecard[], cardsB: Scorecard[],
): Scoreboard {
  // Bootstrap is paired, so both arms must be the same length. Simulation runs
  // the same personas through both; truncate to the shorter if they differ.
  const n = Math.min(cardsA.length, cardsB.length);
  const ci95 = bootstrapDiffCI(
    cardsA.slice(0, n).map((c) => c.qualified),
    cardsB.slice(0, n).map((c) => c.qualified),
    { seed: 1 },
  );

  const correctnessDelta =
    a.quality.meanCorrectness !== null && b.quality.meanCorrectness !== null
      ? round4(b.quality.meanCorrectness - a.quality.meanCorrectness)
      : null;

  const verdict: Verdict =
    ci95[0] > 0 ? "b_better"
    : ci95[1] < 0 ? "a_better"
    : "inconclusive";

  return {
    a, b,
    qualifiedDelta: round4(b.quality.qualifiedRate - a.quality.qualifiedRate),
    qualifiedCi95: ci95,
    completenessDelta: round4(b.quality.meanCompleteness - a.quality.meanCompleteness),
    correctnessDelta,
    verdict,
  };
}

/**
 * Compares two repeated arms on the range of their qualified rates.
 *
 * `singleVerdict` is the one the first run of each arm produced, so the report
 * can say whether repetition confirmed it or took it away.
 */
export function compareRanges(
  a: VarianceReport, b: VarianceReport, singleVerdict: Verdict,
): RangeComparison | null {
  const ra = a.ranges.qualifiedRate;
  const rb = b.ranges.qualifiedRate;
  if (!ra || !rb) return null;

  // Separation means the winner's worst run still beat the loser's best.
  const verdict: Verdict =
    rb.min > ra.max ? "b_better"
    : ra.min > rb.max ? "a_better"
    : "inconclusive";

  return {
    repeats: Math.min(a.repeats, b.repeats),
    a: ra, b: rb,
    verdict,
    agreesWithSingleRun: verdict === singleVerdict,
    identical: a.identical && b.identical,
  };
}
