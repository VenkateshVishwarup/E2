import type { EventStore } from "@midfunnel/core/events/store";
import type { EventInput, LeadState } from "@midfunnel/core/events/types";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { AgentRuntime } from "@midfunnel/runtime/step";
import type { Persona } from "./persona.js";
import type { Replier } from "./replier.js";

export interface RunSummary {
  runId: string;
  journey: string;
  journeyVersion: number;
  n: number;
  completed: number;
  qualified: number;
  escalated: number;
  ghosted: number;
  avgTurns: number;
}

export interface RunOptions {
  runId?: string;
  agentId?: string;
}

interface ConversationResult {
  turns: number;
  completed: boolean;
  qualified: boolean;
  escalated: boolean;
  ghosted: boolean;
}

export class SimulationRunner {
  constructor(
    private readonly store: EventStore,
    private readonly runtime: AgentRuntime,
    private readonly replier: Replier,
  ) {}

  /**
   * Drives each persona through the journey and writes real events.
   *
   * `allowFollowUp` is true here — unlike replay, there is a synthetic lead to
   * answer the question, so the runtime's full conversational behaviour is
   * exercised. That is what makes a simulation run a sandbox rather than a
   * scoring exercise.
   */
  async run(spec: JourneySpec, personas: Persona[], opts: RunOptions = {}): Promise<RunSummary> {
    const runId = opts.runId ?? `run_${Date.now()}`;
    const agentId = opts.agentId ?? spec.agent.identity;

    let completed = 0, qualified = 0, escalated = 0, ghosted = 0, turnTotal = 0;

    for (const persona of personas) {
      const leadId = `sim_${runId}_${persona.id}`;
      const base = { leadId, journey: spec.journey, journeyVersion: spec.version, agentId, runId };

      await this.store.append({
        ...base, type: "LeadIngested",
        payload: { source: "simulation", personaId: persona.id, campaignId: "sim" },
      });

      const outcome = await this.conversation(spec, persona, base);
      turnTotal += outcome.turns;
      if (outcome.escalated) escalated++;
      else if (outcome.ghosted) ghosted++;
      else if (outcome.completed) { completed++; if (outcome.qualified) qualified++; }
    }

    return {
      runId, journey: spec.journey, journeyVersion: spec.version,
      n: personas.length, completed, qualified, escalated, ghosted,
      avgTurns: personas.length ? Math.round((turnTotal / personas.length) * 10) / 10 : 0,
    };
  }

  private async conversation(
    spec: JourneySpec,
    persona: Persona,
    base: { leadId: string; journey: string; journeyVersion: number; agentId: string; runId: string },
  ): Promise<ConversationResult> {
    let turns = 0;

    // Hard ceiling independent of the spec, so a misbehaving runtime cannot
    // spin forever and burn the batch budget.
    for (let i = 0; i <= spec.policy.max_turns; i++) {
      const state: LeadState = await this.store.fold(base.leadId);
      const actions = await this.runtime.step(spec, state, { allowFollowUp: true });

      const pending: EventInput[] = [];
      let sentText: string | null = null;
      let escalated = false;
      let completed = false;
      let qualified = false;

      for (const a of actions) {
        switch (a.kind) {
          case "send":
            sentText = a.text;
            pending.push({ ...base, type: "MessageSent",
              payload: { channel: "simulated", renderedText: a.text,
                         templateId: a.pinnedTemplate ?? null } });
            break;
          case "extract":
            for (const [field, v] of Object.entries(a.evidence)) {
              pending.push({ ...base, type: "EvidenceExtracted",
                payload: { field, value: v.value, confidence: v.confidence } });
            }
            break;
          case "score":
            pending.push({ ...base, type: "Scored", payload: { score: a.score } });
            break;
          case "route":
            pending.push({ ...base, type: "Routed",
              payload: { decision: a.decision, target: a.target, sla: a.sla ?? null } });
            break;
          case "escalate":
            escalated = true;
            pending.push({ ...base, type: "PolicyEvaluated",
              payload: { ruleId: a.reason, verdict: "escalate", severity: "high" } });
            break;
          case "complete":
            completed = true;
            qualified = a.qualified;
            break;
        }
      }
      if (pending.length > 0) await this.store.appendMany(pending);

      if (escalated) return { turns, completed: false, qualified: false, escalated: true, ghosted: false };
      if (completed) return { turns, completed: true, qualified, escalated: false, ghosted: false };
      if (sentText === null) break;

      const reply = await this.replier.reply(persona, spec, (await this.store.fold(base.leadId)).turns);
      if (reply === null) {
        return { turns, completed: false, qualified: false, escalated: false, ghosted: true };
      }

      await this.store.append({ ...base, type: "MessageReceived",
        payload: { channel: "simulated", rawText: reply } });
      turns++;
    }

    // Ran out of turns without the runtime completing.
    return { turns, completed: false, qualified: false, escalated: false, ghosted: false };
  }
}
