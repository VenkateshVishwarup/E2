import { createHash } from "node:crypto";
import type { EventStore } from "@midfunnel/core/events/store";
import type { EventInput } from "@midfunnel/core/events/types";
import { scrub } from "./pii.js";

export interface HistoricalLead {
  externalId: string;
  source: string;
  campaignId?: string;
  creativeId?: string;
  consentScope?: string;
  turns: Array<{ role: "agent" | "lead"; text: string; at: string }>;
  outcome?: {
    outcome: "attended" | "applied" | "enrolled" | "paid";
    amount?: number;
    currency?: string;
    observedAt: string;
  };
}

export interface ImportOptions {
  journey: string;
  journeyVersion: number;
  agentId: string;
}

export class ImportBoundary {
  constructor(
    private readonly store: EventStore,
    private readonly opts: ImportOptions,
  ) {}

  /**
   * Deterministic lead ids from externalId make imports idempotent without a
   * dedupe table. Re-importing the same export is a no-op.
   */
  async import(leads: HistoricalLead[]): Promise<string[]> {
    const ids: string[] = [];

    for (const lead of leads) {
      const leadId = deriveLeadId(lead.externalId);
      ids.push(leadId);

      const existing = await this.store.query({ leadId, limit: 1 });
      if (existing.length > 0) continue;

      const base = {
        leadId,
        journey: this.opts.journey,
        journeyVersion: this.opts.journeyVersion,
        agentId: this.opts.agentId,
      };
      const first = lead.turns[0]?.at ?? new Date().toISOString();

      const events: EventInput[] = [{
        ...base, type: "LeadIngested", occurredAt: new Date(first),
        payload: {
          externalId: lead.externalId, source: lead.source,
          campaignId: lead.campaignId ?? null, creativeId: lead.creativeId ?? null,
          consentScope: lead.consentScope ?? null,
        },
      }];

      for (const t of lead.turns) {
        events.push(t.role === "agent"
          ? { ...base, type: "MessageSent", occurredAt: new Date(t.at),
              payload: { channel: "whatsapp", renderedText: scrub(t.text) } }
          : { ...base, type: "MessageReceived", occurredAt: new Date(t.at),
              payload: { channel: "whatsapp", rawText: scrub(t.text) } });
      }

      if (lead.outcome) {
        events.push({
          ...base, type: "OutcomeObserved", occurredAt: new Date(lead.outcome.observedAt),
          payload: {
            outcome: lead.outcome.outcome,
            amount: lead.outcome.amount ?? null,
            currency: lead.outcome.currency ?? null,
            source: "import",
          },
        });
      }

      await this.store.appendMany(events);
    }

    return ids;
  }
}

function deriveLeadId(externalId: string): string {
  return `L_${createHash("sha256").update(externalId).digest("hex").slice(0, 16)}`;
}
