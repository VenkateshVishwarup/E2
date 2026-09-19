import { z } from "zod";

/**
 * Observable facts only. There is deliberately NO `Converted` event —
 * "converted" means different things to different teams, so it is a declared
 * predicate over these facts (see JourneySpec.metrics), never a stored fact.
 */
export const EVENT_TYPES = [
  "LeadIngested", "MessageSent", "MessageReceived", "EvidenceExtracted",
  "PolicyEvaluated", "ToolInvoked", "AuthorizationDenied", "Scored", "Routed",
  "HandoffCreated", "NurtureScheduled", "OutcomeObserved", "CostObserved",
  // An open-strategy agent's choice of what to do next, and whether the
  // guardrail let it. Recorded for the same reason `AuthorizationDenied` is: a
  // decision nobody can read afterwards is not a decision anyone will trust.
  "MoveChosen",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ENVIRONMENTS = ["live", "sim"] as const;
export type Env = (typeof ENVIRONMENTS)[number];

export const eventInputSchema = z.object({
  leadId: z.string().min(1),
  journey: z.string().min(1),
  journeyVersion: z.number().int().positive(),
  agentId: z.string().min(1, "agentId is required — every event needs a principal"),
  runId: z.string().min(1).optional(),
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.unknown()),
  occurredAt: z.date().optional(),
});

export type EventInput = z.infer<typeof eventInputSchema>;

export interface StoredEvent {
  id: number;
  tenantId: string;
  leadId: string;
  journey: string;
  journeyVersion: number;
  agentId: string;
  env: Env;
  runId: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
  recordedAt: Date;
}

export interface Turn { role: "agent" | "lead"; text: string; at: Date }

/**
 * One planner decision, as folded back out of the log.
 *
 * `proposed` and `move` differ exactly when the guardrail intervened, so the
 * pair is the whole audit trail: what the model wanted, what it was allowed, and
 * which rule made the difference.
 */
export interface MoveRecord {
  /** What was actually performed. */
  move: string;
  /** What the planner asked for. Equal to `move` when nothing intervened. */
  proposed: string;
  overridden: boolean;
  /** The guardrail rule that fired, or null when the proposal stood. */
  rule: string | null;
  /** The planner's own one-line reason, in its words. */
  rationale: string;
  /** For an `ask`, the field it asked for. What lets a repeated question be caught. */
  targetField: string | null;
  at: Date;
}

export interface OutcomePayload {
  outcome: "attended" | "applied" | "enrolled" | "paid";
  amount?: number;
  currency?: string;
}

export interface LeadState {
  leadId: string;
  journey: string;
  journeyVersion: number;
  evidence: Record<string, { value: unknown; confidence: number }>;
  turns: Turn[];
  score?: number;
  decision?: string;
  outcomes: OutcomePayload[];
  /**
   * Planner decisions in order. Empty for a scripted journey, which makes no
   * decisions worth recording — its path is in the code.
   */
  moves: MoveRecord[];
}
