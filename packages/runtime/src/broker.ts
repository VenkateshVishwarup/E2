import { createHash } from "node:crypto";
import type { EventStore } from "@midfunnel/core/events/store";
import type { AgentPrincipal, AgentRegistry } from "@midfunnel/core/agent/registry";

export interface InvocationContext {
  leadId: string;
  journey: string;
  journeyVersion: number;
}

export type Binding = (
  args: Record<string, unknown>,
  scope?: string,
) => Promise<unknown>;

export interface ToolResult { ok: boolean; value?: unknown; error?: string }

/** Deterministic stand-ins. Real vendor bindings arrive post-MVP. */
export const mockBindings: Record<string, Binding> = {
  "crm.upsert_lead": async (args) => ({ id: `crm_${hash(args).slice(0, 8)}`, binding: "mock-crm" }),
  "calendar.book_slot": async () => ({ bookingId: "bk_1", startsAt: "2026-09-10T10:00:00Z" }),
  "catalog.lookup_program": async (args) => ({ program: args.program ?? "executive_mba", feesBand: "5L_to_15L" }),
};

const BINDING_NAMES: Record<string, string> = {
  "crm.upsert_lead": "mock-crm",
  "calendar.book_slot": "mock-calendar",
  "catalog.lookup_program": "mock-catalog",
};

export class ToolBroker {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly store: EventStore,
    private readonly bindings: Record<string, Binding>,
  ) {}

  /**
   * The single egress point. Privilege is enforced here, not suggested by the
   * spec. Arguments are hashed rather than logged — the event log must stay
   * clean of PII.
   */
  async invoke(
    ctx: InvocationContext,
    principal: AgentPrincipal,
    capability: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const base = { ...ctx, agentId: principal.identity };

    const authz = this.registry.authorize(principal, capability);
    if (!authz.allowed) {
      await this.store.append({
        ...base, type: "AuthorizationDenied",
        payload: {
          capability, principal: principal.identity,
          reason: authz.reason, attemptedAt: new Date().toISOString(),
        },
      });
      return { ok: false, error: authz.reason };
    }

    const binding = this.bindings[capability];
    if (!binding) return { ok: false, error: `no binding configured for ${capability}` };

    const startedAt = Date.now();
    let value: unknown;
    let error: string | undefined;
    try {
      value = await binding(args, authz.scope);
    } catch (err) {
      error = (err as Error).message;
    }

    await this.store.append({
      ...base, type: "ToolInvoked",
      payload: {
        capability,
        binding: BINDING_NAMES[capability] ?? "custom",
        argsHash: hash(args),
        resultStatus: error ? "error" : "ok",
        latencyMs: Date.now() - startedAt,
      },
    });

    return error ? { ok: false, error } : { ok: true, value };
  }
}

function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
}
