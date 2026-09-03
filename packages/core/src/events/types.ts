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
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const eventInputSchema = z.object({
  leadId: z.string().min(1),
  journey: z.string().min(1),
  journeyVersion: z.number().int().positive(),
  agentId: z.string().min(1, "agentId is required — every event needs a principal"),
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
  type: EventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
  recordedAt: Date;
}

export interface Turn { role: "agent" | "lead"; text: string; at: Date }

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
}
