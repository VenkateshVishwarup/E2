import { randomUUID } from "node:crypto";
import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import { pinnedDefaults, renderPinned, requiredEvidenceFields } from "@midfunnel/core/journey/spec";
import type { EventInput, LeadState } from "@midfunnel/core/events/types";
import { evaluateAll } from "@midfunnel/core/metrics/predicate";
import type { AgentRuntime } from "@midfunnel/runtime/step";
import { actionsToEvents, type EventBase } from "@midfunnel/runtime/persist";
import { recordModelCost, type ModelCostConfig } from "@midfunnel/intelligence/attribution/cost";
import { TrafficAllocator } from "@midfunnel/batch/experiment/allocator";

/** Chat leads are prefixed so a seed script's cleanup can never delete them. */
const PREFIX = "web_";

export interface StartSession {
  journey: string;
  /** Explicit version, or omit and supply `split`. */
  version?: number;
  /** Live A/B: version -> percentage, summing to 100. */
  split?: Record<string, number>;
  source?: string;
  campaignId?: string;
  creativeId?: string;
  /** Values for `{{placeholders}}` in pinned text, over the spec's defaults. */
  variables?: Record<string, string>;
}

export interface EvidenceView {
  field: string;
  required: boolean;
  value: unknown;
  confidence: number | null;
  /** Declared `sensitive`, so the runtime will not open with it. */
  sensitive: boolean;
}

export interface ChatState {
  leadId: string;
  journey: string;
  version: number;
  turns: Array<{ role: "agent" | "lead"; text: string; at: string }>;
  evidence: EvidenceView[];
  missingRequired: string[];
  score: number | null;
  decision: string | null;
  /**
   * The journey's OWN declared metrics, evaluated live over this conversation.
   * There is no platform-wide notion of "qualified" to report instead.
   */
  metrics: Record<string, boolean | number>;
  completed: boolean;
  escalated: boolean;
  escalationRule: string | null;
  /** Minor units of the reporting currency, metered from real token usage. */
  modelCost: number;
  currency: string;
  /** True when no model credential is configured. */
  offline: boolean;
}

export interface ChatReply { reply: string | null; state: ChatState }

/**
 * A live conversation. The events it writes are `live`-scoped with no `runId`,
 * so they land in the same log the ROI and insight screens already read — a
 * real conversation is not a special case in this system, it is the ordinary
 * case that was missing.
 */
export class ChatService {
  constructor(
    private readonly store: EventStore,
    private readonly registry: JourneyRegistry,
    private readonly runtime: AgentRuntime,
    private readonly fx: ModelCostConfig,
    private readonly offline: boolean,
  ) {}

  async start(opts: StartSession): Promise<ChatReply> {
    const version = await this.chooseVersion(opts);
    const spec = await this.registry.get(opts.journey, version);
    const leadId = `${PREFIX}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const base = this.base(leadId, spec);

    await this.store.append({
      ...base, type: "LeadIngested",
      payload: {
        source: opts.source ?? "web_chat",
        campaignId: opts.campaignId ?? "direct",
        creativeId: opts.creativeId ?? "console",
        consentScope: "marketing",
        channel: "web",
        variables: opts.variables ?? {},
      },
    });

    // The opening turn is pinned and deterministic — never a model call — so
    // the disclosure a lead sees first cannot be improvised.
    return this.advance(spec, base);
  }

  async send(leadId: string, text: string): Promise<ChatReply> {
    const { spec, base } = await this.load(leadId);
    await this.store.append({
      ...base, type: "MessageReceived",
      payload: { channel: "web", rawText: text },
    });
    return this.advance(spec, base);
  }

  async state(leadId: string): Promise<ChatState> {
    const { spec, base } = await this.load(leadId);
    return this.view(spec, base.leadId);
  }

  /** One runtime step, persisted, plus the metered cost of making it. */
  private async advance(spec: JourneySpec, base: EventBase): Promise<ChatReply> {
    const folded: LeadState = await this.store.fold(base.leadId);

    this.runtime.meter.drain();          // cost of THIS turn only
    const actions = await this.runtime.step(spec, folded, { allowFollowUp: true });
    const applied = actionsToEvents(actions, base, "web");
    // Pinned text is a template until here. The runtime cannot render it —
    // the values are per-conversation — so a lead would otherwise receive
    // "Hi {{name}}" verbatim.
    render(applied, await this.variables(spec, base.leadId));
    if (applied.events.length > 0) await this.store.appendMany(applied.events);

    // Written per turn rather than at the end, because a conversation someone
    // abandons still cost real money and still belongs in cost per outcome.
    await recordModelCost(this.store, {
      leadId: base.leadId, journey: base.journey,
      journeyVersion: base.journeyVersion, agentId: base.agentId,
    }, this.runtime.meter.drain(), this.fx);

    return { reply: applied.sentText, state: await this.view(spec, base.leadId) };
  }

  private async view(spec: JourneySpec, leadId: string): Promise<ChatState> {
    const events = await this.store.query({ leadId });
    const folded = await this.store.fold(leadId);
    const required = new Set(requiredEvidenceFields(spec));

    const evidence: EvidenceView[] = Object.entries(spec.evidence).map(([field, def]) => {
      const got = folded.evidence[field];
      return {
        field,
        required: required.has(field),
        value: got?.value ?? null,
        confidence: got?.confidence ?? null,
        sensitive: Boolean(def.sensitive),
      };
    });

    const escalation = events.filter((e) => e.type === "PolicyEvaluated").at(-1);
    const routed = events.filter((e) => e.type === "Routed").at(-1);
    const evaluated = evaluateAll(spec.metrics, events);

    return {
      leadId,
      journey: spec.journey,
      version: spec.version,
      turns: folded.turns.map((t) => ({ role: t.role, text: t.text, at: t.at.toISOString() })),
      evidence,
      missingRequired: evidence
        .filter((e) => e.required && (e.value === null || e.value === undefined))
        .map((e) => e.field),
      score: folded.score ?? null,
      decision: folded.decision ?? null,
      metrics: { ...evaluated.booleans, ...evaluated.aggregates },
      completed: routed !== undefined,
      escalated: escalation !== undefined,
      escalationRule: escalation ? String(escalation.payload.ruleId) : null,
      modelCost: events
        .filter((e) => e.type === "CostObserved" && e.payload.kind === "model")
        .reduce((s, e) => s + Number(e.payload.amount ?? 0), 0),
      currency: this.fx.currency,
      offline: this.offline,
    };
  }

  /** Spec defaults, overridden by whatever this conversation supplied. */
  private async variables(spec: JourneySpec, leadId: string): Promise<Record<string, string>> {
    const [ingested] = await this.store.query({ leadId, type: "LeadIngested", limit: 1 });
    const supplied = (ingested?.payload.variables ?? {}) as Record<string, string>;
    return { name: "there", ...pinnedDefaults(spec), ...supplied };
  }

  private async load(leadId: string): Promise<{ spec: JourneySpec; base: EventBase }> {
    if (!leadId.startsWith(PREFIX)) throw new Error(`not a chat session: ${leadId}`);
    const [first] = await this.store.query({ leadId, limit: 1 });
    if (!first) throw new Error(`chat session not found: ${leadId}`);
    const spec = await this.registry.get(first.journey, first.journeyVersion);
    return { spec, base: this.base(leadId, spec) };
  }

  private base(leadId: string, spec: JourneySpec): EventBase {
    // No runId: this is live traffic. The store refuses a runId on a live
    // event, so the two environments cannot be conflated by accident.
    return {
      leadId, journey: spec.journey, journeyVersion: spec.version,
      agentId: spec.agent.identity,
    };
  }

  /**
   * A split routes real traffic across versions deterministically, which is
   * what "test a new agent without impacting the existing one" means. The same
   * allocator that splits simulated cohorts does it, so live A/B needed wiring
   * rather than machinery.
   */
  private async chooseVersion(opts: StartSession): Promise<number> {
    if (opts.version !== undefined) return opts.version;
    if (opts.split) {
      const arms = Object.entries(opts.split).map(([target, weight]) => ({ target, weight }));
      const allocator = new TrafficAllocator([{ source: opts.journey, arms }]);
      return Number(allocator.allocate(opts.journey, randomUUID()));
    }
    const versions = await this.registry.list(opts.journey);
    if (versions.length === 0) throw new Error(`journey not found: ${opts.journey}`);
    return versions[0]!;
  }
}

/**
 * Renders pinned templates in place, and records any placeholder that had no
 * value. A lead receiving raw braces is a worse failure than a slightly generic
 * greeting, so the substitution never leaves them in.
 */
function render(applied: { events: EventInput[]; sentText: string | null },
                values: Record<string, string>): void {
  for (const event of applied.events) {
    if (event.type !== "MessageSent") continue;
    const raw = String(event.payload.renderedText ?? "");
    const { text, unresolved } = renderPinned(raw, values);
    event.payload = {
      ...event.payload,
      renderedText: text,
      ...(unresolved.length > 0 ? { unresolvedVariables: unresolved } : {}),
    };
    if (applied.sentText === raw) applied.sentText = text;
  }
}
