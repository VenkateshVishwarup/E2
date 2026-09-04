import type { EventStore } from "@midfunnel/core/events/store";
import type { EventInput, StoredEvent } from "@midfunnel/core/events/types";
import type { CallCost } from "@midfunnel/runtime/provider";

/**
 * All monetary amounts are integer MINOR units (paise, cents). Money is never
 * a float in this system: 45000000 is a rupee amount the whole way through,
 * and even allocation below distributes remainders rather than losing them.
 */

export interface MediaSpendRow {
  campaignId: string;
  /** Omit to allocate across the whole campaign regardless of creative. */
  creativeId?: string;
  /** ISO date, `YYYY-MM-DD`. Ad platforms report daily. */
  day: string;
  amount: number;
  currency: string;
}

export interface ModelCostConfig {
  /** Reporting currency for the tenant. */
  currency: string;
  /** Minor units of the reporting currency per USD, e.g. 8300 for ₹83. */
  perUsd: number;
}

export interface IngestResult { leadsCharged: number; allocated: number; skipped: number }

/**
 * Ad platforms report spend per campaign per day; the spine requires a leadId
 * on every event. So spend is ALLOCATED to leads rather than stored beside
 * them, and the allocation method travels in the payload — even allocation is
 * an assumption, and a customer disputing cost-per-enrolment is entitled to
 * see which assumption produced the number.
 */
export class CostIngestor {
  constructor(private readonly store: EventStore) {}

  async ingestMedia(rows: readonly MediaSpendRow[]): Promise<IngestResult> {
    let leadsCharged = 0, allocated = 0, skipped = 0;

    for (const row of rows) {
      const ingested = (await this.store.query({ type: "LeadIngested" }))
        .filter((e) => e.payload.campaignId === row.campaignId)
        .filter((e) => !row.creativeId || e.payload.creativeId === row.creativeId)
        .filter((e) => isoDay(e.occurredAt) === row.day);

      if (ingested.length === 0) { skipped++; continue; }

      // Re-ingesting the same platform export must not double-charge.
      const already = await this.alreadyCharged(row, ingested);
      if (already) { skipped++; continue; }

      // Integer division loses the remainder; hand it to the first leads one
      // minor unit at a time so the allocated total equals the spend exactly.
      const base = Math.floor(row.amount / ingested.length);
      const remainder = row.amount - base * ingested.length;

      const events: EventInput[] = ingested.map((e, i) => ({
        leadId: e.leadId,
        journey: e.journey,
        journeyVersion: e.journeyVersion,
        agentId: "agent://engati/cost-ingestor",
        type: "CostObserved" as const,
        occurredAt: new Date(`${row.day}T23:59:59Z`),
        payload: {
          kind: "media",
          amount: base + (i < remainder ? 1 : 0),
          currency: row.currency,
          campaignId: row.campaignId,
          creativeId: row.creativeId ?? null,
          day: row.day,
          allocation: "even",
          cohortSize: ingested.length,
        },
      }));

      await this.store.appendMany(events);
      leadsCharged += events.length;
      allocated += row.amount;
    }

    return { leadsCharged, allocated, skipped };
  }

  private async alreadyCharged(
    row: MediaSpendRow, ingested: readonly StoredEvent[],
  ): Promise<boolean> {
    const existing = await this.store.query({ leadId: ingested[0]!.leadId, type: "CostObserved" });
    return existing.some((e) =>
      e.payload.kind === "media" &&
      e.payload.campaignId === row.campaignId &&
      e.payload.day === row.day &&
      (e.payload.creativeId ?? null) === (row.creativeId ?? null));
  }
}

export interface ConversationContext {
  leadId: string;
  journey: string;
  journeyVersion: number;
  agentId: string;
  runId?: string;
}

/**
 * Model spend is converted to the reporting currency AT WRITE TIME and the
 * rate is recorded in the event. A later rate change cannot silently rewrite
 * historical ROI, which is the same reason the event log is append-only.
 */
export async function recordModelCost(
  store: EventStore,
  ctx: ConversationContext,
  calls: readonly CallCost[],
  fx: ModelCostConfig,
): Promise<void> {
  const priced = calls.filter((c) => c.priced);
  if (priced.length === 0) return;

  const usd = priced.reduce((sum, c) => sum + c.usd, 0);
  const byModel: Record<string, number> = {};
  for (const c of priced) byModel[c.model] = (byModel[c.model] ?? 0) + c.usd;

  await store.append({
    leadId: ctx.leadId,
    journey: ctx.journey,
    journeyVersion: ctx.journeyVersion,
    agentId: ctx.agentId,
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    type: "CostObserved",
    payload: {
      kind: "model",
      amount: Math.round(usd * fx.perUsd),
      currency: fx.currency,
      usd,
      fxPerUsd: fx.perUsd,
      calls: priced.length,
      inputTokens: sum(priced, (c) => c.inputTokens),
      cachedTokens: sum(priced, (c) => c.cachedTokens),
      outputTokens: sum(priced, (c) => c.outputTokens),
      reasoningTokens: sum(priced, (c) => c.reasoningTokens),
      byModel,
      unpricedCalls: calls.length - priced.length,
    },
  });
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((a, x) => a + f(x), 0);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
