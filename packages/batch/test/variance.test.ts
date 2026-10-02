import { describe, it, expect } from "vitest";
import { varianceAcross, type RepeatRun } from "../src/eval/variance.js";
import type { Alert, RunQuality } from "../src/eval/alerts.js";

const quality = (over: Partial<RunQuality> = {}): RunQuality => ({
  n: 100, meanCompleteness: 0.8, meanCorrectness: 0.95, violationRate: 0,
  hallucinationRate: 0.01, ghostRate: 0.1, escalationRate: 0.05,
  qualifiedRate: 0.2, meanTurns: 5, ...over,
});

const alert = (id: string): Alert => ({
  id, severity: "warn", message: id, observed: 1, threshold: 0,
});

const run = (runId: string, q: Partial<RunQuality> = {}, alerts: Alert[] = []): RepeatRun => ({
  runId, quality: quality(q), alerts,
});

describe("varianceAcross", () => {
  it("says so when every repeat produced the same figures", () => {
    const v = varianceAcross([run("r1"), run("r2"), run("r3")]);
    expect(v.repeats).toBe(3);
    expect(v.identical).toBe(true);
    expect(v.ranges.qualifiedRate).toEqual({ min: 0.2, max: 0.2, mean: 0.2 });
  });

  it("reports the range and mean of each metric across repeats", () => {
    const v = varianceAcross([
      run("r1", { qualifiedRate: 0.1, meanTurns: 4 }),
      run("r2", { qualifiedRate: 0.25, meanTurns: 6 }),
      run("r3", { qualifiedRate: 0.16, meanTurns: 5 }),
    ]);
    expect(v.identical).toBe(false);
    expect(v.ranges.qualifiedRate).toEqual({ min: 0.1, max: 0.25, mean: 0.17 });
    expect(v.ranges.meanTurns).toEqual({ min: 4, max: 6, mean: 5 });
    expect(v.ranges.ghostRate).toEqual({ min: 0.1, max: 0.1, mean: 0.1 });
  });

  it("counts how many repeats each alert fired in", () => {
    // An alert that fires in some repeats and not others is the agent's variance
    // showing up as risk, which a single run cannot reveal.
    const v = varianceAcross([
      run("r1", {}, [alert("ghost_rate"), alert("policy_violations")]),
      run("r2", {}, [alert("ghost_rate")]),
      run("r3", {}, []),
    ]);
    expect(v.alertFrequency).toEqual({ ghost_rate: 2, policy_violations: 1 });
    expect(v.identical).toBe(false);
  });

  it("ranges correctness over the repeats that could grade it, and null when none could", () => {
    const mixed = varianceAcross([
      run("r1", { meanCorrectness: null }),
      run("r2", { meanCorrectness: 0.9 }),
      run("r3", { meanCorrectness: 0.8 }),
    ]);
    expect(mixed.ranges.meanCorrectness).toEqual({ min: 0.8, max: 0.9, mean: 0.85 });

    const none = varianceAcross([run("r1", { meanCorrectness: null }), run("r2", { meanCorrectness: null })]);
    expect(none.ranges.meanCorrectness).toBeNull();
  });

  it("keeps every repeat on the record, so the range can be traced to its runs", () => {
    const v = varianceAcross([run("r1", {}, [alert("ghost_rate")]), run("r2")]);
    expect(v.runs.map((r) => r.runId)).toEqual(["r1", "r2"]);
    // Whole alerts, not ids: one that fired only on a later repeat still has to
    // be explained to someone, and the message carries what was observed.
    expect(v.runs[0]!.alerts).toEqual([alert("ghost_rate")]);
    expect(v.runs[1]!.quality.qualifiedRate).toBe(0.2);
  });

  it("refuses to describe the variance of nothing", () => {
    expect(() => varianceAcross([])).toThrow(/at least one/i);
  });
});
