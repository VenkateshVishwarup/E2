import type { Scorecard } from "./scorecard.js";

export interface RunQuality {
  n: number;
  meanCompleteness: number;
  meanCorrectness: number | null;
  violationRate: number;
  hallucinationRate: number;
  ghostRate: number;
  escalationRate: number;
  qualifiedRate: number;
  meanTurns: number;
}

export interface Alert {
  id: string;
  severity: "warn" | "critical";
  message: string;
  observed: number;
  threshold: number;
}

export interface Thresholds {
  minEvidenceCompleteness: number;
  minEvidenceCorrectness: number;
  maxViolationRate: number;
  maxHallucinationRate: number;
  maxGhostRate: number;
  maxEscalationRate: number;
}

/**
 * Strict on correctness and policy, lenient on ghosting: a lead who stops
 * replying is often the lead's choice, whereas a hallucinated fact or a policy
 * breach is always the agent's fault.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minEvidenceCompleteness: 0.6,
  minEvidenceCorrectness: 0.9,
  maxViolationRate: 0,
  maxHallucinationRate: 0.05,
  maxGhostRate: 0.5,
  maxEscalationRate: 0.3,
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round4 = (v: number) => Math.round(v * 10000) / 10000;

export function aggregate(cards: Scorecard[]): RunQuality {
  const n = cards.length;
  if (n === 0) {
    return {
      n: 0, meanCompleteness: 0, meanCorrectness: null, violationRate: 0,
      hallucinationRate: 0, ghostRate: 0, escalationRate: 0,
      qualifiedRate: 0, meanTurns: 0,
    };
  }

  const gradable = cards.map((c) => c.evidenceCorrectness).filter((v): v is number => v !== null);
  const rate = (pred: (c: Scorecard) => boolean) => round4(cards.filter(pred).length / n);

  return {
    n,
    meanCompleteness: round4(mean(cards.map((c) => c.evidenceCompleteness))),
    meanCorrectness: gradable.length ? round4(mean(gradable)) : null,
    violationRate: rate((c) => c.policyViolations.length > 0),
    hallucinationRate: rate((c) => c.hallucinatedFields.length > 0),
    ghostRate: rate((c) => c.outcome === "ghosted"),
    escalationRate: rate((c) => c.outcome === "escalated"),
    qualifiedRate: rate((c) => c.qualified),
    meanTurns: round4(mean(cards.map((c) => c.turnsUsed))),
  };
}

export function evaluateAlerts(q: RunQuality, t: Thresholds = DEFAULT_THRESHOLDS): Alert[] {
  if (q.n === 0) return [];
  const alerts: Alert[] = [];

  const over = (
    id: string, severity: Alert["severity"], observed: number, threshold: number, message: string,
  ) => { if (observed > threshold) alerts.push({ id, severity, message, observed, threshold }); };

  const under = (
    id: string, severity: Alert["severity"], observed: number, threshold: number, message: string,
  ) => { if (observed < threshold) alerts.push({ id, severity, message, observed, threshold }); };

  // A policy breach is never acceptable, so the threshold is zero.
  over("policy_violations", "critical", q.violationRate, t.maxViolationRate,
    `${(q.violationRate * 100).toFixed(1)}% of conversations breached a "never" rule`);

  over("hallucination_rate", "critical", q.hallucinationRate, t.maxHallucinationRate,
    `${(q.hallucinationRate * 100).toFixed(1)}% recorded evidence contradicting the lead`);

  under("evidence_completeness", "warn", q.meanCompleteness, t.minEvidenceCompleteness,
    `mean evidence completeness ${(q.meanCompleteness * 100).toFixed(1)}% is below target`);

  if (q.meanCorrectness !== null) {
    under("evidence_correctness", "critical", q.meanCorrectness, t.minEvidenceCorrectness,
      `mean evidence correctness ${(q.meanCorrectness * 100).toFixed(1)}% is below target`);
  }

  over("ghost_rate", "warn", q.ghostRate, t.maxGhostRate,
    `${(q.ghostRate * 100).toFixed(1)}% of leads stopped replying`);

  over("escalation_rate", "warn", q.escalationRate, t.maxEscalationRate,
    `${(q.escalationRate * 100).toFixed(1)}% escalated to a human`);

  return alerts;
}
