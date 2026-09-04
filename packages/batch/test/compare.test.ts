import { describe, it, expect } from "vitest";
import { aggregate } from "../src/eval/alerts.js";
import { compareRuns, type ArmResult } from "../src/experiment/compare.js";
import type { Scorecard } from "../src/eval/scorecard.js";

const card = (over: Partial<Scorecard> = {}): Scorecard => ({
  leadId: "l", personaId: "p", evidenceCompleteness: 1, evidenceCorrectness: 1,
  hallucinatedFields: [], policyViolations: [], turnsUsed: 4,
  outcome: "completed", qualified: true, ...over,
});

/**
 * Builds two PAIRED arms with explicit discordance.
 *
 * Real A/B data has leads that flip both ways. Perfectly nested arms - where B
 * qualifies exactly A's set plus more - have zero discordant pairs, so a paired
 * bootstrap can never span zero and every comparison comes out conclusive by
 * construction. That makes nested fixtures useless for testing the verdict.
 */
const paired = (o: { both: number; aOnly: number; bOnly: number; neither: number }) => {
  const a: Scorecard[] = [];
  const b: Scorecard[] = [];
  const no = { qualified: false, outcome: "exhausted" as const };
  const push = (qa: boolean, qb: boolean) => {
    a.push(card(qa ? {} : no));
    b.push(card(qb ? {} : no));
  };
  for (let i = 0; i < o.both; i++) push(true, true);
  for (let i = 0; i < o.aOnly; i++) push(true, false);
  for (let i = 0; i < o.bOnly; i++) push(false, true);
  for (let i = 0; i < o.neither; i++) push(false, false);
  return { a, b };
};

const arm = (target: string, cards: Scorecard[]): ArmResult => ({
  target,
  summary: {
    runId: target, journey: "j", journeyVersion: 4, n: cards.length,
    completed: cards.filter((c) => c.outcome === "completed").length,
    qualified: cards.filter((c) => c.qualified).length,
    escalated: 0, ghosted: 0, avgTurns: 4, results: [],
  },
  quality: aggregate(cards),
});

describe("compareRuns", () => {
  it("reports b better when the interval clears zero", () => {
    // A 18.0%, B 28.0%, with discordance running heavily toward B.
    const { a, b } = paired({ both: 150, aOnly: 30, bOnly: 130, neither: 690 });
    const s = compareRuns(arm("journey@4", a), arm("journey@5", b), a, b);
    expect(s.qualifiedDelta).toBeGreaterThan(0);
    expect(s.qualifiedCi95[0]).toBeGreaterThan(0);
    expect(s.verdict).toBe("b_better");
  });

  it("reports a better when b regresses", () => {
    const { a, b } = paired({ both: 150, aOnly: 150, bOnly: 0, neither: 700 });
    const s = compareRuns(arm("x", a), arm("y", b), a, b);
    expect(s.qualifiedCi95[1]).toBeLessThan(0);
    expect(s.verdict).toBe("a_better");
  });

  it("reports inconclusive when discordance runs both ways", () => {
    // A 20.0%, B 20.5% - a real 0.5 point gap that is not evidence of anything.
    const { a, b } = paired({ both: 180, aOnly: 20, bOnly: 25, neither: 775 });
    const s = compareRuns(arm("x", a), arm("y", b), a, b);
    expect(s.qualifiedDelta).toBeGreaterThan(0);
    expect(s.verdict).toBe("inconclusive");
  });

  it("is inconclusive on a tiny sample even with a big raw gap", () => {
    // A 37.5%, B 50.0% on eight leads. A 12.5-point headline that is noise.
    const { a, b } = paired({ both: 1, aOnly: 2, bOnly: 3, neither: 2 });
    const s = compareRuns(arm("x", a), arm("y", b), a, b);
    expect(s.qualifiedDelta).toBeCloseTo(0.125, 5);
    expect(s.verdict).toBe("inconclusive");
  });

  it("is conclusive on nested arms, because there is no discordance to doubt", () => {
    // Documents why nested fixtures cannot test the inconclusive path: if every
    // lead B wins is also a lead A won, B is better with certainty.
    const { a, b } = paired({ both: 100, aOnly: 0, bOnly: 20, neither: 880 });
    expect(compareRuns(arm("x", a), arm("y", b), a, b).verdict).toBe("b_better");
  });

  it("carries completeness and correctness deltas", () => {
    const a = [card({ evidenceCompleteness: 0.5, evidenceCorrectness: 0.8 })];
    const b = [card({ evidenceCompleteness: 1, evidenceCorrectness: 1 })];
    const s = compareRuns(arm("x", a), arm("y", b), a, b);
    expect(s.completenessDelta).toBeCloseTo(0.5, 5);
    expect(s.correctnessDelta).toBeCloseTo(0.2, 5);
  });

  it("returns a null correctness delta when either arm is ungradable", () => {
    const a = [card({ evidenceCorrectness: null })];
    const b = [card({ evidenceCorrectness: 1 })];
    expect(compareRuns(arm("x", a), arm("y", b), a, b).correctnessDelta).toBeNull();
  });
});
