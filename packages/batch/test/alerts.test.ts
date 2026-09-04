import { describe, it, expect } from "vitest";
import { aggregate, evaluateAlerts, DEFAULT_THRESHOLDS } from "../src/eval/alerts.js";
import type { Scorecard } from "../src/eval/scorecard.js";

const card = (over: Partial<Scorecard> = {}): Scorecard => ({
  leadId: "l", personaId: "p", evidenceCompleteness: 1, evidenceCorrectness: 1,
  hallucinatedFields: [], policyViolations: [], turnsUsed: 4,
  outcome: "completed", qualified: true, ...over,
});

describe("aggregate", () => {
  it("summarises a healthy run", () => {
    const q = aggregate([card(), card(), card()]);
    expect(q.n).toBe(3);
    expect(q.meanCompleteness).toBe(1);
    expect(q.violationRate).toBe(0);
    expect(q.qualifiedRate).toBe(1);
  });

  it("computes rates over the whole cohort", () => {
    const q = aggregate([
      card(),
      card({ outcome: "ghosted", qualified: false }),
      card({ policyViolations: [{ rule: "promise_admission", turnText: "x", matched: "guaranteed" }] }),
      card({ outcome: "escalated", qualified: false }),
    ]);
    expect(q.ghostRate).toBe(0.25);
    expect(q.escalationRate).toBe(0.25);
    expect(q.violationRate).toBe(0.25);
    expect(q.qualifiedRate).toBe(0.5);
  });

  it("ignores ungradable conversations in mean correctness", () => {
    const q = aggregate([card({ evidenceCorrectness: null }), card({ evidenceCorrectness: 0.5 })]);
    expect(q.meanCorrectness).toBe(0.5);
  });

  it("reports null correctness when nothing was gradable", () => {
    expect(aggregate([card({ evidenceCorrectness: null })]).meanCorrectness).toBeNull();
  });

  it("handles an empty run without dividing by zero", () => {
    const q = aggregate([]);
    expect(q.n).toBe(0);
    expect(q.meanCompleteness).toBe(0);
    expect(q.meanCorrectness).toBeNull();
  });
});

describe("evaluateAlerts", () => {
  it("stays silent on a healthy run", () => {
    expect(evaluateAlerts(aggregate([card(), card(), card()]))).toEqual([]);
  });

  it("raises a critical alert on any policy violation", () => {
    const q = aggregate([card({
      policyViolations: [{ rule: "promise_admission", turnText: "x", matched: "guaranteed" }],
    })]);
    expect(evaluateAlerts(q).find((a) => a.id === "policy_violations")?.severity).toBe("critical");
  });

  it("raises an alert when evidence collection collapses", () => {
    const q = aggregate(Array.from({ length: 10 }, () => card({ evidenceCompleteness: 0.2 })));
    expect(evaluateAlerts(q).map((a) => a.id)).toContain("evidence_completeness");
  });

  it("raises a critical alert on hallucinated evidence", () => {
    const q = aggregate(Array.from({ length: 10 }, () => card({
      evidenceCorrectness: 0.4, hallucinatedFields: ["target_program"],
    })));
    expect(evaluateAlerts(q).find((x) => x.id === "hallucination_rate")?.severity).toBe("critical");
  });

  it("raises an alert when leads ghost too often", () => {
    const q = aggregate(Array.from({ length: 10 }, (_, i) =>
      card(i < 7 ? { outcome: "ghosted", qualified: false } : {})));
    expect(evaluateAlerts(q).map((a) => a.id)).toContain("ghost_rate");
  });

  it("reports the observed value and the threshold it breached", () => {
    const q = aggregate(Array.from({ length: 10 }, () => card({ evidenceCompleteness: 0.2 })));
    const a = evaluateAlerts(q).find((x) => x.id === "evidence_completeness")!;
    expect(a.observed).toBeCloseTo(0.2, 5);
    expect(a.threshold).toBe(DEFAULT_THRESHOLDS.minEvidenceCompleteness);
  });

  it("accepts caller-supplied thresholds", () => {
    const q = aggregate([card({ evidenceCompleteness: 0.9 })]);
    expect(evaluateAlerts(q, { ...DEFAULT_THRESHOLDS, minEvidenceCompleteness: 0.95 }))
      .toHaveLength(1);
  });

  it("stays silent on an empty run rather than alerting on nothing", () => {
    expect(evaluateAlerts(aggregate([]))).toEqual([]);
  });
});
