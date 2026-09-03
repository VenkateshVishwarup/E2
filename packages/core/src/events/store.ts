import type { Pool } from "../db/client.js";
import {
  EVENT_TYPES, eventInputSchema,
  type EventInput, type LeadState, type OutcomePayload, type StoredEvent, type Turn,
} from "./types.js";

const COLS = `id, tenant_id, lead_id, journey, journey_version,
              agent_id, type, payload, occurred_at, recorded_at`;

export interface EventFilter {
  leadId?: string;
  journey?: string;
  journeyVersion?: number;
  type?: string;
  limit?: number;
}

export class EventStore {
  constructor(private readonly pool: Pool, private readonly tenantId: string) {
    if (!tenantId) throw new Error("EventStore requires a tenantId");
  }

  private validate(e: EventInput): EventInput {
    if (!EVENT_TYPES.includes(e.type as never)) {
      throw new Error(`unknown event type: ${e.type}`);
    }
    return eventInputSchema.parse(e);
  }

  async append(e: EventInput): Promise<StoredEvent> {
    const [row] = await this.appendMany([e]);
    return row!;
  }

  async appendMany(events: EventInput[]): Promise<StoredEvent[]> {
    if (events.length === 0) return [];
    const valid = events.map((e) => this.validate(e));

    const values: unknown[] = [];
    const tuples = valid.map((e, i) => {
      const o = i * 8;
      values.push(
        this.tenantId, e.leadId, e.journey, e.journeyVersion,
        e.agentId, e.type, JSON.stringify(e.payload), e.occurredAt ?? new Date(),
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
    });

    const { rows } = await this.pool.query(
      `INSERT INTO events (tenant_id, lead_id, journey, journey_version,
                           agent_id, type, payload, occurred_at)
       VALUES ${tuples.join(",")} RETURNING ${COLS}`,
      values,
    );
    return rows.map(toStored);
  }

  /** Always tenant-scoped. There is no unscoped read path. */
  async query(filter: EventFilter = {}): Promise<StoredEvent[]> {
    const where = ["tenant_id = $1"];
    const values: unknown[] = [this.tenantId];
    const add = (sql: string, v: unknown) => { values.push(v); where.push(`${sql} $${values.length}`); };

    if (filter.leadId) add("lead_id =", filter.leadId);
    if (filter.journey) add("journey =", filter.journey);
    if (filter.journeyVersion !== undefined) add("journey_version =", filter.journeyVersion);
    if (filter.type) add("type =", filter.type);

    const limit = filter.limit ? ` LIMIT ${Number(filter.limit)}` : "";
    const { rows } = await this.pool.query(
      `SELECT ${COLS} FROM events WHERE ${where.join(" AND ")}
       ORDER BY occurred_at ASC, id ASC${limit}`,
      values,
    );
    return rows.map(toStored);
  }

  /** Reconstruct everything known about a lead. This is the only read model. */
  async fold(leadId: string): Promise<LeadState> {
    const events = await this.query({ leadId });
    const state: LeadState = {
      leadId,
      journey: events[0]?.journey ?? "",
      journeyVersion: events[0]?.journeyVersion ?? 0,
      evidence: {}, turns: [], outcomes: [],
    };

    for (const e of events) {
      const p = e.payload as Record<string, never>;
      switch (e.type) {
        case "MessageSent":
          state.turns.push({ role: "agent", text: String(p.renderedText ?? ""), at: e.occurredAt } satisfies Turn);
          break;
        case "MessageReceived":
          state.turns.push({ role: "lead", text: String(p.rawText ?? ""), at: e.occurredAt } satisfies Turn);
          break;
        case "EvidenceExtracted":
          // Last write wins: a later extraction supersedes an earlier one.
          state.evidence[String(p.field)] = { value: p.value, confidence: Number(p.confidence) };
          break;
        case "Scored":   state.score = Number(p.score); break;
        case "Routed":   state.decision = String(p.decision); break;
        case "OutcomeObserved": state.outcomes.push(e.payload as unknown as OutcomePayload); break;
        default: break;
      }
    }
    return state;
  }
}

function toStored(r: Record<string, never>): StoredEvent {
  return {
    id: Number(r.id), tenantId: r.tenant_id, leadId: r.lead_id,
    journey: r.journey, journeyVersion: Number(r.journey_version),
    agentId: r.agent_id, type: r.type, payload: r.payload,
    occurredAt: r.occurred_at, recordedAt: r.recorded_at,
  };
}
