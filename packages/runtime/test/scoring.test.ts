import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { score, route, qualifies, evaluatePredicate } from "../src/scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const ev = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

describe("score", () => {
  it("sums the weights that match field.value", () => {
    // timeline.this_intake 30 + budget_band.above_15L 25 + decision_maker.self 15
    // + target_program.* 10 = 80
    expect(score(spec, ev({
      timeline: "this_intake", budget_band: "above_15L",
      decision_maker: "self", target_program: "executive_mba",
    }))).toBe(80);
  });

  it("honours a wildcard weight for any value of the field", () => {
    expect(score(spec, ev({ target_program: "online_mba" }))).toBe(10);
  });

  it("scores an empty evidence set as zero", () => {
    expect(score(spec, {})).toBe(0);
  });

  it("caps at 100", () => {
    const inflated = { ...spec, scoring: { weights: { "timeline.this_intake": 500 } } };
    expect(score(inflated, ev({ timeline: "this_intake" }))).toBe(100);
  });
});

describe("evaluatePredicate", () => {
  it("evaluates a score comparison", () => {
    expect(evaluatePredicate("score >= 70", { score: 72, evidenceComplete: true })).toBe(true);
    expect(evaluatePredicate("score >= 70", { score: 69, evidenceComplete: true })).toBe(false);
  });
  it("evaluates evidence completeness", () => {
    expect(evaluatePredicate("evidence.complete(required)", { score: 0, evidenceComplete: true })).toBe(true);
  });
  it("evaluates a conjunction", () => {
    expect(evaluatePredicate("score >= 70 AND evidence.complete(required)",
      { score: 80, evidenceComplete: false })).toBe(false);
  });
  it("always satisfies `otherwise`", () => {
    expect(evaluatePredicate("otherwise", { score: 0, evidenceComplete: false })).toBe(true);
  });
  it("refuses an expression it does not understand rather than guessing", () => {
    expect(() => evaluatePredicate("process.exit(1)", { score: 0, evidenceComplete: false }))
      .toThrow(/unsupported predicate/i);
  });
});

describe("route", () => {
  it("routes hot at or above 70", () => {
    expect(route(spec, 72, {})).toEqual({ decision: "hot", target: "handoff.counsellor", sla: "5m" });
  });
  it("routes warm between 40 and 69", () => {
    expect(route(spec, 45, {})).toMatchObject({ decision: "warm", target: "nurture.mba_warm_14d" });
  });
  it("falls through to cold", () => {
    expect(route(spec, 10, {})).toMatchObject({ decision: "cold", target: "nurture.mba_longtail_90d" });
  });
  it("takes the first matching rule in declaration order", () => {
    expect(route(spec, 100, {}).decision).toBe("hot");
  });
});

describe("qualifies", () => {
  it("requires both a passing score and complete required evidence", () => {
    const full = ev({ target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L" });
    expect(qualifies(spec, 80, full)).toBe(true);
    expect(qualifies(spec, 80, ev({ timeline: "this_intake" }))).toBe(false);
    expect(qualifies(spec, 20, full)).toBe(false);
  });
});

describe("evaluatePredicate — sentiment", () => {
  const ctx = (sentiment: number) => ({ score: 0, evidenceComplete: false, sentiment });

  it("evaluates a sentiment comparison", () => {
    expect(evaluatePredicate("sentiment < -0.5", ctx(-0.8))).toBe(true);
    expect(evaluatePredicate("sentiment < -0.5", ctx(-0.2))).toBe(false);
  });

  it("treats missing sentiment as neutral", () => {
    expect(evaluatePredicate("sentiment < -0.5", { score: 0, evidenceComplete: false })).toBe(false);
  });

  it("still refuses an unsupported predicate", () => {
    expect(() => evaluatePredicate("mood == bad", ctx(0))).toThrow(/unsupported predicate/i);
  });
});

describe("evidence predicates in routing", () => {
  it("branches on what the lead said, not only on the score", () => {
    const ctx = (evidence: Record<string, { value: unknown; confidence: number }>) =>
      ({ score: 0, evidenceComplete: false, evidence });
    const financing = ctx({ budget_band: { value: "needs_financing", confidence: 0.9 } });

    expect(evaluatePredicate("evidence.budget_band == needs_financing", financing)).toBe(true);
    expect(evaluatePredicate("evidence.budget_band == above_15L", financing)).toBe(false);
    expect(evaluatePredicate("evidence.budget_band != above_15L", financing)).toBe(true);
  });

  it("treats an unestablished field as not matching, and != as matching", () => {
    const empty = { score: 0, evidenceComplete: false, evidence: {} };
    expect(evaluatePredicate("evidence.budget_band == needs_financing", empty)).toBe(false);
    expect(evaluatePredicate("evidence.budget_band != needs_financing", empty)).toBe(true);
  });

  it("composes with a score atom", () => {
    const ctx = {
      score: 80, evidenceComplete: true,
      evidence: { budget_band: { value: "needs_financing", confidence: 0.9 } },
    };
    expect(evaluatePredicate("score >= 70 AND evidence.budget_band == needs_financing", ctx)).toBe(true);
    expect(evaluatePredicate("score >= 90 AND evidence.budget_band == needs_financing", ctx)).toBe(false);
  });
});
