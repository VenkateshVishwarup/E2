import { bootstrapDiffCI } from "@midfunnel/core/stats/bootstrap";
import type { RunQuality } from "../eval/alerts.js";
import type { Scorecard } from "../eval/scorecard.js";
import type { RunSummary } from "../simulate/runner.js";

export interface ArmResult {
  target: string;
  summary: RunSummary;
  quality: RunQuality;
}

export interface Scoreboard {
  a: ArmResult;
  b: ArmResult;
  qualifiedDelta: number;
  qualifiedCi95: [number, number];
  completenessDelta: number;
  correctnessDelta: number | null;
  verdict: "b_better" | "a_better" | "inconclusive";
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

  const verdict: Scoreboard["verdict"] =
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
