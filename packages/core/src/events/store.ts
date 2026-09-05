import type { Pool } from "../db/client.js";
import {
  EVENT_TYPES, eventInputSchema,
  type EventInput, type Env, type EventType, type LeadState, type OutcomePayload,
  type StoredEvent, type Turn,
} from "./types.js";

const COLS = `id, tenant_id, lead_id, journey, journey_version,
              agent_id, env, run_id, type, payload, occurred_at, recorded_at`;

const PARAMS_PER_EVENT = 10;

/**
 * The Postgres wire protocol counts bind parameters in an Int16, so a single
 * statement carries at most 32767 of them. Past that the count wraps negative
 * and the server rejects the message with a parameter-count mismatch that names
 * neither the cause nor the limit.
 *
 * 1500 events per statement leaves generous headroom and is still one round
 * trip per 1500 rows. Importing a real cohort crosses this immediately.
 */
const CHUNK = 1500;

export interface EventFilter {
  leadId?: string;
  journey?: string;
  journeyVersion?: number;
  type?: string;
  runId?: string;
  limit?: number;
}

export class EventStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
    private readonly env: Env = "live",
  ) {
    if (!tenantId) throw new Error("EventStore requires a tenantId");
  }

  private validate(e: EventInput): EventInput {
    if (!EVENT_TYPES.includes(e.type as never)) {
      throw new Error(`unknown event type: ${e.type}`);
    }
    // Enforced in code as well as by the CHECK constraint, so the error is
    // readable rather than a raw constraint violation.
    if (this.env === "sim" && !e.runId) {
      throw new Error("a simulated event requires a runId — it groups the run");
    }
    if (this.env === "live" && e.runId) {
      throw new Error("a live event must not carry a runId");
    }
    return eventInputSchema.parse(e);
  }

  async append(e: EventInput): Promise<StoredEvent> {
    const [row] = await this.appendMany([e]);
    return row!;
  }

  async appendMany(events: EventInput[]): Promise<StoredEvent[]> {
    if (events.length === 0) return [];
    // Validate everything before writing anything: a batch that fails halfway
    // through on the tenth chunk has already committed nine.
    const valid = events.map((e) => this.validate(e));
    if (valid.length <= CHUNK) return this.insert(valid);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out: StoredEvent[] = [];
      for (let i = 0; i < valid.length; i += CHUNK) {
        out.push(...await this.insert(valid.slice(i, i + CHUNK), client));
      }
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async insert(
    valid: EventInput[], on: Queryable = this.pool,
  ): Promise<StoredEvent[]> {
    const values: unknown[] = [];
    const tuples = valid.map((e, i) => {
      const o = i * PARAMS_PER_EVENT;
      values.push(
        this.tenantId, e.leadId, e.journey, e.journeyVersion,
        e.agentId, this.env, e.runId ?? null, e.type,
        JSON.stringify(e.payload), e.occurredAt ?? new Date(),
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},` +
             `$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`;
    });

    const { rows } = await on.query<EventRow>(
      `INSERT INTO events (tenant_id, lead_id, journey, journey_version,
                           agent_id, env, run_id, type, payload, occurred_at)
       VALUES ${tuples.join(",")} RETURNING ${COLS}`,
      values,
    );
    return rows.map(toStored);
  }

  /** Always tenant-scoped. There is no unscoped read path. */
  async query(filter: EventFilter = {}): Promise<StoredEvent[]> {
    // env is part of the WHERE clause, not an optional filter: isolation is
    // enforced by the query builder, never by remembering to pass a flag.
    const where = ["tenant_id = $1", "env = $2"];
    const values: unknown[] = [this.tenantId, this.env];
    const add = (sql: string, v: unknown) => { values.push(v); where.push(`${sql} $${values.length}`); };

    if (filter.leadId) add("lead_id =", filter.leadId);
    if (filter.journey) add("journey =", filter.journey);
    if (filter.journeyVersion !== undefined) add("journey_version =", filter.journeyVersion);
    if (filter.type) add("type =", filter.type);
    if (filter.runId) add("run_id =", filter.runId);

    const limit = filter.limit ? ` LIMIT ${Number(filter.limit)}` : "";
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${COLS} FROM events WHERE ${where.join(" AND ")}
       ORDER BY occurred_at ASC, id ASC${limit}`,
      values,
    );
    return rows.map(toStored);
  }

  /** Reconstruct everything known about a lead. This is the only read model. */
  async fold(leadId: string): Promise<LeadState> {
    return foldEvents(leadId, await this.query({ leadId }));
  }

  /**
   * Fold a whole cohort in ONE query.
   *
   * Replaying 2000 leads used to issue 2000 round trips, which dominated the
   * wall time before a single model call was made. Anything that folds a cohort
   * should use this; `fold` remains for the single-lead case.
   */
  async foldMany(leadIds: readonly string[]): Promise<LeadState[]> {
    if (leadIds.length === 0) return [];

    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${COLS} FROM events
       WHERE tenant_id = $1 AND env = $2 AND lead_id = ANY($3)
       ORDER BY occurred_at ASC, id ASC`,
      [this.tenantId, this.env, leadIds],
    );

    const byLead = new Map<string, StoredEvent[]>();
    for (const row of rows) {
      const e = toStored(row);
      const bucket = byLead.get(e.leadId);
      if (bucket) bucket.push(e); else byLead.set(e.leadId, [e]);
    }
    // Caller order is preserved: replay pairs arms by index.
    return leadIds.map((id) => foldEvents(id, byLead.get(id) ?? []));
  }
}

function foldEvents(leadId: string, events: readonly StoredEvent[]): LeadState {
  {
    const state: LeadState = {
      leadId,
      journey: events[0]?.journey ?? "",
      journeyVersion: events[0]?.journeyVersion ?? 0,
      evidence: {}, turns: [], outcomes: [],
    };

    for (const e of events) {
      const p = e.payload;
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

/** A pool or a checked-out client — both can run a parameterised query. */
interface Queryable {
  query<R>(sql: string, values: unknown[]): Promise<{ rows: R[] }>;
}

/** Shape of a row as it comes back from Postgres (snake_case, loose types). */
interface EventRow {
  id: string | number;
  tenant_id: string;
  lead_id: string;
  journey: string;
  journey_version: string | number;
  agent_id: string;
  env: Env;
  run_id: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  occurred_at: Date;
  recorded_at: Date;
}

function toStored(r: EventRow): StoredEvent {
  return {
    id: Number(r.id), tenantId: r.tenant_id, leadId: r.lead_id,
    journey: r.journey, journeyVersion: Number(r.journey_version),
    agentId: r.agent_id, env: r.env, runId: r.run_id,
    type: r.type, payload: r.payload,
    occurredAt: r.occurred_at, recordedAt: r.recorded_at,
  };
}
