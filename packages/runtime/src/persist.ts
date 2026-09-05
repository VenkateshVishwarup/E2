import type { EventInput } from "@midfunnel/core/events/types";
import type { Action } from "./step.js";

export interface EventBase {
  leadId: string;
  journey: string;
  journeyVersion: number;
  agentId: string;
  /** Set for simulated runs, absent for live traffic. */
  runId?: string;
}

export interface AppliedActions {
  events: EventInput[];
  /** What the agent said this turn, or null if it said nothing. */
  sentText: string | null;
  escalated: boolean;
  escalationRule: string | null;
  completed: boolean;
  qualified: boolean;
  score: number | null;
  decision: string | null;
}

/**
 * The single translation from what the runtime decided into what the log
 * records.
 *
 * It lives here, shared, because a live conversation and a simulated one MUST
 * write identical events. Every fold downstream — attribution, insights,
 * replay, the copilot — reads them the same way, so two copies of this
 * translation would mean live traffic and sim traffic quietly measuring
 * different things. Live and sim differ in exactly two fields, both already
 * modelled: `env` on the store, and `runId` here.
 */
export function actionsToEvents(
  actions: readonly Action[],
  base: EventBase,
  channel: string,
): AppliedActions {
  const events: EventInput[] = [];
  const out: AppliedActions = {
    events, sentText: null, escalated: false, escalationRule: null,
    completed: false, qualified: false, score: null, decision: null,
  };

  for (const a of actions) {
    switch (a.kind) {
      case "send":
        out.sentText = a.text;
        events.push({ ...base, type: "MessageSent",
          payload: { channel, renderedText: a.text, templateId: a.pinnedTemplate ?? null } });
        break;

      case "extract":
        for (const [field, v] of Object.entries(a.evidence)) {
          events.push({ ...base, type: "EvidenceExtracted",
            payload: { field, value: v.value, confidence: v.confidence } });
        }
        break;

      case "score":
        out.score = a.score;
        events.push({ ...base, type: "Scored", payload: { score: a.score } });
        break;

      case "route":
        out.decision = a.decision;
        events.push({ ...base, type: "Routed",
          payload: { decision: a.decision, target: a.target, sla: a.sla ?? null } });
        // A handoff target is what `booked` means; without this event the
        // metric can never be true no matter how the lead was routed.
        if (a.target.startsWith("handoff.")) {
          events.push({ ...base, type: "HandoffCreated",
            payload: { target: a.target, sla: a.sla ?? null } });
        }
        break;

      case "escalate":
        out.escalated = true;
        out.escalationRule = a.reason;
        events.push({ ...base, type: "PolicyEvaluated",
          payload: { ruleId: a.reason, verdict: "escalate", severity: "high" } });
        break;

      case "complete":
        out.completed = true;
        out.qualified = a.qualified;
        break;
    }
  }

  return out;
}
