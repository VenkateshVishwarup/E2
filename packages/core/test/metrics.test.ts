import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMetric, evaluateMetric, metricKind, evaluateAll } from "../src/metrics/predicate.js";
import { parseSpec, lintSpec } from "../src/journey/spec.js";
import type { StoredEvent, EventType } from "../src/events/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const yaml = readFileSync(join(HERE, "fixtures/mba-v4.yaml"), "utf8");

let seq = 0;
function ev(type: EventType, payload: Record<string, unknown> = {}): StoredEvent {
  return {
    id: ++seq, tenantId: "t1", leadId: "L1", journey: "j", journeyVersion: 4,
    agentId: "a", env: "live", runId: null, type, payload,
    occurredAt: new Date("2026-06-01T10:00:00Z"), recordedAt: new Date(),
  };
}

describe("parseMetric", () => {
  it("parses the four reference metrics from the MBA journey", () => {
    const m = parseSpec(yaml).metrics;
    expect(parseMetric(m.qualified_lead!)).toEqual({
      kind: "compare", type: "Routed", cond: { field: "decision", op: "==", value: "hot" },
    });
    expect(parseMetric(m.booked!)).toEqual({ kind: "exists", type: "HandoffCreated" });
    expect(parseMetric(m.conversion!)).toEqual({
      kind: "in", type: "OutcomeObserved", field: "outcome", values: ["enrolled", "paid"],
    });
    expect(parseMetric(m.revenue!)).toEqual({
      kind: "aggregate", fn: "sum", type: "OutcomeObserved", field: "amount",
      where: { field: "outcome", op: "==", value: "paid" },
    });
  });

  it("separates counting metrics from summing metrics", () => {
    expect(metricKind(parseMetric("HandoffCreated exists"))).toBe("boolean");
    expect(metricKind(parseMetric("sum(OutcomeObserved.amount)"))).toBe("aggregate");
  });

  it("rejects an unknown event type rather than quietly reporting false", () => {
    // The failure mode this guards: `Routed.desicion` evaluating false forever
    // and looking like poor conversion rather than a typo.
    expect(() => parseMetric("Rooted.decision == hot")).toThrow(/unknown event type/i);
  });

  it("rejects an aggregate with no field to aggregate", () => {
    expect(() => parseMetric("sum(OutcomeObserved)")).toThrow(/needs a field/i);
  });

  it("does not split on AND inside a bracketed value list", () => {
    const ast = parseMetric("OutcomeObserved.outcome in [enrolled AND paid, applied]");
    expect(ast.kind).toBe("in");
  });
});

describe("evaluateMetric", () => {
  const events = [
    ev("LeadIngested", { campaignId: "camp_0" }),
    ev("Scored", { score: 75 }),
    ev("Routed", { decision: "hot", target: "handoff.counsellor" }),
    ev("HandoffCreated", { target: "counsellor" }),
    ev("OutcomeObserved", { outcome: "enrolled", amount: null }),
    ev("OutcomeObserved", { outcome: "paid", amount: 45000000 }),
    ev("OutcomeObserved", { outcome: "paid", amount: 5000000 }),
  ];

  it("evaluates each reference metric over a real event history", () => {
    const m = parseSpec(yaml).metrics;
    const at = (name: string) => evaluateMetric(parseMetric(m[name]!), events);
    expect(at("qualified_lead")).toBe(true);
    expect(at("booked")).toBe(true);
    expect(at("conversion")).toBe(true);
    expect(at("revenue")).toBe(50000000);
  });

  it("is existential: routed hot once counts, even if re-routed later", () => {
    const rerouted = [...events, ev("Routed", { decision: "cold", target: "nurture.x" })];
    expect(evaluateMetric(parseMetric("Routed.decision == hot"), rerouted)).toBe(true);
  });

  it("counts events and averages only over events that carry the field", () => {
    // One OutcomeObserved has a null amount; it must not drag the average to zero.
    expect(evaluateMetric(parseMetric("count(OutcomeObserved)"), events)).toBe(3);
    expect(evaluateMetric(parseMetric("avg(OutcomeObserved.amount)"), events)).toBe(25000000);
  });

  it("returns falsey and zero for a lead with no matching events", () => {
    expect(evaluateMetric(parseMetric("HandoffCreated exists"), [])).toBe(false);
    expect(evaluateMetric(parseMetric("sum(OutcomeObserved.amount)"), [])).toBe(0);
    expect(evaluateMetric(parseMetric("avg(OutcomeObserved.amount)"), [])).toBe(0);
  });

  it("handles numeric comparisons and boolean composition", () => {
    expect(evaluateMetric(parseMetric("Scored.score >= 70"), events)).toBe(true);
    expect(evaluateMetric(parseMetric("Scored.score >= 90"), events)).toBe(false);
    expect(evaluateMetric(parseMetric("Scored.score >= 90 OR HandoffCreated exists"), events)).toBe(true);
    expect(evaluateMetric(parseMetric("Scored.score >= 90 AND HandoffCreated exists"), events)).toBe(false);
  });

  it("keeps counting metrics and summing metrics in separate buckets", () => {
    const { booleans, aggregates } = evaluateAll(parseSpec(yaml).metrics, events);
    expect(booleans).toEqual({ qualified_lead: true, booked: true, conversion: true });
    expect(aggregates).toEqual({ revenue: 50000000 });
  });
});

describe("lintSpec on metrics", () => {
  it("passes the reference journey", () => {
    const codes = lintSpec(parseSpec(yaml)).map((w) => w.code);
    expect(codes).not.toContain("unparseable_metric");
    expect(codes).not.toContain("unreachable_metric");
  });

  it("flags a booking metric in a journey that never hands off", () => {
    const noHandoff = yaml.replace('target: "handoff.counsellor"', 'target: "nurture.mba_hot"');
    const warnings = lintSpec(parseSpec(noHandoff));
    expect(warnings.map((w) => w.code)).toContain("unreachable_metric");
    expect(warnings.find((w) => w.code === "unreachable_metric")!.message).toMatch(/always report zero/);
  });

  it("flags a metric it cannot parse instead of throwing at publish", () => {
    const typo = yaml.replace("Routed.decision == hot", "Rooted.decision == hot");
    const warnings = lintSpec(parseSpec(typo));
    expect(warnings.map((w) => w.code)).toContain("unparseable_metric");
  });
});
