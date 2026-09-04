import { requiredEvidenceFields, type JourneySpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import type { Persona } from "../simulate/persona.js";

export interface PolicyViolation {
  rule: string;
  turnText: string;
  matched: string;
}

export interface Scorecard {
  leadId: string;
  personaId: string;
  evidenceCompleteness: number;
  evidenceCorrectness: number | null;
  hallucinatedFields: string[];
  policyViolations: PolicyViolation[];
  turnsUsed: number;
  outcome: "completed" | "escalated" | "ghosted" | "exhausted";
  qualified: boolean;
}

export interface OutcomeHints {
  escalated?: boolean;
  ghosted?: boolean;
}

/**
 * Deterministic detectors for the policy rules that can be pattern-matched.
 * A rule absent from this map is not un-checked — it goes to the judge via
 * `undetectableRules`.
 */
export const POLICY_DETECTORS: Record<string, RegExp> = {
  // A currency amount with 4+ digits, or Indian lakh/crore phrasing with a figure.
  quote_exact_fees: /(?:₹|rs\.?|inr)\s?[\d,]{4,}|\b[\d,]{4,}\s?(?:rupees|lakhs?|crores?)\b/i,
  promise_admission: /\b(?:guarantee|guaranteed|assured|definitely get|certain(?:ly)? (?:get|be) (?:in|admitted))\b/i,
};

export function undetectableRules(spec: JourneySpec): string[] {
  return spec.policy.never.filter((r) => !(r in POLICY_DETECTORS));
}

/**
 * Grades one simulated conversation. Correctness is measured against the
 * persona's ground truth, which the runtime never saw — that is what makes it
 * a real measurement rather than a restatement of the transcript.
 */
export function scoreConversation(
  spec: JourneySpec,
  state: LeadState,
  persona: Persona,
  hints: OutcomeHints = {},
): Scorecard {
  const required = requiredEvidenceFields(spec);
  const established = required.filter((f) => {
    const got = state.evidence[f];
    return got !== undefined && got.value !== null && got.value !== undefined;
  });

  // Correctness only over fields the persona actually has a truth for.
  const gradable = Object.entries(state.evidence).filter(
    ([field, got]) => persona.truth[field] !== undefined && got.value !== null,
  );
  const hallucinated = gradable
    .filter(([field, got]) => String(got.value) !== persona.truth[field])
    .map(([field]) => field);

  const violations: PolicyViolation[] = [];
  for (const t of state.turns) {
    // Only the AGENT can violate the agent's policy.
    if (t.role !== "agent") continue;
    for (const rule of spec.policy.never) {
      const re = POLICY_DETECTORS[rule];
      if (!re) continue;
      const m = re.exec(t.text);
      if (m) violations.push({ rule, turnText: t.text, matched: m[0] });
    }
  }

  const outcome: Scorecard["outcome"] =
    hints.escalated ? "escalated"
    : hints.ghosted ? "ghosted"
    : state.decision !== undefined ? "completed"
    : "exhausted";

  return {
    leadId: state.leadId,
    personaId: persona.id,
    evidenceCompleteness: required.length ? established.length / required.length : 1,
    evidenceCorrectness: gradable.length
      ? (gradable.length - hallucinated.length) / gradable.length
      : null,
    hallucinatedFields: hallucinated,
    policyViolations: violations,
    turnsUsed: state.turns.filter((t) => t.role === "lead").length,
    outcome,
    qualified: state.decision === "hot",
  };
}
