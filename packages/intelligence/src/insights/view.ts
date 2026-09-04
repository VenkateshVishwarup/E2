import type { StoredEvent, Turn } from "@midfunnel/core/events/types";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import { requiredEvidenceFields } from "@midfunnel/core/journey/spec";
import { evaluateAll } from "@midfunnel/core/metrics/predicate";

export interface LeadView {
  leadId: string;
  journeyVersion: number;
  campaignId: string;
  creativeId: string;
  /** Field -> established value. */
  evidence: Record<string, unknown>;
  missingRequired: string[];
  turns: Turn[];
  leadReplies: number;
  score: number | null;
  decision: string | null;
  completed: boolean;
  qualified: boolean;
  converted: boolean;
  /** Rule ids that fired, in order. */
  policyFired: string[];
  firstContactAt: Date | null;
  /** True when the lead replied at least once after policy fired, or at all. */
  repliedAfterPolicy: boolean | null;
}

export interface MetricNames { conversion: string; qualified: string }

export function buildViews(
  events: readonly StoredEvent[],
  specs: ReadonlyMap<number, JourneySpec>,
  names: MetricNames,
): LeadView[] {
  const byLead = new Map<string, StoredEvent[]>();
  for (const e of events) {
    const b = byLead.get(e.leadId);
    if (b) b.push(e); else byLead.set(e.leadId, [e]);
  }
  return [...byLead.values()].map((es) => view(es, specs, names));
}

function view(
  events: StoredEvent[],
  specs: ReadonlyMap<number, JourneySpec>,
  names: MetricNames,
): LeadView {
  const ingested = events.find((e) => e.type === "LeadIngested");
  const routed = events.filter((e) => e.type === "Routed").at(-1);
  const scored = events.filter((e) => e.type === "Scored").at(-1);
  const version = routed?.journeyVersion ?? ingested?.journeyVersion ?? events[0]!.journeyVersion;
  const spec = specs.get(version);

  const evidence: Record<string, unknown> = {};
  for (const e of events) {
    if (e.type === "EvidenceExtracted") evidence[String(e.payload.field)] = e.payload.value;
  }

  const turns: Turn[] = [];
  for (const e of events) {
    if (e.type === "MessageSent") turns.push({ role: "agent", text: String(e.payload.renderedText ?? ""), at: e.occurredAt });
    if (e.type === "MessageReceived") turns.push({ role: "lead", text: String(e.payload.rawText ?? ""), at: e.occurredAt });
  }

  const policyEvents = events.filter((e) => e.type === "PolicyEvaluated");
  const firstPolicyAt = policyEvents[0]?.occurredAt ?? null;
  const metrics = spec ? evaluateAll(spec.metrics, events) : { booleans: {}, aggregates: {} };

  return {
    leadId: events[0]!.leadId,
    journeyVersion: version,
    campaignId: text(ingested?.payload.campaignId),
    creativeId: text(ingested?.payload.creativeId),
    evidence,
    missingRequired: spec
      ? requiredEvidenceFields(spec).filter((f) => evidence[f] === undefined || evidence[f] === null)
      : [],
    turns,
    leadReplies: turns.filter((t) => t.role === "lead").length,
    score: scored ? Number(scored.payload.score) : null,
    decision: routed ? String(routed.payload.decision) : null,
    completed: Boolean(routed),
    qualified: Boolean(metrics.booleans[names.qualified]),
    converted: Boolean(metrics.booleans[names.conversion]),
    policyFired: policyEvents.map((e) => String(e.payload.ruleId)),
    firstContactAt: events.find((e) => e.type === "MessageSent")?.occurredAt
      ?? ingested?.occurredAt ?? null,
    repliedAfterPolicy: firstPolicyAt === null
      ? null
      : turns.some((t) => t.role === "lead" && t.at > firstPolicyAt),
  };
}

function text(v: unknown): string {
  return typeof v === "string" && v !== "" ? v : "(unattributed)";
}
